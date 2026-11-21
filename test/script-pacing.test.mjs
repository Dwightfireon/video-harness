import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeScriptPacing, report } from '../lib/script-pacing.mjs';

function makeProject(t, script, timing = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-script-pacing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '脚本.md'), script, 'utf8');
  if (timing) fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify(timing), 'utf8');
  return dir;
}

test('analyzeScriptPacing：正常短场短句无风险提示', t => {
  const dir = makeProject(t, `# 示例\n\n## S1 · 开场\n1. 先看一个具体问题。\n2. 为什么每步都对，连起来却会崩。\n\n## S2 · 展开\n1. 拆开看每一步的依赖。\n2. 前一步出错就会传到后面。\n`);
  const res = analyzeScriptPacing(dir);
  assert.equal(res.ok, true);
  assert.equal(res.sceneCount, 2);
  assert.equal(res.findings.length, 0);
  assert.match(report(res), /未发现超长单场/);
});

test('analyzeScriptPacing：准确标出开场超长句、超长单场与过长句级锚点', t => {
  const longLine = '这是一个故意写得很长很长用来测试开场听觉负担和句级字幕锚点错位风险的超长口播句子而且中间完全没有拆句。';
  const dir = makeProject(t, `# 示例\n\n## S1 · 开场\n1. ${longLine}\n\n## S2 · 超长场\n1. ${longLine}\n2. 短句补充。\n`, {
    measurement: { speed: 1.25 },
    scenes: [[0, 12], [12, 68]],
  });
  const res = analyzeScriptPacing(dir);
  assert.equal(res.ok, false);
  assert.equal(res.measured, true);
  assert.ok(res.findings.some(f => f.kind === 'opening-long-line' && f.scene === 1));
  assert.ok(res.findings.some(f => f.kind === 'long-scene' && f.scene === 2));
  assert.ok(res.findings.some(f => f.kind === 'long-cue-line' && f.scene === 2));
  assert.match(report(res), /实测/);
});
