import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, report, tokensOf } from '../lib/token-audit.mjs';
import { scan as rhythmScan } from '../lib/rhythm.mjs';
import { scan as motionScan, report as motionReport } from '../lib/motion.mjs';
import { scan as transScan, readTransitionTags, KINDS } from '../lib/transition.mjs';

/* 审美纪律三件套 + 动效 + 转场：为什么值得测
   前七批查的是"讲清楚了没有"，这一层查的是"好不好看"。
   每条判据都必须给出**可执行的数字**（改成几档、几个圆角、几秒一次变化），
   否则它就只是又一个"警告"，没人会照着改。 */

const TPL = `<!doctype html><html><head><style>
:root{ --bg:#FAF9F5; --ink:#141413; --ink2:#5E5D59; --ink3:#87867F; --accent:#D97757;
  --line:#E8E6DC; --card:#FFFFFF; --radius:20px; --shadow-sm:0 2px 6px rgba(0,0,0,.04); --scrim-dark:rgba(8,14,10,.72); }
</style></head><body><script>
const ORIENT = 'landscape';
const PRESET = { landscape: { W: 1920, H: 1080, fs: { hero:176, display:112, h1:54, h2:40, body:26, note:24, label:24 } } };
</script></body></html>`;

const mk = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-aes-'));
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(d, k), v, 'utf8');
  return d;
};

/* ---------------- token ---------------- */
test('tokens：能读出引擎里的 token 名', () => {
  const d = mk({ 'engine.tpl.html': TPL });
  const t = tokensOf(d);
  assert.ok(t.names.includes('--accent'));
  assert.ok(t.names.includes('--radius'));
});

test('tokens：颜色写死 hex → 报 color', () => {
  const d = mk({
    'engine.tpl.html': TPL, 'scene.html': TPL,
    'scenes.src.js': `root => { const a = mk('div','','x'); a.style.cssText = 'background:#147A3A'; return {}; }`,
  });
  const r = scan(d);
  assert.ok(r.findings.some(f => f.kind === 'color'), JSON.stringify(r.findings));
});

test('tokens：白/黑/透明不算违规（没有品牌语义）', () => {
  const d = mk({
    'engine.tpl.html': TPL, 'scene.html': TPL,
    'scenes.src.js': `root => {
      const a = mk('div','','x'); a.style.cssText = 'background:#fff;color:#000';
      const b = mk('div','','y'); b.style.cssText = 'background:transparent';
      return {};
    }`,
  });
  const r = scan(d);
  assert.deepEqual(r.findings.filter(f => f.kind === 'color'), []);
});

test('tokens：圆角写死 → 报 radius（细线 ≤4px 与胶囊 999px 除外）', () => {
  const d = mk({
    'engine.tpl.html': TPL, 'scene.html': TPL,
    'scenes.src.js': `root => {
      const a = mk('div','','x'); a.style.cssText = 'border-radius:12px';
      const b = mk('div','','y'); b.style.cssText = 'border-radius:2px';
      const c = mk('div','','z'); c.style.cssText = 'border-radius:999px';
      return {};
    }`,
  });
  const r = scan(d);
  const rad = r.findings.filter(f => f.kind === 'radius');
  assert.equal(rad.length, 1, '只有 12px 该被报：' + JSON.stringify(r.findings));
  assert.match(rad[0].msg, /12px/);
});

test('tokens：全片 3 种以上圆角 → 报 radius-inconsistent', () => {
  const d = mk({
    'engine.tpl.html': TPL, 'scene.html': TPL,
    'scenes.src.js': `root => { const a = mk('div','','x'); a.style.cssText = 'border-radius:12px'; return {}; }
//---
root => { const b = mk('div','','y'); b.style.cssText = 'border-radius:20px'; return {}; }
//---
root => { const c = mk('div','','z'); c.style.cssText = 'border-radius:28px'; return {}; }`,
  });
  const r = scan(d);
  assert.ok(r.findings.some(f => f.kind === 'radius-inconsistent'), JSON.stringify(r.findings));
});

test('tokens：走 var() 就不报', () => {
  const d = mk({
    'engine.tpl.html': TPL, 'scene.html': TPL,
    'scenes.src.js': `root => {
      const a = mk('div','','x'); a.style.cssText = 'background:var(--accent);border-radius:var(--radius)';
      return {};
    }`,
  });
  const r = scan(d);
  assert.deepEqual(r.findings.filter(f => ['color', 'radius'].includes(f.kind)), []);
});

/* ---------------- rhythm ---------------- */
test('rhythm：间距不在 4px 阶梯 → 报 spacing', () => {
  const d = mk({
    'engine.tpl.html': TPL, 'scene.html': TPL,
    'scenes.src.js': `root => { const a = mk('div','','x'); a.style.cssText = 'padding:17px'; return {}; }`,
  });
  const r = rhythmScan(d);
  assert.ok(r.findings.some(f => f.kind === 'spacing'), JSON.stringify(r.findings));
});

test('rhythm：标题起点多种 → 报 inconsistent-top', () => {
  const d = mk({
    'engine.tpl.html': TPL, 'scene.html': TPL,
    'scenes.src.js': `root => {
  const S = window.VH_UI.safeArea();
  const t = line('一'); abs(t.el, S.pad, Math.round(S.top + S.h * 0.03), S.W, 50);
  return {};
}
//---
root => {
  const S = window.VH_UI.safeArea();
  const t = line('二'); abs(t.el, S.pad, Math.round(S.top + S.h * 0.04), S.W, 50);
  return {};
}
//---
root => {
  const S = window.VH_UI.safeArea();
  const t = line('三'); abs(t.el, S.pad, Math.round(S.top + S.h * 0.05), S.W, 50);
  return {};
}`,
  });
  const r = rhythmScan(d);
  assert.ok(r.findings.some(f => f.kind === 'inconsistent-top'), JSON.stringify(r.findings));
});

test('rhythm：大字场的 20% 起点不算"不统一"（设计本意）', () => {
  const d = mk({
    'engine.tpl.html': TPL, 'scene.html': TPL,
    'scenes.src.js': `// @layout 大字断言
root => {
  const S = window.VH_UI.safeArea();
  const t = line('一'); abs(t.el, S.pad, Math.round(S.top + S.h * 0.20), S.W, 50);
  return {};
}
//---
root => {
  const S = window.VH_UI.safeArea();
  const t = line('二'); abs(t.el, S.pad, Math.round(S.top + S.h * 0.04), S.W, 50);
  return {};
}
//---
root => {
  const S = window.VH_UI.safeArea();
  const t = line('三'); abs(t.el, S.pad, Math.round(S.top + S.h * 0.04), S.W, 50);
  return {};
}`,
  });
  const r = rhythmScan(d);
  assert.deepEqual(r.findings.filter(f => f.kind === 'inconsistent-top'), [], JSON.stringify(r.findings));
});

/* ---------------- motion ---------------- */
test('motion：一场 16 秒只动 1 次 → 报 sparse', () => {
  const html = 'const scenes = [];\naddScene(0, 16, root => {});';
  const d = mk({
    'engine.tpl.html': TPL, 'scene.html': html,
    'scenes.src.js': `root => { const a = mk('div','','x'); enter(a, rt, 0.5); return {}; }`,
  });
  const r = motionScan(d);
  assert.ok(r.findings.some(f => f.kind === 'sparse'), JSON.stringify(r.findings));
});

test('motion：认 VH_MOTION 原语（countTo/slideTo/growTo 的 at 也算变化点）', () => {
  const html = 'const scenes = [];\naddScene(0, 16, root => {});';
  const d = mk({
    'engine.tpl.html': TPL, 'scene.html': html,
    'scenes.src.js': `root => {
  const mo = window.VH_UI.motion;
  mo.countTo(a, rt, { at: 4.0, dur: 1, to: 10 });
  mo.slideTo(b, rt, { at: 9.0, dur: 1, y: -6 });
  mo.growTo(c, rt, { at: 13.0, dur: 1, w: 100 });
  enter(d2, rt, 0.5);
  return {};
}`,
  });
  const r = motionScan(d);
  assert.equal(r.scenes[0].beatCount, 4, JSON.stringify(r.scenes[0]));
});

test('motion：全片只用 1–2 种动效 → 报 few-types', () => {
  const html = 'const scenes = [];\naddScene(0, 10, root => {});\naddScene(10, 20, root => {});\naddScene(20, 30, root => {});';
  const d = mk({
    'engine.tpl.html': TPL, 'scene.html': html,
    'scenes.src.js': `root => { enter(a, rt, 0.5); return {}; }
//---
root => { enter(b, rt, 0.5); return {}; }
//---
root => { enter(c, rt, 0.5); return {}; }`,
  });
  const r = motionScan(d);
  assert.ok(r.findings.some(f => f.kind === 'few-types'), JSON.stringify(r.findings));
});

test('motion：report 给出"每分钟几段变化"这个可比的数字', () => {
  const html = 'const scenes = [];\naddScene(0, 10, root => {});';
  const d = mk({
    'engine.tpl.html': TPL, 'scene.html': html,
    'scenes.src.js': `root => { enter(a, rt, 0.5); return {}; }`,
  });
  const t = motionReport(motionScan(d));
  assert.match(t, /每分钟/);
  assert.match(t, /变化段/);
});

/* ---------------- transition ---------------- */
test('transition：读得到 @transition 标签', () => {
  const d = mk({
    'engine.tpl.html': TPL, 'scene.html': TPL,
    'scenes.src.js': `// @transition push
// @layout 卡片
root => { return {}; }
//---
// @transition cut
root => { return {}; }`,
  });
  const tags = readTransitionTags(d);
  assert.equal(tags[0].kind, 'push');
  assert.equal(tags[1].kind, 'cut');
});

test('transition：全片一种转场 → 报 single-transition', () => {
  const html = 'const scenes = [];\naddScene(0, 10, root => {});\naddScene(10, 20, root => {});\naddScene(20, 30, root => {});';
  const d = mk({
    'engine.tpl.html': TPL, 'scene.html': html,
    'scenes.src.js': `root => { return {}; }\n//---\nroot => { return {}; }\n//---\nroot => { return {}; }`,
  });
  const r = transScan(d);
  assert.ok(r.findings.some(f => f.kind === 'single-transition'), JSON.stringify(r.findings));
});

test('transition：4 种都在 → 通过', () => {
  const html = `const scenes = [];
addScene(0, 10, root => {});
addScene(10, 20, root => {});
addScene(20, 30, root => {});
addScene(30, 40, root => {});
window.__vhTrans = [{"k":"fade"},{"k":"push"},{"k":"cut"},{"k":"wipe"}];`;
  const d = mk({
    'engine.tpl.html': TPL + '\n/* vh:transitions-v2 */', 'scene.html': html,
    'scenes.src.js': `root => { return {}; }\n//---\nroot => { return {}; }\n//---\nroot => { return {}; }\n//---\nroot => { return {}; }`,
  });
  const r = transScan(d);
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
  assert.deepEqual(r.kinds.sort(), ['cut', 'fade', 'push', 'wipe']);
});

test('transition：同一种连用 4 次 → 报 consecutive', () => {
  const html = `const scenes = [];
addScene(0, 10, root => {});
addScene(10, 20, root => {});
addScene(20, 30, root => {});
addScene(30, 40, root => {});
window.__vhTrans = [{"k":"fade"},{"k":"fade"},{"k":"fade"},{"k":"fade"}];`;
  const d = mk({
    'engine.tpl.html': TPL + '\n/* vh:transitions-v2 */', 'scene.html': html,
    'scenes.src.js': `root => { return {}; }\n//---\nroot => { return {}; }\n//---\nroot => { return {}; }\n//---\nroot => { return {}; }`,
  });
  const r = transScan(d);
  assert.ok(r.findings.some(f => f.kind === 'consecutive'), JSON.stringify(r.findings));
});

test('transition：4 种转场都有中文名与用途说明', () => {
  for (const k of ['cut', 'fade', 'push', 'wipe']) {
    assert.ok(KINDS[k], '缺 ' + k);
    assert.ok(KINDS[k].name && KINDS[k].when);
  }
});
