/* opencode runner：把「谁写作者稿」交给 opencode 会话，而不是仓库自带的模型循环。
 *
 * 只做四件事：
 *   1. 起 `opencode run --format json` 子进程，把 NDJSON 事件流翻成给人看的日志
 *   2. 记住 session id，续跑用 `-s <id>` 接上原来的对话（这是换 runner 的主要理由）
 *   3. 把退出原因翻成本仓库既有的任务状态（completed / failed / cancelled）
 *   4. 结束前登记发布文案版本——opencode 用原生工具写文件，不经过受控写入钩子，
 *      不补这一步，文案会一直显示「尚未关联脚本版本」
 *
 * 不在这里做的：任务记录、锁、检查点、自动化修复预算。那些仍由 vh.mjs ask 管，
 * 所以换 runner 不需要动工作台、发布台和恢复逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createTaskContract, taskContractPrompt } from '../task-contract.mjs';
import { settleTaskResult } from '../task-completion.mjs';
import { settlePublishWrite, publishRevision } from '../publish.mjs';
import { pendingRunnerInstructions, instructionsPrompt } from '../runner-instructions.mjs';
import { atomicJSON } from '../checkpoint.mjs';
import { interruptSession } from '../opencode-interrupt.mjs';
import { stopRecordedChildren } from '../process-lifecycle.mjs';
import { captureAuthorEvidence, authorEvidenceStatus } from '../author-evidence.mjs';

const SESSION_FILE = 'out/.vh-runner.json';
const LOG_CHUNK_LIMIT = 400;

/* 从 shell 命令里认出当前走到哪个制作关口，只用于界面显示进度。 */
const STAGE_PATTERNS = [
  [/\bvh\.mjs\s+build\b/, 'build'],
  [/\bvh\.mjs\s+measure\b/, 'measure'],
  [/\bvh\.mjs\s+render\b/, 'render'],
  [/\bvh\.mjs\s+voice\b/, 'voice'],
  [/\bvh\.mjs\s+go\b/, 'render'],
  [/\bvh\.mjs\s+pack\b/, 'validate'],
  [/\bvh\.mjs\s+cover\b/, 'validate'],
];

export function stageFromCommand(command) {
  const text = String(command || '');
  for (const [pattern, stage] of STAGE_PATTERNS) if (pattern.test(text)) return stage;
  return null;
}

export function readSession(project) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(project, SESSION_FILE), 'utf8'));
    return data && typeof data.sessionId === 'string' ? data : null;
  } catch { return null; }
}

export function saveSession(project, patch) {
  const file = path.join(project, SESSION_FILE);
  const next = { ...(readSession(project) || {}), ...patch, updatedAt: Date.now() };
  atomicJSON(file, next);
  return next;
}

/* opencode 可执行文件：优先环境变量，其次 PATH。找不到就明确失败，不盲目重试。 */
export function opencodeBinary(env = process.env) {
  return env.VH_OPENCODE_BIN || 'opencode';
}

export async function ready(project, config = {}) {
  const bin = opencodeBinary();
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolve({ ok: false, reason: `找不到 opencode（${bin}）：安装后或设置 VH_OPENCODE_BIN` }); return; }
    let out = '';
    const done = ok => resolve(ok ? { ok: true, version: out.trim() } : { ok: false, reason: `opencode 无法执行（${bin}）` });
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => done(false));
    child.on('close', code => done(code === 0));
    setTimeout(() => { try { child.kill(); } catch {} done(false); }, 10000).unref?.();
  });
}

/* 把一条事件翻成日志行。返回 null 表示这条事件不需要显示。 */
export function describeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const part = event.part || {};
  const name = part.tool || event.tool || 'tool';
  if (event.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
    return part.text.trim().slice(0, LOG_CHUNK_LIMIT);
  }
  if (event.type === 'tool_use') {
    const state = part.state || {};
    if (state.status === 'error') return `✗ ${name} 被拒绝或失败：${String(state.output || '').slice(0, LOG_CHUNK_LIMIT)}`;
    if (state.status === 'running') return `· ${name} 执行中`;
    const outcome = toolOutcome(event);
    if (outcome === 'failed') return `✗ ${name} 返回失败退出状态：${String(state.output || '').slice(0, LOG_CHUNK_LIMIT)}`;
    if (outcome === 'uncertain') return `⚠ ${name} 输出含内部失败线索，不能凭外层退出码确认成功：${String(state.output || '').slice(0, LOG_CHUNK_LIMIT)}`;
    const output = String(state.output || '').replace(/\s+/g, ' ').trim();
    return `· ${name} 完成${output ? '：' + output.slice(0, LOG_CHUNK_LIMIT) : ''}`;
  }
  if (event.type === 'error') {
    const message = event.error?.message || '未知错误';
    return `✗ 模型调用失败：${message}`;
  }
  return null;
}

export function toolOutcome(event) {
  const state = event?.part?.state || {};
  const exit = state.metadata?.metadata?.exit ?? state.metadata?.exit;
  if (state.status === 'error' || (typeof exit === 'number' && exit !== 0)) return 'failed';
  // Output can quote an error, so this is uncertainty, NOT a semantic failure
  // verdict. Never use it as evidence that a failed operation recovered.
  if ((event?.part?.tool || event?.tool) === 'shell' && /^Traceback \(most recent call last\):/m.test(String(state.output || ''))) return 'uncertain';
  return state.status === 'completed' ? 'completed' : 'unknown';
}

/* 从一个错误事件里认出任务失败类别，尽量对齐既有 taskError 的词表。 */
export function classifyEventError(event) {
  const status = Number(event?.error?.status || 0);
  const raw = String(event?.error?.message || '');
  if (status === 402 || /insufficient|quota|额度|余额/i.test(raw)) return 'quota';
  if (status === 401 || status === 403 || /api key|unauthor|expired|认证|权限/i.test(raw)) return 'auth';
  if (status === 429 || /rate|限流/i.test(raw)) return 'rate';
  if (status === 408 || /timeout|超时/i.test(raw)) return 'timeout';
  // 连接被对端断开是网络问题，不是"执行异常"：用户看到"任务未完成"会不知道该查什么。
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|other side closed|network|连接|fetch failed/i.test(raw)) return 'network';
  return 'execution';
}

/* 这次运行是否"中途报错但后来恢复"。
 * 判定要有证据：最后一次错误之后，至少有一个工具成功执行，并且又输出了回答。
 * 顺序在事件流里是天然的：opencode 的 text 事件在一次回答结束时才出现。 */
export function recoveredAfterError(events) {
  let lastError = -1, completedTool = -1, answer = -1;
  events.forEach((event, index) => {
    if (event?.type === 'error') lastError = index;
    if (event?.type === 'tool_use' && toolOutcome(event) === 'completed') completedTool = index;
    if (event?.type === 'text' && typeof event.part?.text === 'string' && event.part.text.trim()) answer = index;
  });
  return lastError >= 0 && completedTool > lastError && answer > lastError;
}

/* 取消时除了杀进程组，还要通知 opencode 服务中断这个会话。
 * 不然它跑在服务里的工具（比如一个长时间的 shell）会继续活着，
 * 变成没人认领的孤儿进程。 */
export { interruptSession };

/* 往正在运行的 opencode 会话插一句话。
 *
 * delivery 语义（opencode 的接口定义，不是我们编的）：
 *   steer —— 尽快插入，正在跑的那一步之后立刻生效：适合"停手/改方向"
 *   queue —— 排到当前轮次结束后再生效：适合"再说一件事，但别打断现在"
 *
 * 用 `opencode api post` 而不是 fetch：它沿用同一套服务发现与鉴权，
 * 不需要在这里复制端口与凭据逻辑。
 */
export function steerSession({ sessionId, message, delivery = 'steer', env = process.env } = {}) {
  if (!sessionId) return Promise.resolve({ ok: false, reason: 'no-session' });
  const text = String(message || '').trim();
  if (!text) return Promise.resolve({ ok: false, reason: 'empty' });
  if (!['steer', 'queue'].includes(delivery)) return Promise.resolve({ ok: false, reason: 'bad-delivery' });
  return new Promise(resolve => {
    const child = spawn(opencodeBinary(env), ['api', 'post', `/api/session/${sessionId}/prompt`,
      '--data', JSON.stringify({ text, delivery })], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => resolve({ ok: false, reason: error.message }));
    child.on('close', code => {
      if (code !== 0) { resolve({ ok: false, reason: (err || out || 'opencode 退出 ' + code).slice(0, 300) }); return; }
      let data = null;
      try { data = JSON.parse(out); } catch {}
      resolve({ ok: true, messageId: data?.data?.id || null });
    });
  });
}

export function createRunner(project, config = {}) {
  const model = config.model || 'opendesign/deepseek-v4.1-flash';
  const agent = config.agent || 'vh-builder';
  const service = config.service || 'shared';
  const env = config.childEnv || process.env;
  const redact = config.redactText || (text => String(text ?? ''));
  let cancellationWork = Promise.resolve();

  return {
    name: 'opencode',
    model,
    execution: config.execution || { runner: 'opencode', model, service },

    // The outer CLI must not exit while its bounded interrupt helper is alive.
    async waitForCancellation() {
      let current;
      do { current = cancellationWork; await current; } while (current !== cancellationWork);
    },

    /* 运行中插话：交给执行器自己决定怎么送达。
     * 这里不碰 opencode 的会话文件、也不碰 local 的队列文件。 */
    async steer({ message, delivery = 'steer' }) {
      const text = String(message || '').trim();
      if (!text) return { ok: false, via: 'opencode', reason: 'empty', message: '插话内容是空的' };
      const session = readSession(project);
      if (!session?.sessionId) {
        return { ok: false, via: 'opencode', reason: 'no-session',
          message: 'opencode 会话还没建立（刚启动或已结束）。这条会作为新指令处理，不会插进进行中的一轮。' };
      }
      if (session.service === 'private' || service === 'private') return { ok: false, via: 'opencode', reason: 'private-session',
        message: '本轮为独立 OpenCode 服务，当前不能可靠地实时插话。输入未丢失；请先停止任务，再带补充要求继续原任务，不会伪报已送达。' };
      const result = await steerSession({ sessionId: session.sessionId, message: text, delivery, env });
      if (result.ok) return { ok: true, via: 'opencode', delivery, messageId: result.messageId };
      return { ok: false, via: 'opencode', reason: result.reason, message: '插话没有送达：' + result.reason };
    },

    /* 返回形状与 lib/agent.mjs 的 runAgent 对齐，调用方不必分两套。 */
    async run({ prompt, log = () => {}, signal, taskId, attemptId, resume = false, onStage = () => {},
      mode = 'edit', contract, instruction = '', instructions = [] }) {
      const previous = readSession(project);
      if (resume && fs.existsSync(path.join(project, SESSION_FILE)) && !previous) throw new Error('OpenCode 会话记录损坏，未静默新开会话；请先核对已有文件');
      const session = resume && (!previous?.taskId || previous.taskId === taskId) ? previous?.sessionId : undefined;
      if (session) log(`↻ 接上上次的 opencode 会话（${session}）`);
      else if (resume) log('↻ 没有可用的 opencode 会话，本轮从头开始（已有文件保留）');
      contract ||= createTaskContract(project, { mode, message: instruction || prompt });
      const includedInstructions = session ? previous?.includedInstructions || [] : [];
      const pending = pendingRunnerInstructions(instructions, includedInstructions);
      const legacyInstruction = resume && instruction && !instructions.some(note => note.content === instruction) ?
        '\n\n【本次继续要求】\n' + instruction : '';
      const requestPrompt = taskContractPrompt(contract) + '\n\n' + prompt + instructionsPrompt(pending) + legacyInstruction;

      /* 文案版本基线：opencode 用原生工具改文件，不经过本仓库的受控写入钩子，
       * 所以这里在开跑前记下源签名与文案哈希，收尾时再判断要不要登记版本。 */
      const publishBaseline = (() => {
        try { const current = publishRevision(project); return { sourceSignature: current.sourceSignature, publishHash: current.publishHash }; }
        catch { return null; }
      })();

      const argv = ['run', '--format', 'json', '--auto', '--agent', agent, '-m', model];
      if (service === 'private') argv.push('--standalone');
      if (session) argv.push('--session', session);
      argv.push(requestPrompt);

      const child = spawn(opencodeBinary(env), argv, {
        cwd: project,
        detached: true,          // 独立进程组：取消时能连同它的子进程一起收
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });

      const markerPath = path.join(project, 'out/.vh-run.json');
      try {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        fs.writeFileSync(markerPath, JSON.stringify({ ...marker, childPid: child.pid }, null, 1));
      } catch {}

      /* 变量必须在 onAbort 之前声明：signal 可能已经是 aborted 状态，
       * 那种情况下 onAbort 会在同一个 tick 里被调用，而它要读 sessionId。
       * 声明在下面会让 onAbort 撞上 TDZ（Cannot access 'sessionId' before initialization），
       * 结果是「停止」既没通知 opencode、也没杀掉子进程。 */
      let buffer = '', answer = '', sessionId = session || null, failure = null, steps = 0;
      let instructionsAccepted = false;
      /* 事件按到达顺序留一份，收尾时用来判断"报错之后是否又正常干活了"。 */
      const events = [];
      let authorEvidence = previous?.authorEvidence || null;
      const receipt = () => ({ sessionId, taskId, attemptId, model, agent, service,
        includedInstructions: [...new Set([...includedInstructions, ...(instructionsAccepted ? pending.map(note => note.key) : [])])] });
      const logs = [];
      const write = line => { line = redact(line); logs.push(line); log(line); };

      let abort = null;
      let childStop = null;
      const cancellationWarnings = [];
      const warnCancellation = text => { cancellationWarnings.push(text); write('⚠ ' + text); };
      const interrupts = new Map();
      const requestInterrupt = () => {
        if (!sessionId || service === 'private' || interrupts.has(sessionId)) return;
        const work = interruptSession(sessionId, { env, cwd: project }).then(result => {
          if (!result.confirmed) warnCancellation('OpenCode 会话中断未确认（' + result.reason + '）；本地进程回收不等于服务端会话已停止');
          return result;
        });
        interrupts.set(sessionId, work);
      };
      const onAbort = () => {
        abort = 'cancelled';
        /* 两件事都要做，顺序无关但缺一不可：
         *   1. 通知 opencode 服务中断这个会话——它跑在服务里，
         *      只杀子进程的话，服务中的工具与后续推理仍会继续；
         *   2. 杀子进程组——把 opencode run 及其派生的 CLI 一起收。
         * sessionId 可能是 resume 时已知的，也可能是刚启动还没收到事件，此时为空。 */
        requestInterrupt();
        childStop ||= child.pid ? stopRecordedChildren([{ pid: child.pid, group: true }]).then(result => {
          if (!result.stopped) warnCancellation('执行器子进程仍待退出，保留运行登记');
          return result;
        }) : Promise.resolve();
        cancellationWork = Promise.all([childStop, ...interrupts.values()]);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      const handle = line => {
        const text = line.trim();
        if (!text) return;
        let event;
        try { event = JSON.parse(text); } catch { return; }
        events.push(event);
        if (event.sessionID) {
          if (event.sessionID !== sessionId) {
            sessionId = event.sessionID;
            /* 会话 id 一出现就落盘，不等进程结束。
             * 否则任务运行期间「指挥」里的插话找不到会话，只能写进没人读的队列。 */
            saveSession(project, receipt());
            if (abort === 'cancelled') onAbort(); // Session id can arrive just after cancellation.
          }
        }
        if (sessionId && !instructionsAccepted && ['step_start', 'text', 'tool_use', 'step_finish'].includes(event.type)) {
          instructionsAccepted = true;
          saveSession(project, receipt());
        }
        if (event.type === 'step_start') steps++;
        const described = describeEvent(event);
        if (described) {
          if (event.type === 'text') answer = redact(event.part.text.trim());
          write(described);
        }
        if (event.type === 'tool_use') {
          const command = event.part?.state?.input?.command || event.part?.state?.input?.cmd || '';
          const toolState = event.part?.state;
          const target = String(toolState?.input?.path || toolState?.input?.filePath || '');
          if (toolOutcome(event) === 'completed' && (/(?:方案|脚本)\.md$/.test(target) || /(?:方案|脚本)\.md/.test(command))) {
            try {
              // Completed write events carry the submitted plan. Prefer that
              // snapshot: the child may already have rewritten the file before
              // the parent consumes the event stream. Shell/patch events have
              // no full snapshot, so they can only bind the observed disk file.
              const submittedPlan = /(?:^|[/\\])方案\.md$/.test(target) && typeof toolState.input?.content === 'string'
                ? toolState.input.content : undefined;
              const captured = captureAuthorEvidence(project, authorEvidence, submittedPlan === undefined ? {} : { plan: submittedPlan });
              if (JSON.stringify(captured) !== JSON.stringify(authorEvidence)) {
                authorEvidence = captured;
                saveSession(project, { authorEvidence });
                write('· 已绑定方案中的原文事实锚；仅保存证据身份，正文与结尾语义仍待核（可用 vh clarity 对照）');
              }
            } catch (error) { write('⚠ 原文锚未保存：' + error.message); }
          }
          const stage = stageFromCommand(command);
          if (stage) { onStage(stage); write(`  → 关口：${stage}`); }
        }
        if (event.type === 'error') { failure = { kind: classifyEventError(event), message: redact(event.error?.message || '未知错误') }; }
      };

      const onData = chunk => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) handle(line);
      };
      child.stdout.on('data', onData);
      // Buffer complete lines before redaction: pipe chunks can split a key,
      // and truncating raw text first can expose a prefix of that key.
      let stderrBuffer = '', stderrDiscarding = false;
      const writeStderr = text => { if (text.trim()) write('  ' + redact(text.trim()).slice(0, LOG_CHUNK_LIMIT)); };
      child.stderr.on('data', chunk => {
        stderrBuffer += chunk.toString('utf8');
        let at;
        while ((at = stderrBuffer.indexOf('\n')) !== -1) {
          const line = stderrBuffer.slice(0, at); stderrBuffer = stderrBuffer.slice(at + 1);
          if (!stderrDiscarding) writeStderr(line);
          stderrDiscarding = false;
        }
        if (stderrBuffer.length > 1024 * 1024) {
          stderrBuffer = ''; stderrDiscarding = true;
          write('  [过长的执行器错误行已省略，未输出未脱敏片段]');
        }
      });

      const exit = await new Promise(resolve => {
        child.on('error', error => resolve({ error }));
        child.on('close', (code, sig) => resolve({ code, sig }));
      });
      if (buffer.trim()) handle(buffer);
      if (!stderrDiscarding) writeStderr(stderrBuffer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      if (abort === 'cancelled') await cancellationWork;
      if (abort === 'cancelled' && service === 'shared' && !interrupts.size)
        warnCancellation('取消时未取得会话 ID，服务端会话停止状态未确认；未尝试中断其他会话');

      if (sessionId) saveSession(project, receipt());
      else if (!session) write('⚠ opencode 没有返回会话 id：下次续跑只能从头开始');
      // Advisory only: no automatic model review, retry, pass receipt, or production gate.
      if (authorEvidence) {
        const evidence = authorEvidenceStatus(project, { baseline: authorEvidence });
        for (const issue of evidence.integrityIssues) write('⚠ 原文事实锚完整性问题：' + issue);
        if (evidence.status === 'pending') write(`⚠ 原文事实锚：${evidence.pending.length} 项语义待核；来源表正确不能代替正文和结尾核对。`);
      }

      /* 文案版本：opencode 不经过受控写入钩子，这里补一次登记。
       * 只在本轮确实改了文案、脚本/要求未变、机械检查通过时才登记。
       * 这一步只看文案本身是否完整、是否对应当前稿，不用它判断任务成败。 */
      const cancelledNow = abort === 'cancelled' || signal?.aborted;
      if (!cancelledNow) {
        try {
          const settled = settlePublishWrite(project, { baseline: publishBaseline });
          if (settled.recorded) write('✓ 发布文案已关联当前脚本与文案（自动登记，不等于人工审阅）');
          else if (settled.reason === 'inputs-changed') write('⚠ 文案已修改，但脚本或本轮要求在运行期间变化，未自动关联；请核对后手动关联');
          else if (settled.reason === 'incomplete') write('· 发布文案尚未完整，未自动关联版本');
        } catch (error) { write('· 发布文案版本未登记：' + (error.message || error)); }
      }

      const cancelled = abort === 'cancelled' || signal?.aborted;
      if (cancelled) return { ok: false, status: 'cancelled', answer, error: null, warns: cancellationWarnings, sessionId };
      if (exit.error) return { ok: false, status: 'failed', answer, sessionId,
        error: `无法启动 opencode：${exit.error.message}`, warns: [] };

      /* 中途报错但之后恢复：真正的结论是"做完了"，不能因为一条错误事件就判任务失败。
       * 证据要求：错误之后有工具成功执行，并且又输出了回答。
       * 真实事故里进程最终退出码是 1（同一错误的余波），所以不能要求 exit.code === 0。 */
      if (failure && recoveredAfterError(events)) {
        /* 卡片上只放一句人话：具体错误原文已经写在日志里，塞进卡片反而更难读。 */
        const label = { network: '网络连接中断', timeout: '请求超时', rate: '请求限流', quota: '额度或余额不足', auth: '认证或权限问题' }[failure.kind] || '执行错误';
        const note = `运行中曾出现${label}，之后已恢复并继续，未影响最终结果；错误原文见日志`;
        write('· 运行中出现过错误但随后恢复：' + failure.message);
        const settled = settleTaskResult(project, { mode, contract }, { ok: true, status: 'completed', answer, sessionId,
          error: null, warns: [note], steps });
        return { ...settled, recoveredFrom: failure.kind };
      }
      if (failure) return { ok: false, status: 'failed', answer, sessionId,
        error: `${failure.message}（${failure.kind}）`, kind: failure.kind, warns: [] };
      if (exit.code !== 0) {
        /* 已交付但收尾异常：作者文件与交付物都核验完整时，不该显示成"制作失败"。
         * settleTaskResult 会按合同与交付物判断；这里只把退出码转成一句可读的原因。 */
        const settled = settleTaskResult(project, { mode, contract }, { ok: true, status: 'completed', answer, sessionId,
          error: null, warns: ['执行器收尾时以非零状态结束，但交付物已核验齐全；建议核对日志'], steps });
        if (settled.status === 'completed') return { ...settled, recoveredFrom: 'exit-code' };
        return { ok: false, status: 'failed', answer, sessionId,
          error: `opencode 异常退出（${exit.sig || '退出码 ' + exit.code}）`, warns: [] };
      }

      return settleTaskResult(project, { mode, contract }, { ok: true, status: 'completed', answer, sessionId, error: null,
        warns: [], steps });
    },
  };
}
