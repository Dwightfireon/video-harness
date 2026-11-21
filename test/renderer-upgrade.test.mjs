import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { repairRenderer, rendererIdentity } from '../lib/renderer-upgrade.mjs';

const buggy = 'chromium.launch({ ...launchArgs, executablePath: localBrowser })';
function fixture(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-renderer-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'render.mjs'), source); return dir;
}
test('Chrome fallback 保留完整 args，精确备份且重复修复不写文件', async t => {
  const args = ['--use-angle=metal', '--force-color-profile=srgb', '--font-render-hinting=none'];
  const original = '/* custom prefix */\nconst launchArgs = ' + JSON.stringify(args) + ';\n' + buggy + '\n// custom suffix';
  const dir = fixture(t, original), result = repairRenderer(dir);
  assert.equal(result.changed, true); assert.equal(fs.readFileSync(result.backup, 'utf8'), original);
  const fixed = fs.readFileSync(path.join(dir, 'render.mjs'), 'utf8');
  let launched;
  await vm.runInNewContext(fixed, { localBrowser: '/local/chrome', chromium: { launch: opts => { launched = opts; } } });
  assert.deepEqual([...launched.args], args); assert.equal(launched.executablePath, '/local/chrome');
  assert.ok(fixed.startsWith('/* custom prefix */')); assert.ok(fixed.endsWith('// custom suffix'));
  assert.equal(rendererIdentity(dir).upgraded, true);
  const mtime = fs.statSync(path.join(dir, 'render.mjs')).mtimeMs;
  assert.equal(repairRenderer(dir).changed, false); assert.equal(fs.statSync(path.join(dir, 'render.mjs')).mtimeMs, mtime);
});
test('注释/字符串/未知自定义启动不覆盖，符号链接拒绝', t => {
  for (const code of ['const launchArgs = [];\n// ' + buggy, 'const launchArgs = [];\n' + JSON.stringify(buggy), 'chromium.launch(customOptions)', 'const launchArgs = {args: ["--custom"]};\n' + buggy]) {
    const dir = fixture(t, code); assert.equal(repairRenderer(dir).changed, false);
    assert.equal(fs.readFileSync(path.join(dir, 'render.mjs'), 'utf8'), code);
    assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  }
  const dir = fixture(t, buggy), file = path.join(dir, 'render.mjs');
  fs.renameSync(file, path.join(dir, 'original.mjs')); fs.symlinkSync('original.mjs', file);
  assert.throws(() => repairRenderer(dir), /普通文件/);
  assert.equal(fs.readFileSync(path.join(dir, 'original.mjs'), 'utf8'), buggy);
});
