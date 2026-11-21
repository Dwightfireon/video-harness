import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { LEXICON, OBJECT_KINDS, promptHint } from '../lib/lexicon.mjs';

const REF = path.join(import.meta.dirname, '..', 'references', 'lexicon.md');

/* 语汇库必须与参考文档条数一致（防止文档加了、程序没加） */
test('lexicon：程序条目数与 references/lexicon.md 一致', () => {
  const md = fs.readFileSync(REF, 'utf8');
  const rows = md.split('\n').filter(l => /^\|\s*\d+\s*\|/.test(l));
  assert.equal(LEXICON.length, rows.length, `程序 ${LEXICON.length} 条，文档 ${rows.length} 条`);
});

/* 每条都要有 4 个字段，且不能为空 */
test('lexicon：每条都有 when/how/why/need，且 need 非空', () => {
  for (const l of LEXICON) {
    for (const k of ['key', 'when', 'how', 'why']) {
      assert.ok(l[k] && String(l[k]).trim(), `${l.key || '?'} 缺 ${k}`);
    }
    assert.ok(Array.isArray(l.need) && l.need.length, `${l.key} 的 need 为空`);
  }
});

/* key 唯一 */
test('lexicon：key 不重复', () => {
  const keys = LEXICON.map(l => l.key);
  assert.equal(new Set(keys).size, keys.length);
});

/* 具体对象类别覆盖 7 类，且每条能测 */
test('objectKinds：7 类且正则可用', () => {
  assert.equal(OBJECT_KINDS.length, 7);
  for (const k of OBJECT_KINDS) {
    assert.ok(k.test instanceof RegExp, k.key + ' 不是正则');
    assert.ok(k.label);
  }
});

/* agent 提示要包含所有 when（否则 agent 看不到某一类） */
test('promptHint：包含每一类内容关系', () => {
  const h = promptHint();
  for (const l of LEXICON) assert.ok(h.includes(l.when), '提示缺少：' + l.when);
  assert.ok(h.includes('具体对象'));
});
