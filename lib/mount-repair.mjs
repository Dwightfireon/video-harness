/* 「元素建了但没挂到画面上」的机械修复。
 *
 * 为什么由执行器做，而不是让模型改：
 * 这类缺陷没有内容判断成分 —— 元素已经建好、坐标已经算好，唯一缺的是一行
 * root.appendChild(x)。把它交给模型，就变成在 1400 行里逐处精确补丁；
 * 真实事故里模型读了 96 轮、写 0 处，任务被反复暂停。执行器能做、能验证、
 * 能备份，就不该消耗模型额度。
 *
 * 边界：
 *   - 只补「最外层」元素（父容器补好后，子元素不再单独补，避免把子元素从
 *     容器里拽出来变成错位叠字）
 *   - .map()/.flatMap() 的结果不是 Node，一律不动（留给内容判断）
 *   - 每一场都必须通过完整的 validateSceneSource 才写入；失败就跳过，不硬改
 *   - 走 replace_scene 的原子写入与备份，编辑历史可追溯
 */
import fs from 'node:fs';
import path from 'node:path';
import { planMountFixes, unmountedElements } from './scene-mount.mjs';
import { readScene, replaceScene, validateSceneSource } from './author-edits.mjs';

const sceneChunks = text => text.split(/^\/\/---\s*$/m);

/** 只读预演：哪些场可以机械修好，哪些必须人/模型决定。 */
export function mountRepairPlan(project) {
  let source;
  try { source = fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'); } catch { return { scenes: [], actionable: 0 }; }
  const scenes = [];
  for (const [index, chunk] of sceneChunks(source).entries()) {
    if (!chunk.trim()) continue;
    const missing = unmountedElements(chunk);
    if (!missing.length) continue;
    const fixed = planMountFixes(chunk).text;
    const remaining = unmountedElements(fixed);
    let valid = true;
    try { validateSceneSource(fixed); } catch { valid = false; }
    scenes.push({ scene: index + 1, missing: missing.map(item => item.name), remaining: remaining.map(item => item.name),
      addable: missing.length - remaining.length, ready: valid && !remaining.length });
  }
  return { scenes, actionable: scenes.filter(item => item.ready).length };
}

/** 直接执行可机械修好的部分；返回实际改了什么，供日志与复检使用。 */
export function repairUnmountedScenes(project, { log = () => {} } = {}) {
  const plan = mountRepairPlan(project);
  if (!plan.scenes.length) return { changed: false, repaired: [], skipped: [], plan };
  const repaired = [], skipped = [];
  for (const item of plan.scenes) {
    if (!item.ready) { skipped.push(item); continue; }
    // 每场单独取当前 base_hash：上一场写入后整文件指纹会变。
    const current = readScene(project, item.scene);
    const fixed = planMountFixes(current.content).text;
    try {
      validateSceneSource(fixed);
      replaceScene(project, item.scene, { base_hash: current.base_hash, content: fixed });
      repaired.push({ scene: item.scene, count: item.addable });
      log(`  ✓ S${item.scene}：补上 ${item.addable} 处元素挂载（原文已备份）`);
    } catch (error) {
      skipped.push({ ...item, error: error.message });
      log(`  ⚠ S${item.scene}：机械修复未通过校验，交给内容判断：${error.message}`);
    }
  }
  return { changed: repaired.length > 0, repaired, skipped, plan };
}

/** 失败原因是否属于「元素没挂到画面上」这一类，决定要不要先机械修复。 */
export function looksLikeMountFailure(reason = '') {
  const text = String(reason);
  return /创建了但没\s*append|没挂到画面|unmounted|UNMOUNTED_ELEMENTS|empty-scene|采样未观测到文字或主体/.test(text);
}
