/* Bounded control request, never a model call or a shared-service shutdown.
 * Only this call's explicitly spawned helper group may be terminated. A CLI
 * exit code alone is not proof that the service interrupted its execution. */
import { spawn } from 'node:child_process';
import { stopRecordedChildren } from './process-lifecycle.mjs';

export function interruptSession(sessionId, { env = process.env, cwd, timeoutMs = 1500,
  graceMs = 100, killWaitMs = 500 } = {}) {
  if (typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId))
    return Promise.resolve({ ok: false, confirmed: false, reason: 'invalid-session' });
  if (![timeoutMs, graceMs, killWaitMs].every(n => Number.isFinite(n) && n >= 0) || timeoutMs === 0)
    return Promise.resolve({ ok: false, confirmed: false, reason: 'invalid-timeout' });
  return new Promise(resolve => {
    let child, timer, timedOut = false, settled = false, output = '';
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(value);
    };
    try {
      child = spawn(env.VH_OPENCODE_BIN || 'opencode', ['api', 'post', `/api/session/${sessionId}/interrupt`],
        { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    } catch { finish({ ok: false, confirmed: false, reason: 'spawn-failed' }); return; }
    child.stdout.on('data', chunk => { if (output.length < 65536) output += chunk.toString('utf8').slice(0, 65536 - output.length); });
    child.on('error', () => { if (!timedOut) finish({ ok: false, confirmed: false, reason: 'spawn-failed' }); });
    child.on('close', code => {
      if (timedOut) return;
      let data;
      try { data = JSON.parse(output); } catch {}
      const interrupted = data?.interrupted ?? data?.data?.interrupted;
      const confirmed = code === 0 && typeof interrupted === 'boolean';
      finish({ ok: code === 0, confirmed, interrupted: confirmed ? interrupted : null,
        reason: code !== 0 ? 'request-failed' : confirmed ? null : 'unconfirmed-response' });
    });
    timer = setTimeout(async () => {
      timedOut = true;
      try {
        const result = await stopRecordedChildren([{ pid: child.pid, group: true }], { graceMs, killWaitMs });
        finish({ ok: false, confirmed: false, reason: 'timeout', helperStopped: result.stopped });
      } catch { finish({ ok: false, confirmed: false, reason: 'timeout', helperStopped: false }); }
    }, timeoutMs);
  });
}
