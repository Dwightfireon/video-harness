import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';
import { RECIPES } from '../lib/scene-recipes.mjs';
import { withSceneMetadata } from '../lib/scene-metadata.mjs';

const vh = path.resolve('vh.mjs');
const script = '# 视觉配方测试\n\n**主体**：Agent 使用工具\n\n## S1 · 流程\n1. 模型判断是否需要工具。\n2. 工具执行请求并返回结果。\n3. 模型结合结果生成答复。\n4. 工具权限因系统而异。\n← 依赖：无\n';
const intent = { focus: '顺序中的当前节点', hierarchy: '文字优先于关系线', restraint: '不用卡片', rhythm: '按三句旁白依次展开' };
const source = () => withSceneMetadata(RECIPES['process-steps'].code()
  .replace('这里放<b class="hl">流程标题</b>', '工具如何参与<b class="hl">回答</b>')
  .replace("['第一步：____', '第二步：____', '第三步：____']", "['提出任务', '调用工具', '整理结果']")
  .replace('补一句边界：什么情况不适用', '工具权限因系统而异')
  .replace('const cueLines = null;', "const cueLines = ['模型判断是否需要工具', '工具执行请求并返回结果', '模型结合结果生成答复'];"),
{ layout: '流程关系', visual: intent });
const run = args => spawnSync(process.execPath, [vh, ...args], { encoding: 'utf8', timeout: 60000 });

for (const aspect of ['16:9', '9:16']) {
  test(`真实生成器和浏览器：${aspect} 流程按字幕锚点展开，版式安全、乱序采样一致`, { timeout: 120000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-visual-recipe-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let result = run(['new', dir, '--aspect', aspect]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    fs.writeFileSync(path.join(dir, '脚本.md'), script);
    fs.writeFileSync(path.join(dir, 'scenes.src.js'), source() + '\n');
    result = run(['build', '--estimate', '--audit', '--dir', dir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const layout = JSON.parse(fs.readFileSync(path.join(dir, 'out/.vh-layout-measured.json'), 'utf8'));
    assert.ok(layout.sampled > 0);
    assert.deepEqual(layout.findings, [], '真实浏览器布局：' + JSON.stringify(layout.findings));
    assert.ok(fs.readFileSync(path.join(dir, 'scene.html'), 'utf8').includes('// @visual '));

    const browser = await launchBrowser(chromium, { headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(dir, 'scene.html')).href);
    await page.evaluate(async () => { if (window.__ready) await window.__ready; });
    const timing = await page.evaluate(() => {
      const root = document.querySelector('[data-vh-scene-start]');
      return ['模型判断是否需要工具', '工具执行请求并返回结果', '模型结合结果生成答复']
        .map(text => window.VH_FILM.sceneCue(root, text) + Number(root.dataset.vhSceneStart));
    });
    assert.ok(timing[0] < timing[1] && timing[1] < timing[2]);
    const snap = async time => page.evaluate(async time => {
      await window.renderAt(time);
      const scene = document.querySelector('[data-vh-scene-start]');
      return ['提出任务', '调用工具', '整理结果'].map(text => {
        const el = [...scene.querySelectorAll('div')].find(node => node.textContent === text);
        return { text, opacity: el?.style.opacity, transform: el?.style.transform };
      });
    }, time);
    const mid = timing[1] + .2;
    const first = await snap(mid);
    await snap(timing[2] + 1);
    assert.deepEqual(await snap(mid), first, '同一时间不依赖前一帧');
    assert.equal(first[0].opacity, '1');
    assert.equal(first[2].opacity, '0', '第三步不可在对应句子开始前提前显示');
    assert.equal((await snap(timing[2] + 1))[2].opacity, '1');
    const positions = await page.evaluate(() => {
      const elements = [...document.querySelector('[data-vh-scene-start]').querySelectorAll('[data-vh-role="decoration"]')];
      return elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2 };
      });
    });
    assert.equal(positions.length, 4, '关系线和三个节点均存在');
    const [line, firstDot, , lastDot] = positions;
    if (aspect === '9:16') {
      assert.ok(Math.abs(line.centerX - firstDot.centerX) <= 1 && Math.abs(line.top - firstDot.centerY) <= 1 &&
        Math.abs(line.bottom - lastDot.centerY) <= 1, '纵向连线首尾连接节点中心');
    } else {
      assert.ok(Math.abs(line.centerY - firstDot.centerY) <= 1 && Math.abs(line.left - firstDot.centerX) <= 1 &&
        Math.abs(line.right - lastDot.centerX) <= 1, '横向连线首尾连接节点中心');
    }
  });
}

for (const [key, layoutName] of [['funnel-flow', '漏斗损耗'], ['state-chain', '主体状态演进'], ['curve-reveal', '曲线演进']]) {
  for (const aspect of ['16:9', '9:16']) {
    test(`新机制图元 ${key}（${aspect}）：真实构建与停稳帧硬伤快检 0 问题`, { timeout: 120000 }, async t => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vh-recipe-${key}-`));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      let result = run(['new', dir, '--aspect', aspect]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      fs.writeFileSync(path.join(dir, '脚本.md'), script);
      fs.writeFileSync(path.join(dir, 'scenes.src.js'), withSceneMetadata(RECIPES[key].code(), { layout: layoutName }) + '\n');
      result = run(['build', '--estimate', '--dir', dir]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const fast = run(['visual-fast', '--strict', '--json', '--dir', dir]);
      assert.equal(fast.status, 0, fast.stdout + fast.stderr);
      const parsed = JSON.parse(fast.stdout);
      assert.equal(parsed.ok, true, JSON.stringify(parsed.findings));
      assert.equal(parsed.sampled, 1);
    });
  }
}
