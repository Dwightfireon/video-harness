import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';
import { prepareExecution, executionSnapshot, runnerConfig, runnerReady, selectRunner } from '../lib/runners/index.mjs';
import { writeSettings, settingsPath, readKnownProviders, currentSelection, parseConfigJSON } from '../lib/provider-settings.mjs';

const secret = 'fixture-product-private-key';
function fixture(t, runner = { name: 'opencode' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-execution-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(project, 'PROJECT.json'), JSON.stringify({ runner }));
  const env = { HOME: home, PATH: process.env.PATH };
  return { root, home, project, env };
}
function native(home, document, suffix = 'jsonc') {
  const dir = path.join(home, '.config', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'opencode.' + suffix);
  fs.writeFileSync(file, typeof document === 'string' ? document : JSON.stringify(document));
  return file;
}
function product(home, extra = {}) {
  writeSettings({ preferredProvider: 'commandcode', models: { commandcode: 'deepseek/coder' },
    bases: { commandcode: 'https://user:password@cc.invalid/v1?token=query-secret#private' },
    keys: { commandcode: secret }, ...extra }, home);
}

test('设置驱动默认模型、端点与 key，并使用独立私有 server；没有项目/全局配置写入', t => {
  const { project, home, env } = fixture(t);
  const file = native(home, { permissions: [{ action: 'edit', resource: '*', effect: 'ask' }],
    agents: { mine: { system: 'keep me' } }, providers: { commandcode: {
      package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://old.invalid/v1' },
      models: { 'deepseek/coder': {} },
    } } });
  product(home);
  const before = fs.readFileSync(file, 'utf8');
  const projectBefore = fs.readFileSync(path.join(project, 'PROJECT.json'), 'utf8');
  assert.equal(runnerConfig(project, env).model, 'commandcode/deepseek/coder');
  const execution = prepareExecution(project, { env, home });
  assert.equal(execution.config.model, 'commandcode/deepseek/coder');
  assert.equal(execution.config.service, 'private');
  assert.equal(execution.snapshot.modelSource, 'provider-settings');
  assert.equal(execution.snapshot.endpointSource, 'provider-settings');
  assert.equal(execution.snapshot.endpoint, 'https://cc.invalid');
  assert.equal(execution.snapshot.keySource, '本机设置页');
  assert.equal(execution.childEnv.VH_EXECUTION_API_KEY, secret);
  assert.match(execution.childEnv.VH_EXECUTION_BASE_URL, /query-secret/);
  const doc = JSON.parse(execution.childEnv.OPENCODE_CONFIG_CONTENT);
  assert.equal(doc.model, 'commandcode/deepseek/coder');
  assert.equal(doc.providers.commandcode.settings.apiKey, '{env:VH_EXECUTION_API_KEY}');
  assert.equal(doc.providers.commandcode.settings.baseURL, '{env:VH_EXECUTION_BASE_URL}');
  assert.equal(Object.hasOwn(doc, 'permissions'), false, '不注入或覆盖全局权限');
  assert.equal(Object.hasOwn(doc, 'agents'), false, '不注入或覆盖全局 agent');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(project, 'PROJECT.json'), 'utf8'), projectBefore);
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH'], '不修改调用方环境');
});

test('公开 config / snapshot / stringify / inspect 不含 key 或 URL 凭证及 query', t => {
  const { project, home, env } = fixture(t);
  product(home);
  const execution = prepareExecution(project, { env, home });
  for (const output of [JSON.stringify(execution), JSON.stringify(execution.config), JSON.stringify(execution.snapshot),
    JSON.stringify(execution.childEnv), inspect(execution), inspect(execution.childEnv),
    JSON.stringify({ nested: execution })]) {
    for (const forbidden of [secret, 'password', 'query-secret', '?token=', '/v1']) {
      assert.equal(output.includes(forbidden), false, forbidden);
    }
  }
  assert.equal(Object.keys(execution).includes('childEnv'), false);
  assert.match(execution.snapshot.keyFingerprint, /^[0-9a-f]{8}$/);
  assert.match(execution.snapshot.endpointFingerprint, /^[0-9a-f]{12}$/);
  const redacted = execution.redactText('failure key=' + secret + ' url=' + execution.childEnv.VH_EXECUTION_BASE_URL);
  assert.equal(redacted.includes(secret), false);
  assert.equal(redacted.includes('query-secret'), false);
  assert.equal(redacted.includes('password'), false);
});

test('项目 model 与临时环境 model 覆盖设置，并明确报告来源；保留 model 内的 slash / variant', t => {
  const { project, home, env } = fixture(t, { name: 'opencode', model: 'my-provider/model/name#careful' });
  product(home);
  let execution = prepareExecution(project, { env, home });
  assert.equal(execution.config.model, 'my-provider/model/name#careful');
  assert.equal(execution.snapshot.provider, 'my-provider');
  assert.equal(execution.snapshot.modelSource, 'project:runner.model');
  execution = prepareExecution(project, { env: { ...env, VH_RUNNER_MODEL: 'other/native#fast' }, home });
  assert.equal(execution.config.model, 'other/native#fast');
  assert.equal(execution.snapshot.modelSource, 'env:VH_RUNNER_MODEL');
  assert.equal(JSON.parse(execution.childEnv.OPENCODE_CONFIG_CONTENT).model, 'other/native');
  assert.equal(execution.snapshot.keySource, 'opencode-native (not inspected)');
});

test('未知自定义 provider 沿用原生配置，不被重写成默认 provider/package/凭证', t => {
  const { project, home, env } = fixture(t, { name: 'opencode', model: 'bespoke/coder' });
  const doc = { permissions: [{ action: 'shell', resource: '*', effect: 'deny' }],
    agents: { custom: { system: 'preserve' } }, plugins: ['keep-plugin'], providers: {
      bespoke: { package: 'my-native-package', settings: { apiKey: '{env:NATIVE_KEY}' }, models: { coder: {} } },
    } };
  const execution = prepareExecution(project, { env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(doc), NATIVE_KEY: 'native-secret' }, home });
  const result = JSON.parse(execution.childEnv.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(result.providers, doc.providers);
  assert.deepEqual(result.permissions, doc.permissions);
  assert.deepEqual(result.agents, doc.agents);
  assert.deepEqual(result.plugins, doc.plugins);
  assert.equal(execution.childEnv.VH_EXECUTION_API_KEY, undefined);
  assert.equal(execution.snapshot.credentialStatus, 'native-not-inspected');
  assert.equal(execution.snapshot.provider, 'bespoke');
});

test('原生项目 provider package 保留，direct 和 .opencode 端点按 V2 顺序观察', t => {
  const { root, project, home, env } = fixture(t);
  product(home, { bases: {} });
  fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({ providers: { commandcode: {
    package: '@opencode/ai/providers/openai-compatible/responses',
    settings: { baseURL: 'https://direct.invalid/v1' }, models: { 'deepseek/coder': {} },
  } } }));
  fs.mkdirSync(path.join(root, '.opencode'));
  fs.writeFileSync(path.join(root, '.opencode', 'opencode.jsonc'), JSON.stringify({ providers: {
    commandcode: { settings: { baseURL: 'https://dot-config.invalid/v1' } },
  } }));
  const execution = prepareExecution(project, { env, home });
  const entry = JSON.parse(execution.childEnv.OPENCODE_CONFIG_CONTENT).providers.commandcode;
  assert.equal(entry.package, undefined, '运行覆盖不替换原生 package');
  assert.equal(entry.settings.baseURL, undefined, '不覆盖原生端点合并');
  assert.equal(execution.snapshot.endpoint, 'https://dot-config.invalid');
});

test('已保存的产品 key 优先于旧原生 auth 和环境变量', t => {
  const { project, home, env } = fixture(t, { name: 'opencode', model: 'opendesign/deepseek-v4.1-flash' });
  product(home, { keys: { opendesign: secret }, bases: { opendesign: 'https://od.invalid/v1' } });
  const auth = path.join(home, '.local', 'share', 'opencode');
  fs.mkdirSync(auth, { recursive: true });
  fs.writeFileSync(path.join(auth, 'auth.json'), JSON.stringify({ opendesign: { key: 'native-old-secret' } }));
  const execution = prepareExecution(project, { env: { ...env, OPEN_DESIGN_API_KEY: 'old-env-secret' }, home });
  assert.equal(execution.childEnv.VH_EXECUTION_API_KEY, secret);
  assert.equal(execution.snapshot.keySource, '本机设置页');
});

test('缺凭证只阻断所选渠道；只读快照如实显示缺失，绝不切换 provider', t => {
  const { project, home, env } = fixture(t);
  product(home, { keys: { opendesign: 'unrelated-provider-key' } });
  assert.throws(() => prepareExecution(project, { env, home }), error => {
    assert.equal(error.code, 'credentials');
    assert.equal(error.snapshot.provider, 'commandcode');
    assert.equal(error.snapshot.credentialStatus, 'missing');
    assert.equal(error.snapshot.configurationReady, false);
    return true;
  });
  assert.equal(executionSnapshot(project, { env, home }).provider, 'commandcode');
});

test('selectRunner 的 fixture/model 私有原生 provider 不需要本产品 key；默认设置渠道缺 key 明确失败', async t => {
  const { project, home, env } = fixture(t, { name: 'opencode', model: 'fixture/model', service: 'private' });
  const runner = await selectRunner(project, { env, home });
  assert.equal(runner.name, 'opencode');
  assert.equal(runner.model, 'fixture/model');
  fs.writeFileSync(path.join(project, 'PROJECT.json'), JSON.stringify({ runner: { name: 'opencode' } }));
  await assert.rejects(selectRunner(project, { env, home }), { code: 'credentials' });
});

test('没有原生自定义渠道定义时，产品 endpoint + key 建立最小 V2 provider', t => {
  const { project, home, env } = fixture(t);
  product(home);
  const doc = JSON.parse(prepareExecution(project, { env, home }).childEnv.OPENCODE_CONFIG_CONTENT);
  assert.equal(doc.providers.commandcode.package, '@opencode/ai/providers/openai-compatible');
  assert.deepEqual(doc.providers.commandcode.models, { 'deepseek/coder': {} });
  product(home, { bases: {} });
  assert.throws(() => prepareExecution(project, { env, home }), { code: 'endpoint-config' });
});

test('opendesign 使用 provider-settings 的既有默认 endpoint，不在 runner 硬编码', t => {
  const { project, home, env } = fixture(t);
  writeSettings({ keys: { opendesign: secret } }, home);
  const execution = prepareExecution(project, { env, home });
  assert.equal(execution.snapshot.provider, 'opendesign');
  assert.equal(execution.snapshot.endpointSource, 'provider-settings:default');
  assert.equal(execution.childEnv.VH_EXECUTION_BASE_URL, 'https://amr-link.open-design.ai/v1');
});

test('未知显式 runner / service / model 均明确失败，包括 prototype 名称；不回落 local', async t => {
  const { project, home, env } = fixture(t);
  for (const name of ['nonsense', '__proto__', '', 'toString']) {
    assert.throws(() => runnerConfig(project, { ...env, VH_RUNNER: name }), { code: 'runner-config' });
    await assert.rejects(selectRunner(project, { env, home, config: { name } }), { code: 'runner-config' });
  }
  assert.throws(() => runnerConfig(project, { ...env, VH_RUNNER_SERVICE: 'random' }), { code: 'service-config' });
  assert.throws(() => runnerConfig(project, { ...env, VH_RUNNER_MODEL: 'https://key@host/query?secret' }), { code: 'model-config' });
  fs.writeFileSync(path.join(project, 'PROJECT.json'), JSON.stringify({ runner: 'typo' }));
  assert.throws(() => runnerConfig(project, env), { code: 'runner-config' });
});

test('新路径默认 opencode；既有 local 与无 runner 的 legacy 项目保留', t => {
  const { project, home, env } = fixture(t, 'local');
  assert.equal(runnerConfig(project, env).name, 'local');
  fs.writeFileSync(path.join(project, 'PROJECT.json'), '{}');
  assert.equal(runnerConfig(project, env).name, 'local');
  assert.equal(runnerConfig(project, env).runnerSource, 'legacy-default');
  fs.unlinkSync(path.join(project, 'PROJECT.json'));
  assert.equal(runnerConfig(project, env).name, 'opencode');
  assert.equal(prepareExecution(project, { env, home, requireCredentials: false }).config.service, 'private');
});

test('损坏 settings / 无效形状 / 无效选择 fail-closed，错误不带密钥原文', async t => {
  const { project, home, env } = fixture(t);
  product(home);
  for (const bad of ['{"keys":{"commandcode":"' + secret, '[]', '{"keys":[]}', '{"models":{"commandcode":{}}}',
    '{"preferredProvider":"not-present"}']) {
    fs.writeFileSync(settingsPath(home), bad);
    assert.throws(() => prepareExecution(project, { env, home }), error => {
      assert.equal(error.message.includes(secret), false);
      return /设置|渠道/.test(error.message);
    });
    const ready = await runnerReady(project, { env, home });
    assert.equal(ready.ok, false);
    assert.equal(ready.check, 'configuration');
    assert.equal(JSON.stringify(ready).includes(secret), false);
  }
});

test('V2 json/jsonc 发现与兼容旧形状；JSONC 不破坏字符串中的 URL、注释和尾逗号样式', t => {
  const { home } = fixture(t);
  native(home, { provider: { legacy: { options: { baseURL: 'https://old.invalid/v1' }, models: { old: {} } } } }, 'json');
  native(home, `{
    /* block */ "providers": { "custom": {
      "settings": { "baseURL": "https://custom.invalid/v1?q=//ok" },
      "models": { "tricky,}": {}, }, // line comment
    }, },
  }`);
  assert.deepEqual(readKnownProviders(home).map(p => p.name), ['legacy', 'custom']);
  assert.equal(readKnownProviders(home)[1].base, 'https://custom.invalid/v1?q=//ok');
  assert.deepEqual(readKnownProviders(home)[1].models, ['tricky,}']);
  assert.deepEqual(parseConfigJSON('{"text":"/* x */ // ,}",}'), { text: '/* x */ // ,}' });
  writeSettings({ preferredProvider: 'custom', models: { custom: 'coder' } }, home);
  assert.deepEqual(currentSelection(home), { provider: 'custom', model: 'coder' });
});

test('fakeopencode 接收实际 child env、选定 model 与 private 标志；ready 仅执行 --version 并脱敏', async t => {
  const { root, project, home, env } = fixture(t);
  product(home);
  const bin = path.join(root, 'fakeopencode');
  fs.writeFileSync(bin, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('opencode v2.0.21 ${secret} https://user:password@cc.invalid/?token=query-secret');
  process.exit(0);
}
const doc = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const entry = doc.providers.commandcode;
const checks = args[0] === 'run' && args.includes('--standalone') &&
  args[args.indexOf('-m') + 1] === 'commandcode/deepseek/coder' &&
  doc.model === 'commandcode/deepseek/coder' &&
  entry.settings.apiKey === '{env:VH_EXECUTION_API_KEY}' &&
  process.env.VH_EXECUTION_API_KEY === '${secret}' &&
  process.env.VH_EXECUTION_BASE_URL.startsWith('https://user:password@cc.invalid/');
console.log(JSON.stringify({ checks }));
process.exit(checks ? 0 : 1);
`, { mode: 0o700 });
  const fakeEnv = { ...env, VH_OPENCODE_BIN: bin };
  const execution = prepareExecution(project, { env: fakeEnv, home });
  const args = ['run', '-m', execution.config.model];
  if (execution.config.service === 'private') args.push('--standalone');
  const child = spawnSync(bin, args, { cwd: project, env: execution.childEnv, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { checks: true });
  const ready = await runnerReady(project, { env: fakeEnv, home });
  assert.equal(ready.ok, true);
  assert.equal(ready.version, 'v2.0.21');
  assert.equal(ready.check, 'binary-only');
  assert.equal(ready.connectivity, 'not-checked');
  assert.equal(ready.balance, 'not-checked');
  assert.equal(JSON.stringify(ready).includes(secret), false);
  assert.equal(JSON.stringify(ready).includes('query-secret'), false);
  product(home, { keys: {} });
  const missing = await runnerReady(project, { env: fakeEnv, home });
  assert.equal(missing.binaryReady, true, '二进制可用不等于凭证可用');
  assert.equal(missing.configurationReady, false);
});
