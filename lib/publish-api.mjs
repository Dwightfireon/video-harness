/* 发布服务：把 desk/ 里的投稿逻辑接到本地 HTTP 服务上。
 *
 * desk/ 那套模块本来就不依赖 Electron（只有 main.mjs 依赖），所以网页工作台
 * 可以直接复用同一套校验、上传、提交用例，不需要重写一遍——也就不会出现
 * "网页发出去的字段和发布台不一样"这种两套实现的分叉。
 *
 * 这一层只做三件接线的事：
 *   1. 把本机凭据（~/.config/video-harness/bilibili.json）读给服务用
 *   2. 把扫码登录的轮询状态放在内存里（二维码有有效期，不该落盘）
 *   3. 给批量发布持有一个"正在发"的闸门，避免并发提交
 *
 * 不可逆动作的预检、账号锁与持久化尝试统一在 service.submit 的事务里。
 * confirm 必须显式为 true、写请求仍过来源检查；未知结果不会自动重发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { createPublishService } from '../desk/service.mjs';
import { createPublishTransaction, publishAccountKey } from '../desk/publish-transaction.mjs';
import { createPublishScheduler } from './publish-scheduler.mjs';
import { createHarnessAdapter } from '../desk/harness-adapter.mjs';
import { projectDraft, listProjectDirs, resolveProject } from '../desk/projects.mjs';
import { createBiliClient, cookiesComplete, ensureDeviceCookies, checkPublishReady, FALLBACK_PARTITIONS } from '../desk/bili.mjs';
import { readBiliCredential, saveBiliCredential, clearBiliCredential, createQrLogin, qrDataUrl, credentialPath } from '../desk/login.mjs';
import { prepareCover, cleanupCover, prepareCoverIssues } from '../desk/cover-prep.mjs';
import { offlinePartitions, HUMAN_PARTITION_TAXONOMY, HUMAN_COMPAT_TID, formPartition, partitionIdProblems } from '../desk/partitions.mjs';
import { classifyPublishError } from './publish-guard.mjs';
import { publicationState, pendingSummary } from '../desk/publication-state.mjs';
import { observeProjectTask, reconcileProjectTask, projectBusy, sameProjectAttempt } from './project-state.mjs';
import { readSchedule } from './schedule.mjs';
import { acquireProductionLock, ownsProductionLock } from './production-lock.mjs';
import { readPromotion, savePromotion as persistPromotion } from './publish-promotion-store.mjs';
import { applyPublishForm, savePublishForm } from './publish-form-store.mjs';

/* 封面尺寸门槛：只把真正的阻断项（尺寸不够）交给草稿层，
 * 比例/体积这类提醒留到试运行时提示，避免一选项目就满屏红字。 */
export function createPublishApi({ root, home = process.env.HOME, fetchImpl = globalThis.fetch, getDraft, createClient, projectStates,
  schedulerFactory = createPublishScheduler } = {}) {
  const adapter = createHarnessAdapter();
  /* 只为登录态保留内存会话；二维码本身 3 分钟就过期，不落盘。 */
  let loginSession = null;
  let batch = { running: false, cancel: null, results: [] };
  let upload = null;
  function updateUpload(event, context, type) {
    if (!upload?.running || context.id !== upload.id || context.progressId !== upload.progressId) return;
    upload.updatedAt = Date.now();
    if (type === 'step') upload.stage = String(event.name || '正在处理');
    else {
      upload.phase = String(event.phase || '');
      if (Number.isFinite(event.bytes) && Number.isFinite(event.total) && event.total > 0) {
        upload.bytes = event.bytes; upload.total = event.total;
      }
      if (event.phase === 'uploaded') { upload.bytes = event.bytes; upload.total = event.bytes; }
      if (event.phase === 'retry') upload.retry = Number(event.attempt) || 0;
    }
  }

  const credentials = () => readBiliCredential(home);
  const requireCredentials = () => {
    const cred = credentials();
    if (!cookiesComplete(cred?.cookies || {})) throw new Error('还没登录：先扫码登录');
    return cred;
  };

  const readDraft = getDraft || (id => projectStates
    ? projectStates.readDraft(resolveProject(root, id)) : projectDraft(root, id, adapter, { coverIssues: prepareCoverIssues }));
  const draftFor = async (id, { projectLease } = {}) => {
    const dir = path.join(root, 'projects', id);
    const owned = ownsProductionLock(projectLease, dir);
    const initial = reconcileProjectTask(dir, { productionLease: projectLease });
    const draft = await readDraft(id);
    const task = observeProjectTask(dir, { productionLease: projectLease });
    // Worker 读取期间，主线程可能刚启动了下一轮制作，不能把旧快照当成就绪。
    const changed = !sameProjectAttempt(initial, task) || projectBusy(initial) !== projectBusy(task);
    const blockers = (draft.blockers || []).filter(item => !(owned && !projectBusy(task) && item.code === 'project-running'));
    if (projectBusy(task)) blockers.push({ code: 'project-running', text: '项目仍在制作或取消，等待完成后再发布' });
    if (changed) blockers.push({ code: 'project-changed', text: '读取期间任务变化，等待重新核验' });
    return applyPublishForm({ ...draft, task, blockers, promotion: readPromotion(draft.dir) });
  };
  const transaction = createPublishTransaction({ root, home });

  const service = createPublishService({
    getDraft: draftFor,
    getCredentials: credentials,
    credentialKey: publishAccountKey,
    transaction,
    acquireProject: draft => draft.dir ? acquireProductionLock(draft.dir, { command: 'publish-upload', env: {} }) : null,
    // 适配器约定是「传选项对象」，不是「传 cookies 本身」。
    // 写成 createClient: cookies => ... 会把 {cookies} 再包一层，导致 cookie 头失效、
    // 所有接口都返回「账号未登录」。
    createClient: createClient || (options => createBiliClient({ ...options, fetch: fetchImpl })),
    prepareCover,
    cleanupCover,
    onStep: (event, context) => updateUpload(event, context, 'step'),
    onProgress: (event, context) => updateUpload(event, context, 'progress'),
  });

  const submitDraft = (draft, id, partition, expectedAccountKey) => service.submit({
    id, title: draft.fields.title, desc: draft.fields.desc, tags: draft.fields.tags,
    ...partition, expectedAccountKey, copyright: 1, noReprint: false, cover: draft.coverWanted !== false, confirmed: true,
  });
  function scopeIds(plan) {
    if (plan.scope?.kind !== 'production-queue') return plan.ids;
    // 显式授权整个制作队列时，后续关联的新项目自然纳入；不把所有磁盘视频自动授权。
    return [...new Set(readSchedule(root).items.map(item => item.project).filter(project =>
      typeof project === 'string' && path.dirname(project) === 'projects').map(project => path.basename(project)))];
  }
  function gateFor(id, draft) {
    const cred = credentials();
    return cred && draft.video && !projectBusy(draft.task) && !draft.blockers?.some(item => ['video-stale', 'project-changed'].includes(item.code))
      ? transaction.status({ credential: cred, draft, input: { id } }) : undefined;
  }
  async function stateFor(id, { strong = false } = {}) {
    const draft = await draftFor(id);
    let gate = gateFor(id, draft);
    let publication = publicationState({ task: draft.task, draft, gate });
    if (strong && publication.eligible) {
      gate = await service.preflight(id);
      publication = publicationState({ task: draft.task, draft, gate });
    }
    return { id, draft, publication };
  }
  const scheduler = schedulerFactory({
    root,
    accountKey: () => { const cred = credentials(); return cookiesComplete(cred?.cookies || {}) ? publishAccountKey(cred) : null; },
    listScopeIds: scopeIds,
    getCandidate: async id => {
      let item;
      try { item = await stateFor(id, { strong: true }); }
      catch (error) {
        if (['ENOENT', 'PROJECT_NOT_FOUND'].includes(error.code)) return null;
        throw error;
      }
      return item.publication.eligible || ['blocked', 'unknown'].includes(item.publication.state) ? item : null;
    },
    submitOne: async ({ id, draft, publication }, partition, expectedAccountKey) => {
      if (batch.running) return { ok: false, outcome: 'not-submitted', message: '批量投稿正在执行，排程已暂停' };
      if (['blocked', 'unknown'].includes(publication.state)) return { ok: false, outcome: 'not-submitted', reason: publication.state, message: publication.reason };
      return submitDraft(draft, id, partition, expectedAccountKey);
    },
  });

  /* 只读总览：账号 + 分区 + 每个项目的发布素材状态。
   * 不访问网络以外的副作用，也不触发任何上传。 */
  async function overview() {
    const cred = credentials();
    let account = null;
    let ready = null;
    if (cred) {
      try {
        const who = await createBiliClient({ cookies: cred.cookies, fetch: fetchImpl }).whoami();
        account = who.loggedIn
          ? { loggedIn: true, name: who.name, mid: who.mid, level: who.level, savedAt: cred.savedAt }
          : { loggedIn: false, expired: true, name: cred.name || '', savedAt: cred.savedAt, message: who.message || '登录已过期' };
        if (account.loggedIn) {
          try { ready = await checkPublishReady(createBiliClient({ cookies: cred.cookies, fetch: fetchImpl })); }
          catch (error) { ready = { ok: false, checks: [{ name: '体检', ok: false, note: error.message }] }; }
        }
      } catch (error) { account = { loggedIn: false, message: error.message }; }
    }
    return { loggedIn: Boolean(cred), account, ready, accountKey: cred ? publishAccountKey(cred) : null, credentialPath: credentialPath(home) };
  }

  async function projects() {
    const out = [];
    for (const { id } of listProjectDirs(root)) {
      try {
        const { draft, publication } = await stateFor(id);
        out.push({
          id,
          editorKey: createHash('sha256').update(path.resolve(root, 'projects', id)).digest('hex'),
          title: draft.fields.title || '',
          tags: draft.copy.tags || [],
          desc: draft.copy.desc || '',
          comment: draft.copy.comment || '',
          promotion: draft.promotion,
          savedForm: draft.savedForm,
          formSupported: true,
          coverWanted: draft.coverWanted,
          hasCopy: Boolean(draft.fields.title),
          hasVideo: Boolean(draft.video),
          video: draft.video ? { file: draft.video.file, bytes: draft.video.bytes, duration: draft.video.duration } : null,
          cover: draft.cover?.ok ? { file: draft.cover.file, bytes: draft.cover.bytes } : null,
          coverIssue: draft.cover?.ok ? null : { code: draft.cover?.code || 'invalid', reason: draft.cover?.reason || '没有可用封面' },
          task: (({ tail, ...task }) => task)(draft.task),
          publication,
          ready: publication.eligible,
          warnings: draft.warnings.map(item => ({ code: item.code, text: item.text })),
        });
      } catch (error) {
        out.push({ id, title: '', error: error.message });
      }
    }
    return out;
  }

  async function qrGenerate() {
    loginSession?.stop?.();
    loginSession = createQrLogin({ fetch: fetchImpl, home, ensureDevice: cookies => ensureDeviceCookies(cookies, { fetch: fetchImpl }) });
    const { url, key } = await loginSession.generate();
    return { url, key, image: await qrDataUrl(url, QRCode.toDataURL), expiresInMs: 180000 };
  }

  async function qrPoll() {
    if (!loginSession) throw new Error('请先生成二维码');
    const result = await loginSession.poll();
    if (result.state !== 'ok') return result;
    const api = createBiliClient({ cookies: result.cookies, fetch: fetchImpl });
    const who = await api.whoami();
    if (who.loggedIn) saveBiliCredential(result.cookies, { mid: who.mid, name: who.name, home });
    scheduler.reconcileAccount();
    loginSession.stop();
    loginSession = null;
    let ready = null;
    if (who.loggedIn) {
      try { ready = await checkPublishReady(api); }
      catch (error) { ready = { ok: false, checks: [{ name: '体检', ok: false, note: error.message }] }; }
    }
    return { state: 'ok', account: { loggedIn: true, name: who.name, mid: who.mid, level: who.level }, ready };
  }

  async function logout() {
    loginSession?.stop?.();
    loginSession = null;
    clearBiliCredential(home);
    scheduler.pause('已退出登录，请重新确认每日发布');
    return { loggedIn: false };
  }

  const partitions = () => service.loadPartitions();

  /* 分区清单 + 协议元数据一起下发：前端不该复制 taxonomy 名或兼容 tid 这类协议常量。
   * 后端是唯一来源（desk/partitions.mjs），协议变化只改一处。 */
  async function partitionCatalog() {
    const catalog = await service.loadPartitions();
    return { ...catalog, human: catalog.taxonomy === HUMAN_PARTITION_TAXONOMY, compatTid: HUMAN_COMPAT_TID };
  }

  const plan = input => service.plan(input);

  async function promotionCatalog() {
    const cred = requireCredentials();
    return createBiliClient({ cookies: cred.cookies, fetch: fetchImpl }).promotionOptions();
  }
  function savePromotion(input) {
    const dir = resolveProject(root, input?.id);
    return { promotion: persistPromotion(dir, input?.promotion) };
  }
  function saveForm(input) {
    const dir = resolveProject(root, input?.id);
    return { savedForm: savePublishForm(dir, input.form, input.revision) };
  }

  async function submit(input) {
    if (input?.confirmed !== true) throw new Error('投稿是不可逆的对外动作：需要在界面上确认后提交');
    if (upload?.running) return { ok: false, outcome: 'not-submitted', message: '已有投稿正在执行，请勿重复提交' };
    const progressId = typeof input.progressId === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(input.progressId) ? input.progressId : randomUUID();
    const current = { id: input.id, progressId, running: true, startedAt: Date.now(), updatedAt: Date.now(), stage: '核对投稿资料', bytes: 0, total: null };
    upload = current;
    try {
      const result = await service.submit({ ...input, progressId });
      current.outcome = result.outcome; current.stage = result.ok ? '平台已收稿（审核状态未同步）' : '本次处理已结束';
      return result.ok ? result : { ...result, ...classifyPublishError(result) };
    } finally { current.running = false; current.updatedAt = Date.now(); }
  }
  function progress({ id, progressId }) {
    return upload && upload.id === id && upload.progressId === progressId
      ? { available: true, ...upload, elapsedMs: Date.now() - upload.startedAt } : { available: false };
  }

  /* 提交前的防护检查：冷却、重复、上次结果未知。
   * 只回答"能不能"和"为什么"，不替用户做决定。 */
  const preflight = id => service.preflight(id);

  async function batchSubmit({ ids, intervalMs, partitionTaxonomy, humanType2, tid, confirmed }) {
    if (confirmed !== true) throw new Error('批量投稿需要在界面上确认');
    if (batch.running) throw new Error('已有批量发布在执行');
    const { runBatch, normalizeInterval } = await import('../desk/batch.mjs');
    let cancelled = false;
    batch = { running: true, cancel: () => { cancelled = true; }, results: [] };
    try {
      return await runBatch({
        ids,
        intervalMs: normalizeInterval((Number(intervalMs) || 3000) / 1000),
        shouldCancel: () => cancelled,
        onStep: entry => { batch.results.push(entry); },
        submitOne: async id => {
          const draft = await draftFor(id);
          return submitDraft(draft, id, { partitionTaxonomy, humanType2, tid });
        },
      });
    } finally { batch = { running: false, cancel: null, results: batch.results }; }
  }

  const batchCancel = () => {
    if (!batch.running) return { cancelled: false };
    batch.cancel?.();
    return { cancelled: true };
  };

  const batchState = () => ({ running: batch.running, results: batch.results });

  function saveSchedule(input) {
    const action = input.action || (input.enabled === false ? 'pause' : 'enable');
    if (action === 'enable') {
      const { taxonomy, id } = formPartition(input.partition ?? scheduler.view().partition);
      const problems = partitionIdProblems(id, taxonomy);
      if (problems.length) throw new Error(problems.join('；'));
    }
    return scheduler.save(input);
  }

  async function schedule() {
    const state = scheduler.view();
    const items = [];
    for (const id of scopeIds(state)) {
      try { const { publication } = await stateFor(id); items.push({ id, ...publication }); }
      catch (error) {
        if (['ENOENT', 'PROJECT_NOT_FOUND'].includes(error.code)) items.push({ id, state: 'waiting-video', label: '等待项目', reason: '项目尚未创建或已移走', waiting: true, eligible: false });
        else throw error;
      }
    }
    return { ...state, protocolVersion: 3, pending: pendingSummary(items) };
  }

  async function verify(bvid) {
    const cred = requireCredentials();
    if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid || ''))) throw new Error('BV 号格式不对');
    const found = await createBiliClient({ cookies: cred.cookies, fetch: fetchImpl }).findArchive(bvid);
    // Finding (or not finding) one BV does not reconcile an unresolved attempt.
    // Never turn a negative lookup into permission to resubmit.
    const note = '仅查询指定 BV，不解除未知投稿阻断；请在稿件管理人工核对，不会自动重发。';
    return found
      ? { found: true, stateDesc: found.stateDesc, title: found.title, ptime: found.ptime, note }
      : { found: false, note };
  }

  /* 参考链接：从四个来源收集，拼成可直接贴进简介的段落。
   * 只读、不写盘；界面决定要不要用、用几条。 */  async function references(id, options = {}) {
    const { collectReferences } = await import('./reference-sources.mjs');
    const { referenceText, mergeIntoDescription, missingReferences } = await import('./reference-format.mjs');
    /* id 是项目名（与 draftFor 的接口一致），不是相对仓库根的路径。
     * 拼错成 root/id 会静默返回 0 条——链接收集本身没问题，是路径错了。 */
    const dir = path.join(root, 'projects', id);
    const all = collectReferences(dir);
    const draft = await draftFor(id).catch(() => null);
    const desc = typeof options.desc === 'string' ? options.desc : (draft?.fields?.desc || '');
    /* 只保留调用方勾选的链接；没传就全部。勾选题是界面的决定，这里照办。 */
    const sources = Array.isArray(options.urls) && options.urls.length
      ? all.filter(item => options.urls.includes(item.url)) : all;
    // 「还差几条」按完整来源算：界面默认全选，用户取消一两条时也该看到真实缺口。
    const missing = missingReferences(desc, all);

    if (typeof options.desc !== 'string') {
      const preview = mergeIntoDescription(desc, sources, { limit: 2000 });
      return { sources: all, missing, block: referenceText(sources), preview,
        descLength: desc.length, limit: 2000 };
    }
    const merged = mergeIntoDescription(desc, sources, { limit: 2000 });
    return { sources: all, missing, merged: merged.added ? merged.text : '', added: merged.added,
      dropped: merged.dropped, cap: merged.cap ?? 20, capDropped: merged.capDropped ?? 0, roomDropped: merged.roomDropped ?? 0, limit: 2000,
      note: merged.added ? '' : (sources.length ? '简介已到字数上限，放不下参考链接。' : '没有可用的参考链接。') };
  }

  return { overview, projects, qrGenerate, qrPoll, logout, partitions: partitionCatalog, promotionCatalog, savePromotion, saveForm, progress, plan, preflight, submit, batchSubmit, batchCancel, batchState, verify, references,
    schedule, saveSchedule: input => { saveSchedule(input); return schedule(); },
    startSchedule: () => scheduler.start(), stopSchedule: () => scheduler.stop(),
    classify: classifyPublishError,
    fallbackPartitions: () => FALLBACK_PARTITIONS.map(item => ({ ...item })), offline: () => offlinePartitions() };
}
