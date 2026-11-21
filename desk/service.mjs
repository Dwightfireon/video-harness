/* 发布用例层：无 Electron、无目录/凭据格式知识。
 * IPC 只传参；实时分区核验、预览与提交前置条件统一在这里。
 * 依赖由主进程注入，测试无需登录或上传真实文件。 */
import { buildPayload, validateInput } from './publish-contract.mjs';
import { runPublish } from './publish.mjs';
import { offlinePartitions, validateSelection } from './partitions.mjs';
import { classifyPublishError } from '../lib/publish-guard.mjs';
import { PROMOTION_PROTOCOL_VERSION } from './promotion.mjs';

export function createPublishService({ getDraft, getCredentials, createClient, prepareCover, cleanupCover, transaction,
  credentialKey, acquireProject, onStep = () => {}, onProgress = () => {} }) {
  let catalog = offlinePartitions();
  let submitting = false;
  const credentials = () => {
    const cred = getCredentials();
    if (!cred?.cookies?.SESSDATA || !cred?.cookies?.bili_jct) throw new Error('还没登录：先扫码登录');
    return cred;
  };

  async function loadPartitions() {
    const cred = getCredentials();
    catalog = offlinePartitions('未登录：当前显示离线参考分区，不能据此提交');
    if (!cred?.cookies?.SESSDATA || !cred?.cookies?.bili_jct) return catalog;
    try {
      catalog = await createClient({ cookies: cred.cookies }).partitions();
    } catch (error) {
      catalog = offlinePartitions('读取实时分区失败：' + error.message);
    }
    return catalog;
  }

  function problemsFor(input, draft, currentCatalog) {
    return [...new Set([...validateInput(input, draft), ...validateSelection(input, currentCatalog)])];
  }

  // 预览不访问网络/模型；使用上次显式加载的分区，正式投稿仍重新查询。
  async function plan(input) {
    const draft = await getDraft(input?.id);
    input = { ...input, cover: input?.cover === undefined ? draft.coverWanted : input.cover,
      promotion: input?.promotion === undefined ? draft.promotion : input.promotion };
    const problems = problemsFor(input, draft, catalog), notices = [];
    let cover = { ok: false, issues: ['本次不携带封面'], warnings: [] };
    let prepared;
    try {
      if (input?.cover !== false && draft.cover?.ok) {
        prepared = prepareCover(draft.cover.path);
        cover = { ok: prepared.ok, issues: prepared.issues, warnings: prepared.warnings,
          note: prepared.note, info: prepared.info, file: draft.cover.file };
        if (!cover.ok) problems.push('封面不可用：' + (cover.issues || []).join('；'));
      }
    } finally {
      if (prepared) { try { cleanupCover(prepared); } catch { notices.push('预览封面临时文件清理失败'); } }
    }
    const payload = problems.length ? null : buildPayload({ ...input,
      cover: input.cover !== false && draft.cover?.ok ? '（提交时上传后填入）' : '',
      video: { filename: '（上传后由 B 站返回）' } });
    return { payload, problems, cover, warnings: draft.warnings || [], notices, promotionSupported: true,
      promotionProtocolVersion: PROMOTION_PROTOCOL_VERSION, formSupported: true,
      video: draft.video ? { file: draft.video.file, bytes: draft.video.bytes, duration: draft.video.duration } : null,
      ready: !problems.length && Boolean(getCredentials()?.cookies?.SESSDATA) };
  }

  async function submit(input) {
    if (input?.confirmed !== true) throw new Error('需要在界面上确认后才能投稿');
    if (submitting) return { ok: false, outcome: 'not-submitted', message: '已有投稿正在执行，请勿重复提交', steps: [] };
    submitting = true;
    let projectLease;
    try {
      const cred = credentials();
      // 排程授权必须与本次实际捕获的凭据相符，不能只在外层检查后再重读账号。
      if (input.expectedAccountKey !== undefined && (!credentialKey || credentialKey(cred) !== input.expectedAccountKey)) {
        return { ok: false, outcome: 'not-submitted', reason: 'account-changed', message: '投稿账号与排程授权不一致，未提交', steps: [] };
      }
      let draft = await getDraft(input.id);
      if (acquireProject) {
        projectLease = acquireProject(draft);
        // 防止上轮快照后重新制作；取得租约后再读当前成片，上传期间制作命令不能覆盖它。
        draft = await getDraft(input.id, { projectLease });
      }
      input = { ...input, cover: input.cover === undefined ? draft.coverWanted : input.cover,
        promotion: input.promotion === undefined ? draft.promotion : input.promotion };
      // 先完成本地校验，再获取当前账号可投稿的真实叶子分区；不能只校验 tid>0。
      let problems = validateInput(input, draft);
      if (problems.length) return { ok: false, outcome: 'not-submitted', message: problems.join('；'), steps: [], problems,
        waiting: draft.blockers?.some(item => ['project-running', 'project-changed', 'video-stale', 'no-video'].includes(item.code)) === true };
      if (!transaction?.execute) return { ok: false, outcome: 'not-submitted', reason: 'guard-missing', message: '投稿事务保护未配置，已阻止提交', steps: [] };
      return await transaction.execute({ credential: cred, draft, input }, async () => {
        try {
          const context = { id: input.id, progressId: input.progressId };
          const api = createClient({ cookies: cred.cookies, onProgress: event => onProgress(event, context) });
          catalog = offlinePartitions('正在重新核对实时投稿分区');
          catalog = await api.partitions();
          problems = problemsFor(input, draft, catalog);
          if (problems.length) return { ok: false, outcome: 'not-submitted', message: problems.join('；'), steps: [], problems };
          const result = await runPublish({ draft, input, api, prepareCover, cleanupCover, onStep: event => onStep(event, context) });
          return { ok: true, outcome: 'submitted', aid: result.result.aid, bvid: result.result.bvid,
            url: result.result.bvid ? 'https://www.bilibili.com/video/' + result.result.bvid : null,
            message: result.declarationVerification?.message || '',
            steps: result.steps, payload: result.payload, warnings: result.warnings, declarationVerification: result.declarationVerification };
        } catch (error) { return failure(error); }
      });
    } catch (error) {
      return failure(error);
    } finally {
      submitting = false;
      if (projectLease) {
        try { if (!projectLease.release()) throw new Error('项目投稿锁未完整释放'); }
        catch { return { ok: false, outcome: 'unknown', message: '投稿后项目保护锁未完整关闭，请人工核对，禁止自动重发', steps: [] }; }
      }
    }
  }

  function failure(error) {
    const result = { ok: false, outcome: error.outcome || 'not-submitted', stage: error.stage || 'preflight',
      message: error.message, steps: error.steps || [], code: error.code ?? null,
      waiting: error.code === 'PRODUCTION_LOCK_BUSY',
      httpStatus: error.httpStatus ?? null, warnings: error.warnings || [] };
    return { ...result, ...classifyPublishError(result) };
  }

  async function preflight(id) {
    if (!transaction?.preflight) return { ok: false, reason: 'guard-missing', message: '投稿事务保护未配置' };
    try { return await transaction.preflight({ credential: credentials(), draft: await getDraft(id), input: { id } }); }
    catch (error) { return { ok: false, reason: 'preflight', message: error.message }; }
  }

  return { loadPartitions, plan, preflight, submit };
}
