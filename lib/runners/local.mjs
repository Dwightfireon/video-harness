/* local runner：仓库自带的模型循环（lib/agent.mjs）。
 *
 * 保留它的理由不是怀旧：没有 opencode、或者 opencode 渠道全挂时，它是唯一的
 * 离线兜底。接口与 runners/opencode.mjs 一致，调用方不需要知道差别。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runAgent } from '../agent.mjs';
import { buildCandidates, readProviderInfo } from '../agent.mjs';

export async function ready(project) {
  const info = readProviderInfo();
  return info.length
    ? { ok: true, providers: info.map(item => item.provider) }
    : { ok: false, reason: '没有已配置的模型渠道（opendesign / commandcode / opencode-go）' };
}

export function createRunner(project, config = {}) {
  return {
    name: 'local',
    model: config.model || null,

    /* 本地循环的插话：写它自己的队列文件，下一轮读取。
     * 存储格式属于这条实现，调用方不碰。 */
    async steer({ message }) {
      const text = String(message || '').trim();
      if (!text) return { ok: false, via: 'local', reason: 'empty', message: '插话内容是空的' };
      const file = path.join(project, 'out/.vh-steer.json');
      let queue = [];
      try { queue = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (!Array.isArray(queue)) queue = [];
      queue.push({ id: randomUUID(), at: Date.now(), message: text, mode: 'edit' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(queue, null, 1));
      return { ok: true, via: 'local', delivery: 'queue', queued: true };
    },

    async run({ prompt, log = () => {}, signal, taskId, attemptId, resume = false, instruction = '',
      instructions = [], mode, automation, instructionKind, onStage = () => {} }) {
      const providers = buildCandidates();
      if (!providers.length) {
        return { ok: false, status: 'failed', answer: '', warns: [], sessionId: null,
          error: '没有已配置的模型渠道', kind: 'credentials' };
      }
      let currentStage = null;
      const out = await runAgent(project, prompt, {
        mode, log, signal, taskId, attemptId, automation, resume,
        instruction, instructions, instructionKind,
        onStage: stage => { if (stage !== currentStage) { currentStage = stage; onStage(stage); } },
      });
      return { ...out, sessionId: null };
    },
  };
}
