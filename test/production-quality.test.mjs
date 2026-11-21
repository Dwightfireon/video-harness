import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { productionQuality, productionQualityStatus, readProductionQuality } from '../lib/production-quality.mjs';
import { createArtifactRecord, hashFile } from '../lib/artifact-status.mjs';
import { srtText } from '../lib/subtitle-export.mjs';

const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const pre = { phase: 'pre-render' };
const good = () => ({
  contrast: async () => ({ ok: true, sampled: 2, findings: [] }),
  layout: async () => ({ ok: true, sampled: 2, findings: [] }),
  subtitles: async () => ({ ok: true, cues: 1, probes: 3, errors: [], failures: [] }),
});
const check = (r, id) => r.checks.find(c => c.id === id);
function fixture(t, { portrait = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-production-quality-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = n => path.join(dir, n);
  fs.mkdirSync(p('out'));
  fs.writeFileSync(p('PROJECT.json'), '{}');
  fs.writeFileSync(p('脚本.md'), '## S1 · 测试\n1. 一句话。\n');
  fs.writeFileSync(p('scenes.src.js'), '//---\nroot => ({render(){}})\n');
  fs.writeFileSync(p('engine.tpl.html'), `const ORIENT = '${portrait ? 'portrait' : 'landscape'}';`);
  const subs = [{ s: .1, e: .9, t: '一句话。' }];
  const timing = { schemaVersion: 1, textHash: digest(['一句话。']), groupsHash: digest([['一句话。']]),
    measurement: { voice: 'test', speed: 1 }, scenes: [[0, 1]], dur: 1, subs };
  fs.writeFileSync(p('timing.json'), JSON.stringify(timing));
  fs.writeFileSync(p('scene.html'), `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:#000;color:#fff;overflow:hidden}#title{position:absolute;left:80px;top:100px;font:40px sans-serif}
    #subbox{position:absolute;left:80px;top:${portrait ? 1700 : 900}px;width:800px;height:100px;font:32px sans-serif}
    </style><div id="title">Readable title</div><div id="subbox"></div><script>
    window.W=${portrait ? 1080 : 1920};window.H=${portrait ? 1920 : 1080};
    const ORIENT = '${portrait ? 'portrait' : 'landscape'}'; const DURATION = 1;
    const SUBS = ${JSON.stringify(subs)}; const scenes = [];
    function addScene(a,b,f){scenes.push([a,b,f]);} addScene(0, 1, () => {});
    window.renderAt=t=>{document.querySelector('#subbox').textContent=t>=.1&&t<.9?'一句话。':'';};
    </script>`);
  fs.writeFileSync(p('out/subtitles.srt'), srtText(subs));
  const stamp = { scriptHash: hashFile(p('脚本.md')), scenesHash: hashFile(p('scenes.src.js')) };
  fs.writeFileSync(p('out/.vh-state.json'), JSON.stringify({ genStamp: stamp }));
  return { dir, p, timing, subs };
}
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { timeout: 10000 }).status === 0;
function synth(file, source = 'sine=frequency=440:sample_rate=16000:d=1') {
  const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:r=10:d=1',
    '-f', 'lavfi', '-i', source, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file],
  { encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
}
function media(f, source) {
  synth(f.p('out/video.mp4'));
  synth(f.p('out/video-voice.mp4'), source);
  const state = JSON.parse(fs.readFileSync(f.p('out/.vh-state.json'), 'utf8'));
  state.render = { artifact: createArtifactRecord(f.dir, 'render') };
  state.voice = { artifact: createArtifactRecord(f.dir, 'voice') };
  fs.writeFileSync(f.p('out/.vh-state.json'), JSON.stringify(state));
}
function pcmExec(value = .1, mutate) {
  return async (command, args, opts) => {
    assert.equal(command, 'ffmpeg'); assert.ok(opts.timeout > 0 && opts.timeout <= 120000);
    assert.ok(!args.includes('-y')); assert.ok(args.includes('-nostdin'));
    if (args.includes('f32le')) {
      const data = Buffer.alloc(400); for (let i = 0; i < 400; i += 4) data.writeFloatLE(value, i);
      // Exercise arbitrary chunk boundaries, without collecting the whole output.
      opts.onStdout(data.subarray(0, 3)); opts.onStdout(data.subarray(3));
    }
    mutate?.(args);
    return { status: 0, stdout: null, stderr: '' };
  };
}

test('pre-render requires every check and saves a verifiable atomic receipt without touching state', async t => {
  const f = fixture(t), state = fs.readFileSync(f.p('out/.vh-state.json'));
  const r = await productionQuality(f.dir, { ...pre, checkers: good(), skip: true, force: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(productionQualityStatus(f.dir, pre).ok, true);
  assert.equal(readProductionQuality(f.dir, pre).sourceSignature, r.sourceSignature);
  assert.equal(productionQualityStatus(f.dir).ok, false, 'pre cannot count as final');
  assert.deepEqual(fs.readFileSync(f.p('out/.vh-state.json')), state);
  assert.equal(fs.readdirSync(f.p('out')).some(n => n.endsWith('.tmp')), false);
  const rename = fs.renameSync; let observed = false;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('.vh-production-quality.json')) {
      observed = true;
      assert.equal(JSON.parse(fs.readFileSync(to)).ok, true, 'old complete receipt remains until rename');
      assert.equal(JSON.parse(fs.readFileSync(from)).ok, false, 'replacement is complete JSON');
      assert.notEqual(from, to);
    }
    return rename(from, to);
  };
  try { await productionQuality(f.dir, { ...pre, checkers: { ...good(), layout: null } }); }
  finally { fs.renameSync = rename; }
  assert.equal(observed, true); assert.equal(readProductionQuality(f.dir, pre), null);
});

for (const [label, replacement] of [
  ['unavailable', null], ['throws', () => { throw new Error('browser unavailable'); }],
  ['ok false empty findings', () => ({ ok: false, findings: [] })],
  ['missing result', () => undefined], ['no samples', () => ({ ok: true, sampled: 0 })],
  ['skipped', () => ({ ok: true, sampled: 2, status: 'skipped' })],
  ['not run', () => ({ ok: true, sampled: 2, status: 'not-run' })],
  ['finding despite ok', () => ({ ok: true, sampled: 2, findings: [{ msg: 'bad contrast' }] })],
]) test(`checker ${label} fails closed, even with force/skip`, async t => {
  const f = fixture(t), r = await productionQuality(f.dir, { ...pre, force: true, skip: true, checkers: { ...good(), contrast: replacement } });
  assert.equal(r.ok, false); assert.equal(check(r, 'contrast').ok, false);
  assert.ok(check(r, 'contrast').issues[0].hint);
});

test('subtitle probes must cover all three cue positions', async t => {
  const f = fixture(t), r = await productionQuality(f.dir, { ...pre, checkers: { ...good(), subtitles: () => ({ ok: true, cues: 2, probes: 3 }) } });
  assert.equal(check(r, 'subtitles').ok, false);
});

for (const [label, edit, id] of [
  ['unknown timing', f => { f.timing.schemaVersion = 2; fs.writeFileSync(f.p('timing.json'), JSON.stringify(f.timing)); }, 'timing'],
  ['stale measured text', f => fs.appendFileSync(f.p('脚本.md'), '2. 新句子。\n'), 'timing'],
  ['wrong DURATION', f => fs.writeFileSync(f.p('scene.html'), fs.readFileSync(f.p('scene.html'), 'utf8').replace('DURATION = 1', 'DURATION = 2')), 'structure'],
  ['wrong generated subtitles', f => fs.writeFileSync(f.p('scene.html'), fs.readFileSync(f.p('scene.html'), 'utf8').replace('一句话。', '改了文字')), 'structure'],
  ['extra source scene', f => fs.appendFileSync(f.p('scenes.src.js'), '\n//---\nroot=>({})'), 'structure'],
  ['unbuilt source', f => fs.appendFileSync(f.p('scenes.src.js'), '\n// changed'), 'build'],
  ['missing resource', f => fs.appendFileSync(f.p('scene.html'), '<img src="assets/missing.png">'), 'assets'],
]) test(`pure structural gate rejects ${label}`, async t => {
  const f = fixture(t); edit(f);
  const r = await productionQuality(f.dir, { ...pre, checkers: good() });
  assert.equal(check(r, id).ok, false, JSON.stringify(r)); assert.equal(r.ok, false);
});

test('requested voice/speed must match measured timing, no project code execution', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.p('timeline.mjs'), 'throw new Error("must not execute")');
  const r = await productionQuality(f.dir, { ...pre, voice: 'different', checkers: good() });
  assert.equal(check(r, 'timing').ok, false);
});

test('changed sources/assets invalidate read-only receipt even with restored mtime', async t => {
  const f = fixture(t); fs.mkdirSync(f.p('assets')); fs.writeFileSync(f.p('assets/a.bin'), 'abcd');
  await productionQuality(f.dir, { ...pre, checkers: good() });
  assert.equal(productionQualityStatus(f.dir, pre).ok, true);
  const info = fs.statSync(f.p('assets/a.bin')); fs.writeFileSync(f.p('assets/a.bin'), 'wxyz'); fs.utimesSync(f.p('assets/a.bin'), info.atime, info.mtime);
  const before = fs.readFileSync(f.p('out/.vh-production-quality.json'));
  assert.equal(productionQualityStatus(f.dir, pre).ok, false);
  assert.deepEqual(fs.readFileSync(f.p('out/.vh-production-quality.json')), before);
});

test('running source mutation blocks receipt success', async t => {
  const f = fixture(t), c = good(); c.contrast = () => { fs.appendFileSync(f.p('scene.html'), '<!-- changed -->'); return { ok: true, sampled: 2 }; };
  const r = await productionQuality(f.dir, { ...pre, checkers: c });
  assert.equal(r.ok, false); assert.equal(check(r, 'stable').ok, false);
  assert.equal(productionQualityStatus(f.dir, pre).ok, false);
});

test('source edits and invalidated build baseline cannot reuse pre-render receipt', async t => {
  const f = fixture(t); await productionQuality(f.dir, { ...pre, checkers: good() });
  fs.appendFileSync(f.p('scene.html'), '<!-- edited -->');
  assert.equal(productionQualityStatus(f.dir, pre).ok, false);
  await productionQuality(f.dir, { ...pre, checkers: good() });
  assert.equal(productionQualityStatus(f.dir, pre).ok, true);
  fs.writeFileSync(f.p('out/.vh-state.json'), '{}');
  assert.equal(productionQualityStatus(f.dir, pre).ok, false);
});

test('incomplete/forged pass marker is not a machine receipt', async t => {
  const f = fixture(t); fs.writeFileSync(f.p('out/.vh-production-quality.json'), JSON.stringify({ version: 1, phase: 'pre-render', ok: true, checks: [] }));
  assert.equal(productionQualityStatus(f.dir, pre).ok, false);
  await productionQuality(f.dir, { ...pre, checkers: good() });
  const r = JSON.parse(fs.readFileSync(f.p('out/.vh-production-quality.json'))); delete r.checks.find(c => c.id === 'contrast').sampled;
  fs.writeFileSync(f.p('out/.vh-production-quality.json'), JSON.stringify(r));
  assert.equal(productionQualityStatus(f.dir, pre).ok, false);
});

test('actual full decode and non-silent audio pass; black background is legal', { skip: !ffmpegAvailable }, async t => {
  const f = fixture(t); media(f);
  const before = fs.readFileSync(f.p('out/video-voice.mp4'));
  const r = await productionQuality(f.dir, { checkers: good() });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(check(r, 'decode').ok, true); assert.equal(check(r, 'audio').ok, true);
  assert.match(r.media.sha256, /^[a-f0-9]{64}$/); assert.equal(productionQualityStatus(f.dir).ok, true);
  assert.deepEqual(fs.readFileSync(f.p('out/video-voice.mp4')), before);
  const srt = fs.readFileSync(f.p('out/subtitles.srt'));
  fs.appendFileSync(f.p('out/subtitles.srt'), '\nold subtitles');
  assert.equal(productionQualityStatus(f.dir).ok, false);
  fs.writeFileSync(f.p('out/subtitles.srt'), srt);
  assert.equal(productionQualityStatus(f.dir).ok, true);
  fs.appendFileSync(f.p('out/video-voice.mp4'), 'replacement');
  assert.equal(productionQualityStatus(f.dir).ok, false);
});

test('actual silent track fails without modifying user media', { skip: !ffmpegAvailable }, async t => {
  const f = fixture(t); media(f, 'anullsrc=r=16000:cl=mono:d=1');
  const before = fs.readFileSync(f.p('out/video-voice.mp4'));
  const r = await productionQuality(f.dir, { checkers: good() });
  assert.equal(check(r, 'decode').ok, true); assert.equal(check(r, 'audio').ok, false);
  assert.equal(check(r, 'audio').issues[0].category, 'silence'); assert.equal(r.ok, false);
  assert.deepEqual(fs.readFileSync(f.p('out/video-voice.mp4')), before);
});

test('missing SRT points only to subtitles, not voice/TTS', { skip: !ffmpegAvailable }, async t => {
  const f = fixture(t); media(f); fs.unlinkSync(f.p('out/subtitles.srt'));
  const r = await productionQuality(f.dir, { checkers: good(), exec: pcmExec() });
  assert.equal(check(r, 'artifact').ok, true); assert.equal(check(r, 'srt').ok, false);
  assert.match(check(r, 'srt').issues[0].hint, /vh subtitles/);
  assert.doesNotMatch(check(r, 'srt').issues[0].hint, /vh voice|vh measure/);
});

test('probe errors/timeout and severe full-scale audio fail closed', { skip: !ffmpegAvailable }, async t => {
  const f = fixture(t); media(f);
  const r = await productionQuality(f.dir, { checkers: good(), exec: pcmExec(1) });
  assert.equal(check(r, 'audio').issues[0].category, 'clipping');
  const timeout = await productionQuality(f.dir, { checkers: good(), exec: async () => ({ status: null, error: new Error('timeout') }) });
  assert.equal(check(timeout, 'decode').ok, false); assert.equal(check(timeout, 'audio').ok, false);
  const warning = await productionQuality(f.dir, { checkers: good(), exec: async () => ({ status: 0, stderr: 'decode error', stdout: '' }) });
  assert.equal(check(warning, 'decode').ok, false);
});

test('ordinary long pauses do not count as whole-track silence', { skip: !ffmpegAvailable }, async t => {
  const f = fixture(t); media(f);
  const exec = async (command, args, opts) => {
    if (args.includes('f32le')) { const data = Buffer.alloc(4000); data.writeFloatLE(.1, 3996); opts.onStdout(data); }
    return { status: 0, stdout: null, stderr: '' };
  };
  const r = await productionQuality(f.dir, { checkers: good(), exec });
  assert.equal(check(r, 'audio').ok, true); assert.equal(r.ok, true);
});

test('real corrupt-media decode is rejected', { skip: !ffmpegAvailable }, async t => {
  const f = fixture(t); media(f); fs.writeFileSync(f.p('out/video-voice.mp4'), Buffer.from('not a movie'));
  const r = await productionQuality(f.dir, { checkers: good() });
  assert.equal(check(r, 'decode').ok, false); assert.equal(check(r, 'artifact').ok, false); assert.equal(r.ok, false);
});

test('running media replacement invalidates successful probes', { skip: !ffmpegAvailable }, async t => {
  const f = fixture(t); media(f); let changed = false;
  const r = await productionQuality(f.dir, { checkers: good(), exec: pcmExec(.1, () => {
    if (!changed) { changed = true; fs.appendFileSync(f.p('out/video-voice.mp4'), 'changed during probe'); }
  }) });
  assert.equal(check(r, 'decode').ok, true); assert.equal(check(r, 'audio').ok, true);
  assert.equal(check(r, 'stable').ok, false); assert.equal(r.ok, false);
});

for (const portrait of [false, true]) test(`default actual browser checks ${portrait ? 'portrait' : 'landscape'} fixture`, async t => {
  const f = fixture(t, { portrait });
  const r = await productionQuality(f.dir, pre);
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const id of ['contrast', 'layout', 'subtitles']) assert.ok(check(r, id).sampled > 0);
});

test('default browser detects actually unreadable color and hidden subtitles', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.p('scene.html'), fs.readFileSync(f.p('scene.html'), 'utf8').replace('color:#fff', 'color:#111').replace('#subbox{', '#subbox{visibility:hidden;'));
  const r = await productionQuality(f.dir, pre);
  assert.equal(check(r, 'contrast').ok, false); assert.equal(check(r, 'subtitles').ok, false); assert.equal(r.ok, false);
});

test('default browser does not accept transparent subtitle glyphs as visible', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.p('scene.html'), fs.readFileSync(f.p('scene.html'), 'utf8').replace('#subbox{', '#subbox{color:transparent;'));
  const r = await productionQuality(f.dir, pre);
  assert.equal(check(r, 'subtitles').ok, false); assert.equal(r.ok, false);
});

test('完全重合的文字在 fit、普通实测和严格生产检查中一致阻断', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.p('scene.html'), fs.readFileSync(f.p('scene.html'), 'utf8').replace('<div id="subbox">', '<div id="title">Second readable title</div><div id="subbox">'));
  const { analyze } = await import('../lib/fit.mjs');
  const { measureLayout } = await import('../lib/layout-measured.mjs');
  for (const result of [await analyze(f.dir), await measureLayout(f.dir)]) {
    assert.equal(result.ok, false); assert.ok(result.findings.some(f => f.kind === 'text-overlap'), JSON.stringify(result));
  }
  const r = await productionQuality(f.dir, pre);
  assert.equal(check(r, 'layout').ok, false); assert.match(JSON.stringify(check(r, 'layout')), /文字重叠/);
});

test('短暂入场重叠不能只靠中后段采样漏过；含 span 的正文也须检查', async t => {
  const f = fixture(t);
  let html = fs.readFileSync(f.p('scene.html'), 'utf8').replace('Readable title', '<span>Readable title</span>');
  html = html.replace('<div id="subbox">', '<div id="transient" style="position:absolute;left:80px;top:100px;font:40px sans-serif">Transient title</div><div id="subbox">');
  html = html.replace('window.renderAt=t=>{', 'window.renderAt=t=>{document.querySelector("#transient").style.display=t<.3?"block":"none";');
  fs.writeFileSync(f.p('scene.html'), html);
  const r = await productionQuality(f.dir, pre);
  assert.equal(check(r, 'layout').ok, false); assert.match(JSON.stringify(check(r, 'layout')), /文字重叠/);
});

test('带背景的半透明分组只合成一次，清楚的黑字灰底不能误报对比度',async t=>{
  const f=fixture(t);
  let html=fs.readFileSync(f.p('scene.html'),'utf8');
  html=html.replace('<div id="title">Readable title</div>','<div style="position:absolute;left:80px;top:100px;width:700px;height:300px;background:white;opacity:.5"><div id="title" style="color:black">Readable title</div></div>');
  fs.writeFileSync(f.p('scene.html'),html);
  const {measureContrast}=await import('../lib/contrast-rendered.mjs');
  const ordinary=await measureContrast(f.dir);assert.equal(ordinary.ok,true,JSON.stringify(ordinary));
  const r=await productionQuality(f.dir,pre);assert.equal(check(r,'contrast').ok,true,JSON.stringify(r));
});

test('逐场采样证据：空的第二场不能借第一场或全局页码通过',async t=>{
  const f=fixture(t),lines=['一句话。','第二句话。'];
  const subs=[{s:.05,e:.45,t:lines[0]},{s:.55,e:.95,t:lines[1]}];
  fs.writeFileSync(f.p('脚本.md'),'## S1 · 第一场\n1. 一句话。\n\n## S2 · 空场\n1. 第二句话。\n');
  fs.writeFileSync(f.p('scenes.src.js'),'root=>({render(){}})\n//---\nroot=>({render(){}})');
  fs.writeFileSync(f.p('timing.json'),JSON.stringify({...f.timing,textHash:digest(lines),groupsHash:digest(lines.map(l=>[l])),scenes:[[0,.5],[.5,1]],subs}));
  fs.writeFileSync(f.p('scene.html'),`<!doctype html><style>body{margin:0;background:black;color:white}.scene{position:absolute;inset:0}.title{position:absolute;left:80px;top:100px;font:40px sans-serif}#subbox{position:absolute;left:80px;top:900px;width:800px;height:100px;font:32px sans-serif}</style>
    <div class="scene" id="s1"><div class="title">第一场标题</div></div><div class="scene" id="s2"></div><div style="position:absolute;left:1800px;top:40px;font:30px sans-serif">02</div><div id="subbox"></div><script>
    window.W=1920;window.H=1080;const ORIENT='landscape';const DURATION=1;const SUBS=${JSON.stringify(subs)};const scenes = [];
    function addScene(){}addScene(0,.5,()=>{});addScene(.5,1,()=>{});
    window.renderAt=t=>{document.querySelector('#s1').style.display=t<.5?'block':'none';document.querySelector('#s2').style.display=t>=.5?'block':'none';document.querySelector('#subbox').textContent=SUBS.find(s=>t>=s.s&&t<s.e)?.t||'';};</script>`);
  fs.writeFileSync(f.p('out/.vh-state.json'),JSON.stringify({genStamp:{scriptHash:hashFile(f.p('脚本.md')),scenesHash:hashFile(f.p('scenes.src.js'))}}));
  const {measureLayout}=await import('../lib/layout-measured.mjs');
  const {measureContrast}=await import('../lib/contrast-rendered.mjs');
  assert.ok((await measureLayout(f.dir)).findings.some(f=>f.kind==='empty-scene'&&f.scene===2));
  assert.ok((await measureContrast(f.dir)).findings.some(f=>f.kind==='empty-scene'&&f.scene===2));
  const r=await productionQuality(f.dir,pre);
  assert.equal(check(r,'layout').ok,false);assert.equal(check(r,'contrast').ok,false);
  assert.match(JSON.stringify(check(r,'layout')),/empty-scene/);
});

const technical = { ...pre, profile: 'technical' };
test('technical never accesses visual checkers and records honest not-run checks', async t => {
  const f = fixture(t), checkers = { subtitles: good().subtitles };
  for (const id of ['contrast', 'layout']) Object.defineProperty(checkers, id, { get() { throw new Error('visual checker accessed'); } });
  const r = await productionQuality(f.dir, { ...technical, checkers });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.profile, 'technical');
  for (const id of ['contrast', 'layout']) {
    assert.deepEqual({ ok: check(r, id).ok, status: check(r, id).status, required: check(r, id).required },
      { ok: null, status: 'not-run', required: false });
    assert.equal(check(r, id).sampled, undefined);
  }
  assert.equal(check(r, 'subtitles').required, true);
  assert.equal(productionQualityStatus(f.dir, technical).ok, true);
  assert.equal(productionQualityStatus(f.dir, pre).ok, false);
  assert.match(r.scope, /未执行对比度或版式审计/);
});

test('strict is the default; technical can reuse complete strict and legacy strict receipts', async t => {
  const f = fixture(t), r = await productionQuality(f.dir, { ...pre, checkers: good() });
  assert.equal(r.profile, 'strict');
  assert.equal(productionQualityStatus(f.dir, technical).ok, true);
  delete r.profile;
  for (const c of r.checks) { delete c.required; delete c.cues; }
  fs.writeFileSync(f.p('out/.vh-production-quality.json'), JSON.stringify(r));
  assert.equal(productionQualityStatus(f.dir, pre).ok, true, 'old v1 strict evidence remains usable');
  assert.equal(productionQualityStatus(f.dir, technical).ok, true);
  delete r.checks.find(c => c.id === 'layout').sampled;
  fs.writeFileSync(f.p('out/.vh-production-quality.json'), JSON.stringify(r));
  assert.equal(productionQualityStatus(f.dir, technical).ok, false, 'stronger receipt must actually be complete');
});

test('receipt validation derives requirements, not ok/required/profile flags', async t => {
  const f = fixture(t), original = await productionQuality(f.dir, { ...technical, checkers: good() });
  for (const mutate of [
    r => { r.profile = 'strict'; },
    r => { delete r.profile; },
    r => { r.profile = 'unknown'; },
    r => { r.checks.find(c => c.id === 'subtitles').required = false; },
    r => { r.checks.find(c => c.id === 'subtitles').status = 'not-run'; },
    r => { r.checks.find(c => c.id === 'subtitles').sampled = 2; },
    r => { r.checks.find(c => c.id === 'subtitles').cues = 2; },
    r => { r.checks = r.checks.filter(c => c.id !== 'build'); },
    r => { r.checks.push({ ...r.checks.find(c => c.id === 'subtitles') }); },
    r => { r.checks.find(c => c.id === 'contrast').ok = true; },
    r => { r.checks.find(c => c.id === 'layout').status = 'passed'; },
    r => { r.checks.find(c => c.id === 'stable').ok = false; },
  ]) {
    const r = structuredClone(original); mutate(r);
    fs.writeFileSync(f.p('out/.vh-production-quality.json'), JSON.stringify(r));
    assert.equal(productionQualityStatus(f.dir, technical).ok, false, JSON.stringify(r));
  }
});

test('unknown profiles fail closed rather than weakening strict', async t => {
  const f = fixture(t);
  await assert.rejects(productionQuality(f.dir, { ...pre, profile: 'fast', checkers: good() }), /profile/);
  assert.equal(productionQualityStatus(f.dir, { ...pre, profile: 'fast' }).ok, false);
});

test('technical source/assets/build mutations and mutations during checks invalidate receipts', async t => {
  const f = fixture(t); fs.mkdirSync(f.p('assets')); fs.writeFileSync(f.p('assets/input.bin'), 'abcd');
  for (const mutate of [
    () => fs.appendFileSync(f.p('scene.html'), '<!-- source mutation -->'),
    () => fs.appendFileSync(f.p('assets/input.bin'), 'asset mutation'),
    () => fs.writeFileSync(f.p('out/.vh-state.json'), '{}'),
  ]) {
    const r = await productionQuality(f.dir, { ...technical, checkers: good() }); assert.equal(r.ok, true);
    mutate(); assert.equal(productionQualityStatus(f.dir, technical).ok, false);
  }
  const during = fixture(t), checkers = good();
  checkers.subtitles = () => { fs.appendFileSync(during.p('scene.html'), '<!-- during -->'); return { ok: true, cues: 1, probes: 3 }; };
  const r = await productionQuality(during.dir, { ...technical, checkers });
  assert.equal(check(r, 'stable').ok, false); assert.equal(r.ok, false);
});

test('actual technical browser performs no layout evaluation or contrast screenshot; low contrast/overlap do not block', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.p('scene.html'), fs.readFileSync(f.p('scene.html'), 'utf8').replace('color:#fff', 'color:#111')
    .replace('<div id="subbox">', '<div id="title">Overlapping title</div><div id="subbox">'));
  const { chromium } = await import('playwright');
  const launch = chromium.launch;
  let subtitleBatches = 0;
  chromium.launch = async function (...args) {
    const browser = await launch.apply(this, args), newPage = browser.newPage.bind(browser);
    browser.newPage = async options => {
      const page = await newPage(options), evaluate = page.evaluate.bind(page);
      page.evaluate = (fn, arg) => {
        assert.notEqual(fn.name, 'observeLayoutBatch', 'technical must not invoke layout observation');
        if (fn.name === 'observeSubtitleBatch') subtitleBatches++;
        return evaluate(fn, arg);
      };
      page.screenshot = () => { throw new Error('technical must not sample contrast screenshots'); };
      return page;
    };
    return browser;
  };
  try {
    const r = await productionQuality(f.dir, technical);
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(check(r, 'subtitles').sampled, 3);
    assert.equal(productionQualityStatus(f.dir, technical).ok, true); assert.equal(subtitleBatches, 1);
  } finally { chromium.launch = launch; }
  const strict = await productionQuality(f.dir, pre);
  assert.equal(check(strict, 'contrast').ok, false); assert.equal(check(strict, 'layout').ok, false);
});

for (const [label, change] of [
  ['hidden at cue start', html => html.replace('window.renderAt=t=>{', 'window.renderAt=t=>{document.querySelector("#subbox").style.visibility=t<.2?"hidden":"visible";')],
  ['hidden at cue middle', html => html.replace('window.renderAt=t=>{', 'window.renderAt=t=>{document.querySelector("#subbox").style.visibility=t>.4&&t<.6?"hidden":"visible";')],
  ['hidden at cue end', html => html.replace('window.renderAt=t=>{', 'window.renderAt=t=>{document.querySelector("#subbox").style.visibility=t>.8?"hidden":"visible";')],
  ['truncated subtitle', html => html.replace('width:800px;height:100px', 'width:8px;height:10px;overflow:hidden')],
  ['transparent subtitle', html => html.replace('#subbox{', '#subbox{color:transparent;')],
  ['wrong displayed subtitle', html => html.replace("?'一句话。':''", "?'少了字':''")],
  ['runtime error', html => html.replace('window.renderAt=t=>{', 'window.renderAt=t=>{throw new Error("runtime failure");')],
  ['failed runtime resource', html => html.replace('window.W=', 'fetch("missing"+"-runtime.bin").catch(()=>{});window.W=')],
  ['invalid image', html => html.replace('<div id="title">', '<img src="assets/corrupt.png"><div id="title">')],
]) test(`actual technical browser still blocks ${label}`, async t => {
  const f = fixture(t);
  fs.mkdirSync(f.p('assets')); fs.writeFileSync(f.p('assets/corrupt.png'), 'not an image');
  fs.writeFileSync(f.p('scene.html'), change(fs.readFileSync(f.p('scene.html'), 'utf8')));
  const r = await productionQuality(f.dir, technical);
  assert.equal(check(r, 'structure').ok, true, 'failure must come from actual browser, not malformed structure');
  assert.equal(check(r, 'assets').ok, true);
  assert.equal(check(r, 'subtitles').ok, false, JSON.stringify(r)); assert.equal(r.ok, false);
  assert.equal(check(r, 'contrast').status, 'not-run'); assert.equal(check(r, 'layout').status, 'not-run');
  assert.equal(productionQualityStatus(f.dir, technical).ok, false);
});

test('technical final retains actual full decode/audio/SRT and source/media identity checks', { skip: !ffmpegAvailable }, async t => {
  const f = fixture(t); media(f);
  const options = { profile: 'technical' }, r = await productionQuality(f.dir, { ...options, checkers: good() });
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const id of ['artifact', 'srt', 'decode', 'audio']) assert.equal(check(r, id).ok, true);
  assert.equal(productionQualityStatus(f.dir, options).ok, true);
  assert.equal(productionQualityStatus(f.dir).ok, false);
  for (const name of ['scene.html', 'out/subtitles.srt', 'out/video.mp4', 'out/video-voice.mp4']) {
    const before = fs.readFileSync(f.p(name)); fs.appendFileSync(f.p(name), '\nmutation');
    assert.equal(productionQualityStatus(f.dir, options).ok, false, name);
    fs.writeFileSync(f.p(name), before); assert.equal(productionQualityStatus(f.dir, options).ok, true, name);
  }
  const clipped = await productionQuality(f.dir, { ...options, checkers: good(), exec: pcmExec(1) });
  assert.equal(check(clipped, 'audio').ok, false); assert.equal(clipped.ok, false);
  fs.unlinkSync(f.p('out/subtitles.srt'));
  const noSrt = await productionQuality(f.dir, { ...options, checkers: good(), exec: pcmExec() });
  assert.equal(check(noSrt, 'srt').ok, false); assert.equal(noSrt.ok, false);
  fs.writeFileSync(f.p('out/video-voice.mp4'), 'corrupt media');
  const corrupt = await productionQuality(f.dir, { ...options, checkers: good() });
  assert.equal(check(corrupt, 'decode').ok, false); assert.equal(corrupt.ok, false);
});

for (const profile of ['strict', 'technical']) test(`${profile} opt-in final reuses only current pre-render browser evidence and still probes final media`, { skip: !ffmpegAvailable }, async t => {
  const f = fixture(t); media(f);
  const before = await productionQuality(f.dir, { ...pre, profile, checkers: good() });
  let probes = 0;
  const exec = pcmExec(), r = await productionQuality(f.dir, { profile, reuseRendered: true,
    checkers: { contrast: () => { throw new Error('must reuse contrast'); }, layout: () => { throw new Error('must reuse layout'); },
      subtitles: () => { throw new Error('must reuse subtitles'); } },
    exec: (...args) => { probes++; return exec(...args); } });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(probes, 2, 'decode and audio are never reused');
  assert.deepEqual(r.renderedReuse, { phase: 'pre-render', profile, sourceSignature: before.sourceSignature,
    receiptSignature: createHash('sha256').update(JSON.stringify(before)).digest('hex'), at: before.at,
    checks: profile === 'strict' ? ['contrast', 'layout', 'subtitles'] : ['subtitles'] });
  for (const id of r.renderedReuse.checks) assert.deepEqual(check(r, id), check(before, id));
  assert.equal(productionQualityStatus(f.dir, { profile }).ok, true);
  assert.equal(check(r, 'stable').ok, true);
  // A final receipt is not a reusable pre-render receipt, even if still current.
  let rerun = false;
  const again = await productionQuality(f.dir, { profile, reuseRendered: true, checkers: { ...good(), subtitles: () => {
    rerun = true; return good().subtitles();
  } }, exec: pcmExec() });
  assert.equal(again.ok, true); assert.equal(rerun, true); assert.equal(again.renderedReuse, undefined);
});

test('final defaults to rerunning browser checks even with a current pre-render receipt', { skip: !ffmpegAvailable }, async t => {
  const f = fixture(t); media(f);
  await productionQuality(f.dir, { ...pre, checkers: good() });
  const r = await productionQuality(f.dir, { checkers: { ...good(), subtitles: () => { throw new Error('direct audit runs'); } }, exec: pcmExec() });
  assert.equal(check(r, 'subtitles').ok, false); assert.equal(r.renderedReuse, undefined);
});

test('same-size source/asset edits with restored mtimes force fresh browser checks instead of pre-render reuse', { skip: !ffmpegAvailable }, async t => {
  const f = fixture(t); media(f); fs.mkdirSync(f.p('assets')); fs.writeFileSync(f.p('assets/input.bin'), 'abcd');
  for (const name of ['scene.html', 'assets/input.bin']) {
    await productionQuality(f.dir, { ...technical, checkers: good() });
    const file = f.p(name), before = fs.readFileSync(file, 'utf8'), info = fs.statSync(file);
    fs.writeFileSync(file, name === 'scene.html' ? before.replace('Readable title', 'Modified title') : 'wxyz');
    fs.utimesSync(file, info.atime, info.mtime);
    let rerun = false;
    const r = await productionQuality(f.dir, { profile: 'technical', reuseRendered: true, checkers: { ...good(), subtitles: () => {
      rerun = true; return good().subtitles();
    } }, exec: pcmExec() });
    assert.equal(rerun, true, name); assert.equal(r.renderedReuse, undefined, name);
    assert.equal(check(r, 'subtitles').ok, true, name);
    fs.writeFileSync(file, before);
  }
});

for (const profile of ['strict', 'technical']) test(`${profile} reuse requires a matching profile and fully validated pre-render checks`, { skip: !ffmpegAvailable }, async t => {
  const f = fixture(t); media(f);
  const other = profile === 'strict' ? 'technical' : 'strict';
  await productionQuality(f.dir, { ...pre, profile: other, checkers: good() });
  let calls = 0;
  const checker = () => { calls++; return good().subtitles(); };
  let r = await productionQuality(f.dir, { profile, reuseRendered: true, checkers: { ...good(), subtitles: checker }, exec: pcmExec() });
  assert.equal(calls, 1); assert.equal(r.renderedReuse, undefined);
  await productionQuality(f.dir, { ...pre, profile, checkers: good() });
  const receipt = JSON.parse(fs.readFileSync(f.p('out/.vh-production-quality.json')));
  delete receipt.checks.find(c => c.id === 'subtitles').sampled;
  fs.writeFileSync(f.p('out/.vh-production-quality.json'), JSON.stringify(receipt));
  r = await productionQuality(f.dir, { profile, reuseRendered: true, checkers: { ...good(), subtitles: checker }, exec: pcmExec() });
  assert.equal(calls, 2); assert.equal(r.renderedReuse, undefined);
});

test('reusing browser evidence does not waive final SRT or source/media stable boundary failures', { skip: !ffmpegAvailable }, async t => {
  const f = fixture(t); media(f);
  await productionQuality(f.dir, { ...technical, checkers: good() });
  fs.appendFileSync(f.p('out/subtitles.srt'), '\ninvalid subtitle');
  const r = await productionQuality(f.dir, { profile: 'technical', reuseRendered: true, checkers: {}, exec: pcmExec(.1, () => {
    fs.appendFileSync(f.p('scene.html'), '<!-- source changed during final probes -->');
    fs.appendFileSync(f.p('out/video-voice.mp4'), 'changed during probes');
  }) });
  assert.ok(r.renderedReuse); assert.equal(check(r, 'subtitles').ok, true);
  assert.equal(check(r, 'srt').ok, false); assert.equal(check(r, 'stable').ok, false);
  assert.equal(r.ok, false); assert.equal(productionQualityStatus(f.dir, { profile: 'technical' }).ok, false);
});

for (const profile of ['strict', 'technical']) test(`actual ${profile} pre-render browser evidence can be reused without launching a final browser`, { skip: !ffmpegAvailable }, async t => {
  const f = fixture(t);
  const before = await productionQuality(f.dir, { ...pre, profile });
  assert.equal(before.ok, true, JSON.stringify(before));
  media(f);
  const { chromium } = await import('playwright'), launch = chromium.launch;
  chromium.launch = () => { throw new Error('current rendered evidence must avoid a second browser launch'); };
  try {
    const r = await productionQuality(f.dir, { profile, reuseRendered: true });
    assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(r.renderedReuse);
    assert.deepEqual(check(r, 'subtitles'), check(before, 'subtitles'));
    assert.equal(productionQualityStatus(f.dir, { profile }).ok, true);
  } finally { chromium.launch = launch; }
});
