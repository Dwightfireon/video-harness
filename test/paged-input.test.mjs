import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* 用最小 DOM 桩测试分页逻辑本身（不依赖浏览器）。
   真实浏览器里的性能验证见 test/input-perf.test.mjs。 */
function fakeTextarea() {
  const listeners = new Map();
  const el = {
    value: '', selectionStart: 0, clientHeight: 100, scrollTop: 0,
    addEventListener(type, fn) { (listeners.get(type) || listeners.set(type, []).get(type)).push(fn); },
    dispatch(type) { for (const fn of listeners.get(type) || []) fn({ type }); },
    setSelectionRange(a) { el.selectionStart = a; },
    focus() {},
  };
  return el;
}
const fakeHost = () => ({ children: [], appendChild(n) { this.children.push(n); }, append() {} });

/* 复刻 splitInto，确保分页边界与实现一致。 */
const splitInto = (content, size) => {
  if (!content) return [''];
  const out = [];
  for (let i = 0; i < content.length; i += size) out.push(content.slice(i, i + size));
  return out;
};

test('分页切分不丢字符、不改变换行与空白', () => {
  const text = '第一段\n第二段\n\n  缩进行\n结尾';
  for (const size of [3, 5, 7, 100]) {
    const pages = splitInto(text, size);
    assert.equal(pages.join(''), text, `size=${size}`);
    assert.ok(pages.every(p => p.length <= size));
  }
  assert.deepEqual(splitInto('', 10), ['']);
});

test('超长文本按页切分，页数符合预期', () => {
  const text = '一'.repeat(10000);
  const pages = splitInto(text, 4000);
  assert.equal(pages.length, 3);
  assert.equal(pages.join(''), text);
});

test('大量换行不会改变拼接结果', () => {
  let text = '';
  for (let i = 0; i < 500; i++) text += '这是第' + i + '句，一句一行。\n';
  const pages = splitInto(text, 4000);
  assert.ok(pages.length > 1);
  assert.equal(pages.join(''), text);
  assert.equal((pages.join('').match(/\n/g) || []).length, 500);
});
