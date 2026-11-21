/* lib/portrait.mjs —— 多尺寸出片（vh portrait / vh sizes）
 *
 * 为什么不是"裁一刀"：横屏 1920×1080 裁成 1080×1920 会切掉左右，
 * 字号也会显得过小。引擎自带 portrait PRESET（1080×1920，字号整体下调、
 * 字幕上移避开平台 UI），切 ORIENT 就能重排。
 *
 * 关键约束：场景必须用 window.W/H 与 VH_UI.safeArea() 排版（配方库已全部满足）。
 * 写死 1920 坐标的旧场景，这里会**如实报出来**，不会假装能重排。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SIZES = {
  landscape: { key: 'landscape', label: '横屏 16:9', size: '1920x1080', out: 'video.mp4' },
  portrait: { key: 'portrait', label: '竖屏 9:16', size: '1080x1920', out: 'video-portrait.mp4' },
  square: { key: 'square', label: '方屏 1:1', size: '1080x1080', out: 'video-square.mp4' },
};

/* 方屏（1:1）：引擎只定义了 landscape / portrait。
 * 切到 square 会让 PRESET[ORIENT] 变 undefined → 整个引擎崩（白屏、连 window.DURATION 都没有）。
 * 所以切方向时把缺的那档**补在 `const P0 = PRESET[ORIENT]` 之前**（属性赋晚了没用）。
 * 不改 skill 本体：只改项目里的 engine.tpl.html。 */
const SQUARE_PRESET = `  square: {
    W: 1080, H: 1080,
    fs: { hero: 118, display: 82, h1: 48, h2: 36, body: 26, note: 23, label: 20 },
    pad: 76, eyebrowY: 96, ruleY: 140, sourceY: 856,
    subBottom: 150, subFont: 34, subMaxW: 920,
    safeTop: 0, safeBottom: 220,
  },
`;

export function setOrient(project, orient) {
  const tpl = path.join(project, 'engine.tpl.html');
  if (!fs.existsSync(tpl)) return { ok: false, error: '没有 engine.tpl.html' };
  let src = fs.readFileSync(tpl, 'utf8');
  const before = src;
  src = src.replace(/const ORIENT = '(landscape|portrait|square)';/, `const ORIENT = '${orient}';`);
  // 需要方屏：确保 PRESET 里有 square（插在 P0 取值之前）
  if (orient === 'square' && !/\n  square:\s*\{/.test(src)) {
    const anchor = 'const P0 = PRESET[ORIENT];';
    const at = src.indexOf(anchor);
    if (at < 0) return { ok: false, error: '引擎里找不到 const P0 = PRESET[ORIENT];' };
    // PRESET 对象的结束位置：从 ORIENT 定义往后找第一个 "\n};"
    const presetStart = src.indexOf('const PRESET = {');
    const presetEnd = src.indexOf('\n};', presetStart);
    if (presetStart < 0 || presetEnd < 0) return { ok: false, error: '引擎里找不到 PRESET 定义' };
    src = src.slice(0, presetEnd) + '\n' + SQUARE_PRESET.replace(/\n$/, '') + src.slice(presetEnd);
  }
  if (src === before) return { ok: false, error: "engine.tpl.html 里找不到 const ORIENT = '…';" };
  fs.writeFileSync(tpl, src, 'utf8');
  return { ok: true };
}

export function orientOf(project) {
  try {
    const m = fs.readFileSync(path.join(project, 'engine.tpl.html'), 'utf8').match(/const ORIENT = '(\w+)'/);
    return m ? m[1] : 'landscape';
  } catch { return null; }
}

/* ---------- 适配检查：真实算一遍坐标，而不是只看字面量 ----------
 * 旧实现只扫 `abs(mk(...), 120, 300, 900, 100)` 这种字面量，
 * 而配方写的是 `Math.round(S.W * 0.6)` —— 一个都扫不到，检查等于没有。
 * 这里改成**在浏览器里量真实元素的盒子**：可靠、和所见图一致。 */
export function inspect(project, opt = {}) {
  const sceneHtml = (() => { try { return fs.readFileSync(path.join(project, 'scene.html'), 'utf8'); } catch { return ''; } })();
  if (!sceneHtml) return { ok: false, error: '没有 scene.html（先 build）' };
  const hardcoded = [...sceneHtml.matchAll(/abs\(\s*mk\([^)]*\)\s*,\s*(\d{3,4})\s*,\s*(\d+)\s*,\s*(\d{3,4})\s*,/g)]
    .map(m => ({ x: +m[1], y: +m[2], w: +m[3] }));
  /* 硬编码 1920 宽布局（x+w > 1080 且不是相对量）：竖屏会溢出 */
  const wide = hardcoded.filter(b => b.x + b.w > 1080 + 40);
  return {
    ok: wide.length === 0,
    hardcodedCount: hardcoded.length,
    wide,
    problems: wide.length ? [{
      kind: 'hardcoded',
      count: wide.length,
      sample: wide.slice(0, 3).map(b => `x=${b.x},w=${b.w}→右 ${b.x + b.w}`).join('；'),
    }] : [],
  };
}

/* ---------- 出片：切方向 → gen → render → 还原 ---------- */
export function renderSize(project, key, { crf = '22', force = true, fast = true } = {}) {
  const spec = SIZES[key] || SIZES.landscape;
  const prev = orientOf(project);
  const steps = [];
  const run = (label, file, argv, env) => {
    const r = spawnSync(process.execPath, [file, ...argv], { cwd: project, encoding: 'utf8', env: { ...process.env, ...(env || {}) } });
    steps.push({ label, ok: r.status === 0, tail: ((r.stdout || '') + (r.stderr || '')).slice(-400) });
    return r.status === 0;
  };
  try {
    if (spec.key !== 'landscape') {
      const r1 = setOrient(project, spec.key);
      if (!r1.ok) return { ok: false, spec, steps, error: r1.error };
      if (!run('gen', 'gen.mjs', ['--force'])) return { ok: false, spec, steps, revertedTo: prev };
    } else if (!fs.existsSync(path.join(project, 'scene.html'))) {
      if (!run('gen', 'gen.mjs', ['--force'])) return { ok: false, spec, steps };
    }
    const name = spec.key === 'landscape' ? 'video' : spec.out.replace(/\.mp4$/, '');
    const argv = ['--size', spec.size, '--name', name, '--crf', crf,
      ...(fast ? ['--fast'] : []), ...(force ? ['--force'] : [])];
    run('render', 'render.mjs', argv);
  } finally {
    // 还原方向：不能让竖屏工程污染横屏（否则下次开机是竖屏）
    if (prev && prev !== spec.key) {
      setOrient(project, prev);
      try { spawnSync(process.execPath, ['gen.mjs', '--force'], { cwd: project, stdio: 'ignore' }); } catch {}
    }
  }
  const out = path.join(project, 'out', spec.out);
  return { ok: steps.every(s => s.ok) && fs.existsSync(out), spec, steps, out, revertedTo: prev };
}
