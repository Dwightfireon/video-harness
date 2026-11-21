// 量出每场文字元素的真实上下边界，一次性列出越界与重叠。
// 用法：node scripts/layout-probe.mjs <项目目录> [--scene N]
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const project = process.argv[2];
if (!project) { console.error('用法：node scripts/layout-probe.mjs <项目目录> [--scene N]'); process.exit(2); }
const onlyArg = process.argv.indexOf('--scene');
const only = onlyArg > 0 ? Number(process.argv[onlyArg + 1]) : null;

const html = fs.readFileSync(path.resolve(project, 'scene.html'), 'utf8');
const ranges = [...html.matchAll(/addScene\(([\d.]+),\s*([\d.]+)/g)].map((m, i) => ({ i: i + 1, start: +m[1], end: +m[2] }));

const { launchBrowser, closeLaunchedBrowsers } = await import('../lib/browser.mjs');
const { chromium } = await import('playwright');
const browser = await launchBrowser(chromium);
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(pathToFileURL(path.resolve(project, 'scene.html')).href, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.renderAt === 'function', null, { timeout: 30000 });

  for (const r of ranges) {
    if (only && r.i !== only) continue;
    // 取场景末段（动画已停稳）作为测量点
    const SUBS = JSON.parse(fs.readFileSync(path.resolve(project, 'scene.html'), 'utf8').match(/const SUBS\s*=\s*(\[[\s\S]*?\]);/)[1]);
    const local = SUBS.filter(x => x.s >= r.start && x.s < r.end);
    const times = [...new Set([r.start + 1.2, r.start + 2.5,
      ...local.flatMap(x => [x.s + 0.3, x.e - 0.35]),
      ...Array.from({length: 12}, (_, k) => r.start + 0.4 + k * 0.22),
      r.end - 0.6])].sort((a,b)=>a-b);
    for (const t of times) {
    const items = await page.evaluate((tt) => {
      window.renderAt(tt);
      const scene = [...document.querySelectorAll('#stage .scene')].find(s => s.style.display !== 'none');
      if (!scene) return [];
      const out = [];
      const walk = (el) => {
        for (const child of el.children) {
          const txt = (child.textContent || '').trim();
          if (child.children.length === 0 && txt) {
            const b = child.getBoundingClientRect();
            const st = getComputedStyle(child);
            if (b.width > 0 && b.height > 0 && st.opacity !== '0' && st.visibility !== 'hidden')
              out.push({ text: txt.slice(0, 40), top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) });
          } else walk(child);
        }
      };
      walk(scene);
      return out;
    }, t);

    const over = items.filter(x => x.bottom > 848);
    const ov = [];
    for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
      const A = items[a], B = items[b];
      const ix = Math.min(A.right, B.right) - Math.max(A.left, B.left);
      const iy = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
      if (ix > 4 && iy > 4) ov.push(`"${A.text.slice(0,18)}" × "${B.text.slice(0,18)}" (${ix}×${iy})`);
    }
    if (over.length || ov.length) {
      console.log(`S${r.i} t=${t.toFixed(1)}`);
      over.forEach(x => console.log(`  ✗ bottom=${x.bottom}  "${x.text.slice(0,30)}"`));
      ov.forEach(x => console.log(`  ✗ overlap ${x}`));
    }
    }
  }
} finally {
  await closeLaunchedBrowsers();
}
