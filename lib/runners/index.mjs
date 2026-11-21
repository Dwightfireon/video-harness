/* runner 选择：决定「谁来写作者文件」。
 *
 * 目标是把执行器变成可替换的一层，而不是让调用方知道用的是哪个模型循环。
 *   - 契约：run() 返回 { ok, status, answer, error, warns }
 *   - 状态：两种 runner 都写同一份 out/.vh-task.json 与 out/.vh-chat.log，
 *           工作台、发布台、任务恢复都不需要知道是谁跑的。
 *
 * 现在有两实现：
 *   runners/local.mjs    仓库自带的模型循环（lib/agent.mjs），保留作离线兜底
 *   runners/opencode.mjs 交给 opencode 会话，带 websearch / 断点续跑
 *
 * 选择顺序：环境变量 VH_RUNNER → 项目 PROJECT.json.runner → 兼容默认。
 *
 * 默认 local 是为了兼容：已有工程与测试只配了显式渠道凭据，换成 opencode
 * 会改变它们实际访问的端点和行为。新工程由 `vh new` 写入 runner: opencode，
 * 需要时也可以用 `vh runner --set opencode` 显式切过来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveRunnerConfig, executionSnapshot, prepareExecution } from '../execution-config.mjs';

export { prepareExecution, executionSnapshot } from '../execution-config.mjs';

export const RUNNERS = Object.freeze({ opencode: 'opencode', local: 'local' });

export function runnerConfig(project, env = process.env, options = {}) {
  return resolveRunnerConfig(project, { ...options, env });
}

/* 优先级：环境变量 > 项目配置 > 默认。
 * 环境变量放最前是因为它是一次性覆盖（测试、临时试另一个执行器），
 * 不该被工程里持久化的选择盖掉。 */
export async function selectRunner(project, options = {}) {
  const config = resolveRunnerConfig(project, options);
  if (config.name === 'local') return (await import('./local.mjs')).createRunner(project, config);
  const prepared = prepareExecution(project, options);
  const runtimeConfig = { ...prepared.config, execution: prepared.snapshot };
  // 密钥不能挂在可序列化的公共 config；spawn 显式读取私有属性。
  Object.defineProperty(runtimeConfig, 'childEnv', { value: prepared.childEnv });
  Object.defineProperty(runtimeConfig, 'redactText', { value: prepared.redactText });
  return (await import('./opencode.mjs')).createRunner(project, Object.freeze(runtimeConfig));
}

/* 只检查 binary 能否执行。不调用模型，不代表连通、鉴权、额度或发布授权。
 * 正式派发仍须 prepareExecution()，并真正注入它的私有 env。 */
export async function runnerReady(project, options = {}) {
  let snapshot, config;
  try {
    config = resolveRunnerConfig(project, options);
    snapshot = executionSnapshot(project, options);
  } catch (error) {
    return { ok: false, check: 'configuration', reason: error.message, ...(error.snapshot ? { snapshot: error.snapshot } : {}) };
  }
  if (config.name === 'local') {
    const ready = await (await import('./local.mjs')).ready(project);
    return { ...ready, check: 'local-configuration-only', connectivity: 'not-checked', balance: 'not-checked', snapshot };
  }
  const env = options.env ?? process.env;
  return new Promise(resolve => {
    let output = '', settled = false, child, timer;
    const done = ok => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // stdout/stderr 可能夹带诊断及秘密，绝不原样暴露。
      const version = output.match(/\b(?:v)?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\b/)?.[0] || null;
      resolve({ ok, binaryReady: ok, check: 'binary-only', version: ok ? version : null,
        configurationReady: snapshot.configurationReady, connectivity: 'not-checked', balance: 'not-checked',
        snapshot, ...(ok ? {} : { reason: 'opencode 无法执行；请安装或检查 VH_OPENCODE_BIN' }) });
    };
    try {
      child = spawn(env.VH_OPENCODE_BIN || 'opencode', ['--version'], {
        env: { ...env, ...(options.home ? { HOME: options.home } : {}) }, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { done(false); return; }
    child.stdout.on('data', chunk => { if (output.length < 512) output += chunk.toString().slice(0, 512 - output.length); });
    child.on('error', () => done(false));
    child.on('close', code => done(code === 0));
    timer = setTimeout(() => { try { child.kill(); } catch {} done(false); }, 10000);
    timer.unref?.();
  });
}

/* 往正在跑的任务插一句话。
 *
 * 只做选择与转发，不碰任何执行器的存储：
 *   opencode → 直接投给正在跑的会话（steer 立即生效 / queue 排到轮次末）
 *   local    → 写它自己的插话队列，下一轮读取
 * 谁拥有哪种存储，由各自的 runner 决定；这一层不知道 out/.vh-runner.json、
 * 也不知道 out/.vh-steer.json 的存在。
 *
 * 返回 { ok, via, delivery } 或 { ok:false, reason, message }。 */
export async function steerRunningTask(project, { message, delivery = 'steer', env = process.env } = {}) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, reason: 'empty', message: '插话内容是空的' };
  if (!['steer', 'queue'].includes(delivery)) {
    return { ok: false, reason: 'bad-delivery', message: 'delivery 只能是 steer 或 queue' };
  }
  const runner = await selectRunner(project, { env });
  if (typeof runner.steer !== 'function') {
    return { ok: false, via: runner.name, reason: 'unsupported', message: runner.name + ' 执行器不支持运行中插话' };
  }
  return runner.steer({ message: text, delivery });
}

/* 正在运行但当前不能实时提交时，唯一安全的出路是把这条要求持久保存到原任务，
 * 等进程结束后由「继续原任务」交给下一次执行；不能写进没人读取的旧队列后假报成功。 */
export async function queueTaskInstruction(project, { message, taskId, attemptId, mode = 'edit' } = {}) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, reason: 'empty', message: '补充指令是空的' };
  if (typeof taskId !== 'string' || !taskId) return { ok: false, reason: 'no-task', message: '找不到当前任务，未保存补充指令' };
  const { readTask, updateTask } = await import('../task-status.mjs');
  const task = readTask(project);
  if (!task || task.id !== taskId || (attemptId && task.attemptId !== attemptId)) {
    return { ok: false, reason: 'task-changed', message: '任务身份已变化，未保存补充指令；请刷新核对后再发' };
  }
  const note = { id: globalThis.crypto?.randomUUID?.() || ('steer-' + Date.now() + '-' + Math.random().toString(16).slice(2)),
    content: text, at: Date.now(), source: 'chat-running-submit', mode };
  const next = updateTask(project, task.id, {
    resumeInstructions: [...(Array.isArray(task.resumeInstructions) ? task.resumeInstructions : []), note],
  }, task.attemptId);
  if (!next) return { ok: false, reason: 'task-changed', message: '任务身份已变化，未保存补充指令；请刷新核对后再发' };
  return { ok: true, reason: 'saved-for-resume', note, taskId: task.id, attemptId: task.attemptId };
}

/* 写入项目的 runner 选择。只改 PROJECT.json 的 runner 字段，保留其他配置。 */
export function configureRunner(project, patch = {}) {
  const file = path.join(project, 'PROJECT.json');
  const before = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(before);
  const current = typeof data.runner === 'object' && data.runner ? data.runner : {};
  const name = patch.name ?? current.name ?? 'opencode';
  if (!Object.hasOwn(RUNNERS, name)) throw new Error('runner 只能是 opencode 或 local');
  const runner = { ...current, name };
  for (const key of ['model', 'agent', 'service']) {
    if (patch[key]) runner[key] = patch[key];
  }
  const temp = file + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify({ ...data, runner }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (fs.readFileSync(file, 'utf8') !== before) throw new Error('保存 runner 时项目配置改变，未覆盖');
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return runnerConfig(project);
}
