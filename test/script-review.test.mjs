import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze as analyzeClarity } from '../lib/clarity.mjs';
import {
  resolveReviewModel, buildReviewPrompt, parseReviewOutput, runScriptReview,
} from '../lib/script-review.mjs';
import { writeSettings } from '../lib/provider-settings.mjs';

function makeProject(t, script, { plan = '已经知道：常见软件\n\n不知道：术语甲\n' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-script-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, '方案.md'), plan);
  fs.writeFileSync(path.join(dir, '脚本.md'), script);
  return dir;
}

test('clarity 检测开场术语过密、单场术语过密与百分比未入来源表', t => {
  const script = [
    '# 测试脚本',
    '',
    '## S1 · 开场',
    '1. 析氧反应指的是把水变成氧气，过电位是额外电压，共价性是电子云重叠。',
    '2. 实验成功率达到了 81.18%。',
    '← 依赖：无',
    '',
    '## 术语',
    '- 析氧反应：把水变成氧气。',
    '- 过电位：额外电压。',
    '- 共价性：电子云重叠。',
    '',
    '## 数字与来源',
    '| 数字/事实 | 性质 | 来源与口径 |',
    '|---|---|---|',
    '| 50% | 论文 | 示例来源 |',
  ].join('\n');
  const dir = makeProject(t, script);
  const res = analyzeClarity(dir);
  assert.ok(res.warn.some(w => w.includes('开场 S1 集中出现 3 个专业术语')));
  assert.ok(res.warn.some(w => w.includes('81.18%') && w.includes('数字与来源')));
});

test('clarity 检测反人类长精确数字口播与过多场数预警，且审校提示词含最小必要前提原则', t => {
  const scenes = Array.from({ length: 10 }, (_, i) => [
    `## S${i + 1} · 场次${i + 1}`,
    i === 0 ? '1. 上下文窗口是一百零四万八千五百七十六个单位，输出上限六万五千五百三十六。' : '1. 这里推进下一步具体变化。',
    i === 0 ? '← 依赖：无' : `← 依赖：S${i}`,
    '',
  ].join('\n')).join('\n');
  const dir = makeProject(t, `# 测试\n\n${scenes}`);
  const res = analyzeClarity(dir);
  assert.ok(res.warn.some(w => w.includes('一百零四万八千五百七十六')));
  assert.ok(res.warn.some(w => w.includes('10 场偏多')));
  const prompt = buildReviewPrompt({ script: scenes, clarity: res, pacing: { findings: [] } });
  assert.match(prompt, /最小必要前提/);
  assert.match(prompt, /一百零四万八千五百七十六/);
});

test('resolveReviewModel 按 CLI > 环境变量 > 设置文件 reviewModel > 默认模型分层', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-review-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeSettings({ preferredProvider: 'opencode-go', models: { 'opencode-go': 'hy4-flash-free' } }, home);
  assert.deepEqual(resolveReviewModel({ env: {}, home }), { model: 'opencode-go/hy4-flash-free', source: 'provider-settings' });
  const settingsFile = path.join(home, '.config', 'video-harness', 'providers.json');
  const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  raw.reviewModel = 'opencode-go/kimi-k2.5';
  fs.writeFileSync(settingsFile, JSON.stringify(raw, null, 2));
  assert.deepEqual(resolveReviewModel({ env: {}, home }), { model: 'opencode-go/kimi-k2.5', source: 'provider-settings:reviewModel' });
  assert.deepEqual(resolveReviewModel({ env: { VH_REVIEW_MODEL: 'opendesign/deepseek-v4.1-flash' }, home }),
    { model: 'opendesign/deepseek-v4.1-flash', source: 'env:VH_REVIEW_MODEL' });
  assert.deepEqual(resolveReviewModel({ explicit: 'commandcode/claude-sonnet', env: { VH_REVIEW_MODEL: 'opendesign/deepseek-v4.1-flash' }, home }),
    { model: 'commandcode/claude-sonnet', source: 'cli:--model' });
});

test('parseReviewOutput 自动将含 high 问题的审校判定为 revise 并规范字段', () => {
  const out = parseReviewOutput('```json\n{"verdict":"pass","summary":"整体不错但有越界","strengths":["例子清晰"],"issues":[{"scene":"S2","category":"accuracy","severity":"high","quote":"成功率99%","problem":"原文分母仅为测试集子集","fix":"补充分母范围"}]}\n```');
  assert.equal(out.verdict, 'revise');
  assert.equal(out.issues.length, 1);
  assert.equal(out.issues[0].category, 'accuracy');
  assert.equal(out.issues[0].severity, 'high');
});

test('runScriptReview 写入 JSON 与 审查-文稿.md，并携带本地体检线索', async t => {
  const dir = makeProject(t, '## S1 · 开场\n1. 这是一个具体例子，先说清发生了什么。\n← 依赖：无\n');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-review-run-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeSettings({ preferredProvider: 'opencode-go', models: { 'opencode-go': 'hy4-flash-free' } }, home);
  let capturedPrompt = '';
  const result = await runScriptReview(dir, {
    home,
    env: {},
    runner: async ({ prompt, model }) => {
      capturedPrompt = prompt;
      assert.equal(model, 'opencode-go/hy4-flash-free');
      return JSON.stringify({
        verdict: 'pass',
        summary: '开场直觉清晰，因果连贯。',
        strengths: ['例子具体'],
        issues: [],
      });
    },
  });
  assert.equal(result.review.verdict, 'pass');
  assert.ok(capturedPrompt.includes('待审脚本'));
  assert.equal(fs.existsSync(path.join(dir, 'out/.vh-script-review.json')), true);
  const md = fs.readFileSync(path.join(dir, '审查-文稿.md'), 'utf8');
  assert.match(md, /通过（可进入分镜）/);
  assert.match(md, /opencode-go\/hy4-flash-free/);
});
