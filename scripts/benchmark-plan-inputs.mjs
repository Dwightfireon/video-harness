#!/usr/bin/env node
/* Compare equivalent plans with/without the old redundant input observation.
 * Only synthetic assets; no model, renderer, user project or weakened checks. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipelinePlan } from '../lib/pipeline-plan.mjs';
import { currentArtifactInputs } from '../lib/artifact-status.mjs';
import { snapshot } from '../lib/state.mjs';
import { createSnapshotService } from '../lib/snapshot-service.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-plan-benchmark-'));
try {
  fs.mkdirSync(path.join(dir, 'assets'));
  for (const [name, value] of Object.entries({ 'PROJECT.json': '{"deliveryTarget":"video"}',
    '脚本.md': '## S1\n1. 基准测试。\n', 'scenes.src.js': '// synthetic\n', 'engine.tpl.html': '',
    'scene.html': 'const DURATION=3; const scenes=[]; addScene(0,3,()=>({}));',
    'gen.mjs': '// unused', 'voice-kokoro.py': '# unused' })) fs.writeFileSync(path.join(dir, name), value);
  const asset = fs.openSync(path.join(dir, 'assets/fixture.bin'), 'wx');
  try { const block = Buffer.alloc(1024 * 1024, 0xa5); for (let i = 0; i < 128; i++) fs.writeSync(asset, block); }
  finally { fs.closeSync(asset); }
  const deps = { machine: { cpus: 4, freeMemory: 8 * 1024 ** 3 },
    diskObservation: () => ({ freeBytes: 1024 ** 4, volume: 'synthetic' }) };
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  // Warm the same file/page cache before the interleaved observations.
  pipelinePlan(dir, {}, deps);
  const rows = [];
  for (const mode of ['before', 'after', 'after', 'before', 'before', 'after', 'after', 'before', 'before', 'after']) {
    const start = performance.now();
    if (mode === 'before') currentArtifactInputs(dir); // old plan's extra full input scan
    const plan = pipelinePlan(dir, {}, deps);
    rows.push({ mode, elapsedMs: Math.round(performance.now() - start), sha256: digest(plan) });
  }
  if (new Set(rows.map(row => row.sha256)).size !== 1) throw new Error('计划结果不同，不能认定优化有效');
  const service = createSnapshotService(), stateRows = [];
  try {
    // Warm OS/module and input caches; every full snapshot still retires its
    // worker. A zero-delay timer is not a network/whole-video benchmark.
    await service.read(dir);
    for (const mode of ['direct', 'worker', 'worker', 'direct', 'direct', 'worker']) {
      const start = performance.now();
      const heartbeat = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
      const operation = mode === 'direct' ? snapshot(dir) : service.read(dir);
      const [timerMs, state] = await Promise.all([heartbeat, operation]);
      stateRows.push({ mode, timerMs: Math.round(timerMs), completeMs: Math.round(performance.now() - start), sha256: digest(state) });
    }
    if (new Set(stateRows.map(row => row.sha256)).size !== 1) throw new Error('工作台快照结果不同');
  } finally { service.close(); }
  console.log(JSON.stringify({ scope: '合成128 MiB素材；热缓存交替测量同一只读计划及完整快照，不代表完整制作耗时', rows, stateRows }, null, 2));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
