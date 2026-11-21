import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireContentReview, contentReviewInputs, contentReviewStatus, reviewContentIndependently } from '../lib/content-review.mjs';

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-review-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, '方案.md'), '已经知道：设备\n\n不知道 / 容易误解：无\n');
  fs.writeFileSync(path.join(dir, 'claims.json'), '[]');
  fs.writeFileSync(path.join(dir, '脚本.md'), '**主体**：设备\n\n' + Array.from({ length: 8 }, (_, i) =>
    `## S${i + 1} · 设备检查\n← 依赖：无\n1. 工程师检查设备并保存检查记录。\n`).join('\n'));
  requireContentReview(dir);
  return dir;
}
const reply = value => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
function answer(payload) {
  if (payload.phase === '仅听旁白复原') return { scenes: payload.narration.map(s => ({ scene: s.scene, understood: '检查设备并保存记录。', missing: [] })) };
  return { verdict: 'pass', question: '工程师做什么？', answer: '检查并保存记录。', scope: '直接陈述检查行为，没有跨域推断。',
    scenes: payload.input.narration.map(s => ({ scene: s.scene, line: 1, takeaway: '记录检查结果。', bridge: '继续检查设备。' })),
    essentials: payload.input.narration.map(s => ({ scene: s.scene, lines: [], reason: '直接陈述，没有额外前提。' })),
    links: [], analogies: [], findings: payload.input.findings.map(f => ({ i: f.i, reason: '已核对。' })), issues: [] };
}
function review(dir, handle, model = 'fixture') {
  return reviewContentIndependently(dir, { provider: 'fixture', model, chat: async messages => {
    const payload = JSON.parse(messages[1].content);
    return reply(await handle(payload, answer(payload)));
  } });
}
const cacheFile = dir => path.join(dir, 'out/.vh-content-review-shards.json');

test('invalid shard stops later model requests, is not cached, and retry reuses only completed valid requests', async t => {
  const dir = project(t), seen = [];
  await assert.rejects(review(dir, (p, result) => {
    seen.push(p);
    if (p.input?.shard.scenes[0] === 2) result.scenes.push({ ...result.scenes[0] });
    return result;
  }), /覆盖所有场/);
  assert.equal(seen.length, 4, '2 blind shards + first judge + invalid second judge, not all 10 requests');
  assert.equal(contentReviewStatus(dir).ok, false);
  const signature = contentReviewInputs(dir).signature;
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(cacheFile(dir)))[signature]).length, 3);
  assert.ok(fs.readdirSync(path.join(dir, 'out/.vh-content-review-attempts')).length);
  const resumed = [];
  const status = await review(dir, (p, result) => { resumed.push(p); return result; });
  assert.equal(status.ok, true);
  assert.deepEqual(resumed.map(p => p.input.shard.scenes[0]), [2, 3, 4, 5, 6, 7, 8]);
  assert.equal(fs.existsSync(cacheFile(dir)), false, 'settled reviews cannot serve as a fresh review');
});

async function interrupted(dir) {
  await assert.rejects(review(dir, (p, result) => {
    if (p.input?.shard.scenes[0] === 3) throw new Error('fixture interrupted');
    return result;
  }), /fixture interrupted/);
}

test('corrupt cached scenes or references are rejected and only the affected requests are reissued', async t => {
  for (const corrupt of [part => part.scenes.push({ ...part.scenes[0] }), part => { part.scenes[0].line = 999; }]) {
    const dir = project(t);
    await interrupted(dir);
    const cache = JSON.parse(fs.readFileSync(cacheFile(dir))), signature = contentReviewInputs(dir).signature;
    const part = Object.values(cache[signature]).find(p => p.verdict && p.scenes[0].scene === 2);
    corrupt(part); fs.writeFileSync(cacheFile(dir), JSON.stringify(cache));
    const seen = [];
    const status = await review(dir, (p, result) => { seen.push(p); return result; });
    assert.equal(status.ok, true);
    assert.deepEqual(seen.map(p => p.input.shard.scenes[0]), [2, 3, 4, 5, 6, 7, 8]);
  }
});

test('different model or missing resume marker must not reuse prior answers', async t => {
  for (const mode of ['model', 'orphan']) {
    const dir = project(t);
    await interrupted(dir);
    if (mode === 'orphan') fs.unlinkSync(path.join(dir, 'out/.vh-content-review-in-progress.json'));
    const seen = [];
    const status = await review(dir, (p, result) => { seen.push(p); return result; }, mode === 'model' ? 'different-model' : 'fixture');
    assert.equal(status.ok, true);
    assert.equal(seen.length, 10, 'both isolated phases run again, with all eight scenes');
  }
});

test('local validation preserves cross-scene references and the global blind-gap downgrade', async t => {
  for (const blindGap of [false, true]) {
    const dir = project(t);
    fs.writeFileSync(path.join(dir, '脚本.md'), '**主体**：设备\n\n' + [...'甲乙丙丁戊己庚辛'].map((label, i) =>
      `## S${i + 1} · 设备检查\n← 依赖：无\n1. 工程师打开${label}设备。\n2. 工程师检查${label}设备。\n3. 工程师记录${label}设备结果。\n`).join('\n'));
    const status = await review(dir, (p, result) => {
      if (p.phase === '仅听旁白复原') {
        if (blindGap) for (const scene of result.scenes) if (scene.scene === 3) scene.missing.push('缺少检查依据。');
      } else if (p.input.shard.scenes[0] === 2) {
        result.links = [{ premise: { scene: 1, line: 1 }, middle: blindGap
          ? { missing: '尚未讲清检查依据。' } : { scene: 2, line: 2 }, conclusion: { scene: 3, line: 3 } }];
      }
      return result;
    });
    assert.equal(status.state, blindGap ? 'revise' : 'declared-pass');
    assert.equal(status.record.links[0].premise, '工程师打开甲设备。');
    if (blindGap) assert.match(status.reason, /缺少检查依据/);
  }
});
