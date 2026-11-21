#!/usr/bin/env node
/* Offline, synthetic, fresh-process measurements of real runtime entry points.
 * No model/network calls or user projects; no cache/quality policy changes.
 * --before <dir> compares exact saved modules against the current modules.
 * Each case has warmup, raw samples, CPU, process high-water RSS and output hash.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const hash = value => createHash('sha256').update(value).digest('hex');
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const cases = ['task-1024', 'task-5120', 'sse-8', 'sse-128', 'sse-512', 'sse-2048', 'sse-2048-65536'];

async function load(name) {
  if (!args.includes('--source')) return import(pathToFileURL(path.join(root, 'lib', name)).href);
  // Saved modules keep their exact code; relative imports resolve to unchanged
  // dependencies in lib/. This is only for these two self-contained modules.
  const text = fs.readFileSync(path.join(option('--source'), name), 'utf8')
    .replace(/from '(\.\/[^']+)'/g, (_m, relative) => `from '${pathToFileURL(path.resolve(root, 'lib', relative)).href}'`);
  return import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
}

async function worker(name) {
  const [kind, kib, chunkSize = '1024'] = name.split('-');
  let operation, cleanup = () => {}, checkpoint = null;
  if (kind === 'task') {
    const { taskStatus } = await load('task-status.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-runtime-benchmark-'));
    cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    const task = { schemaVersion: 1, id: 'fixture', attemptId: 'attempt', status: 'paused',
      mode: 'article', message: 'Resume fixture', startedAt: 1, updatedAt: 1, pid: null };
    checkpoint = path.join(dir, 'out/.vh-tasks/fixture/checkpoint.json');
    fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
    fs.writeFileSync(path.join(dir, 'out/.vh-task.json'), JSON.stringify(task));
    fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
    const messages = [{ role: 'user', content: 'Fixture' }];
    for (let i = 0; i < Number(kib) / 16; i++) messages.push({ role: 'assistant', content: 'x'.repeat(16 * 1024) });
    fs.writeFileSync(checkpoint, JSON.stringify({ schemaVersion: 1, taskId: task.id, attemptId: task.attemptId,
      status: 'paused', mode: task.mode, messages, pending: [], pipelineState: {} }));
    operation = () => taskStatus(dir, { includeDeliverable: false });
  } else {
    const { readResponseText, parseChatSSE } = await load('provider-response.mjs');
    const event = content => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n';
    const unit = event('fixture中'.repeat(16));
    const bytes = Buffer.from(unit.repeat(Math.ceil(Number(kib) * 1024 / Buffer.byteLength(unit))) +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    operation = async () => {
      let offset = 0;
      const body = new ReadableStream({ pull(controller) {
        if (offset >= bytes.length) { controller.close(); return; }
        const end = Math.min(offset + Number(chunkSize), bytes.length);
        controller.enqueue(bytes.subarray(offset, end)); offset = end;
      } });
      return parseChatSSE(await readResponseText(new Response(body, { headers: { 'content-type': 'text/event-stream' } })));
    };
  }
  const readFile = fs.readFileSync;
  let reads = 0, readBytes = 0;
  fs.readFileSync = function(file, ...rest) {
    const result = readFile.call(this, file, ...rest);
    if (file === checkpoint) { reads++; readBytes += Buffer.byteLength(result); }
    return result;
  };
  try {
    for (let i = 0; i < 3; i++) await operation();
    const rows = [], hashes = new Set();
    for (let i = 0; i < 25; i++) {
      global.gc?.(); reads = 0; readBytes = 0;
      const cpu = process.cpuUsage(), start = performance.now();
      const heartbeat = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
      const result = await operation();
      const wallMs = performance.now() - start, used = process.cpuUsage(cpu);
      rows.push({ wallMs, cpuMs: (used.user + used.system) / 1000,
        eventLoopDelayMs: await heartbeat, checkpointReads: reads, checkpointReadBytes: readBytes });
      // Fresh children have different temporary roots. Normalize only that
      // observational path; all decisions, notices and recovery fields remain.
      const comparable = kind === 'task' ? { ...result,
        productionLock: { ...result.productionLock, project: '<fixture>' } } : result;
      hashes.add(hash(JSON.stringify(comparable)));
    }
    if (hashes.size !== 1) throw new Error('Non-deterministic result');
    return { case: name, samples: rows.length, sha256: [...hashes][0],
      p50Ms: quantile(rows.map(r => r.wallMs), 0.5), p95Ms: quantile(rows.map(r => r.wallMs), 0.95),
      cpuP50Ms: quantile(rows.map(r => r.cpuMs), 0.5),
      eventLoopP50Ms: quantile(rows.map(r => r.eventLoopDelayMs), 0.5),
      operationsPerSecond: rows.length / (rows.reduce((n, r) => n + r.wallMs, 0) / 1000),
      maxRssKiB: process.resourceUsage().maxRSS, rows };
  } finally { fs.readFileSync = readFile; cleanup(); }
}

if (args.includes('--worker')) {
  console.log(JSON.stringify(await worker(option('--case'))));
} else {
  const results = [];
  for (const [i, name] of cases.entries()) {
    const modes = args.includes('--before') ? (i % 2 ? ['after', 'before'] : ['before', 'after']) : ['current'];
    for (const mode of modes) {
      const child = spawnSync(process.execPath, ['--expose-gc', import.meta.filename, '--worker', '--case', name,
        ...(mode === 'before' ? ['--source', path.resolve(option('--before'))] : [])],
      { encoding: 'utf8', timeout: 120000 });
      if (child.status !== 0) throw new Error(child.stderr || 'Benchmark child failed');
      results.push({ mode, ...JSON.parse(child.stdout) });
    }
    const pair = results.filter(r => r.case === name);
    if (new Set(pair.map(r => r.sha256)).size !== 1) throw new Error('Before/after output mismatch: ' + name);
  }
  console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, arch: process.arch,
    cpus: os.cpus().length, totalMemory: os.totalmem() },
    scope: 'Synthetic warm-cache entry-point timings, not HTTP latency or whole-video throughput. RSS is per fresh child including warmup/fixtures/GC. No network or model calls.', results }, null, 2));
}
