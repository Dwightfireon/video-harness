import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settleTimes, runVisualFastGuard, report } from '../lib/visual-fast-guard.mjs';

test('settleTimes：每场只取 1 个停稳点，长场取 end-0.8s，短场取中点', () => {
  const times = settleTimes([[0, 10], [10, 11], [11, 20.5]]);
  assert.equal(times.length, 3);
  assert.deepEqual(times[0], { scene: 1, t: 9.2 });
  assert.deepEqual(times[1], { scene: 2, t: 10.5 });
  assert.deepEqual(times[2], { scene: 3, t: 19.7 });
});

test('runVisualFastGuard：缺 scene.html 时安全返回失败而不抛异常', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-fast-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const res = await runVisualFastGuard(dir);
  assert.equal(res.ok, false);
  assert.equal(res.sampled, 0);
  assert.match(report(res), /scene\.html/);
});
