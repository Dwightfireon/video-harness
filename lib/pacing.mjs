/* lib/pacing.mjs —— 场内定点截图的 PSNR 启发式；长停只供人工复核。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { launchBrowser } from './browser.mjs';
import { prepareSamplingPage } from './alive.mjs';

export function parsePsnr(result) {
  if (result.error || result.status !== 0) throw new Error(`ffmpeg 像素比较失败：${result.error?.message || result.signal || `退出码 ${result.status}`}`);
  const m = /average:(inf|\d+(?:\.\d+)?)(?=\s|$)/i.exec(result.stderr || '');
  if (!m) throw new Error('ffmpeg 没有返回有效的 PSNR average');
  return m[1].toLowerCase() === 'inf' ? 99 : Number(m[1]);
}

export function summarizePsnrs(psnrs, times) {
  if (times.length !== psnrs.length + 1 || !psnrs.length || psnrs.some(v => !Number.isFinite(v))) throw new Error('PSNR 样本无效或不完整');
  let run = 0, longest = 0, stillStreak = 0, longestStreak = 0;
  for (let i = 0; i < psnrs.length; i++) {
    const seconds = times[i + 1] - times[i];
    if (!(seconds > 0)) throw new Error('采样时间必须递增');
    if (psnrs[i] >= 45) {
      run += seconds; stillStreak++;
      if (run > longest) { longest = run; longestStreak = stillStreak; }
    } else { run = 0; stillStreak = 0; }
  }
  const avg = psnrs.reduce((s, v) => s + v, 0) / psnrs.length;
  const activity = Math.max(0, Math.min(100, Math.round((60 - Math.min(60, avg)) / 60 * 100)));
  return { activity, stillSeconds: +longest.toFixed(1), stillStreak: longestStreak };
}

export async function analyze(project, opt = {}) {
  const sceneHtml = path.join(project, 'scene.html');
  if (!fs.existsSync(sceneHtml)) return { ok: false, error: '没有 scene.html（先 build）' };
  const src = fs.readFileSync(sceneHtml, 'utf8');
  const ranges = [...src.matchAll(/addScene\(\s*([\d.]+)\s*,\s*([\d.]+)/g)].map(m => [+m[1], +m[2]]);
  if (!ranges.length) return { ok: false, error: '没有解析到场景' };
  const samples = opt.samples ?? 6;
  if (!Number.isInteger(samples) || samples < 2) return { ok: false, error: 'samples 必须是至少 2 的整数' };
  let browser, tmp;
  try {
    const { chromium } = await import('playwright');
    browser = await launchBrowser(chromium, { headless: true, args: ['--force-color-profile=srgb', '--disable-lcd-text'] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await prepareSamplingPage(page, sceneHtml);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-pace-'));
    const scenes = [];
    for (let i = 0; i < ranges.length; i++) {
      const [a, b] = ranges[i];
      const dur = b - a;
      if (!(dur > 0)) throw new Error(`第 ${i + 1} 场时长无效`);
      const ts = Array.from({ length: samples }, (_, k) => a + dur * (k + 0.5) / samples);
      const files = [];
      for (let k = 0; k < ts.length; k++) {
        await page.evaluate(t => window.renderAt(t), ts[k]);
        await page.waitForTimeout(35);
        const f = path.join(tmp, `s${i}-${k}.jpg`);
        await page.screenshot({ path: f, type: 'jpeg', quality: 70, animations: 'disabled' });
        files.push(f);
      }
      const psnrs = [];
      for (let k = 1; k < files.length; k++) {
        const r = spawnSync('ffmpeg', ['-loglevel', 'info', '-i', files[k - 1], '-i', files[k], '-filter_complex', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
        psnrs.push(parsePsnr(r));
      }
      const { activity, stillSeconds, stillStreak } = summarizePsnrs(psnrs, ts);
      const issues = [];
      if (stillSeconds >= 12) issues.push(`连续约 ${stillSeconds}s 抽样画面差异较低（最长 ${stillStreak}/${psnrs.length} 段），待人工复核`);
      scenes.push({ n: i + 1, dur: +dur.toFixed(1), activity, stillSeconds, issues });
    }
    const findings = scenes.flatMap(s => s.issues.map(msg => ({ scene: s.n, msg })));
    return { scenes, findings, ok: findings.length === 0 };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    try { if (browser) await browser.close(); }
    finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
  }
}

export function report(res) {
  if (res.error) return '节奏检查失败：' + res.error;
  const lines = [`节奏检查：${res.scenes.length} 场，${res.findings.length} 处人工复核疑点`, ''];
  lines.push('  场次   时长  差异指数  最长低差');
  for (const s of res.scenes) {
    lines.push(`  S${String(s.n).padEnd(3)} ${String(s.dur).padStart(5)}s ${String(s.activity ?? '-').padStart(7)} ${String(s.stillSeconds + 's').padStart(9)}`);
  }
  if (res.findings.length) {
    lines.push('', '  疑点：');
    for (const f of res.findings) lines.push(`   · S${f.scene}：${f.msg}`);
    lines.push('', '  请结合旁白、阅读时间与叙事意图观看；有意停顿可保留，不必为指标增加运动。');
  } else lines.push('', '  未触发长停复核阈值（连续 ≥12s 低差），不代表成片质量合格。');
  lines.push('', '口径：排除字幕/进度条后的像素抽样启发式；差异指数不是质量评分或运动配额。');
  lines.push('抽样可能漏掉间隔内的变化，不能据此断言看过成片，也不保证人眼感受。');
  return lines.join('\n');
}
