import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runVisualReview, reviewSummary } from '../lib/visual-review.mjs';

function fixture(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-review-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('检查器真的被执行：不再出现 run is not a function', async t => {
  const dir = fixture(t, {
    'scenes.src.js': "root => { const a = mk('div','','标题'); abs(a,140,300,800,100); root.appendChild(a); return { render() {} }; }",
    'scene.html': 'const DURATION = 10; const scenes = []; addScene(0,10,root=>({})); const SUBS = [{"s":0,"e":5,"t":"一句旁白"}];',
    '脚本.md': '## S1 · 开场\n1. 一句旁白。\n',
  });
  const review = await runVisualReview(dir);
  assert.equal(review.checks.length, 7);
  assert.ok(review.checks.some(c => c.name === '动作时间点（静态线索）' && c.count > 0));
  assert.ok(review.checks.some(c => c.name === '连续运动/视听审阅' && c.status === 'skipped'));
  for (const check of review.checks) {
    assert.notEqual(check.status, 'failed', check.name + ' 不应该失败：' + check.error);
  }
  assert.equal(review.failed, 0);
});

test('检查失败不能被当成“0 处疑点 / 通过”', async t => {
  const dir = fixture(t, {});
  const review = await runVisualReview(dir);
  const summary = reviewSummary(review);
  // 没有场景文件时，各检查会给出空结果或明确失败；关键是失败的项必须让整体不通过
  if (review.failed) {
    assert.equal(review.ok, false);
    assert.match(summary, /检查失败|结论无效/);
  } else {
    assert.equal(review.ok, false, '像素级检查未执行时不能宣称全面通过');
    assert.match(summary, /未执行|本轮未运行/);
  }
});

test('真实疑点会进入报告与摘要，不会被静默吞掉', async t => {
  const dir = fixture(t, {
    'scenes.src.js': "root => { const t = line('这是画面正文和旁白一模一样的一句话'); abs(t.el,140,300,1600,100); root.appendChild(t.el); return { render() {} }; }",
    'scene.html': 'const DURATION = 10; const scenes = []; addScene(0,10,root=>({})); const SUBS = [{"s":0,"e":9,"t":"这是画面正文和旁白一模一样的一句话"}];',
    '脚本.md': '## S1 · 开场\n1. 这是画面正文和旁白一模一样的一句话\n',
  });
  const review = await runVisualReview(dir);
  assert.ok(review.total >= 1, '应当报出图文重复：' + JSON.stringify(review.checks));
  assert.match(reviewSummary(review), /疑点/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'out/.vh-visual-review.json'), 'utf8'));
  assert.equal(saved.total, review.total);
});
