import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserSource } from '../lib/film.mjs';
import { normalizeGeneratedMetadata } from '../lib/generator-metadata.mjs';
import { launchBrowser } from '../lib/browser.mjs';

test('真实标准生成入口：builder执行前得到边界，重测后的句级动作不沿用旧起点', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-motion-context-')); let browser;
  try {
    const { chromium } = await import('playwright'); browser = await launchBrowser(chromium, { headless: true });
    const page = await browser.newPage();
    const builder = `root => {
  const F = window.VH_FILM;
  const plan = F.compileMotion({subs:SUBS,...F.sceneTiming(root),targets:{file:{opacity:0}},
    beats:[{id:'reveal',target:'file',cue:{text:'文件已更新'},dur:1,to:{opacity:1}}]});
  window.__plan = plan;
  return {render(t){window.__sample = plan.sample(t);root.style.opacity = window.__sample.targets.file.opacity;}};
}`;
    fs.writeFileSync(path.join(dir, 'scenes.src.js'), builder);
    for (const start of [30, 42.25]) {
      const html = `<!doctype html><body><div id="stage"></div><script>
${browserSource()}
const stage = document.getElementById('stage');
const mk = () => document.createElement('div');
const SUBS = [{s:${start + 3},e:${start + 7},t:'文件已更新'}];
const scenes = [];
function addScene(start, end, build, fade){
  const root = mk('div','scene');
  stage.appendChild(root);
  const api = build(root) || {};
  scenes.push({start,end,root,render:api.render});
}
addScene(${start},${start + 20},${builder});
const DURATION = ${start + 20};
window.DURATION = DURATION;
window.W = 1920; window.H = 1080;
window.renderAt = t => { for(const s of scenes) s.render(t-s.start); };
window.renderAt(0);
</script>`;
      const file = path.join(dir, 'scene.html'); fs.writeFileSync(file, html);
      assert.equal(normalizeGeneratedMetadata(dir), true); assert.equal(normalizeGeneratedMetadata(dir), false);
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(t => window.renderAt(t), start + 3.5);
      const value = await page.evaluate(() => ({ at: window.__plan.beats[0].at,
        opacity: window.__sample.targets.file.opacity, start: document.querySelector('#stage>div').dataset.vhSceneStart }));
      assert.deepEqual(value, { at: 3, opacity: .5, start: String(start) });
    }
  } finally { if (browser) await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
