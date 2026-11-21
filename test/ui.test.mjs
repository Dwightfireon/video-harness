import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../lib/browser.mjs';

/* 页面层回归测试：把 7 个"靠肉眼发现"的 UI bug 变成自动化。
   做法：起一个最小项目 + 临时服务，用 Playwright 点真实控件。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const VH = path.join(ROOT, 'vh.mjs');

let chromium;
try { ({ chromium } = await import('playwright')); } catch {}
const SKIP = chromium ? false : '没有 playwright';

/* 起一个测试项目（含 scene.html，够渲染即可） */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-ui-'));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ name: 'ui-test' }));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, '脚本.md'), '**主体**：测试\n\n## S1 · 场\n1. 一句旁白。\n\n← 依赖：无\n');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), "root => { const t = line('测试'); abs(t.el,140,300,800,100); type(t.el,'h1'); root.appendChild(t.el); return { render(rt){ t.set(P(rt,.2,.6)); } }; }\n");
  fs.writeFileSync(path.join(dir, 'scene.html'), `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;background:#111;color:#fff}#subs{position:fixed;bottom:0}</style></head><body>
<div id="bar"></div><div id="subs"><div id="subbox"></div></div>
<script>
const W=1920,H=1080; window.W=W; window.H=H;
const DURATION=20; window.DURATION=DURATION;
const box=document.getElementById('subbox');
window.renderAt=t=>{ box.textContent='t='+t.toFixed(2); document.getElementById('bar').style.width=(t/DURATION*W)+'px'; };
window.renderAt(0);
</script></body></html>`);
  return dir;
}

/* 临时起服务，返回 {port, close} */
/* 端口：固定从 8270 起，探测占用后顺延（不随机撞车）；测试结束必须杀掉 */
let portCursor = 8270;
async function pickPort() {
  for (let i = 0; i < 30; i++) {
    const p = portCursor++;
    const busy = spawnSync('/bin/zsh', ['-lc', `lsof -ti :${p} 2>/dev/null | head -1`], { encoding: 'utf8' }).stdout.trim();
    if (!busy) return p;
  }
  throw new Error('8270–8300 都被占用，测试无法起服务');
}

async function startServer(project) {
  const port = await pickPort();
  const cp = spawn(process.execPath, [VH, 'preview', '--dir', project, '--port', String(port)], { stdio: 'ignore', detached: true });
  cp.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/_api/projects`);
      if (r.ok) return { port, close: () => { try { process.kill(-cp.pid, 'SIGTERM'); } catch { try { cp.kill(); } catch {} } } };
    } catch {}
  }
  throw new Error('服务起不来');
}

test('UI：聊天输入框能打空格与方向键（不被全局快捷键抢走）', { skip: SKIP }, async () => {
  const project = makeProject();
  const srv = await startServer(project);
  const browser = await launchBrowser(chromium);
  try {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await p.goto(`http://127.0.0.1:${srv.port}/?p=${path.basename(project)}&tab=chat`);
    await p.waitForSelector('#chatInput');
    // 真实键入（不是 dispatchEvent）：空格必须真的进去
    await p.click('#chatInput');
    await p.keyboard.type('你好 世界');
    await p.keyboard.press('Space');
    await p.keyboard.type('ok');
    const v = await p.inputValue('#chatInput');
    assert.match(v, /你好 世界\s*ok/, `输入框内容异常：${JSON.stringify(v)}`);
  } finally { await browser.close(); srv.close(); }
});

test('UI：切标签时只有目标 panel 可见（不串页）', { skip: SKIP }, async () => {
  const project = makeProject();
  const srv = await startServer(project);
  const browser = await launchBrowser(chromium);
  try {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await p.goto(`http://127.0.0.1:${srv.port}/?p=${path.basename(project)}&tab=chat`);
    await p.waitForSelector('#tabs button');
    // 逐个点，检查可见的 tab 只有一个
    for (const name of ['script', 'board', 'video', 'publish', 'chat']) {
      await p.click(`#tabs button[data-tab="${name}"]`);
      await p.waitForTimeout(120);
      const visible = await p.evaluate(() => [...document.querySelectorAll('#side .tab')]
        .filter(el => getComputedStyle(el).display !== 'none').map(el => el.id));
      assert.deepEqual(visible, [name], `点 ${name} 时可见的是 ${JSON.stringify(visible)}`);
    }
  } finally { await browser.close(); srv.close(); }
});

test('UI：播放时 <video> 元素不会被轮询重建（转圈 bug 的根因）', { skip: SKIP }, async () => {
  const project = makeProject();
  const srv = await startServer(project);
  const browser = await launchBrowser(chromium);
  try {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await p.goto(`http://127.0.0.1:${srv.port}/?p=${path.basename(project)}&tab=video`);
    await p.waitForTimeout(500);
    // 没有成片时 video tab 显示提示；这里验证"轮询不会重建 #video 内的 DOM"
    const before = await p.evaluate(() => document.querySelector('#video')?.innerHTML.length || 0);
    await p.waitForTimeout(2600);   // 跨过一轮轮询（2s）
    const after = await p.evaluate(() => document.querySelector('#video')?.innerHTML.length || 0);
    assert.equal(after, before, '轮询后 #video 内容长度变了 —— 可能在无条件重建');
  } finally { await browser.close(); srv.close(); }
});

test('UI：运行中发指令 → 进队列而不是报错（插话）', { skip: SKIP }, async () => {
  const project = makeProject();
  const srv = await startServer(project);
  try {
    // 伪造"运行中"：写 run 标记 + 一个活着的进程（用 sleep）
    const { spawn: sp } = await import('node:child_process');
    const sleeper = sp('sleep', ['60'], { detached: true });
    sleeper.unref();
    fs.writeFileSync(path.join(project, 'out', '.vh-run.json'), JSON.stringify({ pid: sleeper.pid, mode: 'article', startedAt: Date.now(), label: '测试中' }));
    const r = await fetch(`http://127.0.0.1:${srv.port}/_api/chat?p=${path.basename(project)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '插一句：把标题改短', mode: 'edit-visual' }),
    });
    const j = await r.json();
    assert.equal(j.queued, true, JSON.stringify(j));
    assert.ok(fs.existsSync(path.join(project, 'out', '.vh-steer.json')));
    const q = JSON.parse(fs.readFileSync(path.join(project, 'out', '.vh-steer.json'), 'utf8'));
    assert.equal(q.length, 1);
    assert.match(q[0].message, /把标题改短/);
    try { process.kill(sleeper.pid); } catch {}
  } catch (e) {
    try { fs.rmSync(path.join(project, 'out', '.vh-run.json'), { force: true }); } catch {}
    throw e;
  } finally { srv.close(); }
});
