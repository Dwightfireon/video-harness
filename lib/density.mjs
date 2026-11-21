/* lib/density.mjs —— 画面密度体检（vh density）
 *
 * 来源：真实事故——one-take 配方在 t=8s 时几乎全白，只有左上角两个词。
 * 当时 layout / screen / pacing 全部通过：它们查的是"代码里有没有对象"，
 * 不是"画到屏幕上还剩多少"。观众看到的是一片空。
 *
 * 这个模块把画面**真的截下来**，按像素统计墨量：
 *   · coverage      画面有多少比例是"非背景"（排除底部字幕区）
 *   · centerCoverage 画面中心 1/3 的墨量（主体该在这里）
 *   · region       3×3 网格的墨量分布（看主体是否被推出画面）
 *
 * 三条机器能判的规则：
 *   1. 整场平均墨量 < 2% → 太空（一屏几乎没东西）
 *   2. 某一时刻墨量 < 该场最高值的 45% → 中段甩空（运镜把内容推走了）
 *   3. 中心区几乎没墨、四个边角有墨 → 主体偏出画面中心
 *
 * 只报疑点，不判好坏（"留白是设计"仍需人看）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripVisualIntent } from './scene-visual.mjs';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './browser.mjs';

/* 采样点：避开转场首尾 0.4s，按场长等距取 5 帧
   （只取 3 帧会漏掉运镜中段——one-take 事故就发生在第 8 秒，正好落在 3 帧之间） */
function sampleTimes(start, end, extraGuard = 0) {
  const dur = end - start;
  /* 入场动画通常在头 1–2 秒内完成，退场在最后 0.5 秒。
     采样必须避开这两段：在入场中途取样会把"还没画完"误报成"空屏"（真实误报）。
     ⚠ 第八批的转场更花（push/wipe 有整屏位移），入场期要留够 ——
     实测 103.27s 正是 S7 的 push 入场中点，画面还在右边框外。 */
  const pad = Math.min(Math.max(2.4, dur * 0.18), 3.4) + (extraGuard || 0);
  const a = start + pad, b = end - 0.6;
  if (b <= a) return [Math.round((start + dur / 2) * 100) / 100];
  const n = 5;
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round((a + (b - a) * i / (n - 1)) * 100) / 100);
  return [...new Set(out)];
}

/* 在页面里解码截图并统计（页面自带 jpeg 解码器，不引依赖） */
const MEASURE_FN = async ({ dataUrls, subTopFrac }) => {
  const out = [];
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  for (const url of dataUrls) {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    /* 按真实宽高比采样：把竖屏硬压成 16:9 会让文字像素少一半，
       结构量被低估，于是"竖屏有内容"会被误报成"中段甩空"（真实事故）。 */
    const long = 320;
    const cw = img.width >= img.height ? long : Math.round(long * img.width / img.height);
    const ch = img.width >= img.height ? Math.round(long * img.height / img.width) : long;
    cv.width = cw; cv.height = ch;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    const d = ctx.getImageData(0, 0, cw, ch).data;
    // 字幕已隐藏；若调用方仍给了裁剪比例（<1）就照它裁
    const yMax = Math.max(1, Math.floor(ch * Math.min(0.98, Math.max(0.5, subTopFrac))));
    // 找背景色：量化到 32 级后取众数
    const buckets = new Map();
    for (let y = 0; y < yMax; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        const k = ((d[i] >> 5) << 10) | ((d[i + 1] >> 5) << 5) | (d[i + 2] >> 5);
        const b = buckets.get(k);
        if (b) { b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2]; }
        else buckets.set(k, { n: 1, r: d[i], g: d[i + 1], b: d[i + 2] });
      }
    }
    let bg = null, best = 0;
    for (const b of buckets.values()) if (b.n > best) { best = b.n; bg = b; }
    const bgR = bg.r / bg.n, bgG = bg.g / bg.n, bgB = bg.b / bg.n;
    const near = (i, tol) => Math.abs(d[i] - bgR) + Math.abs(d[i + 1] - bgG) + Math.abs(d[i + 2] - bgB) < tol;

    // 灰度 + 边缘：空白卡片与背景同色，但"没有纹理"这件事本身可测
    const gray = new Float32Array(cw * ch);
    for (let y = 0; y < yMax; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        gray[y * cw + x] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      }
    }
    let ink = 0, total = 0, edgePx = 0;
    const cells = new Array(9).fill(0), cellTotal = new Array(9).fill(0);
    const edgeCells = new Array(9).fill(0);
    /* 四等分横带（比 3×3 更适合判"头重脚轻"：字幕条只占最底一格，不会掩盖中间的空） */
    const bands = new Array(4).fill(0), bandTotal = new Array(4).fill(0);
    const bandEdge = new Array(4).fill(0);
    for (let y = 1; y < yMax - 1; y++) {
      for (let x = 1; x < cw - 1; x++) {
        const i = (y * cw + x) * 4;
        const cell = Math.min(2, Math.floor(x / (cw / 3))) + Math.min(2, Math.floor(y / (ch / 3))) * 3;
        const band = Math.min(3, Math.floor(y / (ch / 4)));
        total++; cellTotal[cell]++; bandTotal[band]++;
        // 容差 26：放过纸纹与渐变，只算"画上去的东西"
        if (!near(i, 26)) { ink++; cells[cell]++; bands[band]++; }
        // 边缘：与上下左右灰度的差（文字、线条、图形都有；空卡片没有）
        const g = gray[y * cw + x];
        const gx = Math.abs(g - gray[y * cw + x + 1]) + Math.abs(g - gray[y * cw + x - 1]);
        const gy = Math.abs(g - gray[(y + 1) * cw + x]) + Math.abs(g - gray[(y - 1) * cw + x]);
        if (gx + gy > 18) { edgePx++; edgeCells[cell]++; bandEdge[band]++; }
      }
    }
    const centerCells = [4];
    const centerInk = centerCells.reduce((s, c) => s + cells[c], 0);
    const centerTotal = centerCells.reduce((s, c) => s + cellTotal[c], 0);
    const cornerCells = [0, 2, 6, 8];
    const edgeInk = cornerCells.reduce((s, c) => s + cells[c], 0);
    const edgeTotal = cornerCells.reduce((s, c) => s + cellTotal[c], 0);
    out.push({
      coverage: ink / total,
      structure: edgePx / total,
      centerCoverage: centerInk / centerTotal,
      edgeCoverage: edgeInk / edgeTotal,
      centerStructure: edgeCells[4] / cellTotal[4],
      bands: bands.map((v, i) => +(v / (bandTotal[i] || 1)).toFixed(4)),
      bandEdge: bandEdge.map((v, i) => +(v / (bandTotal[i] || 1)).toFixed(4)),
      edgeStructure: edgeCells.filter((v, i) => [0, 2, 6, 8].includes(i)).reduce((a, b) => a + b, 0)
        / [0, 2, 6, 8].reduce((a, c) => a + cellTotal[c], 0),
      cells: cells.map((n, i) => +(n / cellTotal[i]).toFixed(4)),
    });
  }
  return out;
};

export async function analyze(project, opt = {}) {
  const sceneHtml = fs.readFileSync(path.join(project, 'scene.html'), 'utf8');
  const ranges = [...sceneHtml.matchAll(/addScene\(\s*([\d.]+)\s*,\s*([\d.]+)/g)].map(m => [+m[1], +m[2]]);
  /* 每场的转场时长：push/wipe 在转场期画面是"半个屏"或"被裁一半"，
     这时候采样必然失真（真实误报：S7 push 入场期被报"墨量掉到 5%"）。
     把转场时长也算进保护期。 */
  const transTable = (() => {
    const m = sceneHtml.match(/window\.__vhTrans = (\[[^;]*\]);/);
    try { return m ? JSON.parse(m[1]).map(t => (t.d == null ? 0.45 : t.d)) : []; } catch { return []; }
  })();
  if (!ranges.length) return { ok: true, scenes: [], findings: [], note: '没有可比对的场景' };

  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { return { ok: false, scenes: [], findings: [{ kind: 'env', msg: '没有 playwright，无法按像素体检' }] }; }

  const browser = await launchBrowser(chromium, {
    headless: true,
    args: ['--force-color-profile=srgb', '--use-gl=angle', '--use-angle=metal',
           '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--disable-lcd-text'],
  });
  /* 哪些场是"真实素材场"（截图/录屏/图表）：这些场的大块同色是内容本身，不是留白。
     判据看场景代码里有没有 shotEl/videoEl/chartEl/bgImg（与 variety 同口径）。 */
  const src = (() => { try { return fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'); } catch { return ''; } })();
  const chunks = src.split(/^\/\/---\s*$/m).map(c => stripVisualIntent(c.trim())).filter(Boolean);
  const shotScenes = new Set(), statementScenes = new Set();
  chunks.forEach((c, i) => {
    if (/shotEl\s*\(|videoEl\s*\(|chartEl\s*\(|bgImg\s*\(/.test(c)) shotScenes.add(i + 1);
    const tag = (c.match(/@layout\s+([^\s*·\n]+)/) || [])[1] || '';
    if (/大字|断言|章节|标题页|钩子|hero/i.test(tag) || /type\([^,]+,\s*'hero'\)/.test(c)) statementScenes.add(i + 1);
  });

  const scenes = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(path.join(project, 'scene.html')).href);
    await page.evaluate(() => document.fonts.ready);
  /* 等素材解码（图片/视频）—— 不等会截到空白首帧 */
  try { await page.evaluate(async () => { if (window.__ready) await window.__ready; else if (window.VH_UI && window.VH_UI.assetsReady) await window.VH_UI.assetsReady(); }); } catch {}
    await page.waitForTimeout(200);
    const W = await page.evaluate(() => window.W || 1920);
    const H = await page.evaluate(() => window.H || 1080);
    if (W !== 1920 || H !== 1080) await page.setViewportSize({ width: W, height: H });
    /* 字幕条不参与测量：它是旁白的镜像，不是"画面画了什么"。
       而且字幕一换两行就往上长，按固定比例裁会把字幕算成内容（真实误报：
       同一场 1.8% vs 5.5% 的差异全来自字幕条位置）。
       直接隐藏它，画布整块都算画面。 */
    await page.evaluate(() => {
      const s = document.getElementById('subs');
      if (s) s.style.visibility = 'hidden';
    });
    const subTopFrac = 1;

    for (let i = 0; i < ranges.length; i++) {
      const [start, end] = ranges[i];
      const times = sampleTimes(start, end, transTable[i] || 0);
      const urls = [];
      for (const t of times) {
        await page.evaluate(tt => window.renderAt(tt), t);
        await page.waitForTimeout(35);
        const buf = await page.screenshot({ type: 'jpeg', quality: 60, animations: 'disabled' });
        urls.push('data:image/jpeg;base64,' + buf.toString('base64'));
      }
      const measured = await page.evaluate(MEASURE_FN, { dataUrls: urls, subTopFrac });
      const shotLike = shotScenes.has(i + 1);
      const statementLike = statementScenes.has(i + 1);
      measured.forEach(m => { m.shotLike = shotLike; m.statementLike = statementLike; });
      const cov = measured.map(m => m.coverage);
      scenes.push({
        i: i + 1,
        start, end,
        frames: times.map((t, j) => ({ t, ...measured[j] })),
        avg: cov.reduce((a, b) => a + b, 0) / cov.length,
        min: Math.min(...cov),
        max: Math.max(...cov),
      });
    }
  } finally {
    // 出错也要关：否则异常一次就留一堆无头 Chromium
    await browser.close();
  }

  const findings = [];
  for (const sc of scenes) {
    const pct = (n) => (n * 100).toFixed(1) + '%';
    // 结构量（边缘）才是"画了多少东西"；覆盖率会被大白卡片骗过去
    const structs = sc.frames.map(f => f.structure);
    const avgStruct = structs.reduce((a, b) => a + b, 0) / structs.length;
    const maxStruct = Math.max(...structs);

    if (maxStruct < 0.015) {
      findings.push({
        kind: 'empty', scene: sc.i,
        msg: `第 ${sc.i} 场结构量峰值 ${pct(maxStruct)}，可能空屏或主体未显示，待看真实静帧`,
        fix: '先核对主体是否可见、素材是否加载；若是有意的极简或停顿，不必为指标填充。',
      });
      continue;
    }

    /* 大白卡片：覆盖率高但结构量低 → 一大片同色块（空窗口/空卡片）。
       这条判据有两次真实误报，都指向同一个问题：**它无法区分"空容器"和"有内容的浅色容器"**。
         ① 真实截图（深色界面占半个屏）：整块都是内容，边缘少因为它本来就是深色平板；
         ② 带说明文字的三步卡片（占 25% 画面）：卡是浅色、文字只占一小块。
       修法：比值再放宽到 0.30（真正空卡片的比值通常 < 0.15），并要求"结构量绝对值也很低"。
       宁可漏报，不要误报——误报会让人不再相信这个工具。 */
    const hasShot = sc.frames.some(f => f.shotLike);
    const fat = hasShot ? [] : sc.frames.filter(f =>
      f.coverage > 0.15 &&
      f.structure / Math.max(f.coverage, 1e-6) < 0.30 &&
      f.structure < 0.02);
    if (fat.length) {
      const worst = fat.reduce((a, b) => (a.structure / a.coverage <= b.structure / b.coverage ? a : b));
      findings.push({
        kind: 'blank-card', scene: sc.i,
        msg: `第 ${sc.i} 场在 ${worst.t}s 有大面积低边缘区块（覆盖 ${pct(worst.coverage)}，结构量 ${pct(worst.structure)}），待复核`,
        fix: '看静帧判断是空容器、真实素材还是有意留白；无用的容器可缩小或移除，不要为了填满添加内容。',
      });
    }

    /* "中段甩空"判据只看**结构量**（文字/线条/图形的边缘），不看覆盖率。
       覆盖率会被"浅色大卡片"骗过去：整块卡都算"与背景不同色"，
       但一帧有卡无字（或卡色接近背景）时覆盖率仍高、结构量却掉下去。
       真实误报：S7 三步卡在 113s 判"墨量掉到 5.8%"，其实画面很完整。 */
    const sMax = maxStruct, sMin = Math.min(...structs);
    if (sMax > 0.03 && sMin < sMax * 0.45) {
      const worst = sc.frames.reduce((a, b) => (a.structure <= b.structure ? a : b));
      findings.push({
        kind: 'dip', scene: sc.i,
        msg: `第 ${sc.i} 场在 ${worst.t}s 时结构量掉到 ${pct(worst.structure)}（该场最高 ${pct(sMax)}），主体可能出画，也可能是有意留白`,
        fix: '核对该时刻的主体与字幕；若确实出画，调整镜头或主体位置，保留有意义的停顿。',
      });
    }
    /* 主体是否偏出中心：只在"内容很少、且都堆在边角"时才算问题。
       大字断言 / 章节页天然是"上方一句大标题 + 下方留白"，
       中心区没墨是设计，不该报（真实误报：hero-statement 被判"主体偏出画面"）。 */
    /* 垂直分布：内容全堆在上半屏 / 下半屏 → 画面"头重脚轻"。
       这是真实盲区：三层卡片占上半屏、下面 40% 全空，density 之前完全不报
       （结构量够、没有空卡片、没有甩空 —— 但观众看到的是一张"没做完"的图）。 */
    /* 四横带：前 1/4、2/4、3/4、末 1/4 的结构量。
       "头重脚轻" = 上两条带很有肉、第三条带（画面 50–75%）几乎空。
       末 1/4 不算（字幕条与进度条在那儿，会把空遮住）—— 这是两次误报的教训。 */
    const bandOf = (f) => f.bandEdge || [0, 0, 0, 0];
    const upper = sc.frames.map(f => (bandOf(f)[0] + bandOf(f)[1]) / 2);
    const mid = sc.frames.map(f => bandOf(f)[2]);
    /* 大字断言/章节页豁免：标题在上、下面留白是设计（与 screen 的 statementLike 同口径） */
    const hasStatement = sc.frames.some(f => f.statementLike);
    const topHeavy = !hasStatement && sc.frames.every((f, k) => upper[k] > 0.012 && mid[k] < upper[k] * 0.30);
    if (topHeavy) {
      findings.push({
        kind: 'top-heavy', scene: sc.i,
        msg: `第 ${sc.i} 场结构集中在上半屏（上半 ${pct(Math.max(...upper))}，50–75% 仅 ${pct(Math.max(...mid))}）；核对是否看起来"没做完"或属于有意留白`,
        fix: '结合焦点和讲述看真实静帧；无目的的空容器可调整，但有意留白不必补文字或强制居中。',
      });
    }

    /* 判据改成"内容是不是全挤在一个角" —— 那才是被推出画面的签名。
       标题在上、副文在下（大字断言）中心自然空着，属正常排版，不报。 */
    const cornerHeavy = sc.frames.every(f => {
      const corners = [f.cells[0], f.cells[2], f.cells[6], f.cells[8]];
      const total = f.cells.reduce((a, b) => a + b, 0) || 1;
      return Math.max(...corners) / total > 0.55 && f.centerStructure < 0.02;
    });
    if (cornerHeavy) {
      findings.push({
        kind: 'offcenter', scene: sc.i,
        msg: `第 ${sc.i} 场结构集中在角落（中心 ${pct(Math.max(...sc.frames.map(f => f.centerStructure)))}），需核对主体是否出画`,
        fix: '先看焦点是否清楚可见；只有主体确实出画时才调整镜头或安全区坐标，不强制中心构图。',
      });
    }
  }
  return { ok: findings.length === 0, scenes, findings };
}

export function report(res) {
  if (res.note) return res.note;
  const pct = (n) => (n * 100).toFixed(1).padStart(5) + '%';
  const lines = ['画面密度（按像素算的墨量，不含底部字幕区）', ''];
  lines.push('  场次   结构量  覆盖量  中心结构  逐帧（结构/覆盖）');
  for (const sc of res.scenes) {
    const structs = sc.frames.map(f => f.structure);
    const avgS = structs.reduce((a, b) => a + b, 0) / structs.length;
    const per = sc.frames.map(f => `${f.t}s:${(f.structure * 100).toFixed(1)}/${(f.coverage * 100).toFixed(1)}`).join('  ');
    lines.push(`  S${String(sc.i).padStart(2)}   ${pct(avgS)}  ${pct(sc.avg)}  ${pct(Math.max(...sc.frames.map(f => f.centerStructure)))}  ${per}`);
  }
  lines.push('');
  if (!res.findings.length) {
    lines.push('未触发抽样阈值；不保证主体位置或构图正确。');
  } else {
    for (const f of res.findings) {
      lines.push(`⚠ ${f.msg}`);
      if (f.fix) lines.push(`   → ${f.fix}`);
    }
    lines.push('');
    lines.push(`⚠ ${res.findings.length} 处像素疑点，需结合画面判断`);
  }
  lines.push('');
  lines.push('口径：「结构量」= 画面里有边缘的像素比例（文字、线条、图形）；「覆盖量」= 与背景不同色的比例。');
  lines.push('      覆盖量高但结构量低可能是空容器、真实素材或留白。留白是设计，不等于空屏。');
  return lines.join('\n');
}
