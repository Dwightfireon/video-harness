/* 模型渠道与凭证的本机设置。
 *
 * 目标：用户能在工作台里自己挑 provider 与模型，不用每次口头交代。
 *
 * 安全边界：
 * - 密钥只写入本机私有文件（权限 600），不进入项目目录、不进入日志、不回显。
 * - 只读回"是否已配置 / 来自哪里 / 什么时候换的"，绝不返回密钥本身。
 * - 渠道之间不自动切换：这里只决定"用哪个"，失败后的行为仍由 provider-pool 决定。
 * - 默认仍是 opendesign；没有显式选择时不改变既有行为。
 *
 * 密钥优先级只有一处（keyFromChain），页面展示、agent 请求、命令行都必须复用它。
 * 曾经页面保存了新 key 却仍用旧 key：因为 agent 自己拼了一套顺序，两处会分叉。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CATALOGS, readCatalog } from './opencode-catalog.mjs';

const VH_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const HOME = process.env.HOME || os.homedir();

/* 已知的渠道名 → 展示名。只有这些名字会出现在选择器里。 */
export const PROVIDER_LABELS = Object.freeze({
  opendesign: 'OpenDesign',
  commandcode: 'CommandCode',
  '9router': '9Router（本机路由）',
  'opencode-go': 'OpenCode Go',
  opencode: 'OpenCode Zen',
});

/* 每个渠道的默认请求模型别名。用户在设置页选了别的模型就用别的。 */
export const DEFAULT_MODELS = Object.freeze({
  opendesign: 'deepseek-v4.1-flash',
  commandcode: 'deepseek/deepseek-v4.1-flash',
  '9router': 'cmc/deepseek/deepseek-v4-flash',
  'opencode-go': 'minimax-m3.1-flash-free',
});

/* OpenCode Go 是 opencode 内置渠道，模型清单与端点由官方目录给出。 */
export const OPENCODE_GO_BASE = 'https://opencode.ai/inference/go/openai/v1';
// 与旧 local agent 的既有默认端点一致；不猜测其他自定义渠道地址。
export const DEFAULT_BASES = Object.freeze({ opendesign: 'https://amr-link.open-design.ai/v1' });

/* 本机私有配置（项目外）。存 provider 选择、模型选择与各渠道密钥。 */
export function settingsPath(home = HOME) {
  if (!home || !path.isAbsolute(home)) throw new Error('无法确定本机配置目录');
  return path.join(home, '.config', 'video-harness', 'providers.json');
}

const emptySettings = () => ({ preferredProvider: null, models: {}, bases: {}, keys: {}, keyHints: {} });

export function readSettings(home = HOME) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return emptySettings();
    // JSON.parse 的错误可能含原文（包括 key），只给固定消息。
    throw new Error('本机模型设置损坏或无法读取；请修复 providers.json，不会自动换渠道');
  }
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!record(data) || (data.preferredProvider != null && typeof data.preferredProvider !== 'string') ||
      ['models', 'bases', 'keys', 'keyHints'].some(key => data[key] != null && !record(data[key])) ||
      ['models', 'bases', 'keys'].some(key => Object.values(data[key] || {}).some(value => typeof value !== 'string'))) {
    throw new Error('本机模型设置格式无效；不会自动换渠道');
  }
  return {
    preferredProvider: typeof data.preferredProvider === 'string' && data.preferredProvider ? data.preferredProvider : null,
    models: data.models && typeof data.models === 'object' ? data.models : {},
    bases: data.bases && typeof data.bases === 'object' ? data.bases : {},
    keys: data.keys && typeof data.keys === 'object' ? data.keys : {},
    keyHints: data.keyHints && typeof data.keyHints === 'object' ? data.keyHints : {},
  };
}

/* 渠道的最终 base：设置页里填的地址优先，其次是本机 opencode 配置。 */
export function providerBase(name, home = HOME) {
  const custom = readSettings(home).bases?.[name];
  if (custom) return String(custom);
  return readKnownProviders(home).find(p => p.name === name)?.base || DEFAULT_BASES[name] || null;
}

export function setProviderBase(name, base, home = HOME) {
  const providers = listProviders(home);
  if (!providers.some(p => p.name === name)) throw new Error('未知渠道：' + name);
  const value = String(base || '').trim();
  if (value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('地址格式不对，需要是完整 URL'); }
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('地址只支持 http/https');
  }
  const settings = readSettings(home);
  settings.bases = settings.bases || {};
  if (value) settings.bases[name] = value;
  else delete settings.bases[name];
  writeSettings(settings, home);
  return providerBase(name, home);
}

export function writeSettings(next, home = HOME) {
  const target = settingsPath(home);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(target), '.' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, target);
  } finally { try { fs.unlinkSync(temp); } catch {} }
  try { fs.chmodSync(target, 0o600); } catch {}
  return target;
}

/* 从 opencode 的本机配置里读出各渠道的 base 与可用模型（不读密钥）。 */
export function readKnownProviders(home = HOME) {
  const out = new Map();
  for (const suffix of ['json', 'jsonc']) {
    const file = path.join(home, '.config', 'opencode', 'opencode.' + suffix);
    let d;
    try { d = parseConfigJSON(fs.readFileSync(file, 'utf8')); }
    catch { continue; }
    // V2 原生形状与迁移文档明确支持的旧形状。原生同名项优先。
    for (const [name, cfg] of Object.entries({ ...d.provider, ...d.providers })) {
      out.set(name, { name, base: cfg.settings?.baseURL || cfg.options?.baseURL || cfg.api || null,
        models: Object.keys(cfg.models || {}) });
    }
  }
  return [...out.values()];
}

/* 只移除字符串外的注释和尾逗号；不破坏 URL 或字符串中的 //、,}。 */
export function parseConfigJSON(text) {
  let out = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (quoted) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; out += c; }
    else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i >= text.length) throw new Error('Invalid JSONC');
      i++; out += ' ';
    } else out += c;
  }
  let cleaned = ''; quoted = false; escaped = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (!quoted && c === ',' && /^[\s]*[}\]]/.test(out.slice(i + 1))) continue;
    cleaned += c;
    if (quoted && escaped) escaped = false;
    else if (quoted && c === '\\') escaped = true;
    else if (c === '"') quoted = !quoted;
  }
  return JSON.parse(cleaned);
}

/* 现有 opencode 凭证里已配置的渠道（只判断有没有，不取内容）。 */
function readOpencodeAuth(home = HOME) {
  try { return JSON.parse(fs.readFileSync(path.join(home, '.local', 'share', 'opencode', 'auth.json'), 'utf8')); }
  catch { return {}; }
}

/* opencode 桌面版把有效凭证放在自己的 SQLite 库里（auth.json 里那份可能已过期）。
 * 只读，取当前 active 的那一条；拿不到就返回 null，不猜。
 * 用 createRequire 保持同步：渠道密钥要在同步的 listProviders/providerKey 里取。 */
let sqliteSync;
function loadSqliteSync() {
  if (sqliteSync !== undefined) return sqliteSync;
  try {
    // node:sqlite 是实验特性，会往 stderr 打 ExperimentalWarning。
    // 制作 agent 的 stderr 就是项目聊天日志，不抑制的话会污染日志内容。
    const prev = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
      const name = typeof rest[0] === 'string' ? rest[0] : rest[0]?.name;
      if (name === 'ExperimentalWarning') return;
      return prev.call(process, warning, ...rest);
    };
    try { sqliteSync = createRequire(import.meta.url)('node:sqlite'); }
    finally { process.emitWarning = prev; }
  } catch { sqliteSync = null; }
  return sqliteSync;
}

export function readOpencodeDbCredential(integrationId, home = HOME) {
  const dbPath = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  try {
    if (!fs.existsSync(dbPath)) return null;
    const mod = loadSqliteSync();
    if (!mod?.DatabaseSync) return null;
    const db = new mod.DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("select value from credential where integration_id = ? and active = 1 order by time_created desc limit 1").get(integrationId);
      if (!row?.value) return null;
      const parsed = JSON.parse(row.value);
      return parsed.key || parsed.apiKey || null;
    } finally { db.close(); }
  } catch { return null; }
}

/* 从 opencode 本机已抓取的 models.dev 目录里取出某个模型的原生定义（只读）。
 *
 * 桌面版/后台服务会把最新目录写进 opencode.db 的 kv（models-dev:v3:catalog，
 * 兼容 v2），而 --standalone 启动的独立私有 server 只带打包时的模型目录。
 * 新上线的模型（例如 opencode-go/hy4-flash-free）因此在私有 server 里被误判为
 * "Model unavailable"，即使本机登录态与模型目录都是好的。
 * 这里复用凭证那套 sqlite 同步加载，不写库、不缓存，读不到就返回 null，
 * 由调用方决定是否用最小兜底定义。 */
export function readOpencodeModelDefinition(providerID, modelID, home = HOME) {
  const dbPath = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  try {
    if (!fs.existsSync(dbPath)) return null;
    const mod = loadSqliteSync();
    if (!mod?.DatabaseSync) return null;
    const db = new mod.DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const key of ['models-dev:v3:catalog', 'models-dev:v2:catalog']) {
        const row = db.prepare('select value from kv where key=?').get(key);
        if (!row?.value) continue;
        const raw = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8');
        const parsed = JSON.parse(raw);
        const body = typeof parsed.body === 'string' ? JSON.parse(parsed.body) : parsed.body || parsed;
        const definition = body?.[providerID]?.models?.[modelID];
        if (definition && typeof definition === 'object' && !Array.isArray(definition)) return definition;
      }
    } finally { db.close(); }
  } catch { /* 读不到不视为配置失败：调用方有最小兜底定义 */ }
  return null;
}

function readHarnessCredentialsFile(home = HOME) {
  try { return JSON.parse(fs.readFileSync(path.join(home, '.config', 'video-harness', 'credentials.json'), 'utf8')); }
  catch { return {}; }
}

/* 项目自带的旧配置（vh.config.json）。只作为最低优先级的兜底来源。 */
export function readHarnessConfigFile() {
  try { return JSON.parse(fs.readFileSync(path.join(VH_DIR, 'vh.config.json'), 'utf8')); }
  catch { return {}; }
}

/* ------------------------------------------------------------------ */
/* 密钥来源链：整个 harness 只有这一处定义优先级                          */
/* ------------------------------------------------------------------ */
/* 顺序（高 → 低）：
 *   设置页 → 环境变量 → harness 凭证文件 → vh.config.json → opencode 凭证库 → opencode 旧凭证
 *
 * 设置页排第一是刻意的：用户在页面里明确填了新 key，就必须真的生效。
 * 旧实现里 agent 自己拼了另一套顺序（环境变量最优先），于是页面保存后仍然用旧 key，
 * 界面却显示"已保存"——这类"说了做了其实没做"的分叉必须从根上去掉。
 *
 * 入参全部可注入：测试要能固定来源，不能读使用者的真实配置。 */
export function keySourceChain(name, sources = {}, home = HOME) {
  for (const [source, value] of keySteps(name, sources, home)) {
    const key = typeof value === 'string' ? value.trim() : '';
    if (key) return { key, source };
  }
  return { key: '', source: null };
}

/* env 显式传 {} 表示"没有环境变量"，不会回落到 process.env——
 * 否则测试结果会随使用者的 shell 变化。 */
function keySteps(name, sources = {}, home = HOME) {
  const s = sources.settings === undefined ? readSettings(home) : sources.settings;
  const c = sources.credentials === undefined ? readHarnessCredentialsFile(home) : sources.credentials;
  const cfg = sources.config === undefined ? readHarnessConfigFile() : sources.config;
  const a = sources.auth === undefined ? readOpencodeAuth(home) : sources.auth;
  const env = sources.env === undefined ? process.env : sources.env;
  return [
    ['本机设置页', s?.keys?.[name]],
    ...(name === 'opencode' ? [['环境变量', env?.OPENCODE_API_KEY]] : []),
    ...(name === 'opendesign' ? [
      ['环境变量', env?.OPEN_DESIGN_API_KEY],
      ['harness 凭证文件', c?.opendesignKey],
      ['vh.config.json', cfg?.opendesignKey],
    ] : []),
    ['opencode 凭证库', sources.dbKey === undefined ? readOpencodeDbCredential(name, home) : sources.dbKey],
    ['opencode 凭证', a?.[name]?.key],
  ];
}

/* 密钥指纹：用于"换成功了没"的确认，不可逆、不可还原。
 * 只给 8 位十六进制，既不回显 key，也不泄露长度以外的信息。 */
export function keyFingerprint(key) {
  const value = typeof key === 'string' ? key.trim() : '';
  if (!value) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/* 逐一列出所有有 key 的来源，标出哪一个真正生效。
 * 用途：用户可能在不同地方填过 key（页面、命令行、环境变量），
 * 界面必须能说清"现在用的是哪一把、还有哪几把被压在下面"，
 * 否则用户换了 key 却看到旧行为时无从下手。 */
export function keySourcesAudit(name, sources = {}, home = HOME) {
  const seen = [];
  for (const [source, value] of keySteps(name, sources, home)) {
    const key = typeof value === 'string' ? value.trim() : '';
    if (key) seen.push({ source, keyFingerprint: keyFingerprint(key), active: seen.length === 0 });
  }
  return seen;
}

/* 密钥来自哪里：让界面能说清"已配置"是哪来的，而不是笼统一句。 */
export function keySource(name, home = HOME) {
  return keySourceChain(name, {}, home).source;
}

/* 某渠道当前是否已具备可用凭证。 */
export function providerHasKey(name, home = HOME) {
  return !!keySource(name, home);
}

/* 取某渠道实际使用的密钥；供 agent 使用，不对外暴露。 */
export function providerKey(name, home = HOME) {
  return keySourceChain(name, {}, home).key;
}

/* 列出所有可选渠道：名称、展示名、base、可用模型、是否已配凭证、当前是否选中。 */
export function listProviders(home = HOME) {
  const settings = readSettings(home);
  const known = readKnownProviders(home);
  const names = [...new Set([...Object.keys(PROVIDER_LABELS), ...known.map(p => p.name)])];
  return names.map(name => {
    const info = known.find(p => p.name === name);
    const current = settings.models?.[name] || DEFAULT_MODELS[name] || null;
    const catalog = Object.hasOwn(CATALOGS, name) ? readCatalog(home, name) : null;
    const available = [...new Set([...(catalog?.models.map(m => m.id) || []), ...(info?.models || [])])];
    // 当前模型放首位：前端 <select> 在没有匹配项时会静默选中第一项，
    // 若当前模型不在列表里，页面会把它悄悄换成别的模型。
    const models = [...new Set([current, ...available, !catalog?.at && DEFAULT_MODELS[name]].filter(Boolean))];
    const from = keySourceChain(name, { settings }, home);
    return {
      name,
      label: PROVIDER_LABELS[name] || name,
      base: settings.bases?.[name] || (name === 'opencode-go' ? OPENCODE_GO_BASE : info?.base) || DEFAULT_BASES[name] || null,
      models,
      freeModels: catalog?.models.filter(m => m.free).map(m => m.id) || [],
      catalog: catalog ? { at: catalog.at, stale: catalog.stale, currentMissing: !!(catalog.at && current && !available.includes(current)) } : null,
      hasKey: !!from.key,
      keySource: from.source,
      // 指纹与更换时间是给用户"确认换对了"用的；换 key 时必须能核对，
      // 否则页面除了"已保存"没有任何可验证的信号。
      keyFingerprint: keyFingerprint(from.key),
      keyUpdatedAt: settings.keyHints?.[name]?.updatedAt || null,
      selected: settings.preferredProvider === name,
      model: current,
    };
  });
}

/* 选择渠道与模型。provider 必须在已知清单内；模型必须属于该渠道。 */
export function setSelection({ provider, model }, home = HOME) {
  const providers = listProviders(home);
  const target = providers.find(p => p.name === provider);
  if (!target) throw new Error('未知渠道：' + provider);
  if (model != null && model !== '') {
    if (!target.models.includes(model)) throw new Error('该渠道没有这个模型：' + model);
    if (target.catalog?.currentMissing && model === target.model) throw new Error('当前模型已不在目录，请选其他模型');
  }
  if (target.catalog && !model) throw new Error('请明确选择一个模型');
  const settings = readSettings(home);
  settings.preferredProvider = target.name;
  if (model) settings.models[target.name] = model;
  writeSettings(settings, home);
  return { provider: target.name, model: settings.models[target.name] || target.model };
}

/* 一次性把现有渠道预先保存好：把 opencode 里已配置的 base 与默认模型写进设置文件，
 * 密钥仍留在它原来的位置（不复制到新文件），但选择与模型会固化下来。 */
export function seedExisting(home = HOME) {
  const settings = readSettings(home);
  if (!settings.preferredProvider) settings.preferredProvider = 'opendesign';
  for (const p of readKnownProviders(home)) {
    if (settings.models[p.name]) continue;
    const available = p.models || [];
    const preferred = DEFAULT_MODELS[p.name];
    // 优先用该渠道的默认别名；只有它确实在这个渠道的模型清单里才用。
    if (preferred && available.includes(preferred)) settings.models[p.name] = preferred;
    else if (available.length) settings.models[p.name] = available[0];
    else if (preferred) settings.models[p.name] = preferred;
  }
  writeSettings(settings, home);
  return settings;
}

/* 保存某渠道的密钥。空值表示不改；显式 clear 表示删除。
 * 返回值带上来源与指纹，页面据此给出可核对的"换成了哪一把"。 */
export function setProviderKey(name, key, { clear = false } = {}, home = HOME) {
  const providers = listProviders(home);
  if (!providers.some(p => p.name === name)) throw new Error('未知渠道：' + name);
  const settings = readSettings(home);
  settings.keys = settings.keys || {};
  settings.keyHints = settings.keyHints || {};
  if (clear) {
    delete settings.keys[name];
    delete settings.keyHints[name];
  } else {
    const value = String(key || '').trim();
    if (!value) throw new Error('密钥为空');
    if (/\s/.test(value)) throw new Error('密钥含空白，请只粘贴 API key');
    if (value.length > 400) throw new Error('密钥长度异常');
    settings.keys[name] = value;
    settings.keyHints[name] = { updatedAt: new Date().toISOString(), fingerprint: keyFingerprint(value) };
  }
  writeSettings(settings, home);
  const from = keySourceChain(name, { settings: readSettings(home) }, home);
  return { hasKey: !!from.key, keySource: from.source, keyFingerprint: keyFingerprint(from.key) };
}

/* 当前生效的渠道与模型（agent 侧用）。
 * 没显式选择过时保持旧行为：opendesign + deepseek-v4.1-flash。 */
export function currentSelection(home = HOME) {
  const settings = readSettings(home);
  const name = settings.preferredProvider || 'opendesign';
  const known = readKnownProviders(home).find(p => p.name === name);
  if (!Object.hasOwn(PROVIDER_LABELS, name) && !known) throw new Error('本机选择的渠道不存在；不会自动换渠道');
  const model = settings.models?.[name] || DEFAULT_MODELS[name] || known?.models?.[0];
  if (!model) throw new Error('所选渠道没有模型；请在设置中选择模型');
  return {
    provider: name,
    model,
  };
}
