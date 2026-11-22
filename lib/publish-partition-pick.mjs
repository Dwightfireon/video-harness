/* 投稿分区 AI 推荐（低耦合独立模块）。
 *
 * 复用「模型设置」里的当前渠道与模型做单次无工具 HTTP 调用（不启动 opencode）。
 * 严格以当前账号实时分区清单为白名单，绝不编造编号或混用 human-type2 / legacy-tid。
 * 默认接受注入的 chat 函数，便于离线单测；未注入时才按 home 读取本机模型设置。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  HUMAN_PARTITION_TAXONOMY,
  HUMAN_COMPAT_TID,
  partitionLabel,
  validateSelection,
} from '../desk/partitions.mjs';

export function partitionSubmissionFields(item, catalog = {}) {
  const id = Number(item?.id) || 0;
  const human = catalog.taxonomy === HUMAN_PARTITION_TAXONOMY || catalog.human === true;
  return {
    partitionTaxonomy: catalog.taxonomy || (human ? HUMAN_PARTITION_TAXONOMY : 'legacy-tid'),
    tid: human ? (catalog.compatTid || HUMAN_COMPAT_TID) : id,
    humanType2: human ? id : 0,
  };
}

export function readScriptExcerpt(projectDir, maxChars = 600) {
  if (!projectDir) return '';
  let raw = '';
  try { raw = fs.readFileSync(path.join(projectDir, '脚本.md'), 'utf8'); }
  catch { return ''; }
  const lines = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^##\s*(?:术语|数字与来源)\b/.test(trimmed)) break;
    if (/^←\s*依赖/.test(trimmed)) continue;
    if (/^##\s*S\d+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) lines.push(trimmed);
    if (lines.join('\n').length >= maxChars) break;
  }
  return lines.join('\n').slice(0, maxChars).trim();
}

export function buildPartitionPrompt({ title = '', tags = '', desc = '', scriptExcerpt = '', catalog }) {
  const list = Array.isArray(catalog?.list) ? catalog.list : [];
  const human = catalog?.taxonomy === HUMAN_PARTITION_TAXONOMY || catalog?.human === true;
  const tagText = Array.isArray(tags) ? tags.filter(Boolean).join('、') : String(tags || '').trim();
  const catalogLines = list.map(item => {
    const label = item.parent ? `${item.parent} · ${item.name}` : item.name;
    const extra = item.description ? ` — ${item.description.slice(0, 80)}` : '';
    return `- id=${item.id} | ${label}${extra}`;
  }).join('\n');

  const system = [
    '你是 B 站视频投稿分区顾问。请根据视频的核心主题与目标观众，从给定的「当前账号可用分区清单」里选出 1 个最合适的推荐分区，以及 1–2 个合理的备选分区。',
    '',
    '【选区原则（必须遵守）】',
    '1. 只能从下方清单中选取真实存在的 id，严禁编造或猜测清单外编号。',
    '2. 避免「万物皆 AI」偏置：不要只因为标题或正文提到 ChatGPT / AI / 大模型 / 某款软件，就一律选「人工智能」或「计算机技术」。',
    '   - 若核心讲的是职场、商业模式、成本核算、消费或行业经济，优先考虑财经商业/知识/生活等对应垂类；',
    '   - 若核心讲的是软件实操教程、效率工具用法，优先考虑软件应用/科技数码/知识；',
    '   - 若核心讲的是自然科学、心理、历史、方法论等通用科普，优先考虑科学科普/知识；',
    '   - 只有核心主体本身是 AI 原理、大模型机制、Agent 开发或 AI 技术前沿解读时，才优先选「人工智能」或「计算机技术」。',
    '3. 不按制作工具选区：用 AI 配音/剪辑做的科普或杂谈，不要选「AI影像」或「AI音乐」。',
    '4. 每条理由控制在 15–35 个中文字，直白说明为什么更贴合目标观众。',
    '',
    '【输出格式】直接输出一个合法 JSON 对象，无需冗长分析过程或额外解释文字：',
    '{"primaryId": 1010, "reason": "一句话说明主推荐理由", "alternatives": [{"id": 1011, "reason": "一句话说明备选理由"}]}',
  ].join('\n');

  const userParts = [
    `当前分区模式：${human ? '新版分区（human-type2）' : '旧版分区（legacy-tid）'}`,
    '',
    '【待投稿视频信息】',
    `标题：${String(title || '').trim() || '（未填）'}`,
    `标签：${tagText || '（未填）'}`,
    `简介：${String(desc || '').trim().slice(0, 800) || '（未填）'}`,
  ];
  if (String(scriptExcerpt || '').trim()) {
    userParts.push(`脚本节选：${String(scriptExcerpt).trim().slice(0, 600)}`);
  }
  userParts.push('', '【当前账号可用分区清单】', catalogLines);

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') },
  ];
}

function extractJSON(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('模型返回为空，未能推荐分区');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try { return JSON.parse(candidate); } catch {}
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch {}
  }
  throw new Error('模型未返回合法 JSON，未能解析推荐分区');
}

export function parsePartitionRecommendation(rawText, catalog) {
  const list = Array.isArray(catalog?.list) ? catalog.list : [];
  if (!list.length) throw new Error('当前没有可用的分区清单，请先刷新分区');
  const byId = new Map(list.map(item => [Number(item.id), item]));
  const parsed = extractJSON(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型返回的推荐格式无效');
  }
  const primaryId = Number(parsed.primaryId ?? parsed.id);
  const primaryItem = byId.get(primaryId);
  if (!primaryItem) {
    throw new Error(`模型推荐的分区编号（${parsed.primaryId ?? '空'}）不在当前账号可用列表中`);
  }

  const formatEntry = (item, reason) => ({
    id: Number(item.id),
    name: item.name,
    parent: item.parent || '',
    label: partitionLabel(item),
    reason: String(reason || '').trim().slice(0, 120) || '与视频核心主题和目标受众更匹配',
    partition: partitionSubmissionFields(item, catalog),
  });

  const primary = formatEntry(primaryItem, parsed.reason);
  const seen = new Set([primary.id]);
  const alternatives = [];
  for (const alt of Array.isArray(parsed.alternatives) ? parsed.alternatives : []) {
    const id = Number(alt?.id);
    const item = byId.get(id);
    if (!item || seen.has(id)) continue;
    seen.add(id);
    alternatives.push(formatEntry(item, alt?.reason));
    if (alternatives.length >= 2) break;
  }

  return {
    primary,
    alternatives,
    taxonomy: catalog.taxonomy || (catalog.human ? HUMAN_PARTITION_TAXONOMY : 'legacy-tid'),
    human: catalog.taxonomy === HUMAN_PARTITION_TAXONOMY || catalog.human === true,
    live: catalog.live !== false,
  };
}

function readOpencodeAuth(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, '.local', 'share', 'opencode', 'auth.json'), 'utf8')); }
  catch { return {}; }
}

function readOpencodeProviders(home) {
  const file = path.join(home, '.config', 'opencode', 'opencode.jsonc');
  const out = [];
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
    const d = JSON.parse(raw);
    for (const [name, cfg] of Object.entries(d.provider || {})) {
      out.push({ name, base: cfg.options?.baseURL, models: Object.keys(cfg.models || {}) });
    }
  } catch {}
  return out;
}

function extractReplyText(resp) {
  const choice = resp?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = typeof msg.content === 'string' ? msg.content.trim() : '';
  if (content) return content;
  for (const key of ['reasoning_content', 'reasoning']) {
    const val = typeof msg[key] === 'string' ? msg[key].trim() : '';
    if (val && val.includes('{') && val.includes('primaryId')) return val;
  }
  return '';
}

async function directHttpChat(messages, { home = process.env.HOME || '', signal, timeoutMs = 25000, fetchImpl = globalThis.fetch } = {}) {
  const [{ buildCandidates, pickProvider }, { readSettings }, { readHarnessCredentials }] = await Promise.all([
    import('./agent.mjs'),
    import('./provider-settings.mjs'),
    import('./harness-credentials.mjs'),
  ]);
  const settings = readSettings(home);
  const env = { ...process.env, HOME: home };
  const candidates = buildCandidates({
    providers: readOpencodeProviders(home),
    auth: readOpencodeAuth(home),
    env,
    credentials: home ? readHarnessCredentials(home) : {},
    settings,
    home,
  });
  if (!candidates.length) return null;
  const prov = await pickProvider(null, candidates, undefined, settings);
  if (!prov?.base || !prov?.key || !prov?.model) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const res = await fetchImpl(prov.base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      signal: combined,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + prov.key, ...(prov.headers || {}) },
      body: JSON.stringify({ model: prov.model, messages, temperature: 0.2, max_tokens: 2048, stream: false }),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = JSON.parse(raw);
    if (data?.error) throw new Error(data.error.message || '接口返回错误');
    const text = extractReplyText(data);
    return text ? { text, provider: prov.name, model: prov.model } : null;
  } finally {
    clearTimeout(timer);
  }
}

async function opencodePartitionChat(messages, { home = process.env.HOME || '', signal, timeoutMs = 45000 } = {}) {
  const [{ spawn }, { randomUUID }, { currentSelection, parseConfigJSON }] = await Promise.all([
    import('node:child_process'),
    import('node:crypto'),
    import('./provider-settings.mjs'),
  ]);
  const selection = currentSelection(home);
  const model = `${selection.provider}/${selection.model}`;
  const agentName = 'vh-partition-' + randomUUID();
  let document = {};
  try { document = process.env.OPENCODE_CONFIG_CONTENT ? parseConfigJSON(process.env.OPENCODE_CONFIG_CONTENT) : {}; } catch {}
  if (!document || typeof document !== 'object' || Array.isArray(document)) document = {};
  document = {
    ...document,
    agents: {
      ...document.agents,
      [agentName]: {
        mode: 'primary',
        description: '一次性无工具的投稿分区推荐',
        system: '只根据给定的视频信息和分区清单直接输出合法 JSON，不调用任何工具。',
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
        steps: 2,
      },
    },
  };
  const prompt = messages.map(m => m.content).join('\n\n');
  const argv = ['run', '--format', 'json', '--auto', '--agent', agentName, '--standalone', '-m', model, prompt];
  const childEnv = { ...process.env, HOME: home, OPENCODE_CONFIG_CONTENT: JSON.stringify(document) };

  return new Promise((resolve, reject) => {
    const child = spawn(process.env.VH_OPENCODE_BIN || 'opencode', argv, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '', err = '', done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} } };
    const onAbort = () => { kill(); finish(new Error('分区推荐已取消')); };
    const timer = setTimeout(() => { kill(); finish(new Error('分区推荐超时')); }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => { out += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { err += chunk.toString('utf8'); });
    child.on('error', error => finish(new Error('无法启动 opencode：' + error.message)));
    child.on('close', code => {
      const texts = [];
      let errMsg = '';
      for (const line of out.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const ev = JSON.parse(s);
          if (ev?.type === 'text' && typeof ev.part?.text === 'string' && ev.part.text.trim()) texts.push(ev.part.text.trim());
          if (ev?.type === 'error' && ev.error?.message) errMsg = ev.error.message;
        } catch {}
      }
      const text = [...texts].reverse().find(t => t.includes('{') && t.includes('primaryId')) || texts.at(-1) || '';
      if (text) return finish(null, { text, provider: selection.provider, model: selection.model });
      finish(new Error(errMsg || (code !== 0 ? `opencode 退出 ${code}` : '模型返回为空，未能推荐分区')));
    });
  });
}

async function defaultModelChat(messages, { home = process.env.HOME || '', signal, timeoutMs = 45000 } = {}) {
  let directError = null;
  try {
    const direct = await directHttpChat(messages, { home, signal, timeoutMs: Math.min(timeoutMs, 25000) });
    if (direct?.text) return direct;
  } catch (error) {
    directError = error;
  }
  try {
    return await opencodePartitionChat(messages, { home, signal, timeoutMs });
  } catch (fallbackError) {
    throw new Error(fallbackError.message || directError?.message || '模型返回为空，未能推荐分区');
  }
}

export async function recommendPartition({
  title = '',
  tags = '',
  desc = '',
  scriptExcerpt = '',
  catalog,
  chat,
  home = process.env.HOME || '',
  signal,
  timeoutMs = 30000,
} = {}) {
  if (!catalog?.list?.length) {
    throw new Error('当前没有可用的投稿分区清单，请先刷新分区');
  }
  const hasContent = Boolean(
    String(title || '').trim() ||
    String(desc || '').trim() ||
    (Array.isArray(tags) ? tags.filter(Boolean).length : String(tags || '').trim()) ||
    String(scriptExcerpt || '').trim()
  );
  if (!hasContent) {
    throw new Error('请先填写标题、标签或简介，再让模型推荐分区');
  }

  const messages = buildPartitionPrompt({ title, tags, desc, scriptExcerpt, catalog });
  const runner = chat || ((msgs, opts) => defaultModelChat(msgs, { home, ...opts }));
  const reply = await runner(messages, { signal, timeoutMs });
  const choice = typeof reply === 'object' ? (reply?.choices?.[0] || null) : null;
  const rawContent = typeof reply === 'string' ? reply : (reply?.text ?? choice?.message?.content ?? '');
  const trimmed = String(rawContent || '').trim();
  const reasoning = typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content.trim() : '';
  const text = trimmed || (reasoning.includes('{') && reasoning.includes('primaryId') ? reasoning : '');
  const result = parsePartitionRecommendation(text, catalog);
  return {
    ...result,
    provider: typeof reply === 'object' ? (reply?.provider || '') : '',
    model: typeof reply === 'object' ? (reply?.model || '') : '',
  };
}

export async function resolveAutoPublishPartition({ draft, defaultPartition, catalog, recommend } = {}) {
  const saved = draft?.savedForm?.partition || null;
  if (saved) {
    if (!catalog?.live || validateSelection(saved, catalog).length === 0) {
      return saved;
    }
  }
  if (typeof recommend === 'function' && catalog?.live) {
    try {
      const picked = await recommend();
      const candidate = picked?.primary?.partition || null;
      if (candidate && validateSelection(candidate, catalog).length === 0) {
        return candidate;
      }
    } catch {
      /* 推荐失败不阻断自动发布，回退到排程默认分区。 */
    }
  }
  return defaultPartition;
}
