/* Exact-template migration. Generated renderers remain standalone and their
 * existing rendererHash covers all injected runtime code. */
import { createHash } from 'node:crypto';

export const PERFORMANCE_MARK = 'vh:renderer-performance-v1';
export const KNOWN_RENDERER_HASHES = new Set([
  'be18c3aa389857c45286e33afefe5d377dd428afc7e2d9b2c0446424f07b550f',
  'bf6b8e055126ab8bf92151f709336c9e3d5f805ec3d8e8de4a20bbfb2cbbfe17',
]);

// Integer half-open intervals, with the same rounding and fade semantics as
// the approved scaffold. Merge after padding, never bridge untouched gaps.
export function sceneFrameIntervals(pick, ranges, fades, duration, fps) {
  const total = Math.round(duration * fps);
  // Out-of-range means there is no such scene (before the first / after the
  // last). The scaffold's 0.45 fallback is only meaningful for an actual
  // neighbouring scene; using it past the final scene just pads dead frames.
  const fade = i => i >= 0 && i < fades.length ? fades[i] : 0;
  const intervals = pick.map(n => {
    const pad = Math.max(0, fade(n - 1), fade(n));
    return [Math.max(0, Math.round((ranges[n - 1][0] - pad) * fps)),
      Math.min(total, Math.round((ranges[n - 1][1] + pad) * fps))];
  }).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of intervals) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

export function performanceRendererSource(source) {
  if (!KNOWN_RENDERER_HASHES.has(createHash('sha256').update(source).digest('hex'))) return null;
  let next = source;
  const replace = (before, after) => {
    if (next.split(before).length !== 2) throw new Error('Known renderer migration anchor mismatch');
    next = next.replace(before, () => after);
  };
  replace("import fs from 'node:fs';", "import fs from 'node:fs';\nimport { randomUUID } from 'node:crypto';\n/* " + PERFORMANCE_MARK + ' */\n' + sceneFrameIntervals.toString());
  if (next.includes('chromium.launch({ ...launchArgs, executablePath: localBrowser })')) {
    replace('chromium.launch({ ...launchArgs, executablePath: localBrowser })', 'chromium.launch({ args: launchArgs, executablePath: localBrowser }) /* vh:chrome-args-v1 */');
  }
  replace('let browser;', `let browser;
async function closeRenderBrowser() {
  if (browser) { const closing = browser; browser = null; await closing.close(); }
}
const renderRunId = process.env.VH_RENDER_RUN_ID || randomUUID();
let activeStage = null;
function beginRenderStage(stage, detail = {}) {
  activeStage = { stage, detail, start: performance.now() };
}
function endRenderStage(ok) {
  if (!activeStage) return;
  const { stage, detail, start } = activeStage;
  activeStage = null;
  const event = { schemaVersion: 1, runId: renderRunId, kind: 'renderer-stage',
    stage, elapsedMs: performance.now() - start, ok, ...detail };
  // One event per attempted stage; an interrupted stage can never claim success.
  const line = JSON.stringify(event);
  try { fs.appendFileSync(path.join(OUTDIR, '.vh-renderer-performance.jsonl'), line + '\\n'); }
  catch (error) { console.error('Renderer timing write failed:', error.message); }
  // Progress rewrites the same console line; start a fresh line so the
  // machine-readable event is a whole line, not a progress-bar suffix.
  console.log('\\nVH_RENDER_STAGE ' + line);
}
process.on('exit', () => endRenderStage(false));
try {`);
  // All exits close the browser; the normal path closes before ffmpeg starts.
  next = next.replaceAll('await browser.close()', 'await closeRenderBrowser()');
  const start = next.indexOf('if (scenesArg) {');
  const end = next.indexOf('\n// 段切点', start);
  if (start < 0 || end < 0) throw new Error('Known renderer range anchors missing');
  next = next.slice(0, start) + `let frameIntervals;
if (scenesArg) {
  const pick = scenesArg.split(',').map(Number);
  if (!/^\\d+(?:,\\d+)*$/.test(scenesArg) || pick.some(n => !Number.isInteger(n) || n < 1 || n > sceneRanges.length)) {
    throw new Error('--scenes 场号无效');
  }
  frameIntervals = sceneFrameIntervals(pick, sceneRanges, sceneFades, DURATION, FPS);
} else {
  frameIntervals = [[Math.max(0, Math.round(fromSec * FPS)), Math.min(total, Math.round(toSec * FPS))]];
}
const partial = frameIntervals.length !== 1 || frameIntervals[0][0] > 0 || frameIntervals[0][1] < total;
` + next.slice(end);
  replace('const totalN = Math.max(1, TO - FROM);', 'const totalN = frameIntervals.reduce((sum, [a, b]) => sum + b - a, 0);');
  replace("if (!ENCODE_ONLY) {\n  console.log", "if (!ENCODE_ONLY) {\n  beginRenderStage('screenshot', { frames: totalN, intervals: frameIntervals });\n  console.log");
  replace('`　（只重渲 ${FROM}–${TO}）`', '`　（只重渲 ${frameIntervals.map(([a,b]) => a + "–" + b).join(", ")}）`');
  replace('let next = FROM, done = 0;', 'let intervalIndex = 0, next = frameIntervals[0]?.[0] ?? 0, done = 0;');
  replace('const i = next++;\n      if (i >= TO) break;', `while (intervalIndex < frameIntervals.length && next >= frameIntervals[intervalIndex][1]) {
        intervalIndex++; next = frameIntervals[intervalIndex]?.[0] ?? 0;
      }
      if (intervalIndex >= frameIntervals.length) break;
      const i = next++;`);
  replace('await Promise.all(pages.map(worker));', `const workers = await Promise.allSettled(pages.map(worker));
  const failed = workers.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  endRenderStage(true);`);
  replace('/* ---------- 编码 ---------- */', "await closeRenderBrowser();\n\n/* ---------- 编码 ---------- */\nbeginRenderStage('encode');");
  replace('const partialRun = FROM > 0 || TO < total;', 'const partialRun = partial;');
  replace('const overlaps = !(b <= FROM || a >= TO);', 'const overlaps = frameIntervals.some(([from, to]) => b > from && a < to);');
  replace('  const listPath =', "  endRenderStage(true);\n  beginRenderStage('concat');\n  const listPath =");
  replace('\nawait closeRenderBrowser();\nconst size', '\nendRenderStage(true);\nconst size');
  next += '\n} finally {\n  endRenderStage(false);\n  await closeRenderBrowser();\n}\n';
  return next;
}
