import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBrief, save, load, selfCheck, report } from '../lib/brief.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vh-brief-'));

test('brief：从"简单点，只要链接和优惠码"抽出 must 与 mustNot', () => {
  const b = parseBrief('简单点，只要链接和优惠码');
  assert.ok(b.must.some(m => /链接和优惠码/.test(m)), JSON.stringify(b.must));
  assert.ok(b.mustNot.some(m => /长篇细节/.test(m)), JSON.stringify(b.mustNot));
});

test('brief：识别"X 就是 Y"为用户认定的事实', () => {
  const b = parseBrief('S9JE6G 就是优惠码');
  assert.ok(b.facts.some(f => f.subject.includes('S9JE6G') && /优惠码/.test(f.is)), JSON.stringify(b.facts));
});

test('brief：抽出链接（含裸域名）', () => {
  const b = parseBrief('链接 https://prodclub.xyz/r/ABC 或 prodclub.xyz');
  assert.ok(b.urls.some(u => u.includes('prodclub.xyz')), JSON.stringify(b.urls));
});

test('brief：自检能报"你认定的事实没写进脚本"', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, '脚本.md'), '这里没有那个词\n');
  const b = parseBrief('S9JE6G 就是优惠码');
  save(d, b);
  const warns = selfCheck(d, b);
  assert.ok(warns.some(w => /优惠码/.test(w)), JSON.stringify(warns));
});

test('brief：自检能报"说只给链接和优惠码却写了价格"', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, '脚本.md'), '链接 prodclub.xyz，优惠码 ABC，价格 ¥168\n');
  const b = parseBrief('简单点，只要链接和优惠码，链接 prodclub.xyz');
  save(d, b);
  const warns = selfCheck(d, b);
  assert.ok(warns.some(w => /价格/.test(w)), JSON.stringify(warns));
});

test('brief：没要求时 selfCheck 不误报', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, '脚本.md'), '普通内容 ¥168\n');
  const b = parseBrief('把标题改短');
  assert.deepEqual(selfCheck(d, b), []);
});

test('brief：report 列出必须/不许/事实/链接', () => {
  const b = parseBrief('简单点，只要链接和优惠码，S9JE6G 就是优惠码 https://x.xyz');
  const t = report(b);
  for (const k of ['必须', '不许', '事实', '链接']) assert.ok(t.includes(k), '缺 ' + k);
});

/* ---- amend：用户中途改主意，旧要求必须能撤 ---- */
import { amend } from '../lib/brief.mjs';

test('brief --amend：说"加上价格"时，撤掉旧的"只给链接"与"不要价格"', () => {
  const first = parseBrief('简单点，只要链接和优惠码 https://x.xyz');
  const merged = amend(first, '算了，价格也写上');
  assert.ok(merged.must.some(m => /价格/.test(m)), JSON.stringify(merged.must));
  assert.ok(!merged.must.some(m => /只给链接/.test(m)), '旧的"只给链接"应被撤销：' + JSON.stringify(merged.must));
  assert.ok(!merged.mustNot.some(m => /长篇细节/.test(m)), '旧的"不许展开"应被撤销：' + JSON.stringify(merged.mustNot));
  assert.ok(merged.urls.length >= 1, '链接要保留');
});

test('brief --amend：冲突要求会被标出来（不静默合并）', () => {
  const a = parseBrief('必须写出价格');
  const merged = amend(a, '不要价格');
  assert.ok(merged.conflicts.length > 0, JSON.stringify(merged));
});
