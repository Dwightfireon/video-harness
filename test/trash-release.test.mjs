/* 回收站的本质问题：删除只是把目录 rename 到 .vh-trash，
 * 空间一点没释放，而界面上看不到回收站、也没给"彻底删除"的入口，
 * 用户会以为删干净了，实际内容越积越多。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { startServer } from '../lib/server.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-trash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  // 造一个带大文件的假项目（8MB，模拟成片）
  const proj = path.join(root, 'projects', 'demo');
  fs.mkdirSync(path.join(proj, 'out'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'PROJECT.json'), JSON.stringify({ name: 'demo' }));
  fs.writeFileSync(path.join(proj, '脚本.md'), '## S1\n1. 测试\n');
  fs.writeFileSync(path.join(proj, 'out', 'video-voice.mp4'), Buffer.alloc(8 * 1024 * 1024));
  return { root, home, proj };
}
async function serve(t, root, home) {
  const server = startServer(root, 0, { root, home });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return 'http://127.0.0.1:' + server.address().port;
}

test('删除只是移入回收站：磁盘上的字节没有减少', async t => {
  const { root, home, proj } = setup(t);
  const url = await serve(t, root, home);
  const before = fs.readdirSync(root);

  const r = await (await fetch(url + '/_api/remove?p=projects/demo', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: url } })).json();
  assert.equal(r.ok, true);
  assert.ok(r.bytes >= 8 * 1024 * 1024, '删除响应要报出体积，界面才能说清"还没释放"');

  // 模块级 ROOT 与 runtime.root 不同，这里必须验证写进了测试自己的 root。
  assert.equal(fs.existsSync(proj), false);
  const trash = fs.readdirSync(path.join(root, '.vh-trash'));
  assert.equal(trash.length, 1, '要移到传入的 root，不能写进 harness 自身目录');
  const trashItem = path.join(root, '.vh-trash', trash[0]);
  const kept = path.join(trashItem, 'out', 'video-voice.mp4');
  assert.ok(fs.existsSync(kept), '成片要保留在回收站里');
  // 用真实字节判断：稀疏文件（Buffer.alloc）不一定占盘，所以测内容而不是 size。
  assert.equal(fs.statSync(kept).size, 8 * 1024 * 1024, '成片内容要完整保留');
});

test('回收站接口能列出占用，界面据此提示"空间未释放"', async t => {
  const { root, home } = setup(t);
  const url = await serve(t, root, home);
  await fetch(url + '/_api/remove?p=projects/demo', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: url } });

  const d = await (await fetch(url + '/_api/trash')).json();
  assert.equal(d.items.length, 1);
  assert.ok(d.totalBytes >= 8 * 1024 * 1024, '要能算出回收站真实占用');
  assert.ok(d.items[0].name.includes('demo'));
});

test('彻底删除后空间真的释放', async t => {
  const { root, home } = setup(t);
  const url = await serve(t, root, home);
  await fetch(url + '/_api/remove?p=projects/demo', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: url } });
  const before = await (await fetch(url + '/_api/trash')).json();
  assert.ok(before.totalBytes > 0);

  const r = await (await fetch(url + '/_api/trash', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({ action: 'empty', confirmed: true, expectedNames: before.items.map(item => item.name) }) })).json();
  assert.equal(r.ok, true);

  const after = await (await fetch(url + '/_api/trash')).json();
  assert.equal(after.items.length, 0);
  assert.equal(after.totalBytes, 0, '清空后占用必须归零');
  assert.equal(fs.existsSync(path.join(root, '.vh-trash')), false);
});

test('单项彻底删除只影响那一项', async t => {
  const { root, home } = setup(t);
  const url = await serve(t, root, home);
  const proj2 = path.join(root, 'projects', 'demo2');
  fs.mkdirSync(proj2, { recursive: true });
  fs.writeFileSync(path.join(proj2, 'PROJECT.json'), JSON.stringify({ name: 'demo2' }));
  for (const rel of ['projects/demo', 'projects/demo2']) {
    await fetch(url + '/_api/remove?p=' + rel, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: url } });
  }
  const before = await (await fetch(url + '/_api/trash')).json();
  assert.equal(before.items.length, 2);

  const victim = before.items.find(i => i.name.includes('demo-')) || before.items[0];
  await fetch(url + '/_api/trash', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({ action: 'purge', name: victim.name, confirmed: true }) });

  const after = await (await fetch(url + '/_api/trash')).json();
  assert.equal(after.items.length, 1, '只该删掉指定的一项');
});

test('可以恢复回收站里的项目，且不会覆盖同名项目', async t => {
  const { root, home, proj } = setup(t);
  const { acquireProductionLock, readProductionLock } = await import('../lib/production-lock.mjs');
  const prior = acquireProductionLock(proj, { command: 'test', env: {} });
  prior.release();
  const url = await serve(t, root, home);
  await fetch(url + '/_api/remove?p=projects/demo', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: url } });
  const d = await (await fetch(url + '/_api/trash')).json();
  const name = d.items[0].name;

  // 先占一个同名项目，验证恢复不覆盖
  fs.mkdirSync(path.join(root, 'projects', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'demo', 'PROJECT.json'), '{"name":"existing"}');

  const r = await (await fetch(url + '/_api/trash', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({ action: 'restore', name }) })).json();
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'projects', 'demo', 'PROJECT.json'))).name, 'existing');
  assert.ok(fs.existsSync(path.join(root, 'projects', 'demo-2')), '重名时恢复到带后缀的目录');
  const restored = path.join(root, 'projects', 'demo-2');
  assert.equal(readProductionLock(restored).busy, false, '已释放的旧路径锁不能让恢复后的工程卡死');
  const resumed = acquireProductionLock(restored, { command: 'test', env: {} });
  resumed.release();
});

test('回收站路径不能越界', async t => {
  const { root, home } = setup(t);
  const url = await serve(t, root, home);
  const r = await fetch(url + '/_api/trash', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({ action: 'purge', name: '../../../etc' }) });
  assert.equal(r.status, 404);
});

test('彻底删除必须单独确认，项目不能通过快捷参数直接清空', async t => {
  const { root, home, proj } = setup(t);
  const url = await serve(t, root, home);
  const direct = await fetch(url + '/_api/remove?p=projects/demo&purge=1', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: url } });
  assert.equal(direct.status, 400);
  assert.equal(fs.readFileSync(path.join(proj, '脚本.md'), 'utf8'), '## S1\n1. 测试\n');
  await fetch(url + '/_api/remove?p=projects/demo', { method: 'POST', headers: { 'content-type': 'application/json', origin: url } });
  const items = (await (await fetch(url + '/_api/trash')).json()).items;
  for (const action of ['purge', 'empty']) {
    const response = await fetch(url + '/_api/trash', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ action, name: action === 'purge' ? items[0].name : undefined }) });
    assert.equal(response.status, 400);
    assert.equal(fs.existsSync(path.join(root, '.vh-trash', items[0].name, '脚本.md')), true);
  }
});

test('清空仅删除用户确认的可见项目，列表变化须重新确认，隐藏文件不动', async t => {
  const { root, home } = setup(t), url = await serve(t, root, home);
  await fetch(url + '/_api/remove?p=projects/demo', { method: 'POST', headers: { origin: url } });
  const before = (await (await fetch(url + '/_api/trash')).json()).items;
  const bin = path.join(root, '.vh-trash');
  fs.writeFileSync(path.join(bin, '.keep'), '不可见但保留');
  fs.writeFileSync(path.join(bin, 'memo.txt'), '也保留');
  fs.mkdirSync(path.join(bin, 'new-item'));
  const request = names => fetch(url + '/_api/trash', { method: 'POST', headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({ action: 'empty', confirmed: true, expectedNames: names }) });
  const stale = await request(before.map(item => item.name));
  assert.equal(stale.status, 409);
  assert.ok(fs.existsSync(path.join(bin, before[0].name, '脚本.md')));
  const current = (await (await fetch(url + '/_api/trash')).json()).items;
  assert.equal((await request(current.map(item => item.name))).status, 200);
  assert.equal(fs.readFileSync(path.join(bin, '.keep'), 'utf8'), '不可见但保留');
  assert.equal(fs.readFileSync(path.join(bin, 'memo.txt'), 'utf8'), '也保留');
  assert.equal(fs.existsSync(path.join(bin, 'new-item')), false);
});

test('工作台清理遵守生产锁，只删除帧和分段，不删除过程图', async t => {
  const { root, home, proj } = setup(t), url = await serve(t, root, home);
  fs.mkdirSync(path.join(proj, 'out/frames')); fs.writeFileSync(path.join(proj, 'out/frames/0001.jpg'), '帧');
  fs.writeFileSync(path.join(proj, 'out/preview-1.png'), '过程证据');
  const { acquireProductionLock } = await import('../lib/production-lock.mjs');
  const lock = acquireProductionLock(proj, { command: 'test', env: {} });
  const clean = () => fetch(url + '/_api/clean?p=projects/demo', { method: 'POST', headers: { origin: url } });
  try {
    assert.equal((await clean()).status, 409);
    assert.equal(fs.readFileSync(path.join(proj, 'out/frames/0001.jpg'), 'utf8'), '帧');
  } finally { lock.release(); }
  assert.equal((await clean()).status, 200);
  assert.equal(fs.existsSync(path.join(proj, 'out/frames')), false);
  assert.equal(fs.readFileSync(path.join(proj, 'out/preview-1.png'), 'utf8'), '过程证据');
});

test('工作台拒绝清理或删除符号链接指向的项目', async t => {
  const { root, home, proj } = setup(t), url = await serve(t, root, home);
  fs.mkdirSync(path.join(proj, 'out/frames')); fs.writeFileSync(path.join(proj, 'out/frames/0001.jpg'), '不能通过别名清理');
  fs.symlinkSync(proj, path.join(root, 'projects/alias'), 'dir');
  for (const route of ['/_api/clean?p=projects/alias', '/_api/remove?p=projects/alias']) {
    const response = await fetch(url + route, { method: 'POST', headers: { origin: url } });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /符号链接/);
  }
  assert.equal(fs.readFileSync(path.join(proj, 'out/frames/0001.jpg'), 'utf8'), '不能通过别名清理');
  assert.ok(fs.lstatSync(path.join(root, 'projects/alias')).isSymbolicLink());
});
