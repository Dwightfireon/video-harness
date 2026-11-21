import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, extractNumbers, report } from '../lib/claims.mjs';

function fixture(t, script, claims) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-claim-numbers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '脚本.md'), script);
  fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify(claims));
  return dir;
}
const claim = (assertion, quote = '来源原文') => ({ id: 'C1', assertion, kind: '官方', scope: '测试', url: 'https://example.com',
  evidence: [{ quote, type: '原文', checkedAt: '2026-10-28' }] });

test('年份形状的数量仍需登记，裸年份和坐标不当作数量', () => {
  const script = '## S1 · 示例\n1. 2026 年，约 2049 个、1900 次、2099 秒，2050% 和 2000 个百分点。\n2. 坐标 140, 300, 1600。';
  const numbers = extractNumbers(script);
  assert.deepEqual(numbers.map(n => n.value), ['2049', '1900', '2099', '2050', '2000']);
  assert.match(numbers[4].raw, /个百分点/);
});

test('半角逗号可分隔不同数量，但不把格式错误数字的尾部当成数量', () => {
  const values = extractNumbers('## S1\n1. 有3个,4个，另有12,34个，逗号分组为2,049个。').map(n => n.value);
  assert.deepEqual(values, ['3', '4', '2,049']);
});

test('完整数字边界与小数：3 不会被 300 或 3.5 冒充，证据摘录不能代替登记', t => {
  const script = '## S1\n1. 实测 3 秒。';
  for (const c of [claim('约 300 秒'), claim('约 3.5 秒'), claim('未登记具体数量', '原文说 3 秒')]) {
    const result = analyze(fixture(t, script, [c]));
    assert.ok(result.findings.some(f => f.kind === 'unclaimed'), JSON.stringify(result));
  }
});

test('同一数量的千位分隔与小数零可对账；过期数量仍报出', t => {
  const dir = fixture(t, '## S1\n1. 共 2,049 个，耗时 3.0 秒。', [claim('共 2049 个，耗时 3 秒，另有 1900 项')]);
  const result = analyze(dir);
  assert.deepEqual(result.numbers.map(n => n.value), ['2,049', '3.0']);
  assert.equal(result.findings.some(f => f.kind === 'unclaimed'), false);
  assert.ok(result.findings.some(f => f.kind === 'stale-claim' && /1900/.test(f.msg)));
  assert.match(report(result), /不证明事实为真/);
});

test('证据对账中带单位的 20xx 不因类似年份而被忽略', t => {
  const dir = fixture(t, '## S1\n1. 一组 2049 个和 2000 个。', [claim('一组 2049 个和 2000 个', '原文提供 41 和 42')]);
  assert.ok(analyze(dir).findings.some(f => f.kind === 'unsupported-number'));
});
