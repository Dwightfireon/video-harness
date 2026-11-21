import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { currentArtifactInputs, createArtifactRecord, mediaFingerprint } from '../lib/artifact-status.mjs';
import { saveState } from '../lib/state.mjs';
import { productionQualityStatus } from '../lib/production-quality.mjs';
import { readProductionLock } from '../lib/production-lock.mjs';
import { runAgent } from '../lib/agent.mjs';
import { classifyProductionFailure } from '../lib/production-failure.mjs';

const vh = path.resolve('vh.mjs'), digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-auto-cli-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = name => path.join(dir, name), subs = [{ s: .2, e: .8, t: '窗口里的内容。' }]; fs.mkdirSync(p('out'));
  const files = { 'PROJECT.json': '{"deliveryTarget":"video"}', '方案.md': '方案', 'claims.json': '[]',
    '脚本.md': '## S1 · 窗口\n1. 窗口里的内容。\n', 'scenes.src.js': 'root => ({render(t){}})',
    'engine.tpl.html': "const ORIENT = 'landscape';", 'timeline.mjs': 'export const scriptGroups=()=>[];export const validateTiming=d=>({subs:d.subs,total:d.dur});',
    'timing.json': JSON.stringify({ schemaVersion: 1, textHash: digest([subs[0].t]), groupsHash: digest([[subs[0].t]]), measurement: { voice: 'test', speed: 1 }, dur: 1, scenes: [[.1, 1]], subs }),
    'scene.html': `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000;color:white;overflow:hidden}#title{position:absolute;top:100px;left:80px;font:40px sans-serif}#subbox{position:absolute;left:80px;top:900px;width:800px;height:100px;font:32px sans-serif}</style><div id="title">一个窗口</div><div id="subbox"></div><script>window.W=1920;window.H=1080;const ORIENT = 'landscape';const DURATION = 1;const SUBS = ${JSON.stringify(subs)};const scenes = [];function addScene(a,b,f){scenes.push([a,b,f]);}addScene(.1,1,root=>({}));window.renderAt=t=>{document.querySelector('#subbox').textContent=t>=.2&&t<.8?'窗口里的内容。':'';};</script>`,
    'gen.mjs': 'throw new Error("有效构建不得重跑")', 'voice-kokoro.py': 'raise RuntimeError("有效音轨不得重混")' };
  // Standard generated numeric literals use a leading zero.
  files['scene.html'] = files['scene.html'].replace('addScene(.1,1,', 'addScene(0.1,1,');
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(p(name), text);
  const result = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=64x36:rate=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:d=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', p('out/video-voice.mp4')], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); fs.copyFileSync(p('out/video-voice.mp4'), p('out/video.mp4'));
  const input = currentArtifactInputs(dir);
  saveState(dir, { genStamp: { scriptHash: input.sourceHashes['脚本.md'], scenesHash: input.sourceHashes['scenes.src.js'], sourceHashes: input.sourceHashes },
    lastMeasure: { scriptHash: input.sourceHashes['脚本.md'] }, render: { artifact: createArtifactRecord(dir, 'render') }, voice: { artifact: createArtifactRecord(dir, 'voice') } });
  return { dir, p };
}
function cli(dir, ...args) { return spawnSync(process.execPath, [vh, ...args, '--dir', dir], { encoding: 'utf8', timeout: 30000 }); }

test('真实无人CLI：复用媒体→独立字幕→真实浏览器/解码/音频质检，不伪造人工审阅；agent复用关口零模型请求', async t => {
  const { dir, p } = fixture(t), before = mediaFingerprint(p('out/video-voice.mp4'));
  const result = cli(dir, 'go', '--unattended'); assert.equal(result.status, 0, result.stderr + result.stdout);
  const quality = productionQualityStatus(dir, { profile: 'technical' });
  assert.equal(quality.ok, true); assert.equal(quality.receipt.profile, 'technical');
  for (const id of ['contrast', 'layout']) {
    const check = quality.receipt.checks.find(check => check.id === id);
    assert.deepEqual({ ok: check.ok, status: check.status, required: check.required }, { ok: null, status: 'not-run', required: false });
  }
  assert.equal(productionQualityStatus(dir).ok, false, 'technical cannot satisfy the explicit/default strict status API');
  assert.deepEqual(mediaFingerprint(p('out/video-voice.mp4')), before);
  assert.equal(fs.existsSync(p('审查.md')), false); assert.equal(readProductionLock(dir).busy, false);
  let requests = 0;
  const agent = await runAgent(dir, '完成当前版本', { mode: 'article', automation: true,
    providers: [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }],
    request: async () => { requests++; throw new Error('确定性最终检查不应调用模型'); } });
  assert.equal(agent.status, 'completed'); assert.equal(requests, 0);
});
test('真实无人render：未知自定义renderer不隐式force；默认不拦审美问题，但隐藏字幕和运行错误即使force仍阻断', t => {
  const { dir, p } = fixture(t);
  const renderer = '/* vh:renderer-performance-v1 */\nconsole.log("RENDER_ARGS="+JSON.stringify(process.argv.slice(2)));process.exit(23);';
  fs.writeFileSync(p('render.mjs'), renderer);
  const result = cli(dir, 'render', '--unattended', '--all'); assert.equal(result.status, 23, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout.match(/RENDER_ARGS=(.*)/)[1]).includes('--force'), false);
  assert.equal(fs.readFileSync(p('render.mjs'), 'utf8'), renderer, 'unknown renderer must not be rewritten');
  assert.equal(productionQualityStatus(dir, { phase: 'pre-render', profile: 'technical' }).ok, true);
  const html = fs.readFileSync(p('scene.html'), 'utf8');
  fs.writeFileSync(p('scene.html'), html.replace('color:white', 'color:#010101')
    .replace('<div id="subbox">', '<div id="title">完全重叠的标题</div><div id="subbox">'));
  const aesthetics = cli(dir, 'render', '--unattended', '--all');
  assert.equal(aesthetics.status, 23, aesthetics.stderr + aesthetics.stdout);
  assert.equal(JSON.parse(aesthetics.stdout.match(/RENDER_ARGS=(.*)/)[1]).includes('--force'), false);
  const technical = productionQualityStatus(dir, { phase: 'pre-render', profile: 'technical' });
  assert.equal(technical.ok, true);
  for (const id of ['contrast', 'layout']) assert.equal(technical.receipt.checks.find(check => check.id === id).status, 'not-run');
  fs.writeFileSync(p('scene.html'), html.replace('#subbox{', '#subbox{visibility:hidden;'));
  const blocked = cli(dir, 'render', '--unattended', '--all', '--force');
  assert.equal(blocked.status, 1); assert.match(blocked.stderr, /制作技术检查未通过/); assert.doesNotMatch(blocked.stdout, /RENDER_ARGS/);
  assert.equal(classifyProductionFailure(blocked.stderr), 'content');
  assert.equal(productionQualityStatus(dir, { phase: 'pre-render', profile: 'technical' }).ok, false);
  fs.writeFileSync(p('scene.html'), html.replace('window.renderAt=t=>{', 'window.renderAt=t=>{throw new Error("actual runtime failure");'));
  const runtime = cli(dir, 'render', '--unattended', '--all', '--force');
  assert.equal(runtime.status, 1); assert.match(runtime.stderr, /制作技术检查未通过/); assert.doesNotMatch(runtime.stdout, /RENDER_ARGS/);
  assert.equal(classifyProductionFailure(runtime.stderr), 'environment');
  assert.equal(fs.readFileSync(p('render.mjs'), 'utf8'), renderer);
});
test('真实无人render：显式audited保留严格视觉检查，force不能绕过低对比度', t => {
  const { dir, p } = fixture(t);
  const metadata = JSON.parse(fs.readFileSync(p('PROJECT.json'), 'utf8'));
  fs.writeFileSync(p('PROJECT.json'), JSON.stringify({ ...metadata, workflow: { profile: 'audited' } }));
  fs.writeFileSync(p('render.mjs'), 'console.log("RENDER_ARGS="+JSON.stringify(process.argv.slice(2)));process.exit(23);');
  const result = cli(dir, 'render', '--unattended', '--all');
  assert.equal(result.status, 23, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout.match(/RENDER_ARGS=(.*)/)[1]).includes('--force'), false);
  const strict = productionQualityStatus(dir, { phase: 'pre-render' });
  assert.equal(strict.ok, true); assert.equal(strict.receipt.profile, 'strict');
  for (const id of ['contrast', 'layout']) {
    const check = strict.receipt.checks.find(check => check.id === id);
    assert.equal(check.status, 'passed'); assert.equal(check.required, true); assert.ok(check.sampled > 0);
  }
  fs.writeFileSync(p('scene.html'), fs.readFileSync(p('scene.html'), 'utf8').replace('color:white', 'color:#010101'));
  const blocked = cli(dir, 'render', '--unattended', '--all', '--force');
  assert.equal(blocked.status, 1); assert.match(blocked.stderr, /制作技术检查未通过/); assert.doesNotMatch(blocked.stdout, /RENDER_ARGS/);
  const receipt = JSON.parse(fs.readFileSync(p('out/.vh-production-quality.json'), 'utf8'));
  assert.equal(receipt.profile, 'strict'); assert.equal(receipt.checks.find(check => check.id === 'contrast').ok, false);
  assert.equal(classifyProductionFailure(blocked.stderr), 'content');
});
test('项目级自动开关不调用模型，启用后pack force仍要求当前技术最终回执', t => {
  const { dir, p } = fixture(t);
  const enable = cli(dir, 'automation', '--enable'); assert.equal(enable.status, 0, enable.stderr);
  assert.equal(JSON.parse(fs.readFileSync(p('PROJECT.json'))).automation.enabled, true);
  const output = p('export'); const pack = cli(dir, 'pack', '--force', '--out', output);
  assert.equal(pack.status, 1); assert.match(pack.stderr, /质量回执/); assert.equal(fs.existsSync(output), false);
  const plan = cli(dir, 'go', '--dry-run', '--json'); assert.equal(JSON.parse(plan.stdout).automation.enabled, true);
});
