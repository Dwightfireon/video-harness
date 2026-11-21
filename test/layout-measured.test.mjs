import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { measureLayout, report } from '../lib/layout-measured.mjs';

let chromium;
try { ({ chromium } = await import('playwright')); } catch {}
const SKIP = chromium ? false : '没有 playwright';

function project(t, sceneBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-layout-m-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), sceneBody);
  fs.writeFileSync(path.join(dir, 'scene.html'), `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#F6F7F6;overflow:hidden}
  .scene{position:absolute;inset:0;display:none}
  </style></head><body>
  <div class="scene" id="s1"></div>
  <div id="subs" style="position:fixed;left:0;right:0;bottom:0;height:200px;background:#222;color:#fff">字幕</div>
  <script>
  const W=1920,H=1080; window.W=W; window.H=H;
  const scenes=[]; window.renderAt=t=>{ scenes.forEach(s=>{s.el.style.display=(t>=s.a&&t<s.b)?'block':'none';s.api?.render?.(t-s.a);}); };
  const addScene=(a,b,fn)=>{ const el=document.getElementById('s1'); el.style.display='block'; const api=fn(el); scenes.push({a,b,el,api}); };
  addScene(0,10,${sceneBody});
  window.renderAt(0);
  </script></body></html>`);
  return dir;
}

test('文字压到独立装饰框上会被实测报出（静态 abs 检查抓不到这种写法）', { skip: SKIP }, async t => {
  const dir = project(t, `root => {
    const box = document.createElement('div');
    box.style.cssText='position:absolute;left:140px;top:288px;width:300px;height:54px;border:2px solid #000;border-radius:27px';
    root.appendChild(box);
    const txt = document.createElement('div');
    txt.textContent='Expand Prompt';
    txt.style.cssText='position:absolute;left:330px;top:300px;width:400px;height:32px;font-size:21px';
    root.appendChild(txt);
  }`);
  const result = await measureLayout(dir);
  const hit = result.findings.find(f => f.kind === 'text-on-frame');
  assert.ok(hit, '应报出文字压框：' + JSON.stringify(result.findings));
  assert.match(hit.text, /Expand Prompt/);
});

test('正常嵌套的卡片文字不误报压框', { skip: SKIP }, async t => {
  const dir = project(t, `root => {
    const card = document.createElement('div');
    card.style.cssText='position:absolute;left:140px;top:300px;width:600px;height:200px;border:1px solid #ccc;background:#fff';
    const txt = document.createElement('div');
    txt.textContent='卡片里的说明文字';
    txt.style.cssText='position:absolute;left:30px;top:30px;width:500px;height:40px;font-size:24px';
    card.appendChild(txt); root.appendChild(card);
  }`);
  const result = await measureLayout(dir);
  assert.equal(result.findings.filter(f => f.kind === 'text-on-frame').length, 0, JSON.stringify(result.findings));
});

test('字幕层是旁白镜像，不参与版式判定', { skip: SKIP }, async t => {
  const dir = project(t, `root => {
    const t = document.createElement('div');
    t.textContent='正文';
    t.style.cssText='position:absolute;left:140px;top:300px;width:600px;height:60px;font-size:40px';
    root.appendChild(t);
  }`);
  const result = await measureLayout(dir);
  assert.equal(result.findings.filter(f => /字幕/.test(f.text)).length, 0, '字幕不应被报成压字幕区');
});

test('报告能给出具体像素依据，不是只说“有问题”', { skip: SKIP }, async t => {
  const dir = project(t, `root => {
    const t = document.createElement('div');
    t.textContent='压到安全区的文字';
    t.style.cssText='position:absolute;left:140px;top:900px;width:600px;height:60px;font-size:40px';
    root.appendChild(t);
  }`);
  const result = await measureLayout(dir);
  const text = report(result);
  assert.match(text, /安全线|px/);
});

test('同一帧检查组件重叠，不依赖两块文字恰好相碰', { skip: SKIP }, async t => {
  const dir = project(t, `root => {
    for (const y of [100,220]) {
      const card=document.createElement('div');
      card.style.cssText='position:absolute;left:100px;top:'+y+'px;width:400px;height:200px;background:#fff;border:1px solid #000';
      const txt=document.createElement('span');txt.textContent='卡片 '+y;
      txt.style.cssText='position:absolute;left:20px;top:20px;font-size:24px';card.appendChild(txt);root.appendChild(card);
    }
  }`);
  const result=await measureLayout(dir);
  assert.ok(result.findings.some(f=>f.kind==='component-overlap'),JSON.stringify(result));
  assert.equal(result.findings.some(f=>f.kind==='text-overlap'),false);
});

test('祖先隐藏的文字不误报；父子文字节点全部被观测', { skip: SKIP }, async t => {
  const dir=project(t,`root=>{
    root.innerHTML='<div style="position:absolute;left:100px;top:100px;font-size:40px">父文字<span>子文字</span></div><div style="display:none"><span style="position:absolute;left:100px;top:100px;font-size:40px">隐藏文字</span></div>';
  }`);
  const result=await measureLayout(dir);
  assert.equal(result.ok,true,JSON.stringify(result.findings));
});

test('祖先纵向裁切与换行后的实际行框均被检查', { skip: SKIP }, async t => {
  const dir=project(t,`root=>{
    root.innerHTML='<div style="position:absolute;left:100px;top:100px;width:100px;height:20px;overflow:hidden"><div style="font-size:40px">多行文字多行文字</div></div>';
  }`);
  const result=await measureLayout(dir);
  assert.ok(result.findings.some(f=>f.kind==='text-overflow'),JSON.stringify(result));
});

test('不同时间出现的文字不能拼成一帧再报碰撞', { skip: SKIP }, async t => {
  const dir=project(t,`root=>{
    const a=document.createElement('div'),b=document.createElement('div');
    for(const el of [a,b]){el.style.cssText='position:absolute;left:100px;top:100px;font-size:40px';root.appendChild(el);}
    a.textContent='先展示';b.textContent='后展示';
    return {render(t){a.style.display=t<5?'block':'none';b.style.display=t>=5?'block':'none';}};
  }`);
  const result=await measureLayout(dir);
  assert.equal(result.ok,true,JSON.stringify(result.findings));
  assert.ok(result.sampled>3);
});

test('叠放只能在具体元素显式声明，不能给整场加豁免', { skip: SKIP }, async t => {
  const dir=project(t,`root=>{
    root.setAttribute('data-vh-overlap','all');
    root.innerHTML='<div style="position:absolute;left:100px;top:100px;font-size:40px">第一段文字</div><div style="position:absolute;left:100px;top:100px;font-size:40px">第二段文字</div>';
  }`);
  assert.ok((await measureLayout(dir)).findings.some(f=>f.kind==='text-overlap'));
  let html=fs.readFileSync(path.join(dir,'scene.html'),'utf8');
  html=html.replaceAll('<div style="position:absolute;left:100px;', '<div data-vh-overlap="named-title" style="position:absolute;left:100px;');
  fs.writeFileSync(path.join(dir,'scene.html'),html);
  assert.equal((await measureLayout(dir)).ok,true);
});
