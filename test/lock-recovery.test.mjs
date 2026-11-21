/* 真实事故：强杀执行器后，元数据门（.transaction）留在锁目录里，
 * 进程早已全部退出，但项目永久报 "metadata-transaction" ——
 * 继续、取消、删除、改幅全部被挡住，用户再也无法继续这个项目。
 *
 * 修复原则是"可证明的遗弃才清理"：门必须为空、确实老于事务上限、
 * 且所有登记进程都已退出。任一条件不满足就继续阻断，绝不猜测。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireProductionLock, readProductionLock, PRODUCTION_LOCK_DIRECTORY } from '../lib/production-lock.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-lock-recover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  return dir;
}
const lockDir = project => path.join(project, PRODUCTION_LOCK_DIRECTORY);
const gate = project => path.join(lockDir(project), '.transaction');
function ageGate(project, ms) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(gate(project), when, when);
}

test('进程全退出后，空的遗弃元数据门会被恢复，项目重新可用', t => {
  const project = fixture(t);
  const lock = acquireProductionLock(project, { command: 'ask', env: {} });
  lock.release();
  // 模拟强杀：留下一个空门，并且老于事务上限
  fs.mkdirSync(gate(project), { mode: 0o700 });
  ageGate(project, 120000);
  const status = readProductionLock(project);
  assert.equal(status.busy, false, '遗弃门应被恢复：' + JSON.stringify(status));
  assert.notEqual(status.reason, 'metadata-transaction', '不应再报事务中');
  assert.equal(fs.existsSync(gate(project)), false, '恢复后门必须已清除');
});

test('仍活着的登记进程在场时，绝不清理门', t => {
  const project = fixture(t);
  const lock = acquireProductionLock(project, { command: 'ask', env: {} });
  t.after(() => { try { lock.release(); } catch {} });
  fs.mkdirSync(gate(project), { mode: 0o700 });
  ageGate(project, 120000);
  const status = readProductionLock(project);
  assert.equal(status.busy, true, 'owner 仍在运行时不能删门：' + JSON.stringify(status));
  assert.equal(fs.existsSync(gate(project)), true);
});

test('门内还留有半截事务文件时，绝不清理门', t => {
  const project = fixture(t);
  const lock = acquireProductionLock(project, { command: 'ask', env: {} });
  lock.release();
  fs.mkdirSync(gate(project), { mode: 0o700 });
  fs.writeFileSync(path.join(gate(project), 'owner-abc.tmp'), 'half-written');
  ageGate(project, 120000);
  assert.equal(readProductionLock(project).busy, true, '有半截文件说明事务可能仍在进行');
  assert.equal(fs.existsSync(gate(project)), true);
});

test('新近的门（仍在正常临界期内）不清理', t => {
  const project = fixture(t);
  const lock = acquireProductionLock(project, { command: 'ask', env: {} });
  lock.release();
  fs.mkdirSync(gate(project), { mode: 0o700 });
  // 刚创建，未超过事务上限
  assert.equal(readProductionLock(project).busy, true);
  assert.equal(fs.existsSync(gate(project)), true);
});
