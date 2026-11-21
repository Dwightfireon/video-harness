/* Local safety boundary, not platform exactly-once. All entry points inject this
 * into service.submit. Lock and journal live beside credentials, never in a pack.
 * Abandoned valid locks are recovered by the existing process-aware lock; a live
 * owner is never stolen. Corrupt/incomplete lock metadata needs manual inspection.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireProductionLock } from '../lib/production-lock.mjs';
import { marketingStatement } from './promotion.mjs';
import { checkBeforePublish, journalSummary, videoFingerprintAsync, legacyVideoFingerprint,
  recordAttempt, finishAttempt, classifyPublishError, DEFAULT_COOLDOWN_MS } from '../lib/publish-guard.mjs';

export function publishAccountKey(credential) {
  const mid = credential?.mid || credential?.cookies?.DedeUserID;
  // No credential/token hash: tests without mid use a stable non-secret name/id.
  // Unidentified accounts conservatively share one bucket, never a random key.
  const identity = mid ? `bilibili:mid:${mid}` : `bilibili:local:${credential?.accountId || credential?.name || 'unidentified'}`;
  return createHash('sha256').update(identity).digest('hex');
}

const denied = (message, reason = 'guard') => ({ ok: false, outcome: 'not-submitted', reason, message, steps: [] });

export function createPublishTransaction({ root, home = process.env.HOME } = {}) {
  function location(credential) {
    if (!home || !path.isAbsolute(home) || !root) throw new Error('缺少安全投稿状态目录，已阻止提交');
    return path.join(home, '.config/video-harness/publish-state', publishAccountKey(credential));
  }

  async function identity(draft) {
    const fingerprint = await videoFingerprintAsync(draft?.video?.path);
    if (!fingerprint) throw new Error('无法读取完整成片指纹，已阻止投稿');
    return { fingerprint, fingerprints: [fingerprint, legacyVideoFingerprint(draft.video.path)] };
  }

  function gate(store, id, media) {
    // Old repository-wide logs had no account identity. Keep their restrictions
    // conservatively; don't mutate/migrate user journals or silently ignore them.
    const legacy = checkBeforePublish(root, { project: id, ...media });
    return legacy.ok ? checkBeforePublish(store, { project: id, ...media }) : legacy;
  }

  async function preflight({ credential, draft, input }) {
    try {
      const store = location(credential), media = await identity(draft);
      return { ...gate(store, input.id, media), cooldownMs: DEFAULT_COOLDOWN_MS,
        recent: journalSummary(store, input.id) };
    } catch (error) { return { ok: false, reason: 'state', message: error.message, recent: [] }; }
  }

  // 页面只读投影可复用本轮媒体快照的强指纹，不再次对整片哈希。
  // 这不是提交授权；execute 仍在账号锁内重新计算完整媒体身份。
  function status({ credential, draft, input }) {
    try {
      const fingerprints = [draft?.video?.fingerprint, draft?.video?.path ? legacyVideoFingerprint(draft.video.path) : null].filter(Boolean);
      return gate(location(credential), input.id, { fingerprint: fingerprints[0], fingerprints });
    } catch (error) { return { ok: false, reason: 'state', message: error.message }; }
  }

  async function execute({ credential, draft, input }, publish) {
    let lock, store, attemptId, result, started = false;
    try {
      store = location(credential);
      fs.mkdirSync(store, { recursive: true, mode: 0o700 });
      try { lock = acquireProductionLock(store, { command: 'publish', env: {} }); }
      catch {
        return denied('此账号已有投稿正在执行，或投稿锁未完整关闭。活进程不会被接管；若进程已退出仍受阻，请保留状态目录，人工检查锁和稿件，勿直接重发。', 'locked');
      }
      const media = await identity(draft), checked = gate(store, input.id, media);
      if (!checked.ok) return denied(checked.message, checked.reason);
      attemptId = randomUUID();
      // Durable BEFORE any upload/request. A crash from here on is unresolved,
      // including the narrow window after remote success and before local receipt.
      const requested = marketingStatement(input.promotion);
      const declaration = requested ? { requested, state: 'pending' } : null;
      recordAttempt(store, { project: input.id, attemptId, fingerprint: media.fingerprint, outcome: 'submitting', declaration });
      started = true;
      try { result = await publish(); }
      catch { result = { ok: false, outcome: 'unknown', message: '投稿执行意外中断，请人工核对稿件，禁止自动重发', steps: [] }; }
      const outcome = result?.ok ? 'submitted' :
        (['not-submitted', 'rejected'].includes(result?.outcome) ? result.outcome : 'unknown');
      const kind = outcome === 'submitted' ? null : classifyPublishError({ ...result, outcome }).kind;
      if (declaration && result?.declarationVerification) {
        const check = result.declarationVerification;
        Object.assign(declaration, { state: check.state, actualId: check.actualId, checkedAt: check.checkedAt });
      }
      try { finishAttempt(store, attemptId, { outcome, kind, bvid: result?.bvid || null, declaration }); }
      catch {
        return { ok: false, outcome: 'unknown', reason: 'journal-write', steps: [],
          message: '投稿执行后回执记账失败。可能已经收稿，请人工核对，禁止重发。' };
      }
      return { ...result, ok: outcome === 'submitted', outcome };
    } catch (error) {
      if (started) return { ok: false, outcome: 'unknown', reason: 'transaction', steps: [],
        message: '投稿事务未完整结束，请人工核对稿件，禁止重发。' };
      return denied('投稿保护检查或记账失败，未继续提交：' + error.message, 'state');
    } finally {
      // A failed release must not be silently reported as a clean transaction.
      // Existing lock validation fails closed on the next attempt.
      if (lock) {
        try { if (!lock.release()) throw new Error('lock not released'); }
        catch { return { ok: false, outcome: 'unknown', reason: 'lock-release', steps: [],
          message: '投稿保护锁关闭失败，请保留状态目录并人工核对稿件；禁止自动重发。' }; }
      }
    }
  }
  return { preflight, execute, status };
}
