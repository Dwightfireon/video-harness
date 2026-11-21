import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { doctor, report } from '../lib/doctor.mjs';

function fixture() {
  const commands = [], reads = [];
  const files = new Map();
  const deps = {
    home: '/mock-home', cwd: '/mock-work',
    fs: new Proxy({
      existsSync: file => files.has(file),
      statSync: file => {
        reads.push(file);
        const type = files.get(file);
        if (!type) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { isFile: () => type !== 'directory' };
      },
      accessSync: (file, mode) => {
        assert.equal(mode, fs.constants.X_OK);
        if (files.get(file) !== 'executable') throw new Error('not executable');
      },
      statfsSync: () => ({ bavail: 9 * 1024 * 1024, bsize: 1024 }),
    }, {
      get(target, prop) {
        assert.ok(prop in target, `unexpected filesystem access: ${String(prop)}`);
        return target[prop];
      },
    }),
    spawnSync: (cmd, args, options) => {
      commands.push({ cmd, args, options });
      assert.ok(['python3', 'ffmpeg', 'ffprobe'].includes(cmd), `unexpected command: ${cmd}`);
      return { status: 0, stdout: '' };
    },
    loadPlaywright: async () => ({ chromium: { executablePath: () => '/runtime/chrome' } }),
    loadRegistry: () => ({ findExecutable: name => {
      assert.equal(name, 'chromium-headless-shell');
      return { executablePath: () => '/runtime/headless_shell' };
    } }),
    loadChromeInfo: () => ({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', version: '156.0.8078.80' }),
    loadProviderSettings: async () => ({ currentSelection: () => ({ provider: 'fake' }), keySourceChain: () => ({ key: '', source: null }) }),
  };
  return { deps, files, commands, reads };
}

const kernel = res => res.checks.find(c => c.name === 'chromium');

test('playwright 缺失绝不派发 npx；只有 Chrome 也不能代替 Node 包', async () => {
  const { deps, commands, files } = fixture();
  deps.loadPlaywright = async () => { throw new Error('MODULE_NOT_FOUND'); };
  deps.loadRegistry = () => assert.fail('missing playwright must not load registry');
  files.set(deps.loadChromeInfo().executablePath, 'executable');
  const result = await doctor(undefined, deps);
  assert.equal(result.checks.find(c => c.name === 'playwright').ok, false);
  assert.equal(kernel(result).ok, false);
  assert.deepEqual(commands.map(c => c.cmd), ['python3', 'ffmpeg', 'ffprobe']);
});

test('即使缓存内核可执行，也不再作为本项目的渲染内核', async () => {
  const { deps, files, reads } = fixture();
  files.set('/mock-home/Library/Caches/ms-playwright/chromium-1234', 'directory');
  files.set('/runtime/chrome', 'executable');
  assert.equal(kernel(await doctor(undefined, deps)).ok, false, '默认 headless shell 缺失时不能把 full Chromium 当可用');
  files.set('/runtime/headless_shell', 'directory');
  assert.equal(kernel(await doctor(undefined, deps)).ok, false);
  files.set('/runtime/headless_shell', 'file');
  assert.equal(kernel(await doctor(undefined, deps)).ok, false);
  files.set('/runtime/headless_shell', 'executable');
  assert.equal(kernel(await doctor(undefined, deps)).ok, false);
  assert.ok(!reads.includes('/runtime/headless_shell'));
  assert.ok(!reads.includes('/runtime/chrome'));
});

test('本机 Chrome 必须是普通文件、可执行且已达到修复版本', async () => {
  const { deps, files } = fixture();
  const chrome = deps.loadChromeInfo().executablePath;
  files.set(chrome, 'directory');
  assert.equal(kernel(await doctor(undefined, deps)).ok, false);
  files.set(chrome, 'file');
  assert.equal(kernel(await doctor(undefined, deps)).ok, false);
  files.set(chrome, 'executable');
  assert.match(kernel(await doctor(undefined, deps)).note, /本机 Chrome 156\.0\.8078\.80/);
  assert.equal(kernel(await doctor(undefined, deps)).ok, true);
  deps.loadChromeInfo = () => ({ executablePath: chrome, version: '156.0.8078.4' });
  assert.equal(kernel(await doctor(undefined, deps)).ok, false);
});

test('本机 Chrome 版本未知或检查抛异常时，不回退任何缓存内核', async () => {
  const { deps, files } = fixture();
  files.set(deps.loadChromeInfo().executablePath, 'executable');
  files.set('/runtime/headless_shell', 'executable');
  deps.loadChromeInfo = () => { throw new Error('FAKE_SECRET'); };
  const result = await doctor(undefined, deps);
  assert.equal(kernel(result).ok, false);
  assert.doesNotMatch(report(result), /FAKE_SECRET/);
});

test('全部外部命令有限等待、硬终止、限制输出；超时结果进入失败报告', async () => {
  const { deps, commands } = fixture();
  deps.spawnSync = (cmd, args, options) => {
    commands.push({ cmd, args, options });
    assert.equal(options.timeout, 3000);
    assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.shell, false);
    assert.equal(options.maxBuffer, 65536);
    return { status: null, error: Object.assign(new Error('FAKE_SECRET'), { code: 'ETIMEDOUT' }), stderr: 'FAKE_SECRET' };
  };
  const result = await doctor(undefined, deps);
  for (const name of ['python3', 'ffmpeg', 'ffprobe']) {
    const c = result.checks.find(c => c.name === name);
    assert.equal(c.ok, false);
    assert.match(c.note, /超时/);
    assert.ok(result.failed.includes(c));
  }
  assert.equal(commands.length, 3);
  assert.doesNotMatch(report(result), /FAKE_SECRET/);
});

test('命令失败、任意输出及异常不泄漏秘密，且不联网、不打印日志', async t => {
  const { deps } = fixture();
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  const logs = ['log', 'warn', 'error'].map(method => t.mock.method(console, method, () => {}));
  deps.spawnSync = cmd => {
    if (cmd === 'python3') throw new Error('FAKE_SECRET');
    return { status: cmd === 'ffmpeg' ? 1 : 0, stdout: 'FAKE_SECRET', stderr: 'FAKE_SECRET' };
  };
  const result = await doctor(undefined, deps);
  assert.equal(result.checks.find(c => c.name === 'python3').note, '无法执行');
  assert.equal(result.checks.find(c => c.name === 'ffmpeg').note, '命令失败');
  assert.equal(result.checks.find(c => c.name === 'ffprobe').note, '可执行');
  assert.doesNotMatch(report(result), /FAKE_SECRET/);
  assert.equal(network.mock.callCount(), 0);
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
});
