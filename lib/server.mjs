/* lib/server.mjs —— 本地工作台的 HTTP server（多项目版）
 *
 * 只绑 127.0.0.1。职责：
 *   - 明确公开项目作者文件/素材/成片与 demo；仓库代码、配置、私有状态不公开
 *   - GET  /                  → 项目索引页（列出所有项目与各自成片）；?p=<项目相对路径> → 播放器
 *   - GET  /_api/projects     → 项目清单（含成片大小/时间）
 *   - GET  /_api/state?p=…    → 指定项目的状态快照
 *   - POST /_api/stills?p=…   → 重截静帧
 *   - GET/POST /_api/chat?p=… → harness 自带的 agent 循环（不启动 opencode）
 *   - 其余路径                → 明确允许的项目/演示静态资源（支持 Range）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePublish, timingVerdict } from './state.mjs';
import { validAspectRatio, selectVideoFormat, videoFormatState } from './video-format.mjs';
import { beginTask, readTask, updateTask, taskStatus, taskError, retryInput } from './task-status.mjs';
import { configureAutomation, webAutomationPolicy, automationPolicy } from './automation.mjs';
import { resumeTask, validateRepairExtension } from './task-status.mjs';
import { cancelTaskProcesses, reconcileCancellation } from './process-lifecycle.mjs';
import { readCheckpoint } from './checkpoint.mjs';
import { randomUUID } from 'node:crypto';
import { normalizeGeneratedMetadata, generatorCapabilityWarning } from './generator-metadata.mjs';
import { publishStatus, deliveryTarget, setDeliveryTarget, DELIVERY_TARGETS, confirmPublishRevision } from './publish.mjs';
import { createProductionViewService } from './production-view.mjs';
import { createSnapshotService } from './snapshot-service.mjs';
import { createWorkbenchStillsService } from './workbench-stills.mjs';
import { trashNames, trashEntry, emptyTrash } from './trash.mjs';
import { acquireProductionLock } from './production-lock.mjs';
import { hostError, originError } from './http-security.mjs';
import { openSafeFile, isPublicFile, byteRange } from './public-files.mjs';
import { previewBridge, previewCSP } from './preview-bridge.mjs';
import { createPublishApi } from './publish-api.mjs';
import { createProjectStateService, readProjectTask } from './project-state.mjs';
import { acquireQueueDispatch, queueProductionBusy, startDailyBuildTicker } from './daily-build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW = fs.realpathSync(path.join(HERE, '..', 'www'));
const ROOT = path.resolve(path.join(HERE, '..'));      // harness 根：所有项目都在它下面
const MIME = {
  '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.srt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

export function startServer(project, port = 8144, options = {}) {
  // home 可注入：测试与多用户场景下，凭证必须落在指定的本机目录，
  // 不能意外写进运行者的真实 ~/.config。
  const runtime = { root: ROOT, home: options.home || process.env.HOME, ...options };
  const rootAlias = path.resolve(runtime.root);
  runtime.root = fs.realpathSync(runtime.root);
  // macOS /var -> /private/var is a trusted workspace-root alias. Preserve
  // project-relative components so a symlink *inside* the project path is
  // still rejected by destructive-operation checks.
  if (project) {
    const relative = path.relative(rootAlias, path.resolve(project));
    if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) project = path.join(runtime.root, relative);
  }
  runtime.productionViews = createProductionViewService();
  runtime.snapshots = createSnapshotService();
  runtime.projectStates = createProjectStateService({ snapshots: runtime.snapshots });
  runtime.stills = createWorkbenchStillsService();
  // HTTP 与每日排程共用同一投稿服务，不依赖浏览器打开，也不借用制作 daemon。
  runtime.publish ||= createPublishApi({ root: runtime.root, home: runtime.home, projectStates: runtime.projectStates });
  const server = http.createServer(async (req, res) => {
    try { await route(req, res, port, project, runtime); }
    catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (!res.headersSent) res.writeHead(e.statusCode || 500, { 'content-type': 'application/json; charset=utf-8' });
      try { res.end(JSON.stringify({ error: e.message || '工作台处理失败' })); } catch {}
    }
  });
  let stopDailyBuild;
  server.listen(port, '127.0.0.1', () => {
    runtime.publish.startSchedule?.();
    stopDailyBuild = startDailyBuildTicker(runtime.root, {
      launch: () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'schedule-daemon.mjs'), '--daily', '--root', runtime.root],
          { cwd: runtime.root, env: runtime.agentEnv || process.env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('close', resolve);
        child.unref();
      }),
      onError: error => console.warn('定点制作调度：' + error.message),
    });
  });
  server.once('close', () => { stopDailyBuild?.(); runtime.publish.stopSchedule?.(); runtime.productionViews.close(); runtime.snapshots.close(); });
  return server;
}

/* 项目相对路径 → 绝对路径（必须落在 ROOT 内且含 PROJECT.json） */
function resolveDir(rel, root = ROOT) {
  if (!rel) return null;
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(path.join(abs, 'PROJECT.json'))) return null;
  return abs;
}

/* For destructive operations a project alias must not lead through a symlink:
 * moving the alias would otherwise clean a different directory first. */
function assertSafeProjectPath(project, root) {
  const relative = path.relative(path.resolve(root), path.resolve(project));
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw Object.assign(new Error('项目不在当前工作区内，未清理或删除'), { statusCode: 400 });
  }
  let current = path.resolve(root);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw Object.assign(new Error('项目路径含符号链接，未清理或删除'), { statusCode: 400 });
  }
}

/* 目录体积（递归，跳过 .git/node_modules）。
 * ⚠ 性能：frames/ 动辄上万个小文件、上 GB。旧实现每个项目算三次（整项目 + frames + seg），
 *   6 个项目时单次 /_api/projects 就要 500ms 以上，而且会阻塞事件循环。
 *   现在一次遍历同时产出「整项目」与「缓存」两个合计，并带短缓存。 */
const SIZE_CACHE = new Map();          // key: 绝对路径 → { at, size, files, cache }
const SIZE_TTL = 5000;                 // 5s 内复用；任务在跑时也不至于每次重扫

function measureDir(p) {
  let total = 0, cache = 0, files = 0;
  const walk = (d, isCache) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name === '.git' || it.name === 'node_modules') continue;
      const fp = path.join(d, it.name);
      try {
        if (it.isDirectory()) walk(fp, isCache || it.name === 'frames' || it.name === 'seg');
        else { const size = fs.statSync(fp).size; total += size; if (isCache) cache += size; files++; }
      } catch {}
    }
  };
  walk(p, false);
  return { size: total, cache, files };
}

function dirSizes(p) {
  const hit = SIZE_CACHE.get(p);
  if (hit && Date.now() - hit.at < SIZE_TTL) return hit;
  const fresh = { at: Date.now(), ...measureDir(p) };
  SIZE_CACHE.set(p, fresh);
  return fresh;
}
function invalidateDirSizes(p) { for (const key of SIZE_CACHE.keys()) if (key === p || key.startsWith(p + path.sep)) SIZE_CACHE.delete(key); }
function invalidateAllDirSizes() { SIZE_CACHE.clear(); }

function dirSize(p) { return measureDir(p).size; }

/* The task/process observation stays on the server thread. Only the expensive,
 * read-only delivery check runs in the bounded worker; recheck task identity
 * after awaiting so a newly-started task never inherits an old result. */
export async function workbenchTaskStatus(project, runtime) {
  return runtime.projectStates ? runtime.projectStates.readTask(project) : readProjectTask(project, runtime);
}

/* 列出所有项目（按成片更新时间倒序） */
async function listProjects(root = ROOT, runtime) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of items) {
      if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules' || d.name === 'out') continue;
      const abs = path.join(dir, d.name);
      if (fs.existsSync(path.join(abs, 'PROJECT.json'))) {
        const rel = path.relative(root, abs);
        let videos = [];
        try {
          videos = fs.readdirSync(path.join(abs, 'out')).filter(f => f.endsWith('.mp4'))
            .map(f => { const s = fs.statSync(path.join(abs, 'out', f)); return { file: f, size: s.size, mtime: s.mtimeMs }; })
            .sort((a, b) => b.mtime - a.mtime);
        } catch {}
        let dur = null;
        try {
          const html = fs.readFileSync(path.join(abs, 'scene.html'), 'utf8');
          dur = +(html.match(/DURATION\s*=\s*([\d.]+)/) || [])[1] || null;
        } catch {}
        let pub = null;
        try {
          const r = parsePublish(fs.readFileSync(path.join(abs, '发布文案.md'), 'utf8'));
          pub = r ? { main: r.main, alts: r.alts, descHead: (r.desc.split('\n').filter(Boolean)[0] || '').slice(0, 90) } : null;
        } catch {}
        const sizes = dirSizes(abs);
        out.push({ rel, name: d.name, videos, dur, size: sizes.size, cacheBytes: sizes.cache, fileCount: sizes.files,
          publish: pub, publishStatus: publishStatus(abs), task: null, mtime: videos[0] ? videos[0].mtime : fs.statSync(abs).mtimeMs });
      } else {
        walk(abs, depth + 1);
      }
    }
  };
  walk(root, 0);
  let next = 0;
  const fillTasks = async () => {
    while (next < out.length) {
      const item = out[next++], { tail, ...task } = await workbenchTaskStatus(path.join(root, item.rel), runtime);
      item.task = task;
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, out.length) }, fillTasks));
  return out.sort((a, b) => b.mtime - a.mtime);
}

async function configuredProviders(runtime) {
  if (runtime.providerInfo) return runtime.providerInfo();
  const { readProviderInfo } = await import('./agent.mjs');
  return readProviderInfo();
}

/* Probe only configuration/binary, never a paid request or a balance claim. */
async function configuredExecution(project, runtime) {
  if (runtime.providerInfo) {
    const providers = await configuredProviders(runtime);
    return { ready: providers.length > 0, provider: providers.length ? providers.map(item => item.provider).join(' ↔ ') + ' / ' + providers[0].model : null,
      checked: 'credentials-only' };
  }
  const { runnerReady } = await import('./runners/index.mjs');
  const check = await runnerReady(project || path.join(runtime.root, 'projects', '.vh-new-project'),
    { home: runtime.home, env: runtime.agentEnv || process.env });
  return { ready: check.ok && check.configurationReady !== false, execution: check.snapshot || null,
    provider: check.snapshot ? check.snapshot.model : null, checked: check.check,
    connectivity: 'not-checked', balance: 'not-checked',
    reason: check.reason || (check.configurationReady === false ? '所选模型渠道缺少可用凭证，请先配置；不会自动换渠道' : null) };
}

/* 本机服务只绑 127.0.0.1，但浏览器里任意网页都能向它发请求：
 * 攻击页只要 POST /_api/provider/base 把地址改成自己的服务器，
 * 下一次任务就会把用户的 API key 送过去。写操作必须确认来源是本机页面。 */
/* Host 在全部请求入口校验；控制请求还须精确匹配 Origin 的 host/port。
 * opaque preview 的 null Origin 与 cross-site 无预检请求均拒绝。
 * 无 Origin/Fetch Metadata 的 CLI 请求保留；这不是客户端身份认证。 */
export function writeOriginError(req) {
  return originError(req);
}
/* 需要浏览器额外预检的写接口：声明不允许跨站携带凭证。 */
function rejectCrossSite(req, res) {
  const why = writeOriginError(req);
  if (!why) return false;
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: why }));
  return true;
}

async function route(req, res, port, defaultProject, runtime) {
  const root = runtime.root;
  res.setHeader('x-content-type-options', 'nosniff');
  const badHost = hostError(req);
  if (badHost) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: badHost })); return; }
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  let p;
  try { p = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); res.end('400'); return; }

  /* 建项目并开工：首页「开始做视频」与队列「去做」共用这一条。
   * 返回 { status, body }，让两条入口的错误码和文案保持一致。 */
  const createAndStart = async (input0 = {}) => {
    const { name, mode = 'article', input = '', aspectRatio = '16:9', deliveryTarget: target = 'publish-package',
      queueId = null } = input0;
    const bad = (error, status = 400) => ({ status, body: { error } });
    if (!DELIVERY_TARGETS.includes(target)) return bad('交付目标只能是 video 或 publish-package');
    if (!validAspectRatio(aspectRatio)) return bad('画幅只能选择 16:9 或 9:16');
    if (!['article', 'topic'].includes(mode) || typeof input !== 'string') return bad('输入类型或制作模式无效');
    const safe = String(name || '').trim().replace(/[\/\\\s]+/g, '-').replace(/[^\w\u4e00-\u9fff.-]/g, '');
    if (!safe || /^[.-]+$/.test(safe)) return bad('项目名无效');
    const rel = path.join('projects', safe);
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) return bad('同名项目已存在：' + rel, 409);

    const vh = path.join(HERE, '..', 'vh.mjs');
    const r = spawnSync(process.execPath, [vh, 'new', abs, '--aspect', aspectRatio, '--delivery', target],
      { cwd: root, encoding: 'utf8', env: runtime.agentEnv || process.env });
    if (r.status !== 0) return bad('创建失败：' + ((r.stderr || r.stdout || '').slice(-400)), 500);
    configureAutomation(abs, { enabled: true, maxRepairs: 2 });
    spawnSync(process.execPath, [vh, 'enhance', '--dir', abs], { cwd: root, encoding: 'utf8', env: runtime.agentEnv || process.env });

    if (input && input.trim()) {
      fs.mkdirSync(path.join(abs, 'materials'), { recursive: true });
      fs.writeFileSync(path.join(abs, 'materials', mode === 'topic' ? '选题.md' : '原文.md'), input.trim() + '\n', 'utf8');
    }

    /* 队列项在建项目成功之后立刻指向它。
     * 早于派发、晚于建项目：项目不存在就绑不上，绑上了就一定能从项目读状态。 */
    if (queueId) {
      try {
        const { attachProject } = await import('./schedule.mjs');
        attachProject(root, queueId, rel);
      } catch (error) { return bad('未能关联队列，未开始制作：' + error.message, 409); }
    }

    const readiness = await configuredExecution(abs, runtime);
    const hasKey = readiness.ready;
    let started = false, job = null;
    if (hasKey && input && input.trim()) {
      job = chatSpawn(abs, input.trim(), mode, runtime);
      started = true;
    } else if (!input.trim()) {
      // 只建项目、暂不制作：不写一条假装失败的制作任务。
      job = null;
    } else {
      const task = beginTask(abs, input.trim(), mode);
      updateTask(abs, task.id, { automation: webAutomationPolicy(abs, mode, input), status: 'failed',
        execution: readiness.execution || null, error: { ...taskError('', 'credentials'), ...(readiness.reason ? { message: readiness.reason } : {}) }, finishedAt: Date.now() });
      job = taskStatus(abs);
    }
    return { status: 200, body: { ok: true, rel, started, hasKey, needsInput: !input.trim(), task: job } };
  };

  const readBody = async limit => {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > limit) throw Object.assign(new Error('请求体过大'), { statusCode: 413 });
      chunks.push(chunk);
    }
    return bytes ? JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) : {};
  };
  runtime.createAndStart = createAndStart;
  runtime.readBody = readBody;

  // 所有写操作先验来源：本机页面之外的一律拒绝（含改接口地址、改 key、派发任务）。
  if ((!['GET', 'HEAD'].includes(req.method) || p.startsWith('/_api/')) && rejectCrossSite(req, res)) return;
  const qRel = url.searchParams.get('p');
  // 明确指定的旧/错误项目不再悄悄落到默认项目，尤其不能误派发「继续」。
  const defaultExists = defaultProject && fs.existsSync(path.join(defaultProject, 'PROJECT.json'));
  const project = qRel ? resolveDir(qRel, root) || (defaultExists && qRel === path.basename(defaultProject) ? defaultProject : null)
    : defaultExists ? defaultProject : null;
  const globalAPI = ['/_api/projects', '/_api/new', '/_api/agent-ready', '/_api/providers', '/_api/provider/select', '/_api/provider/key', '/_api/provider/base', '/_api/trash',
    '/_api/schedule', '/_api/schedule/discover', '/_api/schedule/discover/topics', '/_api/schedule/start', '/_api/schedule/enqueue',
    '/_api/publish/overview', '/_api/publish/projects', '/_api/publish/qr', '/_api/publish/login', '/_api/publish/logout',
    '/_api/publish/partitions', '/_api/publish/submit', '/_api/publish/batch', '/_api/publish/batch-cancel', '/_api/publish/verify',
    '/_api/publish/preflight', '/_api/publish/references', '/_api/publish/plan', '/_api/publish/batch-state', '/_api/publish/schedule'];
  const globalPublishAPI = p.startsWith('/_api/publish/') && !['/_api/publish/target', '/_api/publish/generate', '/_api/publish/confirm'].includes(p);
  if (p.startsWith('/_api/') && !globalAPI.includes(p) && !globalPublishAPI && !project) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: '项目不存在或已移走，未向其他项目派发任务' })); return;
  }

  if (p === '/_api/projects') {
    const projects = await listProjects(root, runtime);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ root, projects }));
    return;
  }
  if (p === '/_api/state') {
    const s = await runtime.snapshots.read(project);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(s));
    return;
  }
  if (p === '/_api/production') {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const view = await runtime.productionViews.read(project, { verify: url.searchParams.get('verify') === '1' });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(view)); return;
  }
  if (p === '/_api/production/settings') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = '';
    req.on('data', data => { body += data; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        const input = JSON.parse(body || '{}');
        if (!input || typeof input.enabled !== 'boolean' || !Number.isInteger(input.maxRepairs) || input.maxRepairs < 0 || input.maxRepairs > 5 ||
          Object.keys(input).some(key => !['enabled', 'maxRepairs'].includes(key))) throw Object.assign(new Error('设置必须包含 enabled 布尔值和 0–5 的 maxRepairs 整数'), { statusCode: 400 });
        const view = await runtime.productionViews.save(project, input);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(view));
      } catch (error) {
        res.writeHead(error.statusCode || 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: error.message }));
      }
    }); return;
  }
  if (p === '/_api/publish' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ target: deliveryTarget(project), publish: publishStatus(project) })); return;
  }
  if (['/_api/publish/target', '/_api/publish/generate', '/_api/publish/confirm'].includes(p)) {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = '';
    req.on('data', d => { body += d; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
      try {
        const input = JSON.parse(body || '{}');
        const status = taskStatus(project);
        if (status.running || status.orphanRunning) { json(409, { error: '当前项目仍有任务在执行；未启动文案任务或更改交付目标' }); return; }
        if (p === '/_api/publish/confirm') {
          if (input.confirmed !== true) { json(400, { error: '请先实际核对当前脚本与文案，再确认关联；不会自动认定已审阅' }); return; }
          confirmPublishRevision(project, { sourceSignature: input.sourceSignature, publishHash: input.publishHash });
          json(200, { ok: true, publish: publishStatus(project) }); return;
        }
        if (p === '/_api/publish/target') {
          if (!DELIVERY_TARGETS.includes(input.target)) { json(400, { error: '交付目标只能是 video 或 publish-package' }); return; }
          setDeliveryTarget(project, input.target);
          json(200, { ok: true, target: deliveryTarget(project), publish: publishStatus(project) }); return;
        }
        const resumeCopy = status.canResume && status.mode === 'edit-copy';
        if (status.canResume && !resumeCopy && input.confirmNew !== true) {
          json(409, { error: '存在未完成的制作任务。单独生成文案会归档原任务；确认后才启动，不会重做视频。', requiresConfirmation: true }); return;
        }
        if (!fs.existsSync(path.join(project, '脚本.md'))) { json(400, { error: '还没有脚本.md，请先完成脚本，不能凭空生成发布文案' }); return; }
        if (!(await configuredProviders(runtime)).length) { json(503, { error: taskError('', 'credentials').message }); return; }
        // 沿用 edit-copy 检查点；全流程失败则另开文案任务，原检查点归档，不重跑媒体。
        const task = chatSpawn(project, resumeCopy ? '' : '按当前脚本补齐发布文案，保留已有合格内容；只写发布文案.md，不重做视频。', 'edit-copy', runtime, { resume: resumeCopy });
        json(200, { started: true, resumed: resumeCopy, task });
      } catch (e) { json(e.statusCode || 400, { error: e.message }); }
    });
    return;
  }
  if (p === '/_api/format') {
    const view = () => ({ ...videoFormatState(project), taskRunning: (() => {
      const status = taskStatus(project, { includeDeliverable: false }); return status.running || status.orphanRunning;
    })() });
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(view())); return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = '';
    req.on('data', d => { body += d; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        const { aspectRatio } = JSON.parse(body || '{}');
        if (!validAspectRatio(aspectRatio)) { res.writeHead(400); res.end(JSON.stringify({ error: '画幅只能选择 16:9 或 9:16' })); return; }
        const status = taskStatus(project);
        if (status.running || status.orphanRunning) { res.writeHead(409); res.end(JSON.stringify({ error: '任务仍在执行；请先取消并等待进程停止，再切换画幅，现有进度会保留' })); return; }
        // 不触发模型或视频渲染；仅按已选画幅重新生成 HTML 预览。
        const tv = await timingVerdict(project);
        const fresh = taskStatus(project);
        if (fresh.running || fresh.orphanRunning) { res.writeHead(409); res.end(JSON.stringify({ error: '任务已开始执行，未切换画幅' })); return; }
        selectVideoFormat(project, aspectRatio);
        let warning = '画幅已保存；请检查横竖屏布局、字幕与越界，正式成片需要整片重渲。';
        if (fs.existsSync(path.join(project, 'gen.mjs')) && fs.existsSync(path.join(project, '脚本.md'))) {
          const r = spawnSync(process.execPath, ['gen.mjs', ...(tv.state === 'valid' ? [] : ['--estimate']), '--force'], {
            cwd: project, encoding: 'utf8', timeout: 15000, env: runtime.agentEnv || process.env });
          if (r.status !== 0) warning += ' 预览重建未成功；选择已保留，请运行 vh build 查看报错，当前预览可能仍是旧方向。';
          else {
            normalizeGeneratedMetadata(project);
            const compatibility = generatorCapabilityWarning(project);
            if (compatibility) warning += ' ' + compatibility;
          }
        } else warning += ' 尚缺生成器或脚本，开始制作后再运行 build。';
        invalidateDirSizes(project);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, ...view(), warning }));
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }
  if (p === '/_api/stills') {
    if (!['GET', 'POST'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const status = req.method === 'POST' ? runtime.stills.start(project) : runtime.stills.read(project);
    res.writeHead(req.method === 'POST' ? 202 : 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(status)); return;
  }
  if (p === '/_api/upload' && req.method === 'POST') {
    const name = decodeURIComponent(req.headers['x-filename'] || 'file.bin').replace(/[\/\\:]/g, '_').slice(0, 120);
    const dir = path.join(project, 'materials');
    fs.mkdirSync(dir, { recursive: true });
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      try {
        fs.writeFileSync(path.join(dir, name), Buffer.concat(chunks));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: 'materials/' + name, bytes: Buffer.concat(chunks).length }));
      } catch (e) { res.writeHead(500); res.end('{"error":"' + String(e.message).replace(/"/g, '') + '"}'); }
    });
    return;
  }
  if (p === '/_api/agent-ready') {
    let readiness = { ready: false, provider: null }, current = null;
    try {
      readiness = await configuredExecution(project, runtime);
      const { currentSelection } = await import('./provider-settings.mjs');
      current = currentSelection(runtime.home);
    } catch (error) { readiness = { ready: false, provider: null, reason: error.message, checked: 'configuration-error' }; }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ...readiness, current }));
    return;
  }
  /* 模型渠道设置：只在本机回显"是否已配置"，永不返回密钥本身。 */
  const providerView = providers => providers.map(item => ({
    name: item.name, label: item.label, base: item.base, models: item.models,
    freeModels: item.freeModels, catalog: item.catalog,
    hasKey: item.hasKey, keySource: item.keySource, selected: item.selected, model: item.model,
    // 指纹只用于核对"换成的是不是这一把"，8 位十六进制不可逆，也不泄露 key 内容。
    keyFingerprint: item.keyFingerprint, keyUpdatedAt: item.keyUpdatedAt,
  }));
  if (p === '/_api/providers') {
    try {
      const { listProviders, currentSelection } = await import('./provider-settings.mjs');
      const mode = url.searchParams.get('models');
      let catalogErrors;
      if (mode === 'load' || mode === 'refresh') {
        const { CATALOGS, refreshCatalog } = await import('./opencode-catalog.mjs');
        catalogErrors = Object.fromEntries(await Promise.all(Object.keys(CATALOGS).map(async name =>
          [name, await refreshCatalog(runtime.home, name, { force: mode === 'refresh', fetchImpl: runtime.modelCatalogFetch })])));
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ providers: providerView(listProviders(runtime.home)), current: currentSelection(runtime.home), catalogErrors }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (p === '/_api/provider/select' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 64e3) req.destroy(); });
    req.on('end', async () => {
      try {
        const { provider, model } = JSON.parse(body || '{}');
        const { setSelection, listProviders } = await import('./provider-settings.mjs');
        const result = setSelection({ provider, model }, runtime.home);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, current: result, providers: providerView(listProviders(runtime.home)) }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (p === '/_api/provider/base' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 64e3) req.destroy(); });
    req.on('end', async () => {
      try {
        const { provider, base } = JSON.parse(body || '{}');
        const { setProviderBase, listProviders, currentSelection } = await import('./provider-settings.mjs');
        setProviderBase(provider, base, runtime.home);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, current: currentSelection(runtime.home), providers: providerView(listProviders(runtime.home)) }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (p === '/_api/provider/key' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 64e3) req.destroy(); });
    req.on('end', async () => {
      try {
        const { provider, key, clear } = JSON.parse(body || '{}');
        const { setProviderKey, listProviders } = await import('./provider-settings.mjs');
        const saved = setProviderKey(provider, key, { clear: !!clear }, runtime.home);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        // 密钥不回显：只回报是否已配置、来自哪里、以及可核对的指纹。
        res.end(JSON.stringify({ ok: true, saved, providers: providerView(listProviders(runtime.home)) }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  /* 队列项直接开工：不经过首页输入框。
   * 「去做」是一个完整动作——按这一项的选题建项目并派发，一步到位。
   * 首页那个输入框留给"我自己想一个"，两者不共用入口。 */
  if (p === '/_api/schedule/enqueue' && req.method === 'POST') {
    try {
      const { name, mode, input, aspectRatio, deliveryTarget } = await readBody(2e6);
      if (typeof name !== 'string' || !/[\w\u4e00-\u9fff]/.test(name) || name.length > 100 ||
          !['article', 'topic'].includes(mode) || typeof input !== 'string' || !input.trim() ||
          !validAspectRatio(aspectRatio) || !DELIVERY_TARGETS.includes(deliveryTarget)) {
        throw Object.assign(new Error('请填写制作材料并检查项目名、画幅及交付选项'), { statusCode: 400 });
      }
      const { enqueueProduction } = await import('./schedule.mjs');
      let id;
      try { id = enqueueProduction(root, { name: name.trim(), mode, input, aspectRatio, deliveryTarget }); }
      catch (error) { if (error.message === '同一制作请求已在队列中') error.statusCode = 409; throw error; }
      res.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, id }));
    } catch (error) {
      res.writeHead(error.statusCode || (error instanceof SyntaxError ? 400 : 500), { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (p === '/_api/schedule/start' && req.method === 'POST') {
    let lock;
    try {
      const input = await readBody(64e3);
      const { readSchedule, queuedProduction } = await import('./schedule.mjs');
      lock = acquireQueueDispatch(root);
      const queue = readSchedule(root);
      const item = queue.items.find(entry => entry.id === input.id);
      if (!item) { res.writeHead(404); res.end(JSON.stringify({ error: '队列里没有这一项' })); return; }
      if (item.project) { res.writeHead(409); res.end(JSON.stringify({ error: '这一项已经开工：' + item.project })); return; }
      if (queueProductionBusy(root, queue)) { res.writeHead(409); res.end(JSON.stringify({ error: '队列里已有视频在制作，请等它结束' })); return; }

      const result = await createAndStart({
        ...queuedProduction(root, item),
        ...(!item.productionInput ? { aspectRatio: input.aspectRatio || '16:9', deliveryTarget: input.deliveryTarget || 'publish-package' } : {}),
        queueId: item.id,
      });
      res.writeHead(result.status || 200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.body));
    } catch (error) {
      const busy = error.code === 'PRODUCTION_LOCK_BUSY';
      res.writeHead(busy ? 409 : error.statusCode || 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: busy ? '队列里已有制作任务，请等它结束' : error.message }));
    } finally { lock?.release(); }
    return;
  }
  if (p === '/_api/new' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 2e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const input = JSON.parse(body || '{}');
        const result = await createAndStart({ ...input, queueId: null });
        res.writeHead(result.status || 200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result.body));
      } catch (e) {
        res.writeHead(500); res.end('{"error":"' + String(e.message).replace(/"/g, '') + '"}');
      }
    });
    return;
  }
  if (p === '/_api/clean' && req.method === 'POST') {
    assertSafeProjectPath(project, root);
    const task = taskStatus(project);
    if (task.running || task.orphanRunning) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '项目仍在制作，不能清理正在使用的缓存；请先等待或取消任务' })); return; }
    const { stripProjectCaches } = await import('./disk-hygiene.mjs');
    let lock, cleaned;
    try {
      lock = acquireProductionLock(project, { command: 'web-clean', env: {} });
      cleaned = stripProjectCaches(project, { only: ['frames', 'seg'] });
    } catch (error) {
      res.writeHead(error.code === 'PRODUCTION_LOCK_BUSY' ? 409 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '未清理缓存：' + error.message })); return;
    } finally { lock?.release(); }
    invalidateDirSizes(project);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, freed: cleaned.removed, bytes: cleaned.freed }));
    return;
  }
  /* 选题队列：只记录「想做哪些」。执行状态不存这里，读的时候从项目算。
   * 派发由 scripts/schedule-daemon.mjs 负责，两者只共享 schedule.json。 */
  if (p === '/_api/schedule') {
    const workbench = await import('../lib/schedule.mjs');
    const { describePlans, publishPlan } = await import('../lib/timing-plan.mjs');

    /* 项目现在什么状态——队列层不认识项目结构，由这里注入这一个事实。 */
    const inspect = project => {
      const dir = path.join(root, project);
      let task;
      try { task = JSON.parse(fs.readFileSync(path.join(dir, 'out/.vh-task.json'), 'utf8')); }
      catch { return null; }
      return { status: task.status, delivered: fs.existsSync(path.join(dir, 'out/video-voice.mp4')) };
    };
    /* 有没有一支正在做：看已开工的项，不靠队列自己的状态字段。 */
    const anyRunning = queue => queue.items.some(item =>
      item.project && ['starting', 'running', 'cancelling'].includes(inspect(item.project)?.status));

    const view = async () => {
      const queue = workbench.readSchedule(root);
      const { dispatchedToday } = workbench;
      const observed = new Map(), projects = [...new Set(queue.items.map(item => item.project).filter(Boolean))];
      let cursor = 0;
      const observe = async () => {
        while (cursor < projects.length) {
          const rel = projects[cursor++];
          try {
            const status = await workbenchTaskStatus(resolveDir(rel, root) || path.join(root, '__missing-project__'), runtime);
            observed.set(rel, { status: status.status, delivered: status.status === 'completed' && status.completionKind !== 'response' && !status.deliverableStale || status.delivered === true });
          } catch { observed.set(rel, null); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, projects.length) }, observe));
      return {
        ...queue, items: queue.items.map(({ productionInput, ...item }) => ({ ...item, state: workbench.deriveStatus(item, rel => observed.get(rel)) })),
        timing: { ...describePlans(queue), dailyBuildSupported: true },
        next: workbench.firstUnstarted(queue)?.topic || null,
        stats: {
          untouched: queue.items.filter(item => !item.project).length,
          dispatchedToday: dispatchedToday(queue),
          anyRunning: anyRunning(queue),
        },
      };
    };

    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(await view()));
      return;
    }
    let body = '';
    req.on('data', d => { body += d; if (body.length > 64e3) req.destroy(); });
    req.on('end', async () => {
      try {
        const input = JSON.parse(body || '{}');
        if (input.action === 'add') workbench.addTopic(root, String(input.topic || ''));
        else if (input.action === 'attach') {
          /* 手动开做时把队列项指向项目：之后状态由项目算，不需要回来勾完成。 */
          workbench.attachProject(root, input.id, input.project);
        } else if (input.action === 'remove') {
          workbench.removeItem(root, input.id);
        } else if (input.action === 'remove-many') {
          /* 批量移除：正在制作/取消中的项不删，其余一次写完。
           * 状态由项目推导，所以在这里用同一份观察判断，不另存"可删"标记。 */
          const ids = Array.isArray(input.ids) ? input.ids.filter(id => typeof id === 'string' && id) : [];
          if (!ids.length) throw new Error('没有选中要移除的选题');
          if (ids.length > 300) throw new Error('一次最多移除 300 项');
          const current = workbench.readSchedule(root);
          const target = new Map(current.items.filter(item => ids.includes(item.id)).map(item => [item.id, item]));
          const statuses = new Map();
          const projects = [...new Set([...target.values()].map(item => item.project).filter(Boolean))];
          await Promise.all(projects.map(async rel => {
            try {
              const status = await workbenchTaskStatus(resolveDir(rel, root) || path.join(root, '__missing-project__'), runtime);
              statuses.set(rel, status.status);
            } catch { statuses.set(rel, null); }
          }));
          const result = workbench.removeItems(root, ids, { skip: item => {
            if (!item.project) return null;
            const status = statuses.get(item.project);
            if (!status) return '无法确认项目状态，请稍后再试';
            return ['starting', 'running', 'cancelling'].includes(status) ? '正在制作，先停止再移除' : null;
          } });
          if (!result.removed) throw new Error(result.skipped.length
            ? result.skipped.map(item => '「' + item.topic + '」' + item.reason).join('；')
            : '选中的选题已经不在队列里');
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, ...result, ...(await view()) }));
          return;
        } else if (input.action === 'config') {
          const queue = workbench.readSchedule(root);
          if (Number.isInteger(input.dailyLimit)) queue.dailyLimit = Math.max(1, input.dailyLimit);
          if (Number.isInteger(input.intervalMinutes)) queue.intervalMinutes = Math.max(5, input.intervalMinutes);
          if (input.discovery && typeof input.discovery === 'object') queue.discoveryConfig = { ...(queue.discoveryConfig || {}), ...input.discovery };
          workbench.writeSchedule(root, queue);
        } else if (input.action === 'timing') {
          const { setPlans } = await import('../lib/timing-plan.mjs');
          setPlans(root, { build: input.build, publish: input.publish });
        } else throw new Error('未知的队列操作');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...(await view()) }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }
  /* 候选、推荐记忆和可撤销反馈。不触发模型、制作或发布。 */
  if (p === '/_api/schedule/discover/topics') {
    const { topicState, updateTopicState } = await import('./topic-memory.mjs');
    try {
      let body;
      if (req.method === 'GET') body = topicState(root, {
        limit: url.searchParams.get('limit') ?? undefined,
        historyOffset: url.searchParams.get('historyOffset') ?? undefined,
        historyLimit: url.searchParams.get('historyLimit') ?? undefined,
        historyFilter: url.searchParams.get('historyFilter') ?? undefined,
        historyQuery: url.searchParams.get('historyQuery') ?? undefined,
      });
      else if (req.method === 'POST') body = updateTopicState(root, await readBody(64e3));
      else { res.writeHead(405); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    } catch (error) {
      res.writeHead(error.statusCode || 400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  /* 找选题：异步作业。POST 只负责启动，立刻返回；结果由 GET 轮询。
   * 为什么不同步：一次检索 1–3 分钟，HTTP 干等会被浏览器判超时。 */
  if (p === '/_api/schedule/discover') {
    const { startJob, readJob, describeJob } = await import('../lib/discovery-job.mjs');
    const { readSchedule } = await import('../lib/schedule.mjs');

    if (req.method === 'GET') {
      const job = readJob(root);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ job, view: describeJob(job) }));
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

    try {
      const input = await readBody(64e3);
      const queue = readSchedule(root);
      const { topicHistory } = await import('./topic-memory.mjs');
      const { prepareDiscoveryRequest } = await import('./discovery-request.mjs');
      /* 只有一次检索在跑：重复点不会开第二个 opencode 会话。 */
      const started = startJob(root, prepareDiscoveryRequest(input, queue.discoveryConfig || {}, topicHistory(queue)));
      res.writeHead(started.busy ? 409 : 202, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: !started.busy,
        busy: started.busy,
        job: started.job,
        view: describeJob(started.job),
        note: started.busy ? '上一次选题任务还在跑，等它结束再点。' : started.job.operation === 'research' ? '已开始调查这条问题，结果会保存在原记录。' : '已开始构思问题，候选会自动出现。',
      }));
    } catch (error) {
      res.writeHead(error.statusCode || (error instanceof SyntaxError ? 400 : 500), { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  /* ---------------- 发布：B 站投稿 ----------------
   * 复用 desk/ 里那套已经测过的投稿用例（校验→上传→组 payload→提交），
   * 网页这边只做接线，避免两套实现发出不同的字段。 */
  if (p.startsWith('/_api/publish')) {
    const api = runtime.publish;
    const body = async () => {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 64e3) throw Object.assign(new Error('请求体过大'), { statusCode: 413 }); }
      return raw ? JSON.parse(raw) : {};
    };
    const send = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (p === '/_api/publish/schedule' && req.method === 'GET') return send(200, await api.schedule());
      if (p === '/_api/publish/schedule' && req.method === 'POST') return send(200, await api.saveSchedule(await body()));
      if (p === '/_api/publish/overview') return send(200, await api.overview());
      if (p === '/_api/publish/projects') return send(200, { projects: await api.projects() });
      if (p === '/_api/publish/partitions') return send(200, await api.partitions());
      if (p === '/_api/publish/promotion-catalog' && req.method === 'GET') return send(200, await api.promotionCatalog());
      if (p === '/_api/publish/promotion' && req.method === 'POST') return send(200, await api.savePromotion(await body()));
      if (p === '/_api/publish/form' && req.method === 'POST') return send(200, await api.saveForm(await body()));
      if (p === '/_api/publish/progress' && req.method === 'GET') return send(200, api.progress({ id: url.searchParams.get('id'), progressId: url.searchParams.get('progressId') }));
      if (p === '/_api/publish/qr' && req.method === 'POST') return send(200, await api.qrGenerate());
      if (p === '/_api/publish/login' && req.method === 'POST') return send(200, await api.qrPoll());
      if (p === '/_api/publish/logout' && req.method === 'POST') return send(200, await api.logout());
      if (p === '/_api/publish/plan' && req.method === 'POST') return send(200, await api.plan(await body()));
      if (p === '/_api/publish/preflight' && req.method === 'POST') return send(200, await api.preflight((await body()).id));
      if (p === '/_api/publish/references' && req.method === 'POST') {
        const input = await body();
        return send(200, await api.references(input.id, { desc: input.desc, urls: input.urls }));
      }
      if (p === '/_api/publish/submit' && req.method === 'POST') return send(200, await api.submit(await body()));
      if (p === '/_api/publish/batch' && req.method === 'POST') return send(200, await api.batchSubmit(await body()));
      if (p === '/_api/publish/batch-cancel' && req.method === 'POST') return send(200, api.batchCancel());
      if (p === '/_api/publish/batch-state') return send(200, api.batchState());
      if (p === '/_api/publish/verify' && req.method === 'POST') return send(200, await api.verify((await body()).bvid));
      return send(404, { error: '当前服务不支持此发布接口，可能需要安全重启工作台以加载新版本', code: 'PUBLISH_API_UNSUPPORTED' });
    } catch (error) {
      /* 失败不再只回一句话：带上归类与建议，界面才能说清"要不要等、要不要去查、
       * 能不能直接重试"。没有稿件被创建的情况必须明确说，否则用户会以为发成功了。 */
      const classified = error.outcome || error.httpStatus ? api.classify(error) : null;
      return send(error.statusCode || 400, {
        error: error.message,
        outcome: error.outcome || null,
        stage: error.stage || null,
        steps: error.steps || [],
        kind: classified?.kind || null,
        retryable: classified?.retryable ?? null,
        waitMs: classified?.waitMs || null,
        advice: classified?.advice || '',
      });
    }
  }

  if (p === '/_api/trash' && req.method === 'GET') {
    // 必须用 runtime.root：模块级 ROOT 是 harness 自身目录，测试或多实例下会写错地方。
    const trashDir = path.join(root, '.vh-trash');
    let items = [];
    items = trashNames(root)
      .map(name => {
        const abs = path.join(trashDir, name);
        const st = fs.statSync(abs);
        return { name, bytes: dirSize(abs), deletedAt: st.mtimeMs };
      })
      .sort((a, b) => b.deletedAt - a.deletedAt);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      items,
      totalBytes: items.reduce((a, b) => a + b.bytes, 0),
    }));
    return;
  }
  /* 回收站：恢复 / 彻底删除。
   * 删除只是 rename 到 .vh-trash，空间不会自己释放；这里给用户真正的回收站操作。 */
  if (p === '/_api/trash' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 64e3) req.destroy(); });
    req.on('end', async () => {
      try {
        const { action, name, confirmed, expectedNames } = JSON.parse(body || '{}');
        if ((action === 'purge' || action === 'restore') && !name) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: '请选择回收站中的项目' })); return;
        }
        const target = action === 'purge' || action === 'restore' ? trashEntry(root, name) : null;
        if ((action === 'empty' || action === 'purge') && confirmed !== true) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: '彻底删除不可恢复；须明确确认删除范围' })); return;
        }
        if (action === 'empty' || action === 'purge') {
          if (action === 'empty') {
            emptyTrash(root, expectedNames);
          } else fs.rmSync(target, { recursive: true, force: true });
        } else if (action === 'restore') {
          // 恢复到 projects/ 下；重名时加后缀，绝不覆盖已有项目。
          const stamp = name.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, '') || 'project';
          let dest = path.join(root, 'projects', stamp);
          let i = 2;
          while (fs.existsSync(dest)) dest = path.join(root, 'projects', stamp + '-' + i++);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(target, dest);
        } else {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: '未知操作' })); return;
        }
        invalidateAllDirSizes();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, action }));
      } catch (e) {
        res.writeHead(e.statusCode || 500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (p === '/_api/remove' && req.method === 'POST') {
    const purge = url.searchParams.get('purge') === '1';
    if (!qRel || !project) { res.writeHead(400); res.end('{"error":"需要 p 参数"}'); return; }
    if (path.resolve(project) === path.resolve(root) || path.resolve(project) === ROOT) { res.writeHead(400); res.end('{"error":"拒绝删除根目录"}'); return; }
    if (purge) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '请先移入回收站，再明确确认彻底删除；未修改项目' })); return; }
    assertSafeProjectPath(project, root);
    const task = taskStatus(project);
    if (task.running || task.orphanRunning) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '项目仍在制作，不能删除；请先等待或取消任务，未删除任何文件' })); return; }
    let moved = null;
    try {
      // 回收站不是渲染缓存仓库：先删可由源文件重建的帧/TTS，再移动项目。
      const { stripProjectCaches } = await import('./disk-hygiene.mjs');
      const fresh = taskStatus(project);
      if (fresh.running || fresh.orphanRunning) { res.writeHead(409); res.end(JSON.stringify({ error: '项目刚开始执行，未清缓存或删除项目' })); return; }
      stripProjectCaches(project, { keepSeg: false });
      const bytes = dirSize(project);
      const trash = path.join(root, '.vh-trash', new Date().toISOString().replace(/[:.]/g, '-') + '-' + path.basename(project));
      fs.mkdirSync(path.dirname(trash), { recursive: true });
      fs.renameSync(project, trash);
      moved = path.relative(root, trash);
      invalidateAllDirSizes();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      // bytes 让界面能说清"移走了多少/释放了多少"，避免用户以为已经省下空间。
      res.end(JSON.stringify({ ok: true, moved, purge, bytes }));
    } catch (e) { res.writeHead(500); res.end('{"error":"' + String(e.message).replace(/"/g, '') + '"}'); }
    return;
  }
  if (p === '/_api/chat/status') {
    const { tail, ...status } = await workbenchTaskStatus(project, runtime);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(status));
    return;
  }
  if (p === '/_api/chat/history') {
    const { readChatHistory, archivedTaskCount } = await import('./chat-history.mjs');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ entries: readChatHistory(project), archived: archivedTaskCount(project) }));
    return;
  }
  if (p === '/_api/chat/memory') {    let mem = [];
    try {
      const f = path.join(project, 'out', '.vh-chat-memory.json');
      if (fs.existsSync(f)) mem = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {}
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ memory: mem.slice(-8), max: 8 }));
    return;
  }
  if (p === '/_api/chat') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; if (body.length > 64e3) req.destroy(); });
      req.on('end', async () => {
        try {
          const { message = '', mode, intent = 'continue', delivery: requestedDelivery } = JSON.parse(body || '{}');
          if (typeof message !== 'string' || !['continue', 'new'].includes(intent)) throw new Error('无效的任务请求');
          if (requestedDelivery !== undefined && !['steer', 'queue'].includes(requestedDelivery)) throw new Error('delivery 只能是 steer 或 queue');
          // 运行中：插话直接投给正在跑的会话（opencode），或排队等下一轮（local）
          const previous = taskStatus(project);
          if (previous.cancelling || previous.orphanRunning || (previous.productionBusy && !previous.taskRunning) || (previous.running && intent === 'new')) {
            res.writeHead(409); res.end(JSON.stringify({ error: '当前项目仍有执行进程，未启动另一任务' })); return;
          }
          if (previous.running) {
            if (!message.trim()) { res.writeHead(409); res.end(JSON.stringify({ error: '原任务仍在执行，无需重复继续' })); return; }
            /* 执行器是 opencode 时，插话直接投给正在跑的会话（steer/queue）；
             * local 循环没有会话，只能写队列等下一轮。
             * 两条路都留日志，界面才有"排队"和"已送达"的区别可说。 */
            const { steerRunningTask, queueTaskInstruction } = await import('./runners/index.mjs');
            const delivery = requestedDelivery === 'queue' ? 'queue' : 'steer';
            const steer = await steerRunningTask(project, { message, delivery });
            if (steer.ok) {
              try { chatLogLine(project, '\n══ 插话（' + (steer.via === 'opencode' ? (delivery === 'steer' ? '已送达，下一步生效' : '已排队，本轮结束后生效') : '排队，下一步生效') + '）：' + String(message).slice(0, 80) + ' ══'); } catch {}
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ queued: steer.via === 'local', delivered: steer.via === 'opencode', via: steer.via, delivery }));
              return;
            }
            /* 当前不能可靠实时插话（例如独立 OpenCode 服务）：把原文写进当前任务的
             * 恢复指令，进程退出后「继续原任务」会把它交给下一次执行。不能只报错后丢掉，
             * 也不能写进没人读取的旧插话队列再假装送达。 */
            const saved = await queueTaskInstruction(project, { message, taskId: previous.taskId,
              attemptId: previous.attemptId, mode: previous.mode || mode || 'edit' })
              .catch(error => ({ ok: false, message: '补充指令保存失败：' + error.message }));
            try { chatLogLine(project, saved.ok
              ? '══ 补充指令已保存到原任务，停止并继续后提交：' + String(message).slice(0, 80) + ' ══'
              : '══ 补充指令未能送达或保存：' + String(message).slice(0, 80) + ' ══'); } catch {}
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: saved.ok
              ? '这次补充指令没有插进正在执行的步骤：' + (steer.message || '当前执行器不支持运行中插话') +
                '\n已完整保存到原任务，输入框文字也会保留。先点「停止」，等进程退出后点「继续原任务」，下一次执行会收到这条要求。'
              : '补充指令未能送达，也未能保存：' + (saved.message || steer.message || '未知原因') +
                '\n输入仍保留在下面。请刷新核对任务状态后再试；没有自动重试。',
              delivered: false, savedForResume: saved.ok, reason: steer.reason || null }));
            return;
          }
          /* 已完成的任务不能走"恢复检查点"（会报"原任务已结束"），
           * 但用户想在同一项目上接着改是正常需求：开新任务，沿用现有文件。
           * 不这样的话，页面在完成后就不给任何入口加内容。 */
          const doneBefore = previous.status === 'completed';
          const continuing = intent !== 'new' && previous.canResume && !doneBefore;
          if (!continuing && !message.trim()) {
            res.writeHead(400); res.end(JSON.stringify({
              error: doneBefore ? '任务已完成；要修改请直接写要求（例如"在片尾加一段广告"），会作为新任务在现有项目上继续' : '没有可继续的任务，请先输入制作要求',
            })); return;
          }
          const readiness = await configuredExecution(project, runtime);
          if (!readiness.ready) {
            if (continuing) { res.writeHead(503); res.end(JSON.stringify({ error: taskError('', 'credentials').message })); return; }
            const task = beginTask(project, String(message), mode || 'edit');
            updateTask(project, task.id, { automation: webAutomationPolicy(project, mode || 'edit', message), status: 'failed', error: taskError('', 'credentials'), finishedAt: Date.now() });
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: taskStatus(project).error.message })); return;
          }
          const task = chatSpawn(project, message, mode || 'edit', runtime, { resume: continuing });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ started: true, resumed: continuing, task }));
        } catch (e) { res.writeHead(400); res.end('{"error":"' + String(e.message).replace(/"/g, '') + '"}'); }
      });
      return;
    }
    const status = await workbenchTaskStatus(project, runtime);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(status));
    return;
  }
  if (['/_api/chat/retry', '/_api/chat/resume'].includes(p) && req.method === 'POST') {
    if (qRel && !resolveDir(qRel, root)) {
      res.writeHead(404); res.end(JSON.stringify({ error: '项目不存在，未向默认项目派发重试' })); return;
    }
    let extension, instruction = '';
    if (p === '/_api/chat/resume') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 64e3) throw Object.assign(new Error('继续请求过长'), { statusCode: 400 });
      }
      try {
        const value = JSON.parse(body || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('继续参数必须是 JSON 对象');
        if (value.instruction !== undefined && (typeof value.instruction !== 'string' || value.instruction.length > 60000)) {
          throw new Error('补充要求必须是 60000 字以内的文本');
        }
        // 输入框里尚未发送的要求随继续一起进入下一次执行；预算扩展仍是独立显式确认。
        if (String(value.instruction || '').trim()) instruction = value.instruction;
        const extensionKeys = ['additionalRepairs', 'taskId', 'attemptId'];
        if (extensionKeys.some(key => Object.hasOwn(value, key))) extension = Object.fromEntries(extensionKeys
          .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
      } catch (error) { error.statusCode = 400; throw error; }
    }
    /* Busy must be reported before validating an extension: during a running
     * task the identity is stale by design, but the correct answer is 409
     * (do not dispatch another run), not 400 (bad parameters). */
    const status = taskStatus(project), input = retryInput(project);
    if (status.running || status.orphanRunning) { res.writeHead(409); res.end(JSON.stringify({ error: '当前项目的任务仍在运行，未重复派发' })); return; }
    if (extension) validateRepairExtension(project, extension);
    if (!status.canRetry || !input) { res.writeHead(409); res.end(JSON.stringify({ error: '没有可重试的失败任务' })); return; }
    if (!(await configuredProviders(runtime)).length) {
      res.writeHead(503); res.end(JSON.stringify({ error: taskError('', 'credentials').message })); return;
    }
    const task = chatSpawn(project, instruction, input.mode, runtime, { resume: true, repairExtension: extension });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ started: true, resumed: true, task }));
    return;
  }
  if (p === '/_api/chat/cancel' && req.method === 'POST') {
    const status = taskStatus(project);
    if (status.productionBusy && !status.taskRunning && !status.orphanRunning && !status.cancelling) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cancelled: false, cancelling: false, productionBusy: true,
        error: '命令行制作仍在执行或生产锁尚未确认；请在原终端取消，未向无任务绑定的进程发送信号' })); return;
    }
    if (!status.running && !status.orphanRunning) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"cancelled":false,"cancelling":false}'); return;
    }
    const result = await cancelTaskProcesses(project, { taskId: status.taskId, attemptId: status.attemptId });
    try { chatLogLine(project, result.cancelled ? '\n══ 已取消（所有登记进程已退出）══' : '\n══ 正在取消，等待登记进程退出；暂不重复派发 ══'); } catch {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 页面
  if (p === '/') {
    serveFile(res, WWW, qRel ? 'player.html' : 'index.html', req);
    return;
  }
  if (p === '/settings') {
    serveFile(res, WWW, 'settings.html', req);
    return;
  }
  if (p === '/publish') {
    serveFile(res, WWW, 'publish.html', req);
    return;
  }
  if (p.startsWith('/_vh/')) {
    serveFile(res, WWW, p.slice('/_vh/'.length), req);
    return;
  }

  const relative = p.slice(1);
  if (!isPublicFile(root, relative)) { res.writeHead(403); res.end('403'); return; }
  serveFile(res, root, relative, req, { untrusted: true });
}

/* Validate/open once; media streams use the validated fd, including on Range.
 * Untrusted HTML stays opaque even when opened outside the panel iframe. */
function serveFile(res, root, relative, req, { untrusted = false } = {}) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  const opened = openSafeFile(root, relative), ext = path.extname(relative).toLowerCase();
  let fd = opened.fd, body = null, size = opened.stat.size;
  try {
    if (untrusted && ext === '.html') {
      body = Buffer.from(fs.readFileSync(fd, 'utf8') + '\n' + previewBridge);
      size = body.length;
    }
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    if (untrusted) {
      // Only public static data gets CORS. Never apply this to control APIs.
      headers['access-control-allow-origin'] = '*';
      headers['cross-origin-resource-policy'] = 'cross-origin';
      if (ext === '.html' || ext === '.svg') headers['content-security-policy'] = previewCSP;
    }
    const range = byteRange(req.headers.range, size);
    if (range === false) { res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': 0 }); res.end(); return; }
    const start = range?.start ?? 0, end = range?.end ?? size - 1;
    headers['content-length'] = range ? end - start + 1 : size;
    if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || !size) { res.end(); return; }
    if (body) { res.end(body.subarray(start, end + 1)); return; }
    const stream = fs.createReadStream(null, { fd, autoClose: true, start, end });
    fd = undefined; // ownership transferred; stream never reopens the path
    stream.on('error', () => res.destroy());
    res.once('close', () => stream.destroy());
    stream.pipe(res);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/* ================================================================== */
/* 聊天/生成桥：网页消息 → harness 自带的 agent 循环（lib/agent.mjs）      */
/* ================================================================== */
const chatLogLine = (project, s) => {
  fs.mkdirSync(path.join(project, 'out'), { recursive: true });
  fs.appendFileSync(path.join(project, 'out', '.vh-chat.log'), s + '\n');
};


/* 进程退出后写什么日志：退出码不能决定语义。
 * 真实事故：步数预算耗尽按设计退出 0，旧实现却在日志里写“══ 完成 ══”，
 * 与紧邻的“达到 400 步上限”自相矛盾。以持久化任务状态为准。 */
export function stopLogLabel(status, code, signal) {
  const exit = code == null ? '信号 ' + (signal || '未知') : '退出 ' + code;
  return { completed: '完成', paused: '任务已暂停（进度已保留，可继续原任务）',
    cancelled: '已取消', cancelling: '正在取消（等待登记进程退出）', failed: '任务失败（' + exit + '）' }[status] || '任务未完成（' + exit + '）';
}

/* 网页「指挥」= 起一个 vh.mjs ask 子进程（与 CLI 完全同一执行器；这里负责流式日志与取消） */
function chatSpawn(project, message, mode = 'article', runtime = {}, options = {}) {
  const status = taskStatus(project);
  if (status.running || status.orphanRunning) throw Object.assign(new Error('当前项目仍有任务在运行，未重复派发'), { statusCode: 409 });
  if (!['article', 'topic', 'edit', 'edit-visual', 'edit-script', 'edit-copy'].includes(mode)) throw new Error('无效任务模式');
  const vh = path.join(HERE, '..', 'vh.mjs');
  let saved;
  if (options.resume && status.taskId) {
    let checkpoint;
    try { checkpoint = readCheckpoint(project, status.taskId); }
    catch (error) { error.statusCode = 409; throw error; }
    if (checkpoint?.status === 'completed') throw new Error('原任务已有完成记录，请先查看产物；需要修改时明确开始新一轮任务');
    saved = checkpoint;
  }
  const job = options.resume ? resumeTask(project, message === readTask(project)?.message ? '' : message, options.repairExtension) : beginTask(project, message, mode);
  mode = job.mode;
  const attemptId = job.attemptId;
  // Persist before spawn: requested-task CLI reads this exact policy, including
  // a custom repair budget. A normal refresh never dispatches or upgrades a run.
  // Preserve the actual active budget across attempts, not the future project
  // defaults. Legacy disabled tasks still upgrade to today's web default.
  const activePolicy = options.resume && (job.automation?.enabled ? job.automation : saved?.automation?.enabled ? saved.automation : null);
  const automation = activePolicy ? automationPolicy(project, activePolicy) : webAutomationPolicy(project, mode, message || job.message);
  updateTask(project, job.id, { automation }, attemptId);
  const logPath = path.join(project, 'out', '.vh-chat.log');
  if (options.resume) fs.appendFileSync(logPath, '\n══ 继续原任务，正在启动第 ' + job.attemptNumber + ' 次执行 ══\n');
  else fs.writeFileSync(logPath, '══ 任务已提交，正在启动制作进程 ══\n');
  const stderr = fs.openSync(logPath, 'a');
  // detached + unref：agent 是独立进程，重启/关闭工作台不会杀掉它（否则改代码+重启就会误杀用户的活）
  let cp;
  try {
    // 输入保存在任务文件，不塞进命令行，避免长文章超过 argv 限制或暴露在进程列表。
    cp = spawn(runtime.agentExecutable || process.execPath, [vh, 'ask', '--task-id', job.id, '--attempt-id', attemptId, '--mode', mode, '--dir', project], {
      cwd: project, env: runtime.agentEnv || process.env, detached: true, stdio: ['ignore', 'ignore', stderr],
    });
  } catch (e) {
    updateTask(project, job.id, { status: 'failed', error: taskError('', 'startup'), finishedAt: Date.now() }, attemptId);
    throw e;
  } finally { fs.closeSync(stderr); }
  cp.unref();
  if (cp.pid) updateTask(project, job.id, { pid: cp.pid }, attemptId);
  cp.on('error', () => {
    if (readTask(project)?.attemptId !== attemptId) return;
    updateTask(project, job.id, { status: 'failed', error: taskError('', 'startup'), finishedAt: Date.now() }, attemptId);
    chatLogLine(project, '══ 制作进程启动失败；原始输入已保留 ══');
  });
  cp.on('close', (code, signal) => {
    reconcileCancellation(project);
    let current = readTask(project);
    if (current?.id !== job.id || current.attemptId !== attemptId) return;
    if (['starting', 'running'].includes(current.status)) {
      current = updateTask(project, job.id, { status: 'failed', error: taskError('', 'interrupted'), finishedAt: Date.now() }, attemptId);
    }
    if (!current) return;
    // exit 0 也可能只是步数预算暂停；先结算意外退出，再以持久化结果写日志。
    try { fs.appendFileSync(logPath, `\n══ ${stopLogLabel(current.status, code, signal)} ══\n`); } catch {}
  });
  return taskStatus(project);
}
