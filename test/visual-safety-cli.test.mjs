import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { inspectableHtml } from './helpers/inspectable-html.mjs';

test('普通渲染检查未执行也必须阻断，force 和显式质量豁免不能绕过坏检查器', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vh-visual-gate-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'PROJECT.json'),'{}');
  fs.writeFileSync(path.join(dir,'scenes.src.js'),'root=>{return {render(){}};}');
  fs.writeFileSync(path.join(dir,'render.mjs'),'import fs from "node:fs";fs.writeFileSync("renderer-started","yes")');
  const invalid=inspectableHtml('const scenes = []; addScene(0,2,root=>({}));const DURATION=2;').replace('window.W=1920;','');
  fs.writeFileSync(path.join(dir,'scene.html'),invalid);
  for(const args of [[],['--force'],['--allow-low-contrast','--allow-layout-issues']]){
    const result=spawnSync(process.execPath,[path.resolve('vh.mjs'),'render','--dir',dir,...args],{encoding:'utf8',timeout:30000});
    assert.equal(result.status,1,result.stderr+result.stdout);
    assert.match(result.stderr+result.stdout,/检查执行失败/);
    assert.equal(fs.existsSync(path.join(dir,'renderer-started')),false);
    assert.equal(fs.readFileSync(path.join(dir,'scene.html'),'utf8'),invalid);
  }
});

test('普通模式在质检期间被外部改稿，不能用旧检查放行新版本',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vh-quality-version-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const htmlFile=path.join(dir,'scene.html');let changed=false;
  const server=createServer((req,res)=>{
    if(!changed){changed=true;fs.appendFileSync(htmlFile,'<!-- concurrent edit -->');}
    res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="white"/></svg>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  fs.writeFileSync(path.join(dir,'PROJECT.json'),'{}');
  fs.writeFileSync(path.join(dir,'scenes.src.js'),'root=>{return {render(){}};}');
  fs.writeFileSync(path.join(dir,'render.mjs'),'import fs from "node:fs";fs.writeFileSync("renderer-started","yes");process.exit(23);');
  fs.writeFileSync(htmlFile,inspectableHtml('const scenes = [];addScene(0,2,root=>({}));const DURATION=2;')+`<img src="http://127.0.0.1:${server.address().port}/asset.svg">`);
  const child=spawn(process.execPath,[path.resolve('vh.mjs'),'render','--dir',dir],{timeout:30000});let output='';
  child.stdout.on('data',x=>{output+=x;});child.stderr.on('data',x=>{output+=x;});
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(changed,true);assert.equal(code,1,output);assert.match(output,/质检期间制作输入发生变化/);
  assert.equal(fs.existsSync(path.join(dir,'renderer-started')),false);
  assert.ok(fs.readFileSync(htmlFile,'utf8').includes('concurrent edit'),'不撤销外部修改');
});

test('备用输出也必须在渲染后核对输入，不能登记旧画面的新源码基线',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vh-alternate-version-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'out'));fs.writeFileSync(path.join(dir,'PROJECT.json'),'{}');
  fs.writeFileSync(path.join(dir,'scenes.src.js'),'root=>({render(){}})');
  fs.writeFileSync(path.join(dir,'scene.html'),inspectableHtml('const scenes = [];addScene(0,2,root=>({}));const DURATION=2;'));
  const state='{"alternateRenders":{"proof":{"original":"preserve"}}}';fs.writeFileSync(path.join(dir,'out/.vh-state.json'),state);
  fs.writeFileSync(path.join(dir,'render.mjs'),'import fs from "node:fs";fs.appendFileSync("scene.html","<!-- changed during render -->");');
  const result=spawnSync(process.execPath,[path.resolve('vh.mjs'),'render','--dir',dir,'--name','proof'],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,1,result.stderr+result.stdout);assert.match(result.stderr+result.stdout,/阶段运行期间制作输入发生变化/);
  assert.equal(fs.readFileSync(path.join(dir,'out/.vh-state.json'),'utf8'),state);
  const events=fs.readFileSync(path.join(dir,'out/.vh-performance.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const render=events.find(e=>e.kind==='step'&&e.stage==='渲染器（截图与编码）');
  const command=events.find(e=>e.kind==='command');
  assert.equal(render.ok,true);
  assert.equal(command.ok,false);
  assert.equal(command.failureCode,'inputs-changed');
  assert.equal(command.exitCode,1);
  assert.equal(render.runId,command.runId);
});
