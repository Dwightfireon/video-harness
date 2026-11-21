#!/usr/bin/env node
/* Offline full review orchestration, including hashing, isolation, persistence,
 * final validation and interruption/retry. Model responses/latency are fixtures;
 * request counts and JSON bytes are measured, not token or live-model estimates. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2), at = args.indexOf('--before');
if (at < 0 || !args[at + 1]) throw new Error('Usage: node scripts/benchmark-review-workflow.mjs --before <saved-module-directory>');
const file = path.join(path.resolve(args[at + 1]), 'content-review.mjs');
const beforeText = fs.readFileSync(file, 'utf8').replace(/from '(\.\/[^']+)'/g,
  (_m, relative) => `from '${pathToFileURL(path.resolve(root, 'lib', relative)).href}'`);
const modules = { before: await import('data:text/javascript;base64,' + Buffer.from(beforeText).toString('base64')),
  after: await import('../lib/content-review.mjs') };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fixtureLatencyMs = 10, sampleCount = 9;
const kinds = ['valid', 'duplicate-scene', 'invalid-reference', 'resume'];
const rows = [];
for (let sample = 0; sample < sampleCount; sample++) {
  for (const kind of kinds) for (const mode of sample % 2 ? ['after', 'before'] : ['before', 'after']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-review-workflow-bench-'));
    try {
      const api = modules[mode];
      for (const [name, text] of Object.entries({ 'PROJECT.json': '{}', 'claims.json': '[]',
        '方案.md': '已经知道：设备\n\n不知道 / 容易误解：无\n',
        '脚本.md': '**主体**：设备\n\n' + Array.from({ length: 16 }, (_, i) =>
          `## S${i + 1} · 设备检查\n← 依赖：无\n1. 工程师检查设备并保存检查记录。\n`).join('\n') })) fs.writeFileSync(path.join(dir, name), text);
      let requests = 0, requestBytes = 0, result;
      const start = performance.now(), cpu = process.cpuUsage();
      try {
        let interrupted = false;
        const run = () => api.reviewContentIndependently(dir, { provider: 'fixture', model: 'fixture', chat: async messages => {
          requests++; requestBytes += Buffer.byteLength(JSON.stringify(messages));
          const p = JSON.parse(messages[1].content);
          await delay(fixtureLatencyMs);
          if (kind === 'resume' && !interrupted && p.input?.shard.scenes[0] === 3) {
            interrupted = true; throw new Error('fixture interrupted');
          }
          const answer = p.phase === '仅听旁白复原'
            ? { scenes: p.narration.map(s => ({ scene: s.scene, understood: '检查设备并保存记录。', missing: [] })) }
            : { verdict: 'pass', question: '工程师做什么？', answer: '检查并保存记录。', scope: '直接陈述检查行为，没有跨域推断。',
              scenes: p.input.narration.map(s => ({ scene: s.scene, line: 1, takeaway: '记录检查结果。', bridge: '继续检查设备。' })),
              essentials: p.input.narration.map(s => ({ scene: s.scene, lines: [], reason: '直接陈述，没有额外前提。' })),
              links: [], analogies: [], findings: p.input.findings.map(f => ({ i: f.i, reason: '已核对。' })), issues: [] };
          if (p.input?.shard.scenes[0] === 2) {
            if (kind === 'duplicate-scene') answer.scenes.push({ ...answer.scenes[0] });
            if (kind === 'invalid-reference') answer.scenes[0].line = 999;
          }
          return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] };
        } });
        let status;
        try { status = await run(); }
        catch (error) { if (kind !== 'resume' || error.message !== 'fixture interrupted') throw error; status = await run(); }
        const { reviewedAt, ...record } = status.record;
        result = { ok: status.ok, state: status.state, record };
      } catch (error) {
        const category = /覆盖所有场/.test(error.message) ? 'coverage' : /索引越界/.test(error.message) ? 'reference' : null;
        if (!category) throw error;
        result = { ok: false, errorCategory: category, receiptExists: fs.existsSync(path.join(dir, 'out/.vh-content-review.json')) };
      }
      const used = process.cpuUsage(cpu);
      rows.push({ kind, mode, sample, wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000,
        requests, requestBytes, sha256: hash(result) });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
}
const quantile = (values, p) => values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const summary = [];
for (const kind of kinds) {
  const group = rows.filter(r => r.kind === kind);
  if (new Set(group.map(r => r.sha256)).size !== 1) throw new Error('Before/after outcome differs: ' + kind);
  for (const mode of ['before', 'after']) {
    const samples = group.filter(r => r.mode === mode);
    summary.push({ kind, mode, samples: samples.length, p50Ms: quantile(samples.map(r => r.wallMs), .5),
      p95Ms: quantile(samples.map(r => r.wallMs), .95), cpuP50Ms: quantile(samples.map(r => r.cpuMs), .5),
      requests: samples[0].requests, requestBytes: samples[0].requestBytes, sha256: samples[0].sha256 });
  }
}
console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, arch: process.arch },
  sourceSha256: { before: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    after: createHash('sha256').update(fs.readFileSync(path.join(root, 'lib/content-review.mjs'))).digest('hex') },
  scope: '16-scene review orchestration; fixture responses and 10ms per request, no external API. Valid records compared without reviewedAt; failure cases end at the first rejected run, compared by category and absence of passing receipt. Fail-fast defers later shards until repair; it does not prove fewer total requests to eventual success. Request bytes are JSON, not tokens or actual network traffic.',
  fixtureLatencyMs, summary, rows }, null, 2));
