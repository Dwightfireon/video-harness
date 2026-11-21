import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pick, report } from '../lib/recipe-pick.mjs';

/* 版式建议：为什么值得测（以及边界在哪）
   配方库做出来了，但"这场该用哪个"仍是人的判断，agent 于是继续用列表——
   工具没被用等于没有。这里做的是**可解释的规则匹配**，不是意图猜测。
   所以测两件事：
     ① 有明确线索时能认出来（并且给出依据）
     ② 没线索时**必须说没把握**，不能硬塞一个建议（硬塞比不建更糟） */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vh-pick-'));

function makeProject(title, lines) {
  const d = tmp();
  fs.writeFileSync(path.join(d, '脚本.md'),
    `# 测试\n\n**主体**：测试\n\n## S1 · ${title}\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\n← 依赖：无\n`, 'utf8');
  return d;
}

test('pick：有前后变化的两组数字 → 条形对比（高把握）', () => {
  const d = makeProject('前端', [
    '一个 bundle 从 2MB 降到 400KB，首屏就快了两秒。',
    '快两秒对转化率的影响，比任何文案都直接。',
  ]);
  const r = pick(d);
  assert.equal(r.scenes[0].key, 'compare-bars');
  assert.equal(r.scenes[0].confidence, 'high');
  assert.match(r.scenes[0].why, /量|变化|比较/);
});

test('pick：明确说了先后 → 三步流程', () => {
  const d = makeProject('发布', [
    '先跑一遍测试，再打包镜像，最后推到仓库。',
    '顺序不能反，反了就得回滚。',
  ]);
  const r = pick(d);
  assert.equal(r.scenes[0].key, 'process-steps');
});

test('pick：讲界面操作 → 窗口实拍感（要有可看的界面，不只是提到"部署"）', () => {
  const d = makeProject('配置', [
    '打开面板，点一下右上角的设置，返回里会多一行日志。',
    '这一行就是问题的答案。',
  ]);
  const r = pick(d);
  assert.equal(r.scenes[0].key, 'window-walkthrough');
});

test('pick：只提"部署""配置"这类词，不算有界面可拍', () => {
  const d = makeProject('部署', [
    '部署这一层最容易忽略的是时区和编码。',
    '两行环境变量能省掉半天排查。',
  ]);
  const r = pick(d);
  assert.notEqual(r.scenes[0].key, 'window-walkthrough',
    '只提到部署词不该判成窗口场：' + JSON.stringify(r.scenes[0]));
});

test('pick：一句判断 → 大字断言', () => {
  const d = makeProject('结论', [
    '真正的边界不在技术选型，而在层与层之间的契约。',
  ]);
  const r = pick(d);
  assert.equal(r.scenes[0].key, 'hero-statement');
});

test('pick：没有任何线索 → 必须说"你定"，不硬塞建议', () => {
  const d = makeProject('随便', [
    '这一期我们聊聊这件事。',
  ]);
  const r = pick(d);
  assert.equal(r.scenes[0].key, null);
  assert.equal(r.scenes[0].confidence, 'none');
  assert.match(report(r), /你定/);
});

test('pick：中文数字（两分钟/四十分钟）也算量', () => {
  const d = makeProject('反例', [
    '改一行的回归时间，从两分钟涨到四十分钟。',
    '拆开的成本永远低于不拆的代价。',
  ]);
  const r = pick(d);
  assert.equal(r.scenes[0].key, 'compare-bars', JSON.stringify(r.scenes[0]));
});

test('pick：报告里给依据，不只给名字', () => {
  const d = makeProject('前端', [
    '一个 bundle 从 2MB 降到 400KB，首屏就快了两秒。',
  ]);
  const t = report(pick(d));
  assert.match(t, /依据/);
  assert.match(t, /这是建议表，不是自动改写/);
});

test('pick：多场各自独立判断（不会一场定全片）', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, '脚本.md'),
    `# 测试\n\n**主体**：测试\n\n## S1 · 结论\n1. 真正的边界不在技术，而在契约。\n\n← 依赖：无\n\n` +
    `## S2 · 数据\n1. 连接池从 100 涨到 240，池子立刻见底。\n\n← 依赖：S1\n`, 'utf8');
  const r = pick(d);
  assert.equal(r.scenes.length, 2);
  assert.notEqual(r.scenes[0].key, r.scenes[1].key);
});
