import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewSubtitles } from '../lib/subtitle-review.mjs';

/* 回归：Playwright 自带内核缺失时，必须回退到本机 Chrome，而不是把
   所有“字幕实际显示”测试都报成环境错误。 */

const text = '孔子立刻说：赐啊，现在可以和你谈诗了——告诸往而知来者，告诉你过去的事，你能推知别的事。';
function fixture(t, { broken = false, narrow = false, hidden = false } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-subs-review-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const fx = fs.readFileSync(new URL('../assets/fx-block.html', import.meta.url), 'utf8');
  const a = fx.indexOf('function subtitleBreaker(maxW) {');
  const tail = 'window.VH_UI = Object.assign(window.VH_UI || {}, { subtitleBreaker });';
  const block = fx.slice(a, fx.indexOf(tail, a) + tail.length);
  fs.writeFileSync(path.join(project, 'scene.html'), `<!doctype html><meta charset="utf-8">
<style>body{margin:0}#subs{position:absolute;bottom:52px;left:0;width:1920px;display:flex;justify-content:center}
#subbox{font:40px/1.35 sans-serif;max-width:${narrow ? 100 : 1560}px;padding:20px 40px;box-sizing:border-box;background:#111;color:white}</style>
<div id="subs"><div id="subbox"></div></div><script>
window.W=1920;window.H=1080;const SUBS=[{s:.5,e:9,t:${JSON.stringify(text)}}];
window.__subbox=document.getElementById('subbox');
function renderSubs(t){__subbox.textContent=SUBS[0].t${broken ? '.slice(0,20)' : ''};__subbox.style.opacity=${hidden ? 0 : 1};}
window.renderAt=t=>renderSubs(t);
${broken || hidden ? '' : block}
</script>`);
  return project;
}

test('字幕实际显示：完整长句覆盖开始、中间、结束，不靠 SUBS 源文通过', async t => {
  const result = await reviewSubtitles(fixture(t));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.cues, 1); assert.equal(result.probes, 3);
  assert.equal(result.maxLines, 2);
});
test('字幕实际显示：SUBS 完整但 DOM 丢掉后半句，必须失败', async t => {
  const result = await reviewSubtitles(fixture(t, { broken: true }));
  assert.equal(result.ok, false); assert.equal(result.failures.length, 3);
  assert.ok(result.failures.every(f => !f.matches));
});
test('字幕实际显示：字都存在但字幕隐藏，必须失败', async t => {
  const result = await reviewSubtitles(fixture(t, { hidden: true }));
  assert.equal(result.ok, false); assert.ok(result.failures.every(f => !f.visible));
});
test('字幕实际显示：超窄字幕撑出画布，不能以完整文字冒充正常显示', async t => {
  const result = await reviewSubtitles(fixture(t, { narrow: true }));
  assert.equal(result.ok, false); assert.ok(result.failures.some(f => f.outside));
});

test('批量字幕实显仍逐个等待异步 renderAt，覆盖跨批次的全部首中尾', async t => {
  const project = fixture(t);
  const subs = Array.from({ length: 19 }, (_, i) => ({ s: i * 3 + .5, e: i * 3 + 2.8, t: `第${i + 1}条完整字幕` }));
  fs.writeFileSync(path.join(project, 'scene.html'), `<!doctype html><style>
    body{margin:0}#subbox{position:absolute;top:900px;left:300px;font:40px/1.35 sans-serif}
    </style><div id="subbox"></div><script>
    window.W=1920;window.H=1080;const SUBS=${JSON.stringify(subs)};
    window.renderAt=async t=>{
      await new Promise(resolve=>setTimeout(resolve,1));
      const sub=SUBS.find(s=>t>=s.s&&t<s.e);
      document.getElementById('subbox').textContent=sub?.t||'';
    };</script>`);
  const result = await reviewSubtitles(project);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.cues, 19);
  assert.equal(result.probes, 57);
});

test('批次后段的截字不能因合批而漏检', async t => {
  const project = fixture(t);
  const subs = Array.from({ length: 19 }, (_, i) => ({ s: i * 3 + .5, e: i * 3 + 2.8, t: `第${i + 1}条完整字幕` }));
  fs.writeFileSync(path.join(project, 'scene.html'), `<!doctype html><style>
    body{margin:0}#subbox{position:absolute;top:900px;left:300px;font:40px/1.35 sans-serif}
    </style><div id="subbox"></div><script>
    window.W=1920;window.H=1080;const SUBS=${JSON.stringify(subs)};
    window.renderAt=t=>{
      const sub=SUBS.find(s=>t>=s.s&&t<s.e);
      document.getElementById('subbox').textContent=t>54 ? sub.t.slice(0,3) : sub?.t||'';
    };</script>`);
  const result = await reviewSubtitles(project);
  assert.equal(result.ok, false);
  assert.equal(result.probes, 57);
  assert.equal(result.failures.length, 3);
  assert.ok(result.failures.every(f => f.cue === 19 && !f.matches));
});
