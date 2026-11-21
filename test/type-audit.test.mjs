import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, report, ladderOf, LADDER } from '../lib/type-audit.mjs';

/* 字号纪律：为什么值得测
   实测 e2e 8 场里 6 场违规，其中两场同屏 5 档字号（54/40/24/21/20）。
   这是"看着不高级"的第一原因——不是配色，是字号在打架。
   判据必须能抓三种写法：font-size:20px、label(el,20)、type(el,'h1')。 */

const TPL = `<!doctype html><html><head><style>
:root{ --fs-hero:176px; --fs-display:112px; --fs-h1:54px; --fs-h2:40px; --fs-body:26px; --fs-note:24px; --fs-label:24px; }
</style></head><body><script>
const ORIENT = 'landscape';
const PRESET = {
  landscape: { W: 1920, H: 1080, fs: { hero: 176, display: 112, h1: 54, h2: 40, body: 26, note: 24, label: 24 } },
  portrait: { W: 1080, H: 1920, fs: { hero: 124, display: 84, h1: 46, h2: 34, body: 26, note: 23, label: 20 } },
};
</script></body></html>`;

const mk = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-type-'));
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(d, k), v, 'utf8');
  return d;
};

test('type：阶梯必须从 scene.html 的 PRESET 读（横竖屏不同档）', () => {
  const d = mk({ 'scene.html': TPL, 'scenes.src.js': 'root => {}' });
  const l = ladderOf(d);
  assert.equal(l.orient, 'landscape');
  assert.equal(l.sizes.h1, 54);
  assert.equal(l.sizes.hero, 176);
});

test('type：硬编码 font-size 不在阶梯内 → 报 off-ladder', () => {
  const d = mk({
    'scene.html': TPL,
    'scenes.src.js': `root => {
      const a = mk('div','','x'); a.style.cssText = 'font-size:20px';
      return {};
    }`,
  });
  const r = scan(d);
  assert.ok(r.findings.some(f => f.kind === 'off-ladder'), JSON.stringify(r.findings));
});

test('type：label(el, 20) 这种写法也要抓（它也是硬编码的变体）', () => {
  const d = mk({
    'scene.html': TPL,
    'scenes.src.js': `root => {
      const a = mk('div','','x'); label(a, 21, 400, 'var(--ink3)');
      return {};
    }`,
  });
  const r = scan(d);
  assert.ok(r.findings.some(f => f.kind === 'off-ladder'), 'label(…, 21) 应被查出');
});

test('type：同屏超过 3 档 → 报 too-many-tiers', () => {
  const d = mk({
    'scene.html': TPL,
    'scenes.src.js': `root => {
      const a = mk('div','','x'); type(a, 'h1');
      const b = mk('div','','y'); type(b, 'h2');
      const c = mk('div','','z'); type(c, 'body');
      const e = mk('div','','w'); type(e, 'note');
      return {};
    }`,
  });
  const r = scan(d);
  assert.ok(r.findings.some(f => f.kind === 'too-many-tiers'), JSON.stringify(r.findings));
});

test('type：3 档以内且都在阶梯内 → 通过', () => {
  const d = mk({
    'scene.html': TPL,
    'scenes.src.js': `root => {
      const a = mk('div','','x'); type(a, 'h1');
      const b = mk('div','','y'); type(b, 'body');
      const c = mk('div','','z'); type(c, 'note');
      return {};
    }`,
  });
  const r = scan(d);
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
});

test('type：一屏多个 hero → 报 multi-hero', () => {
  const d = mk({
    'scene.html': TPL,
    'scenes.src.js': `root => {
      const a = mk('div','','x'); type(a, 'hero');
      const b = mk('div','','y'); type(b, 'hero');
      return {};
    }`,
  });
  const r = scan(d);
  assert.ok(r.findings.some(f => f.kind === 'multi-hero'), JSON.stringify(r.findings));
});

test('type：用 var(--fs-h1) 视为合法（走 token）', () => {
  const d = mk({
    'scene.html': TPL,
    'scenes.src.js': `root => {
      const a = mk('div','','x'); a.style.cssText = 'font-size:var(--fs-h1)';
      return {};
    }`,
  });
  const r = scan(d);
  assert.deepEqual(r.findings.filter(f => f.kind === 'off-ladder'), []);
});

test('type：竖屏档位不同（h1 = 46 不是 54）', () => {
  const html = TPL.replace("const ORIENT = 'landscape';", "const ORIENT = 'portrait';");
  const d = mk({ 'scene.html': html, 'scenes.src.js': 'root => {}' });
  const l = ladderOf(d);
  assert.equal(l.orient, 'portrait');
  assert.equal(l.sizes.h1, 46);
});

test('type：report 打印合法档位，让人知道该改成什么', () => {
  const d = mk({
    'scene.html': TPL,
    'scenes.src.js': `root => { const a = mk('div','','x'); a.style.cssText = 'font-size:20px'; return {}; }`,
  });
  const t = report(scan(d));
  assert.match(t, /合法档位/);
  assert.match(t, /176 \/ 112 \/ 54/);
});

test('type：没有 scenes.src.js 时给说明，不崩', () => {
  const d = mk({ 'scene.html': TPL });
  const r = scan(d);
  assert.match(r.note, /scenes\.src\.js/);
});

test('type：LADDER 常量覆盖 7 档', () => {
  assert.equal(LADDER.length, 7);
  assert.ok(LADDER.includes('hero'));
  assert.ok(LADDER.includes('label'));
});
