import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

function fixture(t, throws = false, delayMs = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-silent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets/red.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="red"/></svg>');
  for (const [name, value] of Object.entries({ 'PROJECT.json': '{}', '脚本.md': '## S1\n1. 甲。\n## S2\n1. 乙。\n',
    'scenes.src.js': 'root=>({})\n//---\nroot=>({})',
    'scene.html': `<!doctype html><style>body{margin:0}img,#subs{position:absolute;inset:0}#subs{background:white}</style>
      <img src="assets/red.svg"><div id="subs">字幕</div><script>
      window.W=160;window.H=90;window.DURATION=6;function addScene(){};const scenes=[];
      addScene(1,3,()=>{});addScene(4,6,()=>{});
      window.renderAt=async t=>{await new Promise(r=>setTimeout(r,${delayMs}));${throws ? 'throw new Error("fixture render failure")' : 'document.body.dataset.time=String(t)'}};
      </script>` })) fs.writeFileSync(path.join(dir, name), value);
  return dir;
}
function run(dir, ...args) {
  return spawnSync(process.execPath, [path.resolve('vh.mjs'), ...args, '--dir', dir], { encoding: 'utf8', timeout: 30000 });
}

test('screen frames use true scene midpoints, original relative assets, and hidden subtitle layer', t => {
  const dir = fixture(t), result = run(dir, 'screen', '--frames');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const parent = path.join(dir, 'out/silent'), runs = fs.readdirSync(parent);
  assert.equal(runs.length, 1); assert.match(result.stdout, new RegExp(runs[0]));
  const files = fs.readdirSync(path.join(parent, runs[0])).sort();
  assert.deepEqual(files, ['s-01-2.png', 's-02-5.png']);
  assert.equal(fs.existsSync(path.join(dir, 'out/silent-check.html')), false);
  const pixel = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(parent, runs[0], files[0]), '-vf', 'crop=2:2:0:0',
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.equal(pixel.status, 0, String(pixel.stderr));
  assert.ok(pixel.stdout[0] > 200 && pixel.stdout[1] < 50 && pixel.stdout[2] < 50, 'real relative red asset is visible, white subtitle overlay is hidden');
  const regular = run(dir, 'stills');
  assert.equal(regular.status, 0, regular.stdout + regular.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'out/stills/s-01.jpg')));
});

test('screen frames report actual render failure, with a failed performance step', t => {
  const dir = fixture(t, true), result = run(dir, 'screen', '--frames');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture render failure/);
  assert.doesNotMatch(result.stdout, /静音静帧已生成/);
  const events = fs.readFileSync(path.join(dir, 'out/.vh-performance.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.kind === 'step' && e.stage === '静音审阅静帧' && e.ok === false));
  assert.ok(events.some(e => e.kind === 'command' && e.stage === 'screen' && e.ok === false));
});

test('failed asset readiness is not reported as a successful preview', t => {
  const dir = fixture(t), html = path.join(dir, 'scene.html');
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('window.W=160;',
    'window.__ready=Promise.reject(new Error("fixture asset failure"));window.W=160;'));
  for (const command of [['screen', '--frames'], ['stills']]) {
    const result = run(dir, ...command);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /fixture asset failure/);
    assert.doesNotMatch(result.stdout, /静音静帧已生成|张静帧.*out\/stills/);
  }
});

test('edits during a silent capture prevent a success claim', { timeout: 30000 }, async t => {
  const dir = fixture(t, false, 600), parent = path.join(dir, 'out/silent');
  const child = spawn(process.execPath, [path.resolve('vh.mjs'), 'screen', '--frames', '--dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const finished = once(child, 'close');
  let first = false;
  for (let i = 0; i < 500 && !first; i++) {
    try { first = fs.readdirSync(parent).some(run => fs.existsSync(path.join(parent, run, 's-01-2.png'))); } catch {}
    if (!first) await delay(10);
  }
  assert.equal(first, true, output);
  fs.appendFileSync(path.join(dir, 'scenes.src.js'), '\n// changed during capture');
  const [status] = await finished;
  assert.equal(status, 1, output); assert.match(output, /截图期间输入发生变化/);
  assert.doesNotMatch(output, /静音静帧已生成/);
});
