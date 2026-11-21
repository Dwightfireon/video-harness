import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import {
  readSettings, writeSettings, setSelection, setProviderKey, setProviderBase,
  listProviders, currentSelection, providerKey, providerHasKey, settingsPath, seedExisting,
} from '../lib/provider-settings.mjs';
import { buildCandidates, pickProvider } from '../lib/agent.mjs';
import { startServer } from '../lib/server.mjs';

const home = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-providers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('默认行为不变：没有设置文件时用 opendesign + deepseek-v4.1-flash', t => {
  const h = home(t);
  assert.equal(readSettings(h).preferredProvider, null);
  const selection = currentSelection(h);
  assert.equal(selection.provider, 'opendesign');
  assert.equal(selection.model, 'deepseek-v4.1-flash');
});

test('选渠道与模型会写进本机私有文件，权限 600', t => {
  const h = home(t);
  const providers = listProviders(h);
  const target = providers.find(p => p.name === 'commandcode');
  setSelection({ provider: 'commandcode', model: target.models[0] }, h);
  const file = settingsPath(h);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.preferredProvider, 'commandcode');
  assert.equal(saved.models.commandcode, target.models[0]);
  assert.equal(currentSelection(h).provider, 'commandcode');
  assert.equal(currentSelection(h).model, target.models[0]);
});

test('不能选不存在的渠道或不属于该渠道的模型', t => {
  const h = home(t);
  assert.throws(() => setSelection({ provider: 'not-a-provider' }, h), /未知渠道/);
  assert.throws(() => setSelection({ provider: 'opendesign', model: 'gpt/不存在' }, h), /没有这个模型/);
});

test('密钥写入本机私有文件，任何读取接口都不返回密钥本身', t => {
  const h = home(t);
  setProviderKey('opendesign', 'sk-fixture-secret-value', {}, h);
  assert.equal(providerKey('opendesign', h), 'sk-fixture-secret-value');
  assert.equal(providerHasKey('opendesign', h), true);
  const listed = listProviders(h);
  const item = listed.find(p => p.name === 'opendesign');
  assert.equal(item.hasKey, true);
  assert.equal(item.keySource, '本机设置页');
  const text = JSON.stringify(listed);
  assert.equal(text.includes('sk-fixture-secret-value'), false, '列表不得回显密钥');
  assert.equal(text.includes('secret'), false);
  // 文件在项目外，权限 600
  assert.equal(fs.statSync(settingsPath(h)).mode & 0o777, 0o600);
});

test('拒绝空密钥与含空白的密钥', t => {
  const h = home(t);
  assert.throws(() => setProviderKey('opendesign', '', {}, h), /密钥为空/);
  assert.throws(() => setProviderKey('opendesign', 'has space', {}, h), /含空白/);
});

test('可以删除某渠道在设置页保存的密钥', t => {
  const h = home(t);
  setProviderKey('opendesign', 'sk-temp', {}, h);
  assert.equal(providerHasKey('opendesign', h), true);
  setProviderKey('opendesign', '', { clear: true }, h);
  assert.equal(providerHasKey('opendesign', h), false);
});

test('自定义接口地址生效，且必须是完整 http(s) URL', t => {
  const h = home(t);
  setProviderBase('opendesign', 'https://example.invalid/v1', h);
  assert.equal(listProviders(h).find(p => p.name === 'opendesign').base, 'https://example.invalid/v1');
  assert.throws(() => setProviderBase('opendesign', 'not a url', h), /格式不对/);
  assert.throws(() => setProviderBase('opendesign', 'ftp://x.invalid', h), /只支持 http/);
  setProviderBase('opendesign', '', h);
});

test('预先保存：把现有渠道的默认模型固化进设置文件，密钥不复制', t => {
  const h = home(t);
  const dir = path.join(h, '.config', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencode.jsonc'), JSON.stringify({
    provider: { commandcode: { options: { baseURL: 'https://cc.invalid/v1' }, models: { 'a/b': {} } } },
  }));
  const settings = seedExisting(h);
  assert.equal(settings.preferredProvider, 'opendesign');
  // 默认别名不在该渠道清单里时，用它实际提供的第一个模型。
  assert.equal(settings.models.commandcode, 'a/b');
  assert.equal(Object.keys(settings.keys).length, 0, '密钥不复制到新文件');
});

test('agent 用设置页选的渠道与模型，而不是写死的固定值', t => {
  const h = home(t);
  const settings = { preferredProvider: 'commandcode', models: { commandcode: 'deepseek/x-flash' }, keys: {} };
  const candidates = buildCandidates({
    providers: [{ name: 'commandcode', base: 'https://cc.invalid/v1' }],
    config: {}, auth: { commandcode: { key: 'fixture-cc' } }, env: {}, settings,
  });
  assert.deepEqual(candidates.map(c => c.name), ['commandcode']);
  assert.equal(candidates[0].model, 'deepseek/x-flash', '用户选的模型要生效');
});

test('设置页配置的渠道可以带自己的 base 与 key 使用', t => {
  const h = home(t);
  const settings = { preferredProvider: 'local', models: { local: 'local/model' },
    bases: { local: 'http://localhost:1234/v1' }, keys: { local: 'fixture-local' } };
  const candidates = buildCandidates({
    providers: [{ name: 'local', base: 'http://localhost:1234/v1' }],
    config: {}, auth: {}, env: {}, settings,
  });
  assert.equal(candidates[0].name, 'local');
  assert.equal(candidates[0].base, 'http://localhost:1234/v1');
  assert.equal(candidates[0].model, 'local/model');
});

test('选中的渠道缺凭证时不会回退到别的渠道', t => {
  const candidates = buildCandidates({
    providers: [{ name: 'commandcode', base: 'https://cc.invalid/v1' }],
    config: {}, auth: { opendesign: { key: 'fixture-od' } }, env: {},
    settings: { preferredProvider: 'commandcode', models: {}, keys: {} },
  });
  assert.equal(candidates.length, 0, '缺凭证就该停下，不能悄悄换渠道');
});

test('pickProvider 尊重设置页的选择', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-pick-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = { preferredProvider: 'commandcode', models: { commandcode: 'deepseek/y' }, keys: {} };
  const candidates = buildCandidates({ providers: [{ name: 'commandcode', base: 'https://cc.invalid/v1' }],
    config: {}, auth: { commandcode: { key: 'fixture' } }, env: {}, settings });
  const picked = await pickProvider(dir, candidates, { preferredProvider: 'opendesign' }, settings);
  assert.equal(picked.name, 'commandcode');
  assert.equal(picked.model, 'deepseek/y');
});

test('HTTP 接口：可列出与切换，密钥永不回显', async t => {
  const h = home(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-prov-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = startServer(root, 0, { root, home: h });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = 'http://127.0.0.1:' + server.address().port;

  const list = await (await fetch(base + '/_api/providers')).json();
  assert.ok(Array.isArray(list.providers));
  assert.ok(list.providers.some(p => p.name === 'opendesign'));
  assert.equal(list.current.provider, 'opendesign');

  const saved = await (await fetch(base + '/_api/provider/key', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'opendesign', key: 'sk-http-fixture-secret' }) })).json();
  assert.equal(saved.ok, true);
  assert.equal(JSON.stringify(saved).includes('sk-http-fixture-secret'), false, '接口不得回显密钥');

  const selected = await (await fetch(base + '/_api/provider/select', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'commandcode' }) })).json();
  assert.equal(selected.current.provider, 'commandcode');

  const bad = await fetch(base + '/_api/provider/select', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'nope' }) });
  assert.equal(bad.status, 400);

  // 关键：接口只能写进注入的 home，不能污染运行者的真实配置。
  const realSettings = path.join(os.homedir(), '.config', 'video-harness', 'providers.json');
  const before = fs.existsSync(realSettings) ? fs.readFileSync(realSettings, 'utf8') : null;
  assert.equal(fs.existsSync(path.join(h, '.config', 'video-harness', 'providers.json')), true, '应写入注入的 home');
  if (before != null) assert.equal(fs.readFileSync(realSettings, 'utf8'), before, '真实配置不能被测试改动');
});

test('设置页 HTML 不存在时不影响其他页面', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-settings-page-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = startServer(root, 0, { root });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const res = await fetch(base + '/settings');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /模型设置/);
  assert.match(html, /_api\/providers/);
});
