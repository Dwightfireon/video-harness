/* OpenCode 执行配置边界。
 *
 * V2 官方依据：/v2/docs/{config,providers,cli/commands}（2026-11-09）。
 * providers.<id>.settings.{baseURL,apiKey} 与 {env:NAME} 使用原生 V2 形状。
 * OPENCODE_CONFIG_CONTENT 在安装的 V2.0.21 实现中是最后合并的 virtual
 * 配置源；CLI 文档的 CI 示例明确要求 --standalone 才能让 server 收到 env。
 * 不触碰 service set、真实全局配置、凭证库或项目配置。
 *
 * 集成：const execution = prepareExecution(project, { env, home });
 * createRunner(project, execution.config); spawn(..., { env: execution.childEnv });
 * argv 必须使用 config.model / config.service（private -> --standalone）。
 * 只允许 snapshot 进入任务记录/API；childEnv 不得被日志、持久化或转发给网页。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  HOME, PROVIDER_LABELS, DEFAULT_BASES, OPENCODE_GO_BASE, currentSelection, readSettings, readKnownProviders,
  keySourceChain, keyFingerprint, parseConfigJSON, readOpencodeModelDefinition,
} from './provider-settings.mjs';

const names = new Set(['opencode', 'local']);
const nativeSource = 'opencode-native (not inspected)';
const fingerprint = value => value ? createHash('sha256').update(value).digest('hex').slice(0, 12) : null;

function fail(code, message, snapshot) {
  const error = new Error(message);
  error.code = code;
  if (snapshot) error.snapshot = snapshot;
  throw error;
}

function projectRunner(project) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(project, 'PROJECT.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { runner: {}, exists: false };
    fail('project-config', 'PROJECT.json 无效或无法读取；未选择替代执行器');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('project-config', 'PROJECT.json 必须是对象');
  if (data.runner == null) return { runner: {}, exists: true };
  if (typeof data.runner === 'string') return { runner: { name: data.runner }, exists: true };
  if (typeof data.runner !== 'object' || Array.isArray(data.runner)) fail('runner-config', '项目 runner 配置无效');
  return { runner: data.runner, exists: true };
}

function text(value, code, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 400 || /[\s\x00-\x1f\x7f]/.test(value)) {
    fail(code, label + '无效');
  }
  return value;
}

export function splitModel(value) {
  const model = text(value, 'model-config', '模型标识');
  const slash = model.indexOf('/');
  if (slash < 1 || slash === model.length - 1 || !/^[a-zA-Z0-9_.-]+$/.test(model.slice(0, slash)) ||
      /[:?@\\{}]/.test(model) || model.includes('//') || (model.match(/#/g) || []).length > 1 || model.endsWith('#')) {
    fail('model-config', '模型必须是 provider/model，可带 #variant；不能是 URL');
  }
  return { provider: model.slice(0, slash), modelID: model.slice(slash + 1).split('#')[0] };
}

/* 与旧项目兼容：已存在但没有 runner 的 PROJECT.json 仍是 legacy local；
 * 新项目由 vh new 显式写 opencode，尚无 PROJECT.json 的路径也默认 opencode。 */
export function resolveRunnerConfig(project, { env = process.env, home = env.HOME || HOME, config = {} } = {}) {
  const { runner, exists } = projectRunner(project);
  const selectedName = config.name ?? env.VH_RUNNER ?? runner.name;
  const name = selectedName ?? (exists ? 'local' : 'opencode');
  if (!names.has(name)) fail('runner-config', 'runner 只能是 opencode 或 local；未回落到其他执行器');
  const runnerSource = config.name != null ? 'runtime-override' : env.VH_RUNNER != null ? 'env:VH_RUNNER' :
    runner.name != null ? 'project:runner.name' : exists ? 'legacy-default' : 'default';
  // 即使有显式 model，也不能让损坏的设置悄悄被忽略。
  const settings = readSettings(home);
  let model = config.model ?? env.VH_RUNNER_MODEL ?? runner.model;
  let modelSource = config.model != null ? 'runtime-override' : env.VH_RUNNER_MODEL != null ? 'env:VH_RUNNER_MODEL' :
    runner.model != null ? 'project:runner.model' : null;
  if (model == null) {
    const selection = currentSelection(home);
    model = selection.provider + '/' + selection.model;
    modelSource = settings.preferredProvider || settings.models?.[selection.provider] ? 'provider-settings' : 'provider-settings:default';
  }
  const { provider } = splitModel(model);
  const agent = text(config.agent ?? env.VH_RUNNER_AGENT ?? runner.agent ?? 'vh-builder', 'agent-config', '执行 agent');
  if (!/^[a-zA-Z0-9_./-]+$/.test(agent)) fail('agent-config', '执行 agent 标识无效');
  const service = config.service ?? env.VH_RUNNER_SERVICE ?? runner.service ?? 'shared';
  if (!['shared', 'private'].includes(service)) fail('service-config', 'service 只能是 shared 或 private');
  return { name, model, provider, modelSource, runnerSource, agent, service };
}

function privateEnvironment(values) {
  const env = { ...values };
  // spawn 仍需 enumerable env entries；意外 stringify/inspect 只得到固定提示。
  Object.defineProperty(env, 'toJSON', { value: () => '[private execution environment]' });
  Object.defineProperty(env, Symbol.for('nodejs.util.inspect.custom'), { value: () => '[private execution environment]' });
  return env;
}

function redactor(values) {
  const secrets = Object.entries(values)
    .filter(([name, value]) => /(?:API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|BASE_URL)$/i.test(name) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value).sort((a, b) => b.length - a.length);
  return value => {
    let text = String(value ?? '');
    for (const secret of secrets) text = text.split(secret).join('[redacted]');
    return text.replace(/https?:\/\/[^\s<>"']+/g, raw => {
      try { return new URL(raw).origin + '/[redacted-path]'; } catch { return '[redacted-url]'; }
    });
  };
}

function runtimeDocument(env) {
  if (!env.OPENCODE_CONFIG_CONTENT) return {};
  let document;
  try { document = parseConfigJSON(env.OPENCODE_CONFIG_CONTENT); }
  catch { fail('runtime-config', 'OPENCODE_CONFIG_CONTENT 无效；未覆盖原配置'); }
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
      (document.providers != null && (typeof document.providers !== 'object' || Array.isArray(document.providers)))) {
    fail('runtime-config', 'OPENCODE_CONFIG_CONTENT 必须是 V2 配置对象');
  }
  return document;
}

function endpointInfo(base) {
  if (!base) return { endpoint: null, endpointFingerprint: null };
  let url;
  try { url = new URL(base); } catch { fail('endpoint-config', '所选渠道的端点不是有效 URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) fail('endpoint-config', '所选渠道的端点只支持 http/https');
  // 只显示 origin，完全不暴露 userinfo、路径、query 和 fragment。
  return { endpoint: url.origin, endpointFingerprint: fingerprint(base) };
}

/* 只读发现 provider 的非敏感元数据，用于避免覆盖项目自定义 package。
 * 真正的合并仍交给 OpenCode。V2 先合并全部 direct，再合并 .opencode。 */
function discoveredProvider(project, provider, home, env) {
  let known = readKnownProviders(home).find(p => p.name === provider);
  const roots = [];
  for (let dir = path.resolve(project); ; dir = path.dirname(dir)) {
    roots.unshift(dir);
    if (path.dirname(dir) === dir) break;
  }
  const files = [];
  if (env.XDG_CONFIG_HOME) {
    for (const suffix of ['json', 'jsonc']) files.push(path.join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.' + suffix));
  }
  if (env.OPENCODE_CONFIG) files.push(path.resolve(project, env.OPENCODE_CONFIG));
  for (const subdir of ['', '.opencode']) {
    for (const root of roots) {
      for (const suffix of ['json', 'jsonc']) files.push(path.join(root, subdir, 'opencode.' + suffix));
    }
  }
  for (const file of files) {
    let document;
    try { document = parseConfigJSON(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const entry = document?.providers?.[provider] ?? document?.provider?.[provider];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    known = { name: provider,
      base: entry.settings?.baseURL || entry.options?.baseURL || entry.api || known?.base || null,
      models: [...new Set([...(known?.models || []), ...Object.keys(entry.models || {})])],
    };
  }
  return known;
}

/* 把 models.dev 原始目录条目（或无库时的默认参数）转译为 OpenCode V2 配置 overlay。
 * V2 的 providers.<id>.models.<modelID> 只认 modelID / name / package / settings /
 * capabilities / limit 等配置字段；原始目录里的 id / api / cost.text 会导致校验忽略。 */
function bridgeOpencodeGoModel(modelID, raw) {
  const apiMap = raw?.api && typeof raw.api === 'object' && !Array.isArray(raw.api) ? raw.api : null;
  const apiEntry = apiMap?.['chat-completions'] || (apiMap ? Object.values(apiMap).find(v => v && typeof v === 'object') : null);
  const sdk = apiEntry?.sdk && typeof apiEntry.sdk === 'object' ? apiEntry.sdk : null;
  const pkg = (typeof raw?.package === 'string' && raw.package.trim())
    || (typeof sdk?.opencodeai === 'string' && sdk.opencodeai.trim())
    || (typeof sdk?.aisdk === 'string' && sdk.aisdk.trim() ? (sdk.aisdk.startsWith('aisdk:') ? sdk.aisdk : 'aisdk:' + sdk.aisdk) : null)
    || '@opencode/ai/providers/openai-compatible';
  const baseURL = (typeof raw?.settings?.baseURL === 'string' && raw.settings.baseURL.trim())
    || (typeof apiEntry?.base_url === 'string' && apiEntry.base_url.trim())
    || OPENCODE_GO_BASE;
  const rawCaps = raw?.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : null;
  const rawMod = raw?.modalities && typeof raw.modalities === 'object' ? raw.modalities : null;
  const toList = (value, fallback) => Array.isArray(value) && value.length && value.every(v => typeof v === 'string') ? [...value] : fallback;
  const capabilities = {
    tools: typeof rawCaps?.tools === 'boolean' ? rawCaps.tools : typeof raw?.tool_call === 'boolean' ? raw.tool_call : true,
    ...(typeof rawCaps?.reasoning === 'boolean' ? { reasoning: rawCaps.reasoning }
      : typeof raw?.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
    input: toList(rawCaps?.input ?? rawMod?.input, ['text']),
    output: toList(rawCaps?.output ?? rawMod?.output, ['text']),
  };
  const context = Number.isFinite(raw?.limit?.context) && raw.limit.context > 0 ? raw.limit.context : 131072;
  const output = Number.isFinite(raw?.limit?.output) && raw.limit.output > 0 ? raw.limit.output : 32768;
  return {
    modelID: (typeof raw?.modelID === 'string' && raw.modelID.trim()) || (typeof raw?.id === 'string' && raw.id.trim()) || modelID,
    name: (typeof raw?.name === 'string' && raw.name.trim()) || modelID,
    package: pkg,
    settings: { baseURL },
    capabilities,
    limit: { context, output },
  };
}

/* 仅构建运行期环境；无 CLI 调用、无文件写入。
 * requireCredentials:false 专用于只读展示/二进制探测，不得用于正式派发绕过预检。
 * 未知显式 provider 由 OpenCode 原生配置负责，绝不改成产品默认 provider。 */
export function prepareExecution(project, { env = process.env, home = env.HOME || HOME, config = {}, requireCredentials = true } = {}) {
  const requested = resolveRunnerConfig(project, { env, home, config });
  const settings = readSettings(home);
  const { provider, modelID } = splitModel(requested.model);
  const productProvider = Object.hasOwn(PROVIDER_LABELS, provider);
  const known = discoveredProvider(project, provider, home, env);
  const document = runtimeDocument(env);
  const inlineProvider = document.providers?.[provider];
  if (inlineProvider != null && (typeof inlineProvider !== 'object' || Array.isArray(inlineProvider))) {
    fail('runtime-config', '所选渠道的运行配置无效');
  }
  const savedBase = settings.bases?.[provider] || null;
  const defaultBase = Object.hasOwn(DEFAULT_BASES, provider) ? DEFAULT_BASES[provider] : null;
  const base = savedBase || (!known && !inlineProvider ? defaultBase : null) || null;
  // 原生端点不复制到运行配置，保留项目/ancestor/managed 的原生优先级。
  // 只对本产品明确保存的端点做最高优先级覆盖。
  const observedNativeBase = inlineProvider?.settings?.baseURL || known?.base;
  const endpointBase = base || (typeof observedNativeBase === 'string' && !observedNativeBase.includes('{') ? observedNativeBase : null);
  const key = productProvider || settings.keys?.[provider]
    ? keySourceChain(provider, { settings, env, config: {} }, home)
    : { key: '', source: null };
  const effective = { ...requested, service: requested.name === 'opencode' ? 'private' : requested.service };
  // Zen 免费入口由 OpenCode 原生运行时提供；不复用 Go 密钥，也不把 Zen 当通用 HTTP 渠道。
  const nativeCredentials = !productProvider || provider === 'opencode';
  const snapshot = {
    runner: requested.name, runnerSource: requested.runnerSource,
    model: requested.model, provider, modelSource: requested.modelSource, agent: requested.agent,
    requestedService: requested.service, service: effective.service,
    serviceReason: requested.name === 'opencode' ? 'private server required for per-run environment' : 'local runner unchanged',
    endpointSource: base ? savedBase ? 'provider-settings' : 'provider-settings:default' :
      observedNativeBase ? 'opencode-native:discovered-config (managed may override)' : nativeSource,
    ...endpointInfo(endpointBase),
    keySource: key.source || (nativeCredentials ? nativeSource : null),
    keyFingerprint: keyFingerprint(key.key),
    credentialStatus: key.key ? 'configured-not-validated' : nativeCredentials ? 'native-not-inspected' : 'missing',
    configurationReady: requested.name === 'local' || nativeCredentials || !!key.key,
    executionScope: requested.name === 'opencode' ? 'prepared-opencode-runtime' : 'local-selection-only',
    connectivity: 'not-checked', balance: 'not-checked',
  };
  if (requested.name === 'opencode' && !nativeCredentials && !key.key && requireCredentials) {
    fail('credentials', '所选渠道缺少可桥接凭证；请在本产品设置中配置，不会自动换渠道', snapshot);
  }

  const childValues = { ...env, HOME: home };
  delete childValues.VH_EXECUTION_API_KEY;
  delete childValues.VH_EXECUTION_BASE_URL;
  if (requested.name === 'opencode') {
    // 专用 env 引用避免将密钥放入 inline JSON。合并只触碰当前 provider，
    // 不替换 permissions / agents / plugins，也不注入额外审稿 agent。
    const override = {};
    if (base) {
      childValues.VH_EXECUTION_BASE_URL = base;
      override.baseURL = '{env:VH_EXECUTION_BASE_URL}';
    }
    if (key.key) {
      childValues.VH_EXECUTION_API_KEY = key.key;
      override.apiKey = '{env:VH_EXECUTION_API_KEY}';
    }
    if (Object.keys(override).length) {
      const entry = { ...inlineProvider, settings: { ...inlineProvider?.settings, ...override } };
      // 产品自有的兼容渠道：原生定义已存在就沿用它的 package/models；
      // 无原生定义时必须有明确 endpoint，才创建最小 V2 provider。
      if (productProvider && !['opencode-go', 'opencode'].includes(provider) && !known && !inlineProvider) {
        if (!base) {
          snapshot.configurationReady = false;
          if (requireCredentials) fail('endpoint-config', '所选自定义渠道缺少端点；请在设置中配置', snapshot);
        } else {
          entry.package = '@opencode/ai/providers/openai-compatible';
          entry.models = { [modelID]: {} };
        }
      }
      document.providers = { ...document.providers, [provider]: entry };
    }
    /* 独立私有 server（--standalone）只带打包时的 models.dev 目录，可能落后于本机
     * 桌面版已抓取的最新目录；新上线的模型（opencode-go/hy4-flash-free）会被误判为
     * "Model unavailable"。把本机目录里选中的那一个模型定义转译成 OpenCode V2
     * 配置 overlay（modelID / name / package / settings.baseURL / capabilities / limit），
     * 不能直接塞原始 models.dev 结构（api / id / cost.text），否则 V2 配置校验会忽略。
     * 只碰 opencode-go 的这单个模型；已有内联定义优先，其他 provider/model 不动。 */
    if (provider === 'opencode-go' && !document.providers?.['opencode-go']?.models?.[modelID]) {
      const raw = readOpencodeModelDefinition('opencode-go', modelID, home);
      const definition = bridgeOpencodeGoModel(modelID, raw);
      const goEntry = document.providers?.['opencode-go'] || {};
      document.providers = { ...document.providers,
        'opencode-go': { ...goEntry, models: { ...(goEntry.models || {}), [modelID]: definition } } };
      snapshot.modelCatalogBridged = true;
    }
    // CLI -m 是最终模型选择；root model 不支持保留 #variant。
    document.model = requested.model.split('#')[0];
    childValues.OPENCODE_CONFIG_CONTENT = JSON.stringify(document);
  }
  const result = { config: Object.freeze(effective), snapshot: Object.freeze(snapshot) };
  Object.defineProperty(result, 'childEnv', { value: privateEnvironment(childValues) });
  // 调用方应在写入 child stdout/stderr/事件错误前使用它；本模块不记录原文。
  Object.defineProperty(result, 'redactText', { value: redactor(childValues) });
  Object.defineProperty(result, 'toJSON', { value: () => result.snapshot });
  Object.defineProperty(result, Symbol.for('nodejs.util.inspect.custom'), { value: () => ({ config: result.config, snapshot: result.snapshot }) });
  return Object.freeze(result);
}

export function executionSnapshot(project, options = {}) {
  return prepareExecution(project, { ...options, requireCredentials: false }).snapshot;
}
