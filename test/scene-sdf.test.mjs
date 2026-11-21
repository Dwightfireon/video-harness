import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';
import { startServer } from '../lib/server.mjs';
import { initializeVisualMode, projectVisualMode, SDF_SOURCE } from '../lib/scene-sdf.mjs';
import { normalizeGeneratedMetadata } from '../lib/generator-metadata.mjs';
import { composeTask } from '../lib/task-prompts.mjs';

test('new visual mode is project-local; build wraps renderAt once; plain projects keep prior behavior', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-sdf-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (n,v) => fs.writeFileSync(path.join(dir,n),v);
  const read = n => fs.readFileSync(path.join(dir,n),'utf8');
  put('PROJECT.json','{}'); put('engine.tpl.html','<script>'); put('scenes.src.js','');
  assert.equal(projectVisualMode(dir),'dom');
  initializeVisualMode(dir,'dom');
  assert.equal(read('engine.tpl.html'),'<script>');
  const task = () => composeTask({ project: dir, repo: '.', mode: 'topic', message: 'test' });
  assert.doesNotMatch(task(), /按场混合画面/);
  initializeVisualMode(dir,'hybrid-sdf');
  initializeVisualMode(dir,'hybrid-sdf');
  assert.match(task(), /按场混合画面/);
  put('scene.html', read('engine.tpl.html') + 'const scenes = [];\nwindow.renderAt = t => {};\nwindow.renderAt(0);\n</script>');
  normalizeGeneratedMetadata(dir);
  const html = read('scene.html');
  assert.equal(html.match(/\/\* vh:sdf-v1 \*\//g).length,1);
  assert.equal(html.match(/\/\* vh:sdf-frame \*\//g).length,1);
  assert.equal(normalizeGeneratedMetadata(dir),false);
});

test('real opaque workbench preview: independent crossfade pixels, seek determinism, visible shader error and recovery', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-sdf-preview-'));
  const dir = path.join(root,'projects/fixture');
  fs.mkdirSync(path.join(dir,'out'), { recursive:true });
  fs.writeFileSync(path.join(dir,'PROJECT.json'), '{"visualMode":"hybrid-sdf"}');
  fs.writeFileSync(path.join(dir,'脚本.md'),'## S1 · 预览\n1. 预览。\n');
  fs.writeFileSync(path.join(dir,'scene.html'), `
<!doctype html><style>section {position:absolute;inset:0} b {position:relative;color:white}</style>
<section id="a" data-vh-scene-start="0"></section><section id="b" data-vh-scene-start="2"></section><section id="bad" data-vh-scene-start="6"></section>
<b>DOM 字幕保留</b>
<script>
window.W=320;window.H=180; const DURATION=10; const SUBS=[];
${SDF_SOURCE}
const a = VH_SDF.mount(document.querySelector('#a'), {fragment:'void main(){outColor=vec4(uTime*.2,0.,0.,1.);}'});
const b = VH_SDF.mount(document.querySelector('#b'), {fragment:'void main(){outColor=vec4(0.,.75,0.,1.);}'});
const bad = VH_SDF.mount(document.querySelector('#bad'), {fragment:'void main(){broken_word;}'});
window.renderAt = VH_SDF.wrap(t => { if(t<3) a(t); if(t>=2 && t<5) b(t-2); if(t>=6) bad(t-6); });
</script>`);
  const server = startServer(dir,0,{ root,home:root,publish:{},providerInfo:()=>[] });
  await once(server,'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(r=>server.close(r));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const base=`http://127.0.0.1:${server.address().port}`;
  const view=await (await fetch(base+'/_api/production?p=projects%2Ffixture')).json();
  assert.equal(view.visualMode,'hybrid-sdf');
  const browser=await launchBrowser(chromium,{headless:true,args:['--use-gl=angle','--use-angle=metal','--enable-gpu-rasterization','--ignore-gpu-blocklist']});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('**/_api/state?*', route => route.fulfill({ json: {
    name:'SDF fixture',stale:{},scenes:[{i:1,start:0,end:10,text:'预览'}],subs:[],duration:10,videos:[],sceneM:1,stillsCount:0,
  } }));
  await page.goto(base+'/?p=projects%2Ffixture');
  await page.waitForFunction(()=>document.querySelector('#frame').style.width==='320px');
  const frame=page.frames().find(f=>f.url().includes('/scene.html'));
  const seek=value=>page.locator('#scrub').evaluate((node,v)=>{node.value=v;node.dispatchEvent(new Event('input'));},value);
  const readings=()=>frame.evaluate(()=>[...document.querySelectorAll('canvas')].map(c=>c.width === 1 ? [1] : [c.width,
    ...c.getContext('2d').getImageData(0,0,1,1).data]));
  await seek(250);
  await frame.waitForFunction(()=>document.querySelector('#b canvas').width===320);
  const match=await readings();
  assert.deepEqual(match,[[320,128,0,0,255],[320,0,191,0,255],[1]]);
  assert.equal(await frame.locator('b').textContent(),'DOM 字幕保留');
  await seek(550);
  await frame.waitForFunction(()=>document.querySelector('#b canvas').width===1);
  await seek(250);
  await frame.waitForFunction(()=>document.querySelector('#b canvas').width===320);
  assert.deepEqual(await readings(),match);
  await seek(650);
  await page.locator('#frameWarn').waitFor({state:'visible'});
  assert.match(await page.locator('#frameWarn').textContent(),/场景起点 6s.*着色器编译失败/s);
  await seek(250);
  await page.locator('#frameWarn').waitFor({state:'hidden'});
  // Unsupported GPU must fail in the frame path, never produce a silent substitute.
  await page.addInitScript(() => {
    const ctx=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(kind,...args){return kind==='webgl2'?null:ctx.call(this,kind,...args);};
  });
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#frame').style.width==='320px');
  await page.locator('#frameWarn').waitFor({state:'visible'});
  assert.match(await page.locator('#frameWarn').textContent(),/无法创建 WebGL2/);
});
