import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { doctor, report } from '../lib/doctor.mjs';

/* 完全注入，绝不读本机配置、密钥、磁盘或调用实际工具。 */
function fixture() {
  const calls = [];
  const files = new Map();
  const deps = {
    home: '/fake-home', cwd: '/fake-work',
    fs: {
      existsSync: file => files.has(file),
      statSync(file) {
        if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { isFile: () => files.get(file) !== 'directory', size: files.get(file) };
      },
      accessSync(file) { assert.ok(files.has(file)); },
      statfsSync: file => { calls.push(['disk', file]); return { bavail: 10 * 1024 * 1024, bsize: 1024 }; },
    },
    spawnSync: (cmd, args, options) => {
      calls.push(['spawn', cmd, args, options]);
      return { status: 0, stdout: cmd === 'python3' ? 'Python 3.12.1\n' : `${cmd} version 7.1\n` };
    },
    loadPlaywright: async () => ({ chromium: { executablePath: () => '/runtime/chrome' } }),
    loadRegistry: () => ({ findExecutable: name => name === 'chromium-headless-shell' ? { executablePath: () => '/runtime/shell' } : null }),
    loadChromeInfo: () => ({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', version: '156.0.8078.80' }),
    loadProviderSettings: async () => ({
      currentSelection: () => ({ provider: 'mock-provider' }),
      keySourceChain: provider => {
        assert.equal(provider, 'mock-provider');
        return { key: 'FAKE_SECRET_DO_NOT_PRINT', source: '模拟来源' };
      },
    }),
  };
  return { deps, files, calls };
}

const check = (res, name) => res.checks.find(c => c.name === name);

test('doctor 保留报告接口，完整项目与可执行内核通过；凭证仅报告布尔和来源', async () => {
  const { deps, files, calls } = fixture();
  for (const file of ['PROJECT.json', '脚本.md', 'scenes.src.js', 'scene.html', '方案.md', 'claims.json', '发布文案.md', '审查.md']) {
    files.set(path.join('/project', file), 0);
  }
  files.set(deps.loadChromeInfo().executablePath, 100);
  files.set('/fake-home/.local/share/opencode/video-tts/venv', 'directory');
  files.set('/project/out/video-voice.mp4', 12 * 1048576);
  const res = await doctor('/project', deps);
  assert.equal(res.ok, true);
  assert.deepEqual(res.failed, []);
  assert.equal(check(res, '成片').note, '12MB');
  assert.equal(check(res, '模型凭证').note, 'mock-provider（模拟来源）');
  assert.match(report(res), /环境体检：12 项，0 项需处理/);
  assert.match(report(res), /【渲染】/);
  assert.doesNotMatch(JSON.stringify(res) + report(res), /FAKE_SECRET_DO_NOT_PRINT/);
  assert.deepEqual(calls.filter(c => c[0] === 'spawn').map(c => c[1]), ['python3', 'ffmpeg', 'ffprobe']);
});

test('doctor 报告实际 Playwright 版本与来源，注入加载器时不偷读宿主路径', async () => {
  const { deps } = fixture();
  assert.equal(check(await doctor(undefined, deps), 'playwright').note, '运行时可解析');
  deps.loadPlaywrightInfo = () => ({ version: '1.63.0', path: '/fake-home/project/node_modules/playwright/index.js' });
  assert.equal(check(await doctor(undefined, deps), 'playwright').note, '运行时可解析 · 1.63.0 · ~/project/node_modules/playwright/index.js');
  deps.loadPlaywrightInfo = () => { throw new Error('private path'); };
  assert.equal(check(await doctor(undefined, deps), 'playwright').note, '运行时可解析');
});

test('项目磁盘按实际目标卷计算，不取 HOME；空间不足进入 failed', async () => {
  const { deps, calls } = fixture();
  deps.fs.statfsSync = file => {
    calls.push(['disk', file]);
    return { bavail: file === '/Volumes/video/project' ? 2n * 1024n * 1024n : 100n * 1024n * 1024n, bsize: 1024n };
  };
  const res = await doctor('/Volumes/video/project', deps);
  assert.equal(check(res, '可用空间').ok, false);
  assert.equal(check(res, '可用空间').note, '2GB（项目卷）');
  assert.ok(res.failed.includes(check(res, '可用空间')));
  assert.deepEqual(calls.filter(c => c[0] === 'disk'), [['disk', '/Volumes/video/project']]);
});

test('不存在的项目取最近父目录的卷，无项目时取 cwd；磁盘不可读不假通过', async () => {
  const { deps, calls } = fixture();
  deps.fs.statfsSync = file => {
    calls.push(['disk', file]);
    if (file !== '/Volumes/video') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { bavail: 8 * 1024 * 1024, bsize: 1024 };
  };
  assert.equal(check(await doctor('/Volumes/video/new/project', deps), '可用空间').note, '8GB（项目卷）');
  assert.deepEqual(calls.filter(c => c[0] === 'disk').map(c => c[1]), ['/Volumes/video/new/project', '/Volumes/video/new', '/Volumes/video']);
  calls.length = 0;
  deps.cwd = '/Volumes/video';
  assert.equal(check(await doctor(undefined, deps), '可用空间').note, '8GB（工作目录卷）');
  assert.deepEqual(calls.filter(c => c[0] === 'disk'), [['disk', '/Volumes/video']]);
  deps.fs.statfsSync = () => { throw Object.assign(new Error('private error'), { code: 'EACCES' }); };
  const failed = await doctor(undefined, deps);
  assert.equal(check(failed, '可用空间').ok, false);
  assert.doesNotMatch(report(failed), /private error/);
});

test('缺少模型凭证或检查抛异常时，不返回异常或密钥内容', async () => {
  const { deps } = fixture();
  deps.loadProviderSettings = async () => ({ currentSelection: () => ({ provider: 'mock' }), keySourceChain: () => ({ key: '', source: null }) });
  assert.equal(check(await doctor(undefined, deps), '模型凭证').note, 'mock 无可用凭证');
  deps.loadProviderSettings = async () => { throw new Error('FAKE_SECRET_DO_NOT_PRINT'); };
  const res = await doctor(undefined, deps);
  assert.equal(check(res, '模型凭证').ok, false);
  assert.doesNotMatch(report(res), /FAKE_SECRET_DO_NOT_PRINT/);
});
