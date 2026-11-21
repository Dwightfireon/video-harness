import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';
import { LAYOUT_RUNTIME, injectLayoutRuntime } from '../lib/layout-runtime.mjs';
import { collectLayoutFrame } from '../lib/layout-observation.mjs';
import { layoutFindings } from '../lib/layout-geometry.mjs';

test('容器布局注入在构建场景前，幂等且保留原画面代码', () => {
  const html='<script>const scenes = [];\naddScene(0,10,root=>({render(){}}));</script>';
  const next=injectLayoutRuntime(html);
  assert.ok(next.indexOf('window.VH_LAYOUT')<next.indexOf('addScene('));
  assert.equal(injectLayoutRuntime(next),next);
  assert.ok(next.endsWith('addScene(0,10,root=>({render(){}}));</script>'));
  assert.equal(injectLayoutRuntime('<script>custom()</script>'),'<script>custom()</script>');
});

for(const portrait of [false,true]) test(`实际换行驱动容器高度与后续位置，不裁字（${portrait?'竖屏':'横屏'}）`, async t=>{
  const browser=await launchBrowser(chromium,{headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:portrait?1080:1920,height:portrait?1920:1080}});
  await page.setContent(`<body style="margin:0"><script>window.W=${portrait?1080:1920};window.H=${portrait?1920:1080};${LAYOUT_RUNTIME}</script></body>`);
  const r=await page.evaluate(()=>{
    const flow=VH_LAYOUT.flow(document.body,{x:100,y:100,w:500,bottom:window.H-200,gap:24,id:'main'});
    const a=document.createElement('div'),b=document.createElement('div');
    for(const el of [a,b])el.style.font='32px/1.5 sans-serif';
    a.textContent='较长的标题，需要按照真实宽度换行，后面的内容必须跟随实际高度移动。';b.textContent='第二段正文';
    flow.add(a,{id:'title'});flow.add(b,{id:'body'});
    const before=b.getBoundingClientRect().top;
    a.style.fontSize='48px';
    const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();
    return {gap:br.top-ar.bottom,before,after:br.top,result:flow.assertFits()};
  });
  assert.equal(r.gap,24);assert.ok(r.after>r.before);assert.equal(r.result.ok,true);
  const frame=await page.evaluate(collectLayoutFrame);assert.deepEqual(layoutFindings(frame),[]);
});

test('装不下必须报告真实溢出，不缩字、裁字或删除原文', async t=>{
  const browser=await launchBrowser(chromium,{headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();await page.setContent(`<body><script>window.W=1080;window.H=1920;${LAYOUT_RUNTIME}</script></body>`);
  const r=await page.evaluate(()=>{
    const flow=VH_LAYOUT.flow(document.body,{x:100,y:100,w:200,bottom:200,gap:20});
    const el=document.createElement('div');el.style.font='48px/1.5 sans-serif';el.textContent='不能为了通过检查而删掉的完整文字';flow.add(el);
    let error;try{flow.assertFits();}catch(e){error=e.message;}
    return {error,text:el.textContent,font:el.style.fontSize,overflow:flow.el.style.overflow};
  });
  assert.match(r.error,/不得裁字/);assert.equal(r.text,'不能为了通过检查而删掉的完整文字');assert.equal(r.font,'48px');assert.equal(r.overflow,'visible');
});
