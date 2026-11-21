/* Electron 主进程：只做窗口、IPC 接线、凭据位置。
 *
 * 业务都在这些模块里（都不依赖 Electron）：
 *   projects.mjs        项目扫描与草稿组装
 *   publish.mjs         投稿编排（校验 → 上传 → 组装 → 提交）
 *   bili.mjs            B 站投稿协议
 *   login.mjs           扫码登录与凭据文件
 *   cover-prep.mjs      封面合规检查与转码
 *
 * 投稿是不可逆的对外动作：这里没有定时器、没有自动重试提交，必须界面传 confirmed:true。
 */
import { app, BrowserWindow, ipcMain, shell, Menu, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { DESK_ROOT, listProjects, projectDraft, resolveProject } from './projects.mjs';
import { validateInput } from './publish-contract.mjs';
import { createPublishService } from './service.mjs';
import { createPublishTransaction } from './publish-transaction.mjs';
import { acquireProductionLock } from '../lib/production-lock.mjs';
import { reconcileProjectTask } from '../lib/project-state.mjs';
import { readPromotion } from '../lib/publish-promotion-store.mjs';
import { applyPublishForm } from '../lib/publish-form-store.mjs';
import { createBiliClient, FALLBACK_PARTITIONS, cookiesComplete, ensureDeviceCookies, checkPublishReady } from './bili.mjs';
import { readBiliCredential, saveBiliCredential, clearBiliCredential, createQrLogin, qrDataUrl } from './login.mjs';
import { prepareCover, cleanupCover, probeImage, prepareCoverIssues as coverIssueList, coverWarnings } from './cover-prep.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let loginSession = null;
const batchState = { running: false, cancel: null };

const send = channel => payload => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

function credentials() { return readBiliCredential(); }

function requireCredentials() {
  const cred = credentials();
  if (!cookiesComplete(cred?.cookies || {})) throw new Error('还没登录：先扫码登录');
  return cred;
}

const readDraft = async (id, { projectLease } = {}) => {
  reconcileProjectTask(resolveProject(DESK_ROOT, id), { productionLease: projectLease });
  const draft = await projectDraft(DESK_ROOT, id, undefined, { coverIssues: coverIssueList, productionLease: projectLease });
  return applyPublishForm({ ...draft, promotion: readPromotion(draft.dir) });
};
const publishService = createPublishService({
  getDraft: readDraft,
  getCredentials: credentials, createClient: createBiliClient, prepareCover, cleanupCover,
  transaction: createPublishTransaction({ root: DESK_ROOT }),
  acquireProject: draft => acquireProductionLock(draft.dir, { command: 'publish-upload', env: {} }),
  onStep: send('publish:step'), onProgress: send('publish:progress'),
});

function registerIpc() {
  ipcMain.handle('desk:init', async () => {
    let account = null;
    const cred = credentials();
    if (cred) {
      const who = await createBiliClient({ cookies: cred.cookies }).whoami();
      account = who.loggedIn
        ? { loggedIn: true, name: who.name, mid: who.mid, level: who.level, savedAt: cred.savedAt }
        : { loggedIn: false, expired: true, name: cred.name || '', savedAt: cred.savedAt, message: who.message || '登录已过期' };
    }
    return { root: DESK_ROOT, version: app.getVersion(), account, projects: await listProjects(DESK_ROOT),
      partitions: FALLBACK_PARTITIONS.map(item => ({ ...item })), partitionsLive: false };
  });

  ipcMain.handle('desk:projects', () => listProjects(DESK_ROOT));

  ipcMain.handle('desk:draft', async (_e, id) => {
    const draft = await readDraft(id);
    let thumb = null;
    if (draft.cover?.thumb) {
      try {
        const bytes = fs.readFileSync(draft.cover.thumb);
        if (bytes.length < 6 * 1024 * 1024) thumb = 'data:image/png;base64,' + bytes.toString('base64');
      } catch {}
    }
    const info = draft.cover?.ok ? probeImage(draft.cover.path) : null;
    // 比例/体积这类非阻断提醒在选题时就露出，不必等到试运行。
    const coverNotes = info ? coverWarnings(info) : [];
    return { ...draft, coverThumb: thumb, coverInfo: info, coverNotes };
  });

  ipcMain.handle('auth:qr', async () => {
    loginSession?.stop?.();
    // 扫码成功后顺手补设备标识，否则投稿接口常被风控拦成 HTML 403。
    const session = createQrLogin({ ensureDevice: ensureDeviceCookies });
    loginSession = session;
    const { url, key } = await session.generate();
    return { url, key, image: await qrDataUrl(url, QRCode.toDataURL) };
  });

  ipcMain.handle('auth:poll', async () => {
    if (!loginSession) throw new Error('请先生成二维码');
    const result = await loginSession.poll();
    if (result.state !== 'ok') return result;
    const api = createBiliClient({ cookies: result.cookies });
    const who = await api.whoami();
    if (who.loggedIn) saveBiliCredential(result.cookies, { mid: who.mid, name: who.name });
    loginSession.stop();
    loginSession = null;
    // 登录成功不等于能投稿：当场体检一次，把风控/权限问题在上传前暴露。
    let ready = null;
    if (who.loggedIn) { try { ready = await checkPublishReady(api); } catch (error) { ready = { ok: false, checks: [{ name: '体检', ok: false, note: error.message }] }; } }
    return { state: 'ok', account: { loggedIn: true, name: who.name, mid: who.mid, level: who.level }, ready };
  });

  ipcMain.handle('auth:logout', () => {
    loginSession?.stop?.(); loginSession = null;
    clearBiliCredential();
    return { loggedIn: false };
  });

  /* 只读体检：登录状态 + 创作中心接口 + 上传线路。
   * 让“扫码成功但发不出去”在上传 26MB 之前就暴露。 */
  ipcMain.handle('auth:check', async () => {
    const cred = requireCredentials();
    return checkPublishReady(createBiliClient({ cookies: cred.cookies }));
  });

  ipcMain.handle('partitions:load', () => publishService.loadPartitions());
  ipcMain.handle('publish:plan', (_e, input) => publishService.plan(input));
  ipcMain.handle('publish:submit', (_e, input) => publishService.submit(input));

  /* 批量发布：逐条复用单条投稿用例，中间留间隔，失败即停。
   * 必须显式 confirmed；不自动重试，不猜未知结果。 */
  ipcMain.handle('publish:batch', async (event, payload) => {
    const { ids, intervalMs, partitionTaxonomy, humanType2, tid, confirmed } = payload || {};
    if (confirmed !== true) throw new Error('需要在界面上确认后才能批量投稿');
    const { runBatch, normalizeInterval } = await import('./batch.mjs');
    const send = item => { if (!event.sender.isDestroyed()) event.sender.send('batch:step', item); };
    let cancelled = false;
    if (batchState.running) throw new Error('已有批量发布在执行');
    batchState.running = true;
    batchState.cancel = () => { cancelled = true; };
    try {
      return await runBatch({
        ids,
        intervalMs: normalizeInterval((intervalMs || 3000) / 1000),
        shouldCancel: () => cancelled,
        onStep: send,
        submitOne: async id => {
          const draft = await projectDraft(DESK_ROOT, id, undefined, { coverIssues: coverIssueList });
          const form = { id, title: draft.fields.title, desc: draft.fields.desc, tags: draft.fields.tags,
            partitionTaxonomy, humanType2, tid, copyright: 1, noReprint: false, cover: draft.coverWanted !== false, confirmed: true };
          return publishService.submit(form);
        },
      });
    } finally { batchState.running = false; batchState.cancel = null; }
  });
  ipcMain.handle('publish:batch-cancel', () => {
    if (!batchState.running) return { cancelled: false };
    batchState.cancel?.();
    return { cancelled: true };
  });
  ipcMain.handle('publish:batch-state', () => ({ running: batchState.running }));

  ipcMain.handle('publish:verify', async (_e, bvid) => {
    const cred = requireCredentials();
    if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid || ''))) throw new Error('BV 号格式不对');
    const api = createBiliClient({ cookies: cred.cookies });
    const found = await api.findArchive(bvid);
    const note = '仅查询指定 BV，不解除未知投稿阻断；请在稿件管理人工核对，不会自动重发。';
    return found
      ? { found: true, stateDesc: found.stateDesc, title: found.title, ptime: found.ptime, cover: found.cover, note }
      : { found: false, note };
  });

  /* 补齐发布素材：文案（需要模型）+ 封面（依赖文案）。
   * 这两步 vh 不会自动做，而发布台没有它们就无法投稿，所以在这里串起来。
   * 只写 发布文案.md 与 out/cover/，不动脚本、画面与成片。 */
  ipcMain.handle('desk:prepare', async (event, id) => {
    const { spawn } = await import('node:child_process');
    const dir = (await import('./projects.mjs')).resolveProject(DESK_ROOT, id);
    const vh = path.join(DESK_ROOT, 'vh.mjs');
    const sendLine = payload => { if (!event.sender.isDestroyed()) event.sender.send('prepare:log', payload); };

    const run = (label, argv) => new Promise(resolve => {
      sendLine({ type: 'start', text: label });
      const child = spawn(process.execPath, [vh, ...argv, '--dir', dir], { cwd: DESK_ROOT });
      let buffer = '';
      const flush = chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) if (line.trim()) sendLine({ type: 'line', text: line.trim() });
      };
      child.stdout.on('data', flush);
      child.stderr.on('data', flush);
      child.on('close', code => { if (buffer.trim()) sendLine({ type: 'line', text: buffer.trim() }); resolve(code ?? 1); });
      child.on('error', error => { sendLine({ type: 'line', text: '启动失败：' + error.message }); resolve(1); });
    });

    const draft = await projectDraft(DESK_ROOT, id, undefined, { coverIssues: coverIssueList });
    const steps = [];
    if (!draft.fields.title) {
      const code = await run('生成发布文案（调用模型，可能需要一分钟）',
        ['ask', '按当前脚本补齐发布文案，保留已有合格内容；只写 发布文案.md，不重做视频。', '--mode', 'edit-copy', '--new']);
      steps.push({ name: '发布文案', ok: code === 0 });
    }
    const afterCopy = await projectDraft(DESK_ROOT, id, undefined, { coverIssues: coverIssueList });
    if (afterCopy.fields.title && !afterCopy.cover.ok) {
      const code = await run('生成封面（三种比例）', ['cover']);
      steps.push({ name: '封面', ok: code === 0 });
    }
    const final = await projectDraft(DESK_ROOT, id, undefined, { coverIssues: coverIssueList });
    return { steps, draft: final, ready: final.ready };
  });

  ipcMain.handle('clipboard:copy', (_e, text) => { clipboard.writeText(String(text ?? '')); return true; });

  ipcMain.handle('shell:open', (_e, url) => {
    let parsed = null;
    try { parsed = new URL(String(url)); } catch {}
    if (!parsed || !['https:', 'http:'].includes(parsed.protocol)) throw new Error('只允许打开 http(s) 地址');
    return shell.openExternal(parsed.toString());
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 880, minWidth: 980, minHeight: 680,
    backgroundColor: '#faf9f6', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(HERE, 'preload.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(HERE, 'ui', 'index.html'));
  win.on('closed', () => { win = null; });
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
]));

/* 自检：读项目、拉分区、生成二维码；不提交任何投稿。 */
async function smoke() {
  const outDir = process.env.VH_DESK_SMOKE_DIR || path.join(DESK_ROOT, 'diagnostics');
  const report = { steps: [] };
  const step = (name, value) => { report.steps.push({ name, ...value }); console.log('[smoke]', name, JSON.stringify(value).slice(0, 300)); };
  try {
    const projects = await listProjects(DESK_ROOT);
    step('projects', { count: projects.length, first: projects[0]?.id || null });
    if (projects[0]) {
      const draft = await projectDraft(DESK_ROOT, projects[0].id, undefined, { coverIssues: coverIssueList });
      step('draft', { title: draft.fields.title, ready: draft.ready, warnings: draft.warnings.map(w => w.code),
        video: draft.video?.file || null, cover: draft.cover.ok ? draft.cover.file : draft.cover.reason });
      step('validate', { problems: validateInput({ title: draft.fields.title, tid: 171, tags: draft.fields.tags, desc: draft.fields.desc }, draft) });
    }
    const qr = createQrLogin();
    const generated = await qr.generate();
    step('qrcode', { hasUrl: Boolean(generated.url) });
    const first = await qr.poll();
    step('qr-poll', { state: first.state, code: first.code });
    qr.stop();
    step('credential', { exists: Boolean(credentials()) });
    report.ok = true;
  } catch (error) {
    report.ok = false; report.error = error.message;
    step('error', { message: error.message });
  } finally {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'desk-smoke.json'), JSON.stringify(report, null, 2) + '\n');
    app.exit(report.ok ? 0 : 1);
  }
}

async function shot() {
  const outDir = process.env.VH_DESK_SMOKE_DIR || path.join(DESK_ROOT, 'diagnostics');
  const errors = [];
  createWindow();
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
  win.show();
  await new Promise(resolve => setTimeout(resolve, 2500));
  const image = await win.webContents.capturePage();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'desk-ui.png'), image.toPNG());
  fs.writeFileSync(path.join(outDir, 'desk-ui.json'), JSON.stringify({ errors }, null, 2));
  if (errors.length) console.log('[shot] console errors:\n' + errors.join('\n'));
  app.exit(0);
}

app.setName('发布台');

/* 只允许一个实例：重复双击时把已有窗口带到前面，而不是再开一个。 */
if (process.env.VH_DESK_SMOKE !== '1' && process.env.VH_DESK_SHOT !== '1') {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    });
  }
}

app.whenReady().then(() => {
  registerIpc();
  if (process.env.VH_DESK_SMOKE === '1') { smoke(); return; }
  if (process.env.VH_DESK_SHOT === '1') { shot(); return; }
  createWindow();
});

/* 单窗口工具：关掉窗口就退出，不留在 Dock 里让人以为没关干净。
 * macOS 上还想用快捷键的话，Cmd+Q 同样有效。 */
app.on('window-all-closed', () => { app.quit(); });
