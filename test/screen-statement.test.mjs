import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../lib/screen-check.mjs';

/* 断言页豁免：为什么值得测
   真实误报——hero-statement（一屏只留一句）被 screen 判"元素太少撑不住"，
   但"一屏一句"正是这个版式的设计意图。豁免必须窄：
   只免"元素数量"这类判断，**不免"没有任何具体对象"**（那才是真空屏）。 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vh-screen-'));

function makeProject({ layout, chunk, script, dur = 20 }) {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'scenes.src.js'), chunk, 'utf8');
  fs.writeFileSync(path.join(d, '脚本.md'), script, 'utf8');
  fs.writeFileSync(path.join(d, 'scene.html'), `<script>addScene(0, ${dur}, root => {});</script>`, 'utf8');
  return d;
}

const SCRIPT = `# 示例

**主体**：大字断言
**目标时长：20 秒**

## S1 · 大字断言
1. 这是示例，这一期带你把它看明白，一屏只留一句话。
2. 适合的场合是一个结论、一句判据、开场钩子。
3. 把字换成你的内容，先看静帧再决定要不要配音。
`;

test('screen：@layout 大字断言 时，元素少不误报（设计就是一句）', () => {
  const d = makeProject({
    chunk: `// @layout 大字断言
root => {
  bg(root);
  const t = line('一句<b class="hl">结论</b>'); type(t.el, 'hero'); root.append(t.el);
  const sub = abs(mk('div','','补一句人话'), 100, 600, 800, 80); type(sub, 'body'); root.append(sub);
  return { render(){} };
}`,
    script: SCRIPT,
  });
  const res = analyze(d);
  assert.equal(res.findings.length, 0, JSON.stringify(res.findings));
});

test('screen：普通版式元素少仍然要报（豁免不能放宽）', () => {
  const d = makeProject({
    chunk: `// @layout 列表
root => {
  bg(root);
  const t = line('标题'); type(t.el, 'h1'); root.append(t.el);
  const sub = abs(mk('div','','一句说明'), 100, 300, 800, 80); type(sub, 'body'); root.append(sub);
  return { render(){} };
}`,
    script: SCRIPT,
  });
  const res = analyze(d);
  assert.ok(res.findings.length > 0, '普通版式应仍然报"元素太少"');
});

test('screen：断言页里完全没有具体对象时仍然要报（不豁免空屏）', () => {
  const d = makeProject({
    chunk: `// @layout 大字断言
root => {
  bg(root);
  const t = line('一句空话'); type(t.el, 'hero'); root.append(t.el);
  return { render(){} };
}`,
    script: SCRIPT,
  });
  const res = analyze(d);
  assert.ok(res.findings.some(f => /没有任何具体对象/.test(f.msg) || /具体对象/.test(f.msg)),
    '断言页也必须给具体对象：' + JSON.stringify(res.findings));
});
