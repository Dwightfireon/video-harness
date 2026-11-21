/* Workbench stills go through the same production lock, input checks and
 * receipt as `vh stills`. A process start is not a completed capture. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PRODUCTION_LOCK_TOKEN_ENV, PRODUCTION_LOCK_PROJECT_ENV } from './production-lock.mjs';

const CLI = fileURLToPath(new URL('../vh.mjs', import.meta.url));

export function createWorkbenchStillsService() {
  const observations = new Map();
  let active = null;
  const view = entry => ({ state: entry?.state || 'idle', ...(entry?.message ? { message: entry.message } : {}) });
  return {
    read(project) { return view(observations.get(project)); },
    start(project) {
      if (active) {
        if (active.project === project) return { ...view(active), busy: true };
        throw Object.assign(new Error('另一项目正在重截静帧，请稍后重试'), { statusCode: 409 });
      }
      const env = { ...process.env };
      // A UI-launched command is a new production, not a participant in a
      // capability the server may happen to have inherited from its parent.
      delete env[PRODUCTION_LOCK_TOKEN_ENV]; delete env[PRODUCTION_LOCK_PROJECT_ENV];
      const entry = { project, state: 'running', output: '' };
      const child = spawn(process.execPath, [CLI, 'stills', '--dir', project], {
        cwd: path.resolve(project), env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      active = entry;
      observations.delete(project); observations.set(project, entry);
      while (observations.size > 32) observations.delete(observations.keys().next().value);
      const collect = chunk => { entry.output = (entry.output + chunk.toString()).slice(-3000); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const finish = (ok, fallback) => {
        if (entry.state !== 'running') return;
        entry.state = ok ? 'completed' : 'failed';
        if (!ok) entry.message = entry.output.split('\n').map(line => line.trim()).filter(Boolean).at(-1)?.slice(0, 500) || fallback;
        delete entry.output;
        if (active === entry) active = null;
      };
      child.once('error', () => finish(false, '无法启动静帧命令'));
      child.once('close', (code, signal) => finish(code === 0 && !signal, signal ? '静帧命令被中断' : '静帧命令失败'));
      return view(entry);
    },
  };
}
