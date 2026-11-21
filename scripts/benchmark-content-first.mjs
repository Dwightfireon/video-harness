#!/usr/bin/env node
/* Same-input local benchmark. Copies author inputs only into this run's own
 * temporary directory; no models, TTS, rendering or source-project mutations. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), at = args.indexOf('--dir');
if (at < 0 || !args[at + 1]) throw new Error('用法：node scripts/benchmark-content-first.mjs --dir <项目>');
const source = path.resolve(args[at + 1]);
const names = ['PROJECT.json', '方案.md', '脚本.md', 'claims.json', 'scenes.src.js', 'engine.tpl.html', 'gen.mjs', 'timeline.mjs', 'timing.json', '发布文案.md'];
const present = names.filter(name => fs.existsSync(path.join(source, name)));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = Object.fromEntries(present.map(name => [name, hash(path.join(source, name))]));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-content-first-benchmark-'));
const copy = label => {
  const project = path.join(temporary, label); fs.mkdirSync(project);
  for (const name of present) fs.copyFileSync(path.join(source, name), path.join(project, name));
  if (fs.existsSync(path.join(source, 'assets'))) fs.cpSync(path.join(source, 'assets'), path.join(project, 'assets'), { recursive: true, dereference: false });
  // Both use the same source metadata. --audit selects diagnostics without
  // changing PROJECT.json, so author and timing inputs stay byte-identical.
  return project;
};
try {
  const normal = copy('content-first'), audit = copy('full-diagnostics');
  const results = [];
  for (const mode of ['content-first', 'full-diagnostics', 'full-diagnostics', 'content-first']) {
    const start = performance.now();
    const result = spawnSync(process.execPath, [path.join(root, 'vh.mjs'), 'build', '--dir', mode === 'content-first' ? normal : audit,
      ...(mode === 'full-diagnostics' ? ['--audit'] : [])], { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    const elapsedMs = Math.round(performance.now() - start);
    if (result.status !== 0) throw new Error('基准构建失败（' + mode + '）：' + result.stdout + result.stderr);
    const project = mode === 'content-first' ? normal : audit;
    const review = JSON.parse(fs.readFileSync(path.join(project, 'out/subtitle-review.json'), 'utf8'));
    results.push({ mode, elapsedMs, cues: review.cues, subtitleProbes: review.probes, subtitleDisplayOk: review.ok,
      measuredLayoutReport: fs.existsSync(path.join(project, 'out/.vh-layout-measured.json')) });
  }
  const generatedBytesEqual = hash(path.join(normal, 'scene.html')) === hash(path.join(audit, 'scene.html'));
  const sourceUnchanged = present.every(name => hash(path.join(source, name)) === before[name]);
  if (!sourceUnchanged || !generatedBytesEqual) throw new Error('来源或生成内容字节不一致，不能报告可比基准');
  const means = Object.fromEntries(['content-first', 'full-diagnostics'].map(mode => [mode,
    Math.round(results.filter(r => r.mode === mode).reduce((sum, r) => sum + r.elapsedMs, 0) / 2)]));
  console.log(JSON.stringify({ version: 1, at: new Date().toISOString(), results, meanMs: means,
    reductionPercent: Math.round((1 - means['content-first'] / means['full-diagnostics']) * 1000) / 10,
    generatedBytesEqual, sourceUnchanged,
    scope: '同一修订、相同作者输入，默认 build 对比主动 build --audit，各两次交错；均保留全部字幕首中尾实显检查。不是旧版整体耗时基准，不包含模型、TTS、渲染、混流、试听或人工审阅，不据此推算整片提速。' }, null, 2));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
