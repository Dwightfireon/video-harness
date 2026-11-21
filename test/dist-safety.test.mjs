import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

/* dist 删除安全：为什么值得测
   真实事故——dist/ 被清空，5 个交付包（成片+字幕+封面+文案）全没了，
   没有回收站、没有确认。而 vh rm 项目是有回收站的，两者不一致。
   这里锁定：① 没 --yes 不删 ② 删除进回收站可恢复 ③ 有源项目时给提示。 */

const VH = fs.readFileSync(path.join(import.meta.dirname, '..', 'vh.mjs'), 'utf8');

test('dist：purge 必须要求 --yes 确认', () => {
  const seg = VH.slice(VH.indexOf('async function cmdDist'), VH.indexOf('/* ====', VH.indexOf('async function cmdDist') + 10));
  assert.match(seg, /若没有 --yes|必须加 --yes|has\('yes'\)/, '应要求 --yes');
});

test('dist：删除走回收站（.vh-trash），不是直接 rm', () => {
  const seg = VH.slice(VH.indexOf('async function cmdDist'), VH.indexOf('/* ====', VH.indexOf('async function cmdDist') + 10));
  assert.match(seg, /\.vh-trash/, '应移入 .vh-trash 而不是直接删');
  assert.match(seg, /toTrash/, '应有 toTrash 实现');
});

test('dist：prune 保留最新一份（按时间戳排序）', () => {
  const seg = VH.slice(VH.indexOf('async function cmdDist'), VH.indexOf('/* ====', VH.indexOf('async function cmdDist') + 10));
  assert.match(seg, /slice\(0, -1\)/, '应保留最后一份（最新）');
});

test('dist：projects 空了要提示"删了重建不了"', () => {
  const seg = VH.slice(VH.indexOf('async function cmdDist'), VH.indexOf('/* ====', VH.indexOf('async function cmdDist') + 10));
  assert.match(seg, /重建不了|只在这里/, '应提示交付包是唯一副本');
});

test('rm 项目：默认进回收站（与 dist 一致）', () => {
  const seg = VH.slice(VH.indexOf('async function cmdRm'), VH.indexOf('/* ====', VH.indexOf('async function cmdRm') + 10));
  assert.match(seg, /\.vh-trash/);
  assert.match(seg, /PROJECT\.json/, '必须校验是视频项目才允许删');
});
