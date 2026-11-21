/* One browser/layout policy for inspection AND production. No cross-frame
 * rectangle union: objects visible at different times must not collide. */
import { measureLayout } from './layout-measured.mjs';
export { textOverlaps } from './layout-geometry.mjs';

export async function analyze(project, opt = {}) {
  try { return await measureLayout(project, opt); }
  catch (e) { return { ok: false, findings: [{ kind: 'env', msg: '检查执行失败：' + e.message }], sampled: 0, note: '真实盒子体检未完成，不能当作通过' }; }
}

export function report(res) {
  if (!res.sampled && res.note) return res.note;
  const lines = ['真实盒子体检（共享生成/改稿/出片判据）', '',
    `画布 ${res.geo?.W}×${res.geo?.H}　字幕/正文安全底线 ${Math.round(res.geo?.subTop || 0)}px`, ''];
  if (res.ok) lines.push('✓ 没有元素压字幕、没有越界、没有文字重叠或组件碰撞');
  else for (const f of res.findings || []) lines.push(`✗ 第 ${f.scene || '?'} 场 ${f.t?.toFixed(2) || '?'}s ${f.msg}`);
  lines.push('', `采样 ${res.sampled || 0} 帧；这些是观众会直接看到的问题，未发现不等于审美或整段运动已通过。`);
  return lines.join('\n');
}
