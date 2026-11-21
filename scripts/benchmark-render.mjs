#!/usr/bin/env node
/* Small real-render benchmark; never reads/writes existing video projects.
 * --force skips only the legacy human-checklist prompt in this synthetic fixture.
 * Ordinary browser contrast/layout checks remain enabled. Not an end-to-end TTS benchmark. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-render-perf-'));
const logFile = path.resolve(process.argv[2] || path.join(dir, 'benchmark.log'));
try {
  fs.symlinkSync(fileURLToPath(new URL('../', import.meta.resolve('playwright'))), path.join(dir, 'node_modules'), 'dir');
  const skill = process.env.ARTICLE_VIDEO_SKILL || path.join(os.homedir(), '.config/opencode/skills/article-video');
  fs.copyFileSync(path.join(skill, 'assets/render.mjs'), path.join(dir, 'render.mjs'));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{"deliveryTarget":"video"}');
  const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:white;color:#111}.scene{position:absolute;inset:0;background:white}
  .title{position:absolute;left:120px;top:200px;font:48px sans-serif}
  #subbox{position:absolute;left:300px;top:950px;font:40px/1.35 sans-serif;z-index:10}</style><body><div id="subbox"></div><script>
  window.W=1920;window.H=1080;
  const SUBS = [{"s":0.2,"e":1.8,"t":"First subtitle"},{"s":2.2,"e":3.8,"t":"Second subtitle"},{"s":4.2,"e":5.8,"t":"Third subtitle"},{"s":6.2,"e":7.8,"t":"Fourth subtitle"},{"s":8.2,"e":9.8,"t":"Fifth subtitle"}];
  const scenes = [];
  function addScene(a,b,build){const el=document.createElement('div');el.className='scene';document.body.appendChild(el);build(el);scenes.push({a,b,el});}
  __SCENES__
  const DURATION = 10;window.DURATION=DURATION;
  window.renderAt=async t=>{for(const s of scenes)s.el.style.display=t>=s.a&&t<s.b?'block':'none';document.getElementById('subbox').textContent=SUBS.find(s=>t>=s.s&&t<s.e)?.t||'';};window.renderAt(0);
  </script>`;
  const scenes = `root=>{root.innerHTML='<div class="title">First scene</div>'}
//---
root=>{root.innerHTML='<div class="title">Second scene</div>'}
//---
root=>{root.innerHTML='<div class="title">Third scene</div>'}
//---
root=>{root.innerHTML='<div class="title">Fourth scene</div>'}
//---
root=>{root.innerHTML='<div class="title">Fifth scene</div>'}`;
  fs.writeFileSync(path.join(dir, 'engine.tpl.html'), html);
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), scenes);
  fs.writeFileSync(path.join(dir, 'gen.mjs'), `import fs from 'node:fs';
    const bodies=fs.readFileSync('scenes.src.js','utf8').split('//---');
    fs.writeFileSync('scene.html',fs.readFileSync('engine.tpl.html','utf8').replace('__SCENES__',bodies.map((b,i)=>'addScene('+i*2+','+(i+1)*2+','+b.trim()+');').join('\\n')));`);
  fs.writeFileSync(logFile, 'Synthetic 10s, 1920x1080, 12fps, jobs=1, crf=25.\n');
  const build = () => {
    const r = spawnSync(process.execPath, [path.join(root, 'vh.mjs'), 'build', '--estimate', '--dir', dir], { encoding: 'utf8', timeout: 120000 });
    fs.appendFileSync(logFile, '\nbuild\n' + r.stdout + r.stderr);
    if (r.status !== 0) throw new Error('Synthetic build failed: ' + r.stderr);
  };
  const run = (label, flags = []) => {
    const start = performance.now();
    const result = spawnSync(process.execPath, [path.join(root, 'vh.mjs'), 'render', '--dir', dir, '--fps', '12', '--jobs', '1', '--crf', '25', ...flags],
      { encoding: 'utf8', timeout: 120000 });
    fs.appendFileSync(logFile, `\n${label}\n${result.stdout}\n${result.stderr}`);
    if (result.status !== 0) throw new Error(label + ': exit=' + result.status + '; ' + result.stderr);
    const summary = { label, ms: Math.round(performance.now() - start),
      incremental: result.stdout.includes('自动增量'), skipped: result.stdout.includes('跳过渲染'),
      segments: result.stdout.match(/分段编码：[^\n]+/)?.[0] };
    console.log(JSON.stringify(summary)); fs.appendFileSync(logFile, JSON.stringify(summary) + '\n');
  };
  build();
  run('initial', ['--force']);
  run('unchanged');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), scenes.replace('Third scene', 'Third scene updated'));
  build();
  run('one-scene-edit', ['--force']);
  if (process.argv[2]) console.log('Log: ' + logFile);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
