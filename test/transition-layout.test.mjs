import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUNTIME_FOR_TPL } from '../lib/transition.mjs';
import { measureLayout } from '../lib/layout-measured.mjs';

test('push/wipe/fade 的邻场进出不误报越界；本场的真实碰撞仍须阻断', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vh-transition-layout-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const html=kind=>`<!doctype html><style>body{margin:0}.scene{position:absolute;inset:0;overflow:hidden}.title{position:absolute;left:40px;top:100px;font:40px sans-serif}</style><body><script>
    window.W=1920;window.H=1080;window.DURATION=20;const scenes = [];
    function addScene(start,end,build){const root=document.createElement('div');root.className='scene';document.body.appendChild(root);build(root);scenes.push({start,end,root,render(){}});}
    addScene(0,10,root=>{root.innerHTML='<div class="title">第一场标题</div>';});
    addScene(10,20,root=>{root.innerHTML='<div class="title">第二场标题</div>';});
    window.__vhTrans=[{k:'${kind}'},{k:'${kind}'}];window.renderAt=()=>{};
    ${RUNTIME_FOR_TPL}</script>`;
  for(const kind of ['push','wipe','fade']){
    fs.writeFileSync(path.join(dir,'scene.html'),html(kind));
    const result=await measureLayout(dir);assert.equal(result.ok,true,kind+JSON.stringify(result.findings));
    assert.ok(result.scenes[1].probes.includes(10.15));
  }
  fs.writeFileSync(path.join(dir,'scene.html'),html('push').replace('第二场标题</div>','第二场标题</div><div class="title">新增的重叠标题</div>'));
  assert.ok((await measureLayout(dir)).findings.some(f=>f.scene===2&&f.kind==='text-overlap'));
});
