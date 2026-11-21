import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unmountedElements } from '../lib/scene-mount.mjs';
import { validateSceneSource, prepareAuthorEdit, patchText, readEditFile } from '../lib/author-edits.mjs';

/* 真实事故：8 场里 6 场把元素全建好、一次 root.appendChild 都没有，
 * 语法与 render 形状都合法，于是空白场被当成完成稿组装、build 才报错，
 * 修复阶段只拿到变量名没有行号，模型把 1455 行来回读了 96 轮零写入。 */

const blank = name => `// @layout 空
root => {
  bg(root);
  const title = mk('div','serif','${name}');
  const body = mk('div','','正文');
  return { render(t) { void t; } };
}`;

const mounted = `// @layout 正常
root => {
  bg(root);
  const title = mk('div','serif','标题');
  abs(title, 140, 200, 800, 80);
  root.appendChild(title);
  return { render(t) { void t; } };
}`;

const containerBuilt = `// @layout 卡片
root => {
  bg(root);
  function card(text) {
    const box = mk('div','');
    const label = mk('div','', text);
    box.appendChild(label);
    return box;
  }
  const one = card('a');
  root.appendChild(one);
  return { render(t) { void t; } };
}`;

const arrayMountedInCallback = `// @layout 行
root => {
  bg(root);
  const rows = ['a', 'b'].map(function (text) {
    const row = mk('div','', text);
    root.appendChild(row);
    return row;
  });
  return { render(t) { void rows; } };
}`;

const sampleStyle = `// @layout 钩子
root => {
  bg(root);
  const l1 = line('第一句');
  const l2 = line('第二句');
  [l1, l2].forEach(function (L) { root.appendChild(L.el); });
  return { render(t) { void t; } };
}`;

test('建了元素却没挂到画面上会被定位到行，正常写法不误报', () => {
  assert.deepEqual(unmountedElements(mounted), []);
  assert.deepEqual(unmountedElements(containerBuilt), []);
  assert.deepEqual(unmountedElements(arrayMountedInCallback), []);
  assert.deepEqual(unmountedElements(sampleStyle), []);
  const found = unmountedElements(blank('标题'));
  assert.deepEqual(found.map(item => item.name), ['title', 'body']);
  assert.equal(found[0].line, 4);
});

test('写一整场时空白场被拒绝，并指出该补哪一行', () => {
  assert.throws(() => validateSceneSource(blank('标题')), error => {
    assert.equal(error.code, 'UNMOUNTED_ELEMENTS');
    assert.match(error.message, /第 4 行 `title`/);
    assert.match(error.message, /root\.appendChild/);
    return true;
  });
  assert.equal(validateSceneSource(mounted), mounted);
});

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vh-mount-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  return dir;
}

test('已有空白场可以一处一处补挂载，但不能新增空白元素或退回空场', t => {
  const dir = fixture(t);
  const source = `${mounted}\n\n//---\n\n${blank('第二场')}`;
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), source);
  const hash = readEditFile(dir, 'scenes.src.js').base_hash;

  // 给已有空白场补一处挂载：必须放行，否则旧问题会把修复永久锁死。
  const progress = prepareAuthorEdit('scenes.src.js', source, { operation: 'patch_text',
    find: "  const title = mk('div','serif','第二场');",
    replace: "  const title = mk('div','serif','第二场');\n  root.appendChild(title);" });
  assert.match(progress.text, /root\.appendChild\(title\);/);

  // 新增一个只建不挂的元素：拒绝。
  assert.throws(() => patchText(dir, 'scenes.src.js', { base_hash: hash,
    find: "  const body = mk('div','','正文');",
    replace: "  const body = mk('div','','正文');\n  const extra = mk('div','','新块');" }),
    error => error.code === 'UNMOUNTED_ELEMENTS' && /extra/.test(error.message));
  assert.equal(fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8'), source);
});
