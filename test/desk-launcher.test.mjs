import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/* 真实事故：本机另一个 Electron 应用也叫 Electron，按应用名或裸脚本名清理会误关别人的窗口。
 * 这里只校验启动/关闭脚本的边界，不启动 Electron，也不结束任何真实进程。
 *
 * 2026-11-08 起主路径是网页版发布台：投稿逻辑不依赖 Electron，直接开 /publish。
 * 桌面版保留为备用入口，所以"按完整路径识别进程"的规则移到那一份脚本上继续校验。 */
const root = path.resolve(import.meta.dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
/* 注释里会解释“不要用应用名脚本”，只检查实际命令行。 */
const commands = text => text.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');

test('网页发布台入口：打开 /publish，不启动 Electron，不按名字杀进程', () => {
  const open = commands(read('打开发布台.command'));
  assert.match(open, /\/publish/);
  assert.match(open, /vh\.mjs preview/);
  assert.doesNotMatch(open, /osascript|tell application/);
  assert.doesNotMatch(open, /pkill|killall/);
});

test('桌面版备用入口仍按仓库内完整路径识别，不用裸脚本名或应用名', () => {
  const open = commands(read('打开发布台-桌面版.command')), close = commands(read('关闭发布台.command'));
  assert.match(open, /ROOT="\$\(pwd -P\)"/);
  assert.match(open, /"\$ROOT\/desk\/main\.mjs"/);
  assert.doesNotMatch(open, /osascript|tell application "Electron"/);
  assert.doesNotMatch(open, /pkill|killall/);

  assert.match(close, /TARGET="\$ROOT\/desk\/main\.mjs"/);
  assert.match(close, /PATTERN="\(\^\|\[\[:space:\]\\"'\]\)\$ESCAPED/);
  assert.match(close, /pgrep -f -- "\$PATTERN"/);
  assert.doesNotMatch(close, /pgrep -f "desk\/main/);
  assert.doesNotMatch(close, /killall|pkill -f Electron/);
});

test('启动脚本通过 bash 语法检查', () => {
  for (const name of ['打开发布台.command', '打开发布台-桌面版.command', '关闭发布台.command', '打开工作台.command']) {
    const result = spawnSync('bash', ['-n', path.join(root, name)], { encoding: 'utf8' });
    assert.equal(result.status, 0, name + '：' + (result.stderr || ''));
  }
});
