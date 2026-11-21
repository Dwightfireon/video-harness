import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { create, restore } from '../lib/snapshot.mjs';
import { compare } from '../lib/compare.mjs';
import { inspectableHtml } from './helpers/inspectable-html.mjs';

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vh-visual-compare-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'scenes.src.js'),'root=>{return {render(){}};}');
  fs.writeFileSync(path.join(dir,'engine.tpl.html'),'original engine');
  fs.writeFileSync(path.join(dir,'scene.html'),inspectableHtml('const scenes = []; addScene(0,2,root=>({}));const DURATION=2;'));
  fs.writeFileSync(path.join(dir,'gen.mjs'),'throw new Error("comparison must not execute generator");');
  return dir;
}

test('比较使用真实快照预览，从不更换正式源码、重跑生成器或还原当前画面',async t=>{
  const dir=fixture(t),snap=create(dir,'before');
  const html=fs.readFileSync(path.join(dir,'scene.html'),'utf8').replace('Readable fixture','Updated fixture');
  fs.writeFileSync(path.join(dir,'scene.html'),html);
  const before=new Map(['scenes.src.js','engine.tpl.html','scene.html','gen.mjs'].map(n=>[n,fs.readFileSync(path.join(dir,n))]));
  const result=await compare(dir);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.rows,1);assert.ok(fs.statSync(result.file).size>0);
  for(const [n,bytes]of before)assert.deepEqual(fs.readFileSync(path.join(dir,n)),bytes,n);
  restore(dir,path.basename(snap.dir));
  assert.equal(fs.readFileSync(path.join(dir,'scene.html'),'utf8'),html,'undo 不恢复旧预览冒充新作者稿');
});

test('旧快照缺少真实预览时不伪造；素材变化或快照损坏时拒绝比较',async t=>{
  const dir=fixture(t),snap=create(dir,'before'),metaFile=path.join(snap.dir,'_meta.json');
  const meta=JSON.parse(fs.readFileSync(metaFile));
  fs.writeFileSync(metaFile,JSON.stringify({...meta,preview:null}));
  assert.match((await compare(dir)).error,/没有保存真实预览/);
  fs.writeFileSync(metaFile,JSON.stringify(meta));
  fs.mkdirSync(path.join(dir,'assets'));fs.writeFileSync(path.join(dir,'assets','new.txt'),'changed');
  assert.match((await compare(dir)).error,/素材已变/);
  fs.appendFileSync(path.join(snap.dir,'_preview.html'),'changed');
  assert.match((await compare(dir)).error,/指纹不匹配/);
});
