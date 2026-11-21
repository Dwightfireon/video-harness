import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { planMountFixes, unmountedElements } from '../lib/scene-mount.mjs';
import { mountRepairPlan, repairUnmountedScenes, looksLikeMountFailure } from '../lib/mount-repair.mjs';
import { readEditFile } from '../lib/author-edits.mjs';

/* 真实事故复盘：8 场里 6 场元素全建好却一处没挂，成了空白场。
 * 修复阶段让模型逐处补丁，它读了 96 轮、写 0 处，任务被反复暂停。
 * 这类改动没有内容判断成分，必须由执行器确定性完成。 */

const blankScene = (name, extra = '') => `// @layout ${name}
root => {
  bg(root);
  const W = window.W, H = window.H;
  const eyebrow = mk('div', '', '${name}');
  abs(eyebrow, W*.07, H*.09, W*.5, H*.03);
  const head = mk('div', 'serif', '${name} 的标题');
  abs(head, W*.07, H*.14, W*.7, H*.06);
${extra}  return { render(t) { void t; } };
}`;

function fixture(t, scenes) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vh-mountrepair-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), scenes);
  return dir;
}

const compiles = text => { new vm.Script(`(${text}\n)`); return true; };

test('机械补挂载：失败场全部补齐、语法仍合法、其他场次逐字保留', t => {
  const keep = `// @layout 正常
root => {
  bg(root);
  const ok = mk('div','','已经挂好的场');
  root.appendChild(ok);
  return { render(t) { void t; } };
}`;
  const dir = fixture(t, [keep, blankScene('第二场'), blankScene('第三场')].join('\n\n//---\n\n'));
  const before = fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8');
  const untouched = before.split(/^\/\/---\s*$/m)[0];

  const plan = mountRepairPlan(dir);
  assert.equal(plan.actionable, 2, JSON.stringify(plan.scenes));
  const result = repairUnmountedScenes(dir, { log: () => {} });
  assert.deepEqual(result.repaired.map(item => item.scene), [2, 3]);

  const after = fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8');
  assert.equal(after.split(/^\/\/---\s*$/m)[0], untouched, '没问题的场必须逐字保留');
  assert.deepEqual(mountRepairPlan(dir).scenes, [], '修完不应再有未挂元素');
  for (const chunk of after.split(/^\/\/---\s*$/m)) {
    if (!chunk.trim()) continue;
    assert.equal(compiles(chunk), true);
    assert.deepEqual(unmountedElements(chunk), []);
  }
  // 原文必须备份，可回溯
  const history = fs.readdirSync(path.join(dir, 'out/.vh-edit-history'));
  assert.ok(history.length >= 2, '每次写入都要留下备份');
});

test('机械补挂载不把数组当节点，也不把子元素从容器里拽出来', t => {
  const withArray = `// @layout 行
root => {
  bg(root);
  const rows = ['a','b'].map(function (text) {
    const row = mk('div','',text);
    root.appendChild(row);
    return row;
  });
  const cells = ['x','y'].map(function (text) { return mk('div','',text); });
  return { render(t) { void rows; void cells; } };
}`;
  const withContainer = `// @layout 容器
root => {
  bg(root);
  const strip = mk('div','');
  abs(strip, 100, 600, 900, 120);
  const stag = mk('div','','标签');
  strip.appendChild(stag);
  return { render(t) { void t; } };
}`;
  const dir = fixture(t, [withArray, withContainer].join('\n\n//---\n\n'));
  const result = repairUnmountedAssets(dir);
  const after = fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8');
  // 数组结果不是 Node：绝不能生成 root.appendChild(cells)
  assert.doesNotMatch(after, /appendChild\(cells\)/);
  assert.doesNotMatch(after, /appendChild\(rows\)/);
  // 只补最外层容器：孩子不能被拽到 root
  assert.match(after, /root\.appendChild\(strip\)/);
  assert.doesNotMatch(after, /root\.appendChild\(stag\)/);
  assert.deepEqual(unmountedElements(after.split(/^\/\/---\s*$/m)[1]), []);
  void result;
});

function repairUnmountedAssets(dir) {
  const scenes = mountRepairPlan(dir).scenes.filter(item => item.ready);
  if (scenes.length) repairUnmountedScenes(dir, { log: () => {} });
  return scenes;
}

test('多行实参的声明：挂载插在语句之后，不会插进参数列表', t => {
  const scene = `// @layout 价格
root => {
  bg(root);
  const pA = priceCol(100, 'CLAUDE', ORANGE,
    ['Free', 'Pro', 'Max'],
    'Pro 20 美元 / 月');
  return { render(t) { void pA; } };
}`;
  const { text } = planMountFixes(scene);
  assert.match(text, /'Pro 20 美元 \/ 月'\);\n {2}root\.appendChild\(pA\);/);
  assert.equal(compiles(text), true);
});

test('判定只看挂载，不把已挂好的场判成空白', () => {
  assert.equal(looksLikeMountFailure('FAIL 第 1 场: `x` 创建了但没 append'), true);
  assert.equal(looksLikeMountFailure('本场采样未观测到文字或主体组件'), true);
  assert.equal(looksLikeMountFailure('对比度 1.05:1「额度」不足'), false);
  assert.equal(looksLikeMountFailure('时间轴 595 秒超过上限 480 秒'), false);
});

test('补挂载走受控写入：base_hash 过期时不硬写', t => {
  const dir = fixture(t, blankScene('第一场'));
  const stale = readEditFile(dir, 'scenes.src.js').base_hash;
  // 模拟外部改动
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), blankScene('第一场') + '\n');
  const result = repairUnmountedScenes(dir, { log: () => {} });
  assert.equal(result.changed, true, '重新读取后应能成功');
  assert.notEqual(readEditFile(dir, 'scenes.src.js').base_hash, stale);
  // 修完再跑一次不应重复插入
  const again = repairUnmountedScenes(dir, { log: () => {} });
  assert.equal(again.changed, false);
});
