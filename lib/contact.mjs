/* lib/contact.mjs —— 联系表（vh contact）
 *
 * 为什么需要：逐场看画面要读 N 张图，界面上会开 N 个预览 —— 人也累，
 * 而且很难看出"整片是不是一个样"。
 * 联系表把全部场次拼成一张网格图，一眼看完整片的版式分布与亮度节奏。
 *
 * 用法：
 *   node vh.mjs contact            # 每场一张（中点），网格拼图
 *   node vh.mjs contact --times 3  # 每场三帧（1/6、中点、5/6），有限采样
 *   node vh.mjs contact --scenes 3 --times 3  # 先验证关键场景
 *   node vh.mjs contact --cols 4   # 指定列数
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openPreviewPage } from './preview-page.mjs';
import { currentArtifactInputs } from './artifact-status.mjs';

/** Pure plan: never round sampling times out of very short scene intervals. */
export function contactPlan(ranges, opt = {}, width = 1920, height = 1080) {
  if (!Array.isArray(ranges) || !ranges.length) throw new Error('没有场景');
  let previousEnd = 0;
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)
        || range[0] < previousEnd || range[1] <= range[0]) throw new Error('场景区间无效或重叠');
    previousEnd = range[1];
  }
  const times = opt.times ?? 1;
  const cols = opt.cols ?? (times > 1 ? times : ranges.length > 9 ? 4 : 3);
  if (!Number.isInteger(times) || times < 1 || times > 4) throw new Error('--times 必须为 1–4 的整数');
  if (!Number.isInteger(cols) || cols < 2 || cols > 6) throw new Error('--cols 必须为 2–6 的整数');
  if (![width, height].every(n => Number.isFinite(n) && n > 0)) throw new Error('画幅无效');
  const scenes = opt.scenes ?? ranges.map((_, i) => i + 1);
  if (!Array.isArray(scenes) || !scenes.length || scenes.some(n => !Number.isInteger(n) || n < 1 || n > ranges.length)
      || new Set(scenes).size !== scenes.length) throw new Error('--scenes 须为不重复的有效场号，如 2,3');
  const samples = [...scenes].sort((a, b) => a - b).flatMap(scene => {
    const [a, b] = ranges[scene - 1];
    return Array.from({ length: times }, (_, k) => {
      const t = a + (b - a) * (k + 0.5) / times;
      if (!(t > a && t < b)) throw new Error('场景区间过短，无法在场内采样');
      return { scene, t };
    });
  });
  const cellW = Math.round(440 * Math.min(1, width / height));
  const cellH = Math.round(cellW * height / width), labelH = 34;
  const sheetW = cols * cellW, sheetH = Math.ceil(samples.length / cols) * (cellH + labelH);
  if (cellW < 1 || cellH < 1 || sheetH > 30000 || sheetW > 30000) throw new Error('联系表尺寸过大，请用 --scenes 分批检查');
  return { samples, cols, times, cellW, cellH, labelH, sheetW, sheetH, scenes: scenes.length, totalScenes: ranges.length };
}

export async function build(project, opt = {}) {
  const scenePath = path.join(project, 'scene.html');
  if (!fs.existsSync(scenePath)) return { ok: false, error: '没有 scene.html（先 build）' };

  const expectedInputs = currentArtifactInputs(project);
  const ranges = expectedInputs.ranges;
  try { contactPlan(ranges, opt); }
  catch (error) { return { ok: false, error: error.message }; }

  /* 场次标题（从脚本读，拼图里标出来） */
  const titles = (() => {
    try {
      const md = fs.readFileSync(path.join(project, '脚本.md'), 'utf8');
      return [...md.matchAll(/^##\s*S(\d+)\s*[·•\-—]?\s*(.*)$/gm)].map(m => m[2].trim());
    } catch { return []; }
  })();

  let preview;
  const shots = [];
  try {
    preview = await openPreviewPage(scenePath);
    const { page } = preview;
    const { width, height } = page.viewportSize();
    const plan = contactPlan(ranges, opt, width, height);
    const { cols, times, cellW, cellH, labelH, sheetW, sheetH } = plan;

    for (const sample of plan.samples) {
      await page.evaluate(tt => window.renderAt(tt), sample.t);
      await page.waitForTimeout(35);
      const buf = await page.screenshot({ type: 'jpeg', quality: 82, animations: 'disabled' });
      shots.push({ ...sample, b64: buf.toString('base64') });
    }

    /* 用一页 HTML 拼图，再整体截一张（比逐张拼 osascript/ffmpeg 稳） */
    // Reuse the owned preview page after capture; browser.newPage() contexts
    // cannot create a second page. Navigate to clear the scene runtime first.
    const gridPage = page;
    await gridPage.goto('about:blank');
    await gridPage.setViewportSize({ width: sheetW, height: sheetH });
    const cells = shots.map(s => {
      const title = titles[s.scene - 1] || '';
      return `<div class="cell">
        <img src="data:image/jpeg;base64,${s.b64}">
        <div class="cap"><b>S${s.scene}</b> ${title.replace(/[<>&]/g, '')} <span>${Number(s.t.toFixed(6))}s</span></div>
      </div>`;
    }).join('');
    await gridPage.setContent(`<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;background:#111;font-family:-apple-system,"PingFang SC",sans-serif}
      .grid{display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:0}
      .cell{width:${cellW}px;height:${cellH + labelH}px;background:#111;overflow:hidden}
      .cell img{display:block;width:${cellW}px;height:${cellH}px;object-fit:contain}
      .cap{height:${labelH}px;line-height:${labelH}px;padding:0 10px;color:#ddd;font-size:14px;
           white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cap b{color:#7BE3A4;font-weight:600;margin-right:6px}
      .cap span{color:#777;float:right;font-family:ui-monospace,monospace}
    </style><div class="grid">${cells}</div>`);
    await gridPage.evaluate(() => document.fonts.ready);
    await gridPage.evaluate(() => Promise.all([...document.images].map(img => img.decode())));

    const out = path.join(project, 'out', 'contact.jpg');
    const image = await gridPage.screenshot({ type: 'jpeg', quality: 86, animations: 'disabled', fullPage: true });
    if (currentArtifactInputs(project).sourceSignature !== expectedInputs.sourceSignature) throw new Error('截图期间输入发生变化，未更新联系表；请 build 后重新截图');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // Do not replace a previous contact sheet until all frames/readiness and the
    // input check succeed. This receipt is capture provenance, never a review.
    fs.writeFileSync(out, image);
    const receipt = { schemaVersion: 1, sourceSignature: expectedInputs.sourceSignature,
      sha256: createHash('sha256').update(image).digest('hex'), width, height,
      samples: plan.samples, cols, times, reviewed: false };
    fs.writeFileSync(path.join(project, 'out', '.vh-contact.json'), JSON.stringify(receipt, null, 2) + '\n');
    return { ok: true, out, count: shots.length, scenes: plan.scenes, totalScenes: plan.totalScenes, cols, times };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    if (preview) await preview.close();
  }
}

export function report(r) {
  if (!r.ok) return '联系表生成失败：' + r.error;
  return [
    `✓ 联系表 → ${r.out}`,
    `  ${r.scenes} 场 × ${r.times} 帧 = ${r.count} 格（${r.cols} 列）`,
    '  一眼看完整片或所选场：版式、明暗与阶段变化；只对疑点用 stills --at t1,t2 批量放大。',
    '  有限场内采样，不含精确首尾；生成不等于已查看、连续播放、试听或发布审阅。',
  ].join('\n');
}
