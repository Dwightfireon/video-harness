import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, report } from '../lib/motion.mjs';
import { maskJS } from '../lib/js-mask.mjs';

function check(src, dur = 16) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-motion-scan-'));
  try {
    fs.writeFileSync(path.join(dir, 'scenes.src.js'), src);
    fs.writeFileSync(path.join(dir, 'scene.html'), `addScene(0,${dur},root=>{});`);
    return scan(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('motion：t 和 rt 均识别，小数/负数校验，不把场外起点凑数', () => {
  const result = check('root=>{enter(a,t,.5); pop(b,rt,8); P(t,100,1); reveal(c,t,-2); P(t,4+offset,1);}');
  assert.deepEqual(result.scenes[0].beats, [.5, 8]);
  assert.deepEqual(result.scenes[0].outside, [100, -2]);
  assert.ok(result.scenes[0].gaps.every(gap => gap >= 0)); assert.equal(result.ok, false);
});
test('motion：注释、字符串、正则示例不能冒充已执行动画', () => {
  const result = check('root=>{ /* enter(a,t,4); pop(b,t,8); */ const s="P(t,12,1)"; const re=/reveal(c,t,14)/; // P(t,15,1)\n}');
  assert.equal(result.scenes[0].beatCount, 0); assert.deepEqual(result.scenes[0].types, []);
  const masked = maskJS('const x="hi";\n//xxx\nP(t, 4, 1)');
  assert.equal(masked.length, 'const x="hi";\n//xxx\nP(t, 4, 1)'.length);
  assert.match(masked, /P\(t, 4, 1\)/);
});
test('motion：动画扎堆不能仅凭次数合格；报告不声称最长静止或审片通过', () => {
  const result = check('root=>{enter(a,t,.1);pop(b,t,.2);reveal(c,t,.3);}');
  assert.equal(result.scenes[0].beatCount, 3); assert.equal(result.scenes[0].maxGap, 15.7);
  assert.ok(result.findings.some(f => f.kind === 'clustered')); assert.equal(result.ok, false);
  const text = report(result); assert.match(text, /不等于可见变化/); assert.doesNotMatch(text, /节奏合格|最长静止/);
});
test('motion：没有文件不能报告通过', () => {
  const result = scan(path.join(os.tmpdir(), 'vh-motion-nonexistent-file'));
  assert.equal(result.ok, false); assert.match(report(result), /无法检查/);
});
test('motion：字幕编排不可静态展开时标为未解析，不误报零动作/整场静止', () => {
  const result = check('root=>{const plan=F.compileMotion(config); return {render(t){apply(plan.sample(t));}}}');
  assert.equal(result.scenes[0].coverage, 'compiled-unresolved');
  assert.ok(result.findings.some(f => f.kind === 'runtime-plan'));
  assert.ok(!result.findings.some(f => ['sparse', 'monotone-motion', 'clustered'].includes(f.kind)));
  assert.match(report(result), /未解析/);
});
