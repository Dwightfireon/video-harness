/* 换 key 的三条硬要求：
 *   ① 页面保存的新 key 必须真的生效（曾出现：页面显示已保存，实际仍用旧 key）
 *   ② 换 key 后要能核对"换成的是哪一把"（指纹），不能只有一句"已保存"
 *   ③ 所有写入入口都落到同一处，不能一个写这里、一个写那里互相遮挡
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import {
  readSettings, setProviderKey, listProviders, providerKey, keySourceChain,
  keySourcesAudit, keyFingerprint, settingsPath,
} from '../lib/provider-settings.mjs';
import { buildCandidates, saveHarnessKey } from '../lib/agent.mjs';
import { startServer, writeOriginError } from '../lib/server.mjs';

const home = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/* 造一份"旧 key 已经在别处"的现场：harness 凭证文件里有一把旧 key。 */
function seedLegacyKey(h, key = 'sk-legacy-old') {
  const dir = path.join(h, '.config', 'video-harness');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ opendesignKey: key }), { mode: 0o600 });
}

test('回归：设置页保存的新 key 必须覆盖凭证文件里的旧 key', t => {
  const h = home(t);
  seedLegacyKey(h);
  const creds = { opendesignKey: 'sk-legacy-old' };

  // 换 key 之前：用的是凭证文件里的旧 key
  const before = buildCandidates({ providers: [], config: {}, auth: {}, env: {},
    credentials: creds, settings: readSettings(h) });
  assert.equal(before.find(c => c.name === 'opendesign')?.key, 'sk-legacy-old');

  // 页面保存新 key
  setProviderKey('opendesign', 'sk-brand-new', {}, h);

  // 换 key 之后：agent 必须拿到新的，而不是继续用旧的
  const after = buildCandidates({ providers: [], config: {}, auth: {}, env: {},
    credentials: creds, settings: readSettings(h) });
  const od = after.find(c => c.name === 'opendesign');
  assert.equal(od?.key, 'sk-brand-new', '页面填的 key 必须真的生效');
  assert.equal(providerKey('opendesign', h), 'sk-brand-new');
  assert.equal(keySourceChain('opendesign', {}, h).source, '本机设置页');
});

test('命令行写 key 与设置页写同一处，不会互相遮挡', t => {
  const h = home(t);
  seedLegacyKey(h);
  const saved = saveHarnessKey('sk-from-cli', h);
  // 命令行入口必须写进同一份设置文件：两处各写一个文件时，谁生效说不清。
  assert.equal(saved.target, settingsPath(h));
  assert.equal(providerKey('opendesign', h), 'sk-from-cli');
  assert.equal(keySourceChain('opendesign', {}, h).key, 'sk-from-cli');
  // 真实配置不能被测试改动
  assert.equal(fs.existsSync(path.join(h, '.config', 'video-harness', 'providers.json')), true);
});

test('换 key 后能核对指纹：变了、且不可逆', t => {
  const h = home(t);
  setProviderKey('opendesign', 'sk-first-key', {}, h);
  const first = listProviders(h).find(p => p.name === 'opendesign');
  assert.match(first.keyFingerprint, /^[0-9a-f]{8}$/);
  assert.ok(first.keyUpdatedAt, '要记录换 key 的时间');

  setProviderKey('opendesign', 'sk-second-key', {}, h);
  const second = listProviders(h).find(p => p.name === 'opendesign');
  assert.notEqual(second.keyFingerprint, first.keyFingerprint, '换 key 后指纹必须变化');
  assert.equal(second.keyFingerprint, keyFingerprint('sk-second-key'));

  // 指纹不能等于 key，也不能包含 key
  assert.notEqual(second.keyFingerprint, 'sk-second-key');
  assert.equal(JSON.stringify(second).includes('sk-second-key'), false, '列表不得回显密钥');
});

test('同一个 key 指纹稳定：可用来跨设备核对', t => {
  assert.equal(keyFingerprint('sk-same'), keyFingerprint(' sk-same \n'));
  assert.notEqual(keyFingerprint('sk-a'), keyFingerprint('sk-b'));
  assert.equal(keyFingerprint(''), null);
});

test('能看清"用的是哪一把、哪几把被压在下面"', t => {
  const h = home(t);
  const sources = keySourcesAudit('opendesign', {
    settings: { keys: { opendesign: 'sk-page' } },
    credentials: { opendesignKey: 'sk-file' },
    env: { OPEN_DESIGN_API_KEY: 'sk-env' },
    config: { opendesignKey: 'sk-config' },
    auth: {},
  }, h);
  assert.deepEqual(sources.map(s => s.source), ['本机设置页', '环境变量', 'harness 凭证文件', 'vh.config.json']);
  assert.equal(sources.filter(s => s.active).length, 1, '只有一个来源真正生效');
  assert.equal(sources[0].active, true);
  assert.equal(sources[0].keyFingerprint, keyFingerprint('sk-page'));
  assert.equal(JSON.stringify(sources).includes('sk-page'), false, '审计列表也不能回显密钥');
});

test('删除本页密钥后回落到下一来源，而不是变成"没有 key"', t => {
  const h = home(t);
  seedLegacyKey(h, 'sk-still-here');
  setProviderKey('opendesign', 'sk-page-only', {}, h);
  assert.equal(keySourceChain('opendesign', {}, h).source, '本机设置页');
  setProviderKey('opendesign', '', { clear: true }, h);
  const from = keySourceChain('opendesign', {}, h);
  assert.equal(from.key, 'sk-still-here');
  assert.equal(from.source, 'harness 凭证文件');
});

test('commandcode 也从同一条链取 key：页面能覆盖 opencode 里的旧凭证', t => {
  const h = home(t);
  const providers = [{ name: 'commandcode', base: 'https://cc.invalid/v1' }];
  const oldAuth = { commandcode: { key: 'sk-opencode-old' } };

  const before = buildCandidates({ providers, config: {}, auth: oldAuth, env: {},
    settings: { preferredProvider: 'commandcode', models: {}, bases: {}, keys: {} } });
  assert.equal(before[0].key, 'sk-opencode-old');

  const after = buildCandidates({ providers, config: {}, auth: oldAuth, env: {},
    settings: { preferredProvider: 'commandcode', models: {}, bases: {}, keys: { commandcode: 'sk-cc-new' } } });
  assert.equal(after[0].key, 'sk-cc-new', '页面填的 commandcode key 也要生效');
});

test('HTTP 换 key：立即生效，响应只给指纹不给 key', async t => {
  const h = home(t);
  seedLegacyKey(h);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-key-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = startServer(root, 0, { root, home: h });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = 'http://127.0.0.1:' + server.address().port;

  const res = await (await fetch(base + '/_api/provider/key', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'opendesign', key: 'sk-http-new' }) })).json();

  assert.equal(res.ok, true);
  assert.equal(res.saved.keySource, '本机设置页');
  assert.match(res.saved.keyFingerprint, /^[0-9a-f]{8}$/);
  assert.equal(JSON.stringify(res).includes('sk-http-new'), false, '响应不得回显密钥');

  const listed = res.providers.find(p => p.name === 'opendesign');
  assert.equal(listed.keyFingerprint, res.saved.keyFingerprint, '保存结果与列表指纹必须一致');
  assert.equal(providerKey('opendesign', h), 'sk-http-new', '保存后立即生效，无需重启');
});

test('空 key 不会静默清掉已有密钥', async t => {
  const h = home(t);
  setProviderKey('opendesign', 'sk-keep-me', {}, h);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-key-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = startServer(root, 0, { root, home: h });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = 'http://127.0.0.1:' + server.address().port;

  const res = await fetch(base + '/_api/provider/key', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'opendesign', key: '' }) });
  assert.equal(res.status, 400, '空 key 应报错而不是清空');
  assert.equal(providerKey('opendesign', h), 'sk-keep-me', '原密钥必须还在');
});

/* 安全边界：本机服务能被浏览器里的任意网页访问，
 * 只要不校验来源，攻击页就能改接口地址把 key 送到自己的服务器。 */
test('写操作拒绝跨站来源与外部 Host', () => {
  const ok = { headers: { host: '127.0.0.1:8144' } };
  assert.equal(writeOriginError(ok), null);
  assert.equal(writeOriginError({ headers: { host: '127.0.0.1:8144', origin: 'http://127.0.0.1:8144' } }), null);
  assert.equal(writeOriginError({ headers: { host: 'localhost:8144', origin: 'http://localhost:8144' } }), null);

  // 攻击页发起的请求
  assert.match(writeOriginError({ headers: { host: '127.0.0.1:8144', origin: 'https://evil.example' } }), /跨站/);
  assert.match(writeOriginError({ headers: { host: '127.0.0.1:8144', origin: 'null' } }), /来源无法识别/);
  // DNS rebinding：Host 被换成外部域名
  assert.match(writeOriginError({ headers: { host: 'evil.example:8144' } }), /只接受本机/);
});

test('跨站改接口地址被 403 拒绝，本机页面正常放行', async t => {
  const h = home(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-csrf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = startServer(root, 0, { root, home: h });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = 'http://127.0.0.1:' + server.address().port;

  const attack = await fetch(base + '/_api/provider/base', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ provider: 'opendesign', base: 'https://evil.example/v1' }) });
  assert.equal(attack.status, 403, '不能让外部页面改掉接口地址');

  const local = await fetch(base + '/_api/provider/base', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ provider: 'opendesign', base: 'https://ok.invalid/v1' }) });
  assert.equal(local.status, 200, '本机页面必须能改');
});
