/* lib/alive.mjs —— 定时截图的像素差启发式，不替代成片观看或审美判断。 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './browser.mjs';

const VIS_THRESHOLD = 1.2; // 240px 宽缩样的经验阈值，不是人眼可见性保证。
const round = n => +n.toFixed(9);

export function sampleTimes(dur, step = 1) {
  if (!Number.isFinite(step) || step <= 0) throw new Error('step 必须是有限正数（秒）');
  if (!Number.isFinite(dur) || dur <= 0) throw new Error('DURATION 必须是有限正数');
  const times = [];
  for (let i = 0; i * step < dur; i++) times.push(i * step);
  times.push(dur); // 保留不足一个步长的尾段，不能把样本个数当秒数。
  return times;
}

/* 加载原文件以保留相对资源路径，按画幅截图，排除字幕和进度条。 */
export async function prepareSamplingPage(page, sceneHtml) {
  await page.goto(pathToFileURL(sceneHtml).href);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    if (window.__ready) await window.__ready;
    else if (window.VH_UI?.assetsReady) await window.VH_UI.assetsReady();
  });
  const size = await page.evaluate(() => ({ width: window.W ?? 1920, height: window.H ?? 1080 }));
  if (![size.width, size.height].every(v => Number.isInteger(v) && v > 0)) throw new Error('无效画幅 W/H');
  await page.setViewportSize(size);
  await page.addStyleTag({ content: '#subs,#subbox,#bar{display:none !important;visibility:hidden !important}' });
  await page.waitForTimeout(150);
  return size;
}

export function summarizeDiffs(diffs, times, ranges, trans = []) {
  if (times.length !== diffs.length + 1) throw new Error('采样时间与像素差数量不一致');
  const intervals = diffs.map((d, i) => ({ start: times[i], end: times[i + 1], seconds: times[i + 1] - times[i], d }));
  const scenes = ranges.map(([a, b], i) => {
    const guard = (trans[i] ?? 0.45) + 0.5;
    // 只统计完全位于本场主体内的区间，不能按场景起点重新对齐全片采样网格。
    const body = intervals.filter(x => x.start >= a + guard - 1e-9 && x.end <= b + 1e-9);
    let run = 0, runAt = null, worst = 0, worstAt = null;
    let visibleSeconds = 0, quietSeconds = 0, previousEnd = null;
    for (const x of body) {
      if (x.d <= VIS_THRESHOLD) {
        quietSeconds += x.seconds;
        if (!run || Math.abs(x.start - previousEnd) > 1e-9) { run = 0; runAt = x.start; }
        run += x.seconds;
        if (run > worst) { worst = run; worstAt = runAt; }
      } else { visibleSeconds += x.seconds; run = 0; }
      previousEnd = x.end;
    }
    const seconds = visibleSeconds + quietSeconds;
    return {
      n: i + 1, start: a, end: b, dur: round(b - a), samples: body.length,
      visible: body.filter(x => x.d > VIS_THRESHOLD).length,
      ratio: seconds ? Math.round(visibleSeconds / seconds * 100) : 0,
      quietSeconds: round(quietSeconds), maxStill: round(worst), maxStillAt: worstAt == null ? null : round(worstAt),
      minDiff: body.length ? Math.min(...body.map(x => x.d)) : null,
    };
  });
  const findings = scenes.filter(sc => sc.maxStill >= 4).map(sc => ({
    kind: 'still', scene: sc.n,
    msg: `第 ${sc.n} 场从 ${sc.maxStillAt}s 起连续约 ${sc.maxStill} 秒抽样像素差较低，待人工复核`,
    fix: '结合旁白、阅读负担和叙事意图观看这一段；有意留白或阅读停顿可保留，不必为指标增加运动。',
  }));
  const visibleSeconds = round(intervals.filter(x => x.d > VIS_THRESHOLD).reduce((s, x) => s + x.seconds, 0));
  const totalSeconds = round(intervals.reduce((s, x) => s + x.seconds, 0));
  return { scenes, findings, visibleSeconds, totalSeconds, ratio: totalSeconds ? Math.round(visibleSeconds / totalSeconds * 100) : 0 };
}

export async function analyze(project, opt = {}) {
  const sceneHtml = path.join(project, 'scene.html');
  if (!fs.existsSync(sceneHtml)) return { ok: false, error: '没有 scene.html（先 build）' };
  const step = opt.step ?? 1;
  if (!Number.isFinite(step) || step <= 0) return { ok: false, error: 'step 必须是有限正数（秒）' };
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await launchBrowser(chromium, { headless: true, args: ['--force-color-profile=srgb', '--disable-lcd-text'] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const size = await prepareSamplingPage(page, sceneHtml);
    const dur = await page.evaluate(() => window.DURATION);
    const src = fs.readFileSync(sceneHtml, 'utf8');
    const ranges = [...src.matchAll(/addScene\(\s*([\d.]+)\s*,\s*([\d.]+)/g)].map(m => [+m[1], +m[2]]);
    if (!ranges.length) throw new Error('没有解析到场景');
    let trans = [];
    const m = src.match(/window\.__vhTrans\s*=\s*(\[[^;]*\]);/);
    try { trans = m ? JSON.parse(m[1]).map(t => t.d ?? 0.45) : []; } catch {}
    const times = sampleTimes(dur, step);
    const shots = [];
    for (const t of times) {
      await page.evaluate(tt => window.renderAt(tt), t);
      await page.waitForTimeout(12);
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      shots.push('data:image/jpeg;base64,' + buf.toString('base64'));
    }
    const diffs = await page.evaluate(async ({ urls, cw, ch }) => {
      const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      const frames = [];
      for (const u of urls) {
        const im = new Image();
        await new Promise((resolve, reject) => { im.onload = resolve; im.onerror = () => reject(new Error('截图解码失败')); im.src = u; });
        ctx.drawImage(im, 0, 0, cw, ch);
        frames.push(ctx.getImageData(0, 0, cw, ch).data.slice());
      }
      const out = [];
      for (let i = 1; i < frames.length; i++) {
        let s = 0, n = 0;
        const a = frames[i - 1], b = frames[i];
        for (let k = 0; k < a.length; k += 16) {
          s += Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]);
          n += 3;
        }
        out.push(+(s / n).toFixed(2));
      }
      return out;
    }, { urls: shots, cw: 240, ch: Math.max(1, Math.round(240 * size.height / size.width)) });
    const result = summarizeDiffs(diffs, times, ranges, trans);
    return { ok: result.findings.length === 0, ...result, diffs, dur, threshold: VIS_THRESHOLD, step };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    if (browser) await browser.close();
  }
}

export function report(res) {
  if (res.error) return '抽样像素变化检查失败：' + res.error;
  const lines = ['抽样像素变化检查（启发式，不是人眼可见性或审美质量判定）', ''];
  lines.push(`全片 ${res.dur} 秒：${res.visibleSeconds}/${res.totalSeconds} 秒对应区间的像素差超过阈值（${res.ratio}%）`);
  lines.push(`阈值 diff > ${res.threshold}（缩样平均像素差；不设运动比例配额）`);
  lines.push('', '  场次   时长  变化比例  最长低差  最小 diff');
  for (const s of res.scenes) {
    lines.push(`  S${String(s.n).padStart(2)}  ${String(s.dur).padStart(5)}s  ${String(s.ratio + '%').padStart(7)}  ${String(s.maxStill + 's').padStart(7)}  ${String(s.minDiff ?? '-').padStart(8)}`);
  }
  lines.push('');
  if (!res.findings.length) lines.push('未触发长停复核阈值；不代表每秒都在动或成片质量合格。');
  for (const f of res.findings) {
    lines.push(`⚠ ${f.msg}`);
    if (f.fix) lines.push(`   → ${f.fix}`);
  }
  lines.push('', '口径：已排除字幕和进度条；跨场景及转场保护区间不计入场内统计。');
  lines.push('像素抽样可能漏掉采样间隔内的变化，不能据此断言看过成片；长停仅是人工审阅疑点。');
  return lines.join('\n');
}
