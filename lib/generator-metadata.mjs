/* 旧标准生成器把所有作者注释堆到 addScene 前，长注释会挤走布局标签。
 * 只清理由当前作者块精确匹配出的注释前缀，不猜测/改写场景执行代码。 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { injectFrameRuntime } from './frame-runtime.mjs';
import { readTransitionTags } from './transition.mjs';
import { injectLayoutRuntime } from './layout-runtime.mjs';

/* A versioned, read-only observation at the generator boundary. Markers are
 * code clues, not proof that the page was executed or that a custom equivalent
 * is absent. Never use this observation to grant rendering/review approval.
 * Only standalone lines count: a marker quoted inside an author description,
 * string or inline example is not an installed capability. */
export function inspectGeneratedCapabilities(html) {
  if (typeof html !== 'string' || !html) return { version: 1, state: 'unavailable', adapter: 'unknown', markers: {},
    missing: ['场景时间边界', '素材帧屏障', '转场表', '布局辅助'], note: '没有生成画面；未核验生成器能力。' };
  const lines = html.split(/\r?\n/), hasLine = pattern => lines.some(line => pattern.test(line));
  const legacy = hasLine(/^\s*function addScene\(start, end, build, fade\)\{/) && hasLine(/^\s*const scenes = \[\];/);
  const markers = {
    sceneBounds: hasLine(/^\s*root\.setAttribute\("data-vh-scene-start", String\(start\)\);\s*$/) &&
      hasLine(/^\s*root\.setAttribute\("data-vh-scene-end", String\(end\)\);\s*$/),
    frameBarrier: hasLine(/^\s*\/\* vh:frame-runtime \*\/\s*$/) && hasLine(/^\s*\/\* vh:frame-runtime-end \*\/\s*$/),
    transitionTable: hasLine(/^\s*window\.__vhTrans\s*=\s*\[[^;]*\];\s*\/\* vh:trans-table \*\/\s*$/),
    layoutHelper: hasLine(/^\s*\/\* vh:layout-runtime \*\/\s*$/) && hasLine(/^\s*\/\* vh:layout-runtime-end \*\/\s*$/),
  };
  const labels = { sceneBounds: '场景时间边界', frameBarrier: '素材帧屏障', transitionTable: '转场表', layoutHelper: '布局辅助' };
  return { version: 1, state: 'unverified', adapter: legacy ? 'legacy-compatible-pattern' : 'custom-or-unknown', markers,
    missing: Object.keys(markers).filter(key => !markers[key]).map(key => labels[key]),
    note: '仅静态标记线索，不代表运行验证；自定义生成器可能以其他方式实现，不据此改写或放行。' };
}

export function generatedCapabilities(project) {
  try { return inspectGeneratedCapabilities(fs.readFileSync(path.join(project, 'scene.html'), 'utf8')); }
  catch { return inspectGeneratedCapabilities(''); }
}

export function generatorCapabilityWarning(project) {
  const result = generatedCapabilities(project);
  return result.missing.length ? `生成器接口未能识别：${result.missing.join('、')}；${result.note}` : '';
}

export function normalizeGeneratedMetadata(project) {
  const source = path.join(project, 'scenes.src.js'), target = path.join(project, 'scene.html');
  if (!fs.existsSync(source) || !fs.existsSync(target)) return false;
  const before = fs.readFileSync(target, 'utf8'); let next = before;
  let cursor = next.indexOf('const scenes = [];');
  if (cursor < 0) return false;
  for (const chunk of fs.readFileSync(source, 'utf8').split(/^\/\/---\s*$/m).map(s => s.trim()).filter(Boolean)) {
    const comments = chunk.split('\n').filter(line => /^\s*\/\//.test(line));
    if (!comments.length) continue; // 空前缀不是作者注释，不能删掉调用前必要的换行。
    const tags = comments.filter(line => /^\s*\/\/\s*@/.test(line));
    const oldPrefix = comments.join('\n') + '\naddScene(';
    const at = next.indexOf(oldPrefix, cursor);
    if (at < 0) continue; // 定制生成器不匹配已知前缀，保留原输出，不强行修源码。
    const prefix = (tags.length ? tags.join('\n') + '\n' : '') + 'addScene(';
    next = next.slice(0, at) + prefix + next.slice(at + oldPrefix.length);
    cursor = at + prefix.length;
  }
  // 仅匹配标准生成器的已知入口，在 builder 执行前提供当前边界。
  // 不重写 scenes.src.js，不让作者在每次配音重测后手抄全局起点。
  const entry = '  stage.appendChild(root);\n  const api = build(root) || {};';
  if (next.includes('function addScene(start, end, build, fade){') && next.split(entry).length === 2) {
    next = next.replace(entry, '  stage.appendChild(root);\n' +
      '  root.setAttribute("data-vh-scene-start", String(start));\n' +
      '  root.setAttribute("data-vh-scene-end", String(end));\n' +
      '  const api = build(root) || {};');
  }
  // build、measure 和改幅重建共用同一出口，不能重测一次就丢掉转场/素材屏障。
  if (/^\/\* vh:sdf-v1 \*\/$/m.test(next) && !next.includes('/* vh:sdf-frame */')) {
    const at = next.lastIndexOf('window.renderAt(0);');
    if (at < 0) throw new Error('SDF 项目缺少标准 renderAt 首帧入口');
    next = next.slice(0, at) + 'window.renderAt = window.VH_SDF.wrap(window.renderAt); /* vh:sdf-frame */\n' + next.slice(at);
  }
  if (next.includes('window.renderAt(0);')) next = injectFrameRuntime(next);
  if (next.includes('window.renderAt(0);')) next = injectLayoutRuntime(next);
  const table = JSON.stringify(readTransitionTags(project).map(t => ({ k: t.kind || 'fade', d: t.dur })));
  const line = `window.__vhTrans = ${table};  /* vh:trans-table */`;
  if (next.includes('/* vh:trans-table */')) {
    next = next.replace(/window\.__vhTrans = [^;]+;\s*\/\* vh:trans-table \*\//, line);
  } else if (next.includes('window.DURATION = DURATION;')) {
    next = next.replace('window.DURATION = DURATION;', 'window.DURATION = DURATION;\n' + line);
  }
  if (next === before) return false;
  const temp = target + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, next, { flag: 'wx' }); fs.renameSync(temp, target); }
  finally { try { fs.unlinkSync(temp); } catch {} }
  return true;
}
