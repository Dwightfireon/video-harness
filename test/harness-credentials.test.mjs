import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { credentialsPath, readHarnessCredentials, saveOpenDesignKey } from '../lib/harness-credentials.mjs';
import { buildCandidates, pickProvider } from '../lib/agent.mjs';
import { saveState } from '../lib/state.mjs';
import { startServer } from '../lib/server.mjs';

test('凭证写入独立 HOME 私有文件，更新后仍为 600，不进入项目文件', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-credentials-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const target = saveOpenDesignKey('fixture-key-one', home);
  assert.equal(target, credentialsPath(home));
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700);
  fs.chmodSync(target, 0o644);
  saveOpenDesignKey(' fixture-key-two\n', home);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(readHarnessCredentials(home).opendesignKey, 'fixture-key-two');
  assert.throws(() => saveOpenDesignKey('contains whitespace', home), /含空白/);
});

test('候选渠道读取私有凭证，不被旧项目渠道缓存盖过明确的 OpenDesign 首选', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-preferred-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  // settings 显式注入：不能读本机真实设置，否则结果随使用者环境变化。
  const noSettings = { preferredProvider: null, models: {}, bases: {}, keys: {} };
  const configured = buildCandidates({ providers: [{ name: 'commandcode', base: 'http://fixture.invalid' }],
    config: {}, credentials: { opendesignKey: 'fixture-od' }, auth: { commandcode: { key: 'fixture-cc' } }, env: {}, settings: noSettings });
  assert.equal(configured[0].name, 'opendesign');
  assert.equal(configured[0].model, 'deepseek-v4.1-flash');
  saveState(project, { agent: { provider: 'commandcode' } });
  assert.equal((await pickProvider(project, configured, { preferredProvider: 'opendesign' }, noSettings)).name, 'opendesign');
  assert.equal((await pickProvider(project, configured, {}, noSettings)).name, 'opendesign');
});

test('工作台不静态提供配置文件，前端资源路径不能越界读取文件', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-private-serving-'));
  fs.writeFileSync(path.join(root, 'vh.config.json'), '{"opendesignKey":"fixture-never-serve"}');
  const server = startServer(root, 0, { root }); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(url + '/vh.config.json')).status, 403);
  assert.equal((await fetch(url + '/_vh/..%2fpackage.json')).status, 403);
  assert.equal((await fetch(url + '/_vh/panel.js')).status, 200);
});
