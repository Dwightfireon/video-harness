/* lib/agent.mjs —— harness 自带的 agent 循环（v2：带边界约束与收尾校验）
 *
 * v2 相比 v1 修掉的问题（都来自真实踩坑）：
 *   ① 空响应/光汇报不干活 → 当成"完成"就退出（曾导致 105 秒白跑）
 *   ② 步数上限 40 太小 → 读文档就耗尽预算
 *   ③ 提示里让它"读 references/" → 它会整份 cat，吃掉一半步数
 *   ④ 用户说"只改画面"，它却重写了方案/脚本/claims → **越界改文件**
 *   ⑤ 从不检查"成片与脚本是否一致" → 改完脚本不重新测量、不重新渲染
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadState, saveState, parseScript, parseChunks, hashFile } from './state.mjs';
import { readResponseText } from './provider-response.mjs';
import { recordContentReview, reviewVersion, contentReviewInputs, contentReviewStatus, reviewContentIndependently, rememberReviewMaterial } from './content-review.mjs';
import { recordPerformance } from './performance.mjs';
import { AGENT_MODEL, REQUEST_MODELS, createProviderPool, configureMaxOutputTokens } from './provider-pool.mjs';
import { readHarnessCredentials } from './harness-credentials.mjs';
import { readSettings, currentSelection, providerKey, keySourceChain, keyFingerprint, settingsPath, setProviderKey, OPENCODE_GO_BASE, DEFAULT_MODELS } from './provider-settings.mjs';
import { readCheckpoint, writeCheckpoint, fileRecoveryContext } from './checkpoint.mjs';
import { recordTool, worklogBlock } from './worklog.mjs';
import { deliverableState, projectDeliveryState, taskDeliveryState } from './deliverable.mjs';
import { publishStatus, deliveryTarget, publishWriteRefusal, publishInputs, publishRevision, confirmPublishRevision, checkPublish } from './publish.mjs';
import { directPipelineScript, toolOutcome } from './tool-result.mjs';
import { serializeStageResult, parseStageResult } from './stage-result.mjs';
import { writeSceneDraft, assembleSceneDrafts, sceneDraftStatus, sceneDraftMatches, sceneAssemblyMatches, sceneDraftRecovery, rebaseSceneDrafts, recoverSceneDraftTransaction } from './scene-drafts.mjs';
import { pendingSceneWork, SCENE_CAPABILITIES } from './scene-work.mjs';
import { formatWriteRefusal, videoFormatPrompt } from './video-format.mjs';
import { durationPrompt, durationWriteRefusal } from './duration-limit.mjs';
import { readEditFile, patchText, readScene, replaceScene, appendText, initializeAuthorFile, isAuthorFile, authorEditImpact } from './author-edits.mjs';
import { unmountedElements } from './scene-mount.mjs';
import { mountRepairPlan, repairUnmountedScenes, looksLikeMountFailure } from './mount-repair.mjs';
import { restoreChanges, addChange, pendingChanges, changesPrompt, verifyChange, defineChange, PUBLIC_AUTHORS, authorRevision, isPureContinuation, isDiscussionOnly, isExplicitMutation, nextReadOnlyScope } from './change-contract.mjs';
import { nextPipelineWork, autoVerificationSummary, callPath } from './pipeline-work.mjs';
import { isReviewRequest, reviewScopes } from './review-request.mjs';
import { runVisualReview, reviewSummary } from './visual-review.mjs';
import { safeRestrictedRead } from './command-policy.mjs';
import { automationPolicy, automationWriteRefusal, productionFailure, productionRepairWork, productionRepairSignature, productionRepairObservation,
  currentProductionRepair, recordProductionRepairEdit, submitProductionRepair, reconsiderProductionStop, classifyProductionFailure, applyRepairExtensions, stoppedFailureStage } from './automation.mjs';
import { exportSubtitles } from './subtitle-export.mjs';
import { registerProductionChild } from './production-lock.mjs';
import { updateTask, readTask } from './task-status.mjs';
import { authorDocumentState, beginAuthorDraft, finishAuthorDraft, sceneAuthoringState } from './author-readiness.mjs';
import { stageContract, newStageProgress, advanceStageProgress, READ_TOOLS, WRITE_TOOLS, MACHINE_STAGES, AUTHOR_STAGES } from './pipeline-contract.mjs';
import { beginResearchAttempt, finishResearchAttempt } from './research-attempts.mjs';
import { workflowPolicy, workflowPrompt } from './workflow-policy.mjs';
import { claimsDocumentState } from './claims.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VH_DIR = path.join(HERE, '..');
const HOME = process.env.HOME || '';
function registerToolChild(project, pid) {
  return pid && process.env.VH_PRODUCTION_LOCK_TOKEN ? registerProductionChild(project, pid, { group: true }) : null;
}

/* ---------------- provider ---------------- */
function readAuth() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, '.local', 'share', 'opencode', 'auth.json'), 'utf8')); }
  catch { return {}; }
}
function readProviders() {
  const file = path.join(HOME, '.config', 'opencode', 'opencode.jsonc');
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
function readHarnessConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(VH_DIR, 'vh.config.json'), 'utf8')); } catch { return {}; }
}
export function saveHarnessKey(key, home = process.env.HOME) {
  /* 与设置页写同一处：整个 harness 只有一个"用户显式指定"的 key 位置。
   * 若命令行写 credentials.json、页面写 providers.json，两者互相遮挡，
   * 谁优先都说不清——用户换了 key 却看到旧行为。
   * home 可注入：测试必须能落在临时目录，绝不能碰到使用者的真实配置。 */
  setProviderKey('opendesign', key, {}, home);
  return { target: settingsPath(home), fingerprint: keyFingerprint(providerKey('opendesign', home)) };
}
export function readHarnessKeyHint() {
  return buildCandidates().length > 0;
}

/* 判断一次工具调用是否在翻 harness 自己的源码（lib/、vh.mjs、references/ 等）。
 * 用途：写草稿阶段拦掉这类调用，避免模型为了猜格式反复读实现。
 * 只认"项目外的 harness 目录"，项目内同名文件不算——项目里也有 lib 时不能误伤。 */
export function touchesHarnessSource(call, project) {
  const name = call.function?.name;
  let args = {};
  try { args = JSON.parse(call.function?.arguments || '{}'); } catch { return false; }
  const hay = [args.path, args.command, args.pattern, args.glob].filter(Boolean).join(' ');
  if (!hay) return false;
  const harnessRoot = path.resolve(VH_DIR);
  // 读到 harness 源码的典型痕迹：绝对路径、lib/xxx.mjs、vh.mjs、references/、cd lib
  const mentionsHarness = /(?:^|[\s"'=/])(?:lib\/[\w.-]+\.mjs|lib\b|vh\.mjs|references\/|www\/)/.test(hay) ||
    hay.includes(harnessRoot);
  if (!mentionsHarness) return false;
  // 若目标明确落在项目目录内，说明是项目自己的文件，放行。
  const projectAbs = path.resolve(project);
  const targets = [args.path, args.command].filter(Boolean).join(' ');
  if (targets.includes(projectAbs) && !targets.includes(harnessRoot + path.sep + 'lib')) return false;
  return name !== 'append_file' && name !== 'patch_text' && name !== 'replace_scene';
}
export function buildCandidates({ providers: provs = readProviders(), config: cfg = readHarnessConfig(),
  auth = readAuth(), env = process.env, credentials = env.HOME ? readHarnessCredentials(env.HOME) : {},
  settings = readSettings(), home = HOME } = {}) {
  const out = [];
  // home 可注入：除凭证文件外，OpenCode 凭证库也属于本机环境。
  // 测试必须能固定它，否则结果会随使用者是否登录过某个渠道而变化。
  const chain = name => keySourceChain(name, { settings, credentials, env, config: cfg, auth }, home).key;
  const odKey = chain('opendesign');
  const od = provs.find(p => p.name === 'opendesign');
  if (odKey) out.push({ name: 'opendesign', base: (od && od.base) || 'https://amr-link.open-design.ai/v1',
    key: odKey, model: REQUEST_MODELS.opendesign, headers: {} });
  // commandcode 也走同一条来源链：设置页填的 key 必须能覆盖 opencode 里的旧凭证。
  // base 与 UA 头保持原样，这两个不是凭证，不参与优先级。
  const ccKey = chain('commandcode');
  const cc = provs.find(p => p.name === 'commandcode');
  const ccBase = settings.bases?.['commandcode'] || cc?.base;
  if (ccBase && ccKey) {
    out.push({ name: 'commandcode', base: ccBase, key: ccKey,
      model: REQUEST_MODELS.commandcode,
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) opencode/2.0.21' } });
  }
  // 设置页里另外配置的渠道（本机路由等）：走同一条来源链，不在这里另定优先级。
  // 名单只取设置页显式填过密钥/地址的渠道，保持原有"必须由用户明确配置"的边界。
  const extraNames = [...new Set([...Object.keys(settings.keys || {}), ...Object.keys(settings.bases || {})])];
  for (const name of extraNames) {
    if (name === 'opendesign' || name === 'commandcode' || name === 'opencode-go' || name === 'opencode') continue;
    if (out.some(c => c.name === name)) continue;
    const key = chain(name);
    if (!key) continue;
    const base = settings.bases?.[name] || provs.find(p => p.name === name)?.base;
    if (!base) continue;
    out.push({ name, base, key: String(key),
      model: settings.models?.[name] || REQUEST_MODELS[name] || null, headers: {} });
  }
  /* OpenCode Go：opencode 内置渠道。凭证同样走统一来源链：
   * 设置页填过就用设置页的，没填才回落到 opencode 凭证库。
   * 端点要求带 x-opencode-session 头，否则拒绝路由（400）。 */
  if (!out.some(c => c.name === 'opencode-go')) {
    const goKey = chain('opencode-go');
    const goBase = settings.bases?.['opencode-go'] || OPENCODE_GO_BASE;
    if (goKey) {
      out.push({ name: 'opencode-go', base: goBase, key: goKey,
        model: settings.models?.['opencode-go'] || DEFAULT_MODELS['opencode-go'],
        headers: { 'x-opencode-session': 'vh-' + randomUUID().slice(0, 8) } });
    }
  }
  const preferred = settings.preferredProvider || cfg.preferredProvider || 'opendesign';
  const selected = out.filter(c => c.name === preferred);
  // 用户在设置页选了别的模型，就用它；否则沿用该渠道的默认模型。
  for (const c of selected) {
    const wanted = settings.models?.[c.name];
    if (wanted) { c.model = wanted; c.modelExplicit = true; }
  }
  return selected;
}

export function readProviderInfo() {
  const selection = currentSelection();
  return buildCandidates().map(c => ({ provider: c.name, model: c.model || selection.model }));
}

export async function pickProvider(project, candidates = buildCandidates(), config = readHarnessConfig(),
  settings = readSettings()) {
  // 不读旧项目渠道缓存，缺少所选凭证也不能悄悄改用另一个渠道。
  const preferred = settings.preferredProvider || config.preferredProvider || 'opendesign';
  const found = candidates.find(c => c.name === preferred) || null;
  if (found) {
    const wanted = settings.models?.[found.name];
    if (wanted) { found.model = wanted; found.modelExplicit = true; }
  }
  return found;
}

/* 只用于本机当前配置：agent 实际会用到的渠道与模型。 */
export function activeProvider() {
  const candidates = buildCandidates();
  const selection = currentSelection();
  const found = candidates.find(c => c.name === selection.provider) || candidates[0] || null;
  return found ? { provider: found.name, model: found.model || selection.model } : selection;
}

/* ---------------- 工具（带写权限边界） ---------------- */
const ALLOW = /^(node|python3|ffmpeg|ffprobe|git|ls|cat|head|tail|wc|grep|mkdir|cp|mv|du|sed|awk|jq|pwd|which|echo|diff|shasum|md5)\b/;

/* 用解释器直接写作者文件会绕过版本回执与备份；只拦“写入”语义，不拦 readFileSync 只读。 */
const AUTHOR_FILE_NAME = /(?:脚本\.md|发布文案\.md|方案\.md|claims\.json|scenes\.src\.js|engine\.tpl\.html|审查\.md)/;
const WRITE_AUTHOR_VIA_CODE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|renameSync|truncate|unlinkSync)\s*\(|Path\s*\([^)]*\)\s*\.\s*write_text|open\s*\([^)]*['"][wa]|\bsed\s+(?:-i|--in-place|-e\s+['"][^'"]*['"]\s+-i)/;

/* 写权限边界：根据任务模式限制可写文件（解决"只改画面却重写方案"） */
function writeGuard(mode) {
  if (mode === 'edit-visual') {
    return { allow: [/^scenes\.src\.js$/, /^engine\.tpl\.html$/, /^out\//], why: '本次只允许改画面（scenes.src.js / engine.tpl.html）' };
  }
  if (mode === 'edit-script') {
    return { allow: [/^脚本\.md$/, /^claims\.json$/, /^scenes\.src\.js$/, /^发布文案\.md$/], why: '本次只允许改脚本与文案（脚本.md / claims.json / scenes.src.js / 发布文案.md）' };
  }
  if (mode === 'edit-copy') {
    return { allow: [/^发布文案\.md$/], why: '本次只允许改发布文案.md，不改脚本、方案或媒体' };
  }
  return null;   // article / topic：整项目可写
}

/* 文件指纹：判断"这次读的内容是否与上次相同"，mtime 精度不足时也算内容哈希。 */
function fileStamp(project, rel) {
  try {
    const abs = path.resolve(project, rel);
    if (abs !== project && !abs.startsWith(project + path.sep)) return null;
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return null;
    return stat.size <= 1024 * 1024
      ? createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
      : stat.size + ':' + stat.mtimeMs;
  } catch { return null; }
}

function readSlice(text, { max_bytes = 20000, start_line = 0, max_lines = 0 }) {
  const from = Math.max(0, Math.floor(Number(start_line) || 0));
  if (Number(max_lines) > 0 || from > 0) {
    const all = text.split('\n');
    const take = Number(max_lines) > 0 ? Math.max(1, Math.floor(Number(max_lines))) : all.length;
    const body = all.slice(from, from + take).join('\n');
    const limit = Math.max(1, Number(max_bytes) || 20000);
    return `行 ${from + 1}–${Math.min(all.length, from + take)} / 共 ${all.length} 行：\n` +
      body.slice(0, limit) + (body.length > limit ? '\n…（本范围已截断，请缩小 max_lines 继续读取）' : '');
  }
  const limit = Math.max(1, Number(max_bytes) || 20000);
  return text.length > limit ? text.slice(0, limit) + `\n…（截断，原文 ${text.length} 字符；可用 start_line/max_lines 读中段）` : text;
}

export function makeTools(project, log, opts = {}) {
  const publishBaseline = rel => {
    if (rel !== '发布文案.md') return null;
    const current = publishInputs(project), expected = opts.publishInputs || current;
    if (expected.sourceSignature !== current.sourceSignature) throw new Error('文案生成期间脚本或要求已改变；未写入旧输入生成的文案，请重新读取当前稿');
    return expected;
  };
  const recordPublishWrite = (rel, baseline, changed = true) => {
    if (rel !== '发布文案.md' || !changed || !baseline?.sourceHashes.script) return;
    const md = fs.readFileSync(path.join(project, rel), 'utf8');
    if (checkPublish(md).ok) confirmPublishRevision(project, { sourceSignature: baseline.sourceSignature,
      publishHash: publishRevision(project).publishHash, by: 'agent' });
  };
  const beginDraft = rel => {
    if (requiresDeliverable(opts.mode) || opts.automation?.enabled && opts.mode === 'edit') beginAuthorDraft(project, rel);
  };
  const writeRefusal = (rel, next) => automationWriteRefusal(project, rel, next) || publishWriteRefusal(project, rel, next) ||
    durationWriteRefusal(project, rel, next) || formatWriteRefusal(project, rel, next);
  const editOptions = rel => ({
    scene: opts.activeContract?.editScope ?? null,
    validate: next => {
      opts.activeContract?.assertBaseline?.(rel);
      const refusal = writeRefusal(rel, next);
      if (refusal) throw new Error(refusal);
    },
    beforeCommit: () => beginDraft(rel),
  });
  const guard = writeGuard(opts.mode || 'edit');
  /* 审阅模式只能由执行器显式注入；不能读到全局同名变量，否则普通编辑会被误拦。 */
  const review = opts.review || null;
  const inside = (p) => {
    const abs = path.resolve(project, p);
    return abs === project || abs.startsWith(project + path.sep);
  };
  const allowWrite = (rel) => {
    if (opts.readOnly) { log('  ⛔ 当前用户范围为只读，未修改文件'); return false; }
    if (opts.automation?.enabled && !['方案.md', '脚本.md', 'claims.json', 'scenes.src.js', 'engine.tpl.html', '发布文案.md', 'PROGRESS.md'].includes(rel)) {
      log('  ⛔ 自动制作只允许修改作者输入；不能写工具、媒体、状态/质量回执或人工审查文件'); return false;
    }
    if (opts.publishOnly && rel !== '发布文案.md') {
      log('  ⛔ 发布文案阶段只允许修改发布文案.md'); return false;
    }
    if (!guard) return true;
    const rel2 = rel.replace(/^\.\//, '');
    if (guard.allow.some(re => re.test(rel2))) return true;
    log(`  ⛔ 越界写被拒：${rel2}（${guard.why}）`);
    return false;
  };
  return {
    list_files: {
      desc: '列出目录内容（相对项目根，默认 "."）',
      params: { path: 'string' },
      async run({ path: p = '.' }) {
        if (!inside(p)) return '拒绝：越出项目目录';
        const abs = path.resolve(project, p);
        const items = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 200)
          .map(d => (d.isDirectory() ? d.name + '/' : d.name));
        return items.join('\n') || '（空）';
      },
    },
    read_file: {
      desc: '读文本文件（相对项目根）。读参考文档时只读需要的片段，别整份读',
      params: { path: 'string', max_bytes: 'number(可选，默认 20000)', start_line: 'number(可选，从 0 起)', max_lines: 'number(可选，读多少行)' },
      async run({ path: p, max_bytes = 20000, start_line = 0, max_lines = 0 }) {
        if (!inside(p)) return '拒绝：越出项目目录';
        try {
          const s = fs.readFileSync(path.resolve(project, p), 'utf8');
          return readSlice(s, { max_bytes, start_line, max_lines });
        } catch (e) { return '读失败：' + e.message; }
      },
    },
    write_file: {
      desc: '新建文本文件（相对项目根）。已有作者稿不能整份覆盖；用 read_edit_file 后 patch_text / append_file / replace_scene。仅空文件或指纹未变的安装脚手架允许初始化。',
      params: { path: 'string', content: 'string' },
      async run({ path: p, content }) {
        if (review?.required) return '拒绝：这是审阅要求，不能修改文件；先完成检查并只回答发现。';
        if (!inside(p)) return '拒绝：越出项目目录';
        const rel = path.relative(project, path.resolve(project, p));
        if (!allowWrite(rel)) return `拒绝：${guard?.why || '发布文案阶段只允许修改发布文案.md'}（当前模式 ${opts.mode}）`;
        // 禁止通过 out/ 下的现成符号链接写入受保护作者文件或工程外。
        let cursor = fs.realpathSync(project);
        for (const part of rel.split(path.sep)) {
          cursor = path.join(cursor, part);
          try { if (fs.lstatSync(cursor).isSymbolicLink()) return '拒绝：写文件路径包含符号链接，未绕过项目和模式边界'; }
          catch (e) { if (e.code === 'ENOENT') break; throw e; }
        }
        if (['脚本.md', '方案.md', 'claims.json'].includes(rel) && content.length > 12000) {
          return `拒绝：${rel} 这一批 ${content.length} 字符，超过单次写入上限。请改用 append_file 分批写（每批约 3000 字符），不要一次生成整份长文。`;
        }
        const formatRefusal = writeRefusal(rel, content);
        if (formatRefusal) return formatRefusal;
        const abs = path.resolve(project, p);
        const baseline = publishBaseline(rel);
        try { if (fs.readFileSync(abs, 'utf8') === content) return '文件内容已相同，未重复写入 ' + rel + '\n' + JSON.stringify({ affectedScenes: [], sharedImpact: false }); } catch {}
        if (isAuthorFile(rel) && fs.existsSync(abs)) {
          try {
            const result = initializeAuthorFile(project, rel, content, editOptions(rel));
            recordPublishWrite(rel, baseline, result.changed);
            log(`  ✎ 初始化 ${rel}（原脚手架已备份）`);
            return `已写入 ${rel}\n` + JSON.stringify(result);
          } catch (error) { return '拒绝：' + error.message; }
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        beginDraft(rel);
        fs.writeFileSync(abs, content, { encoding: 'utf8', flag: isAuthorFile(rel) ? 'wx' : 'w' });
        recordPublishWrite(rel, baseline);
        log(`  ✎ 写入 ${rel}（${content.length} 字节）`);
        return `已写入 ${rel}` + (['方案.md', '脚本.md'].includes(rel) ? `\nbase_hash=${readEditFile(project, rel, { max_lines: 1 }).base_hash}；分批草稿写完后须 finish_draft 提交。` : '') +
          (isAuthorFile(rel) ? '\n' + JSON.stringify(authorEditImpact(rel, '', content)) : '');
      },
    },
    write_scene: {
      desc: '只保存一个完整场景到独立草稿，不覆盖 scenes.src.js。声明真实 layout；建议填写四项视觉意图，与场景一同保存，不代替审片。全部完成后 assemble_scenes 组装。',
      params: { scene: 'number(从 S1 开始)', layout: 'string(本场真实版式名，如流程图、双栏对照)', content: 'string',
        visual_focus: 'string(可选，本场观众先看什么)', visual_hierarchy: 'string(可选，主体与辅助/背景如何区分)',
        visual_restraint: 'string(可选，留白的用途或明确舍弃什么)', visual_rhythm: 'string(可选，关键变化、停顿与阅读时间)' },
      async run(args) {
        const { scene, content, layout } = args;
        if (opts.readOnly) return '拒绝：当前用户要求只读，不能保存场景';
        if (review?.required) return '拒绝：这是审阅要求，不能修改场景；先完成检查并只回答发现。';
        if (opts.publishOnly) return '拒绝：发布文案阶段不能写场景';
        if (guard && !guard.allow.some(re => re.test('scenes.src.js'))) return `拒绝：${guard.why}`;
        try { const result = writeSceneDraft(project, scene, content, { layout, visual: visualFromSceneArgs(args), required: !!opts.automation?.enabled }); log('  ✎ ' + result); return result; }
        catch (e) { return '写入失败：' + e.message; }
      },
    },
    read_edit_file: {
      desc: '读取作者文件的一小段，返回完整文件 base_hash；随后用 patch_text 精确替换，不需要重写整文件。',
      params: { path: 'string', start_line: 'number(可选，从0起)', max_lines: 'number(可选，默认80)' },
      async run({ path: p, start_line = 0, max_lines = 80 }) {
        try { return JSON.stringify(readEditFile(project, p, { start_line, max_lines })); } catch (e) { return '读失败：' + e.message; }
      },
    },
    patch_text: {
      desc: '只替换一个准确文本片段；base_hash 必须来自 read_edit_file 或当前小任务；匹配数必须等于 expected_count（默认1）。保留其他字节并备份，冲突不覆盖。',
      params: { path: 'string', base_hash: 'string', find: 'string', replace: 'string', expected_count: 'number(可选，默认1)' },
      async run(args) {
        try {
          if (review?.required) return '拒绝：这是审阅要求，不能修改文件；先完成检查并只回答发现。';
          if (!inside(args.path)) return '拒绝：越出项目目录';
          const rel = path.relative(project, path.resolve(project, args.path));
          if (!allowWrite(rel)) return `拒绝：${guard?.why || '发布文案阶段只允许修改发布文案.md'}`;
          if (typeof args.find !== 'string' || !args.find || typeof args.replace !== 'string') throw new Error('find/replace 必须是文本且 find 不能为空');
          // These are still NOT author-edit targets. Preserve their actionable
          // policy diagnostics before the author whitelist rejects the path;
          // passing policy checks never grants a write permission or CAS bypass.
          if (!isAuthorFile(rel) && ['PROJECT.json', 'scene.html'].includes(rel)) {
            const file = path.join(project, rel), stat = fs.lstatSync(file);
            if (stat.isFile() && !stat.isSymbolicLink()) {
              const next = fs.readFileSync(file, 'utf8').split(args.find).join(args.replace);
              const refusal = writeRefusal(rel, next);
              if (refusal) return refusal;
            }
          }
          const baseline = publishBaseline(rel);
          const result = patchText(project, rel, args, editOptions(rel));
          recordPublishWrite(rel, baseline, result.changed);
          log(`  ✎ ${rel}：${result.changed ? '短片段已保存（原文已备份）' : '内容相同，未重复写入'}`);
          return JSON.stringify(result);
        } catch (e) { return '写入失败：' + e.message; }
      },
    },
    append_file: {
      desc: '分批写长文：默认每批最多 3000 字符，追加到作者文件末尾。第一批不带 base_hash；之后带上一批返回的 base_hash。方案/脚本全部写完后须 finish_draft 提交，第一批落盘不算整稿完成。',
      params: { path: 'string', content: 'string', base_hash: 'string(第一批可省略)', max_chars: 'number(可选，默认3000，最多12000)' },
      async run(args) {
        try {
          if (review?.required) return '拒绝：这是审阅要求，不能修改文件；先完成检查并只回答发现。';
          if (!inside(args.path)) return '拒绝：越出项目目录';
          const rel = path.relative(project, path.resolve(project, args.path));
          if (!allowWrite(rel)) return `拒绝：${guard?.why || '发布文案阶段只允许修改发布文案.md'}`;
          const baseline = publishBaseline(rel);
          const result = appendText(project, rel, args, editOptions(rel));
          recordPublishWrite(rel, baseline, result.changed);
          log(`  ✎ ${rel}：追加 ${result.appended_chars} 字符（累计 ${result.total_chars} 字符）`);
          return JSON.stringify(result);
        } catch (e) { return '写入失败：' + e.message; }
      },
    },
    review_content: {
      desc: '仅显式要求审稿的项目使用：传 signature 发起隔离上下文复核；默认不自动调用，不是制作必经步骤。作者不能决定 verdict，不是人工发布通过。',
      get params() { return reviewVersion(project) >= 3 ? { signature: 'string' } : { signature: 'string', verdict: 'string(pass|revise)', question: 'string', answer: 'string', scope: 'string', scenes: 'array({scene:number,quote:string,takeaway:string,bridge:string})', links: 'array({premise:string,middle:string,conclusion:string})', analogies: 'array({claim:string,mapping:string,limit:string})', findings: 'array({finding:string,reason:string})', issues: 'array(string)' }; },
      async run(args) {
        try {
          if (review?.required || !allowWrite('脚本.md')) return '拒绝：只读或限域任务不能登记内容审稿';
          if (!contentReviewStatus(project).required) return '拒绝：本项目未要求模型内容审稿；继续当前制作阶段，不自动发起付费审稿。主动审稿请由用户明确执行 content-review --independent。';
          if (reviewVersion(project) >= 3) {
            if (!opts.reviewContent) throw new Error('未配置独立审稿，不能回退自审');
            return JSON.stringify({ ok: true, review: await opts.reviewContent(args.signature) });
          }
          return JSON.stringify({ ok: true, review: recordContentReview(project, args) });
        } catch (error) { return '核验失败：内容审稿未提交；' + error.message; }
      },
    },
    finish_draft: {
      desc: '方案/脚本的全部批次写完后提交当前全文版本。base_hash 来自最后一次写入或 read_edit_file；缺规划场次、空场、冲突版本均拒绝，不改作者正文，不代表人工审阅通过。',
      params: { path: 'string(方案.md|脚本.md)', base_hash: 'string' },
      async run({ path: p, base_hash }) {
        try {
          if (review?.required) return '拒绝：审阅任务不能提交制作草稿';
          if (!allowWrite(p)) return '拒绝：本次模式不允许提交这个作者文档';
          const result = finishAuthorDraft(project, p, base_hash);
          log('  ✓ 已提交作者草稿 ' + p + '（非人工审阅）');
          return JSON.stringify(result);
        } catch (error) { return '核验失败：' + error.message; }
      },
    },
    finish_repair: {
      desc: '当前一轮修复允许多次短补丁。把本轮已列的问题修完后提交复检；至少要有作者输入变化。不会重置或增加修复预算，不代表质量已通过。',
      params: {},
      async run() {
        if (opts.readOnly) return '拒绝：当前用户要求只读，不能提交修复';
        if (review?.required) return '拒绝：审阅任务不能提交修复';
        try {
          if (!opts.finishRepair) throw new Error('当前没有受控修复事务');
          const result = opts.finishRepair();
          log('  ✓ 本轮修复已提交，下一步重新检查（尚未判定通过）');
          return JSON.stringify(result);
        } catch (error) { return '核验失败：' + error.message; }
      },
    },
    read_scene: {
      desc: '按场读取现有 scenes.src.js，返回该场代码与完整文件 base_hash。已有草稿过期时也可读取当前作者版本。',
      params: { scene: 'number(从1起)' },
      async run({ scene }) { try { return JSON.stringify(readScene(project, scene)); } catch (e) { return '读失败：' + e.message; } },
    },
    replace_scene: {
      desc: '只替换现有作者文件中的一场；必须提供 read_scene 返回的完整文件 base_hash。先校验语法，其他场次逐字保留，并备份。',
      params: { scene: 'number(从1起)', base_hash: 'string', content: 'string' },
      async run({ scene, base_hash, content }) {
        if (review?.required) return '拒绝：这是审阅要求，不能修改场景；先完成检查并只回答发现。';
        if (opts.publishOnly) return '拒绝：发布文案阶段不能写场景';
        if (!allowWrite('scenes.src.js')) return `拒绝：${guard.why}`;
        try {
          const result = replaceScene(project, scene, { base_hash, content }, editOptions('scenes.src.js'));
          log(`  ✎ S${scene}：${result.changed ? '当前一场已保存，其他场次保留' : '内容相同，未重复写入'}`);
          return JSON.stringify(result);
        } catch (e) { return '写入失败：' + e.message; }
      },
    },
    confirm_publish: {
      desc: '核对当前脚本与已有发布文案后，按明确的输入签名和文案指纹关联版本。不改文案、不重做视频、不表示人工审阅通过；输入变化或文案不完整则拒绝。',
      params: { source_signature: 'string(当前 publish 阶段给出的 sourceSignature)', publish_hash: 'string(当前文案的 publishHash)' },
      async run({ source_signature, publish_hash }) {
        if (opts.readOnly) return '拒绝：当前用户要求只读，不能关联版本';
        if (guard && !guard.allow.some(re => re.test('发布文案.md'))) return '拒绝：本次模式不处理发布文案版本';
        try {
          const result = confirmPublishRevision(project, { sourceSignature: source_signature, publishHash: publish_hash, by: 'agent' });
          log('  ✓ 发布文案已关联当前稿（不代替人工审阅）');
          return JSON.stringify({ ok: true, revision: result });
        } catch (e) { return '核验失败：' + e.message; }
      },
    },
    define_change: {
      desc: '脱敏前先列出需移除的具体姓名/表述。instruction_id 来自待完成清单，forbidden_terms 是 JSON 字符串数组。只登记范围，不写作者文件、不算完成；随后逐个 patch_text。',
      params: { instruction_id: 'string', forbidden_terms: 'string(JSON数组，例如 ["张三","政治"])' },
      async run({ instruction_id, forbidden_terms }) {
        if (opts.readOnly) return '拒绝：当前用户要求只读，不能登记制作修改';
        try {
          const change = opts.changeContracts?.find(c => c.id === instruction_id);
          if (!change) throw new Error('找不到该用户指令');
          const result = defineChange(change, JSON.parse(forbidden_terms));
          log('  已登记修改清单（尚未应用）：' + change.text.slice(0, 100));
          return JSON.stringify(result);
        } catch (e) { return '核验失败：' + e.message; }
      },
    },
    verify_change: {
      desc: '修改后核验一条用户要求；instruction_id 来自待完成清单。脱敏必须列出全部待移除姓名/表述并检查脚本、所有场景及发布文案；禁止词仍在或无实际改动则拒绝。机械通过不代替语义审阅。',
      params: { instruction_id: 'string', forbidden_terms: 'string(JSON数组，例如 ["张三","政治"]；非脱敏可传[])', summary: 'string(实际检查说明，至少12字)' },
      async run({ instruction_id, forbidden_terms, summary }) {
        if (opts.readOnly) return '拒绝：当前用户要求只读，不能提交修改核验';
        try {
          const change = opts.changeContracts?.find(c => c.id === instruction_id);
          if (!change) throw new Error('找不到该待核验指令，不得跳过要求清单');
          const result = verifyChange(project, change, { forbidden_terms: JSON.parse(forbidden_terms), summary });
          log('  ✓ 用户修改要求机械核验通过：' + change.text.slice(0, 100) + '（不代替语义审阅）');
          return JSON.stringify(result);
        } catch (e) { return '核验失败：' + e.message; }
      },
    },
    run_stage: {
      desc: '按固定参数执行制作阶段（build/measure/render/voice/validate），不经过 shell 管道。完整日志保存到 out/.vh-tool-logs，按真实退出码判定；不会调用模型。',
      params: { stage: 'string(build|measure|render|voice|validate)' },
      async run({ stage }) {
        if (opts.readOnly || review?.required) return '拒绝：当前为只读/审阅任务，不能执行制作阶段';
        /* 用法错误必须自解释：只回"未知制作阶段"会让模型反复试，
         * 或在多轮只读里打转直到被轮次上限打死（真实事故：把 shell 命令塞进 stage）。 */
        if (!['build', 'measure', 'render', 'voice', 'validate'].includes(stage)) {
          const got = typeof stage === 'string' ? stage.slice(0, 60) : String(stage);
          return '拒绝：未知制作阶段「' + got + '」。run_stage 只接受 stage = build|measure|render|voice|validate；' +
            '要跑 shell 命令请改用 run（例如 run({command:"grep -n x scenes.src.js"})），' +
            '要查看文件请改用 read_file / read_edit_file。';
        }
        if (opts.hasPendingRepair?.()) return '拒绝：当前一轮修复尚未提交；把本轮问题逐项修完后调用 finish_repair，再复检，不要每打一处补丁就重跑制作';
        if ((opts.mode === 'edit-copy' || opts.publishOnly) && stage !== 'validate') return '拒绝：发布文案阶段不执行视频制作';
        if (requiresDeliverable(opts.mode) || opts.automation?.enabled && opts.mode === 'edit') {
          const incomplete = ['方案.md', '脚本.md'].map(name => authorDocumentState(project, name)).find(state => !state.ok);
          const scenes = sceneAuthoringState(project);
          const mismatched = !incomplete && parseScript(fs.readFileSync(path.join(project, '脚本.md'), 'utf8')).length !== parseChunks(path.join(project, 'scenes.src.js')).length;
          const drafts = sceneDraftStatus(project), unassembled = drafts && !drafts.stale && !sceneAssemblyMatches(project);
          if (incomplete || scenes.needed || mismatched || unassembled) return '拒绝：作者输入尚未完成，不能提前执行制作阶段：' +
            (incomplete?.reason || scenes.reason || (mismatched ? '脚本与画面场数不一致，先逐场制作' : '分场草稿尚未组装，先 assemble_scenes'));
        }
        if (stage === 'validate') {
          const changes = pendingChanges(project, opts.changeContracts);
          if (changes.length) return '核验失败：用户要求尚未核验：' + changes.map(c => c.id).join('、');
          if (opts.mode === 'edit-copy') {
            const pub = publishStatus(project);
            return pub.ok ? 'exit=0\n发布文案机械检查通过；视频未重做，内容仍须人工审阅。' : '核验失败：' + pub.errors.map(e => e.message).join('；');
          }
          const result = requiresDeliverable(opts.mode) ? projectDeliveryState(project) : deliverableStale(project);
          if (!result.stale && opts.automation?.enabled) return automatedDeliveryCheck(project);
          return result.stale ? '核验失败：' + result.reason : 'exit=0\n交付机械检查通过：' + result.video + '；内容/视觉仍须实际审阅。';
        }
        if (pendingChanges(project, opts.changeContracts).length && ['measure', 'render', 'voice'].includes(stage)) return '拒绝：先完成并核验用户改稿/脱敏要求，再执行下游制作';
        const file = path.join(project, 'out', '.vh-tool-logs', Date.now() + '-' + randomUUID() + '.log');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const fd = fs.openSync(file, 'wx', 0o600);
        const argv = [path.join(VH_DIR, 'vh.mjs'), stage, '--dir', project, ...(stage === 'voice' ? ['--srt'] : []),
          ...(opts.automation?.enabled ? ['--unattended'] : [])];
        log('  阶段 ' + stage + '；完整日志 ' + path.relative(project, file));
        const result = await new Promise(resolve => {
          const child = spawn(process.execPath, argv, { cwd: project, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VH_AGENT_PROJECT: project, VH_PRODUCTION_IN_STAGE: '1' } });
          let registration;
          try { registration = registerToolChild(project, child.pid); }
          catch { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
          const marker = path.join(project, 'out/.vh-run.json');
          try { const state = JSON.parse(fs.readFileSync(marker, 'utf8')); if (state.pid === process.pid) fs.writeFileSync(marker, JSON.stringify({ ...state, childPid: child.pid })); } catch {}
          let tail = '', closed = false, escalation;
          const stop = () => {
            try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
            escalation ||= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 3000);
          };
          const timer = setTimeout(stop, 20 * 60 * 1000);
          const collect = chunk => { fs.writeSync(fd, chunk); tail = (tail + chunk.toString()).slice(-12000); };
          child.stdout.on('data', collect); child.stderr.on('data', collect);
          opts.signal?.addEventListener('abort', stop, { once: true });
          if (opts.signal?.aborted) stop();
          const done = (status, message = '') => {
            if (closed) return; closed = true; clearTimeout(timer); clearTimeout(escalation); opts.signal?.removeEventListener('abort', stop); fs.closeSync(fd);
            const exited = !registration || registration.unregister();
            if (!exited) { status = 1; message += '制作工具组仍有活后代，保留进程登记与制作锁，不能登记成功\n'; }
            try { const state = JSON.parse(fs.readFileSync(marker, 'utf8')); if (exited && state.pid === process.pid && state.childPid === child.pid) fs.writeFileSync(marker, JSON.stringify({ ...state, childPid: null })); } catch {}
            resolve(serializeStageResult({ stage, exitCode: status, logPath: path.relative(project, file), output: message + tail }));
          };
          child.on('error', () => done(1, '启动阶段进程失败\n'));
          child.on('close', (status, signal) => done(status ?? signal ?? 1));
        });
        const outcome = toolOutcome(result);
        log((outcome.ok ? '  ✓ ' : '  ✗ ') + '阶段 ' + stage + '：' + outcome.summary);
        return result;
      },
    },
    assemble_scenes: {
      desc: '全部分场草稿保存后，检查脚本与作者文件未变，原子组装 scenes.src.js；不会启动 build。',
      params: {},
      async run() {
        if (review?.required) return '拒绝：这是审阅要求，不能组装场景；先完成检查并只回答发现。';
        if (opts.readOnly) return '拒绝：当前用户要求只读，不能组装场景';
        if (opts.publishOnly) return '拒绝：发布文案阶段不能组装场景';
        if (guard && !guard.allow.some(re => re.test('scenes.src.js'))) return `拒绝：${guard.why}`;
        try { const result = assembleSceneDrafts(project, { required: !!opts.automation?.enabled }); log('  ✎ ' + result); return result; }
        catch (e) { return '写入失败：' + e.message; }
      },
    },
    inspect_scene_drafts: {
      desc: '只读核对分场草稿、当前作者基线、可复用场次和遗留事务；返回受控重开的 CAS 指纹。源码冲突不能用重开工具绕过。',
      params: {},
      async run() { try { return JSON.stringify(sceneDraftRecovery(project)); } catch (e) { return '核验失败：' + e.message; } },
    },
    recover_scene_transaction: {
      desc: '仅清理 inspect_scene_drafts 证明持有进程已死且活动代完整的遗留草稿事务门；不会删除草稿、历史或未知文件。',
      params: { transaction_hash: 'string', recovery_hash: 'string' },
      async run(args) {
        if (opts.readOnly || opts.publishOnly || guard && !guard.allow.some(re => re.test('scenes.src.js'))) return '拒绝：当前范围不允许恢复场景事务';
        try { return JSON.stringify(recoverSceneDraftTransaction(project, args)); }
        catch (e) { return '核验失败：' + e.message; }
      },
    },
    rebase_scene_drafts: {
      desc: '仅按 inspect_scene_drafts 返回的当前指纹重开草稿事务，保留全部旧草稿，不修改作者源码。复用列表必须来自 reusable；源码冲突拒绝。',
      params: { script_hash: 'string', source_hash: 'string', manifest_hash: 'string', recovery_hash: 'string', reuse_scenes: 'string(可选，JSON场号数组，默认[])' },
      async run(args) {
        if (opts.readOnly || opts.publishOnly || guard && !guard.allow.some(re => re.test('scenes.src.js'))) return '拒绝：当前范围不允许重开场景草稿';
        try { return JSON.stringify(rebaseSceneDrafts(project, { ...args, reuse_scenes: JSON.parse(args.reuse_scenes || '[]') })); }
        catch (e) { return '写入失败：' + e.message; }
      },
    },
    run: {
      desc: '在项目目录执行白名单命令。生成视频用 node vh.mjs …',
      params: { command: 'string' },
      async run({ command }) {
        if (opts.readOnly && !safeRestrictedRead(command, project, path.join(VH_DIR, 'vh.mjs'))) return '拒绝：当前用户要求只读，不能执行有副作用的命令';
        if (opts.automation?.enabled && /vh\.mjs["']?\s+(?:build|measure|render|voice|go|pack|automation)\b/.test(command)) return '拒绝：自动制作只能用 run_stage 执行受控制作阶段，不能用 run 绕过严格质量关口或修改自动策略';
        if (opts.automation?.enabled && !safeRestrictedRead(command, project, path.join(VH_DIR, 'vh.mjs'))) return '拒绝：自动制作的通用 run 仅允许受限只读查看；写入使用作者工具，制作使用 run_stage，不能经解释器改回执/工具或绕过质检';
        if (opts.publishOnly && !safeRestrictedRead(command, project, path.join(VH_DIR, 'vh.mjs'))) return '拒绝：发布文案阶段不能执行写入或视频制作命令';
        /* 审阅不是改稿：允许实际画面体检与只读采样，拒绝借机改文件或重做媒体。 */
        if (review?.required) {
          const readOnly = /^\s*node\s+(?:["'][^"']*\/)?vh\.mjs["']?\s+(?:screen|layout|variety|contrast|density|stills|contact)\b/.test(command)
            || /^\s*(?:ls|cat|head|tail|wc|grep|rg|diff|stat|find)\b/.test(command);
          if (!readOnly) return '拒绝：这是审阅要求，只允许实际画面体检/静帧/只读查看；用户没有要求改稿或重做媒体。完成检查后只回答发现。';
        }
        if (/(?:^|[;&|]\s*)\s*(?:\/usr\/bin\/)?(?:open|osascript)\b|\bvh\.mjs["']?\s+preview\b[^\n]*--open\b/.test(command)) {
          return '拒绝：制作 agent 不自动打开网页或系统应用。返回文件路径，由用户自行打开。';
        }
        // 真实事故：模型用 `node -e "fs.writeFileSync('发布文案.md',...)"` 绕过受控编辑，
        // 文案改成功了，版本回执却没有更新，界面一直报“仍关联旧稿”。
        // 解释器只读可以；写作者文件必须走 patch_text / write_file，那里会同步版本。
        if (AUTHOR_FILE_NAME.test(command) && WRITE_AUTHOR_VIA_CODE.test(command)) {
          const target = AUTHOR_FILE_NAME.exec(command)?.[0] || '作者文件';
          return `拒绝：不要用 node/python 脚本直接改写 ${target}（会绕过版本校验并让文案与脚本对不上）。` +
            '请用 read_edit_file → patch_text 做短替换，或受控的 write_file / append_file；新文案会同步关联当前脚本。';
        }
        if (!ALLOW.test(command.trim())) return '拒绝：命令不在白名单（node/python3/ffmpeg/git/文本工具）';
        if (/\brm\s+-rf\b|\bsudo\b|\.\.\/\.\./.test(command)) return '拒绝：危险命令';
        if (opts.uncertainCommands?.includes(command)) return '拒绝自动重放：上次执行此命令时进程中断，结果未知。先只读核对产物；若仍需执行，告知用户并由用户确认，不能把未知当成未执行。';
        if (/\b(?:python3\s+-m\s+)?pip3?\s+install\b|\bnpm\s+(?:install|i)\s+(?:-g|--global)\b/.test(command)) return '拒绝：制作循环不安装用户级/全局依赖；请先由用户确认环境准备，不能临时改全局环境';
        if (guard && !safeRestrictedRead(command, project, path.join(VH_DIR, 'vh.mjs'))) return `拒绝：${guard.why}；run 在受限模式只允许项目内只读查询。写入用受控编辑工具，制作命令用 run_stage，不能经解释器绕过范围`;
        // 必须走 vh 命令：只拦"实际执行入口"。sed/grep/cat/Python open() 只是只读查看。
        const script = directPipelineScript(command);
        if (script) {
          const hint = script === 'render.mjs' ? 'vh render [--scenes N,M] [--crf 21]'
            : script === 'gen.mjs' ? 'vh build [--estimate]'
            : 'vh measure / vh voice --srt';
          return `拒绝：不要直接调用 ${script}（会绕过一致性守卫）。请用：node vh.mjs ${hint}。只读查看可用 sed/grep/cat。`;
        }
        // 复述式重复调用检测：同一条命令连续跑两次 → 提示它换做法
        const commandStamp = authorProgressStamp(project) + [...probeScopes(project, 'run', { command }).keys()].join('|');
        if (opts._lastCmd === command && opts._lastCmdStamp === commandStamp) return '（刚刚跑过同一条命令，结果同上。请换下一步，不要重复。）';
        opts._lastCmd = command;
        opts._lastCmdStamp = commandStamp;
        log(`  $ ${command}`);
        const runFile = path.join(project, 'out/.vh-run.json');
        const childMarker = childPid => {
          try {
            const current = JSON.parse(fs.readFileSync(runFile, 'utf8'));
            if (current.pid === process.pid) fs.writeFileSync(runFile, JSON.stringify({ ...current, childPid }));
          } catch {}
        };
        const r = await new Promise(resolve => {
          const child = spawn('/bin/zsh', ['-o', 'pipefail', '-lc', command], { cwd: project, detached: true,
            env: { ...process.env, VH_AGENT_PROJECT: project, VH_PRODUCTION_IN_STAGE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
          let registration;
          try { registration = registerToolChild(project, child.pid); }
          catch { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
          let output = '';
          const collect = data => { output = (output + data.toString()).slice(-6000); };
          child.stdout.on('data', collect); child.stderr.on('data', collect);
          childMarker(child.pid || null);
          let escalation;
          const stop = () => {
            try { process.kill(-child.pid, 'SIGTERM'); } catch {}
            escalation ||= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
          };
          const timeout = setTimeout(stop, 20 * 60 * 1000);
          opts.signal?.addEventListener('abort', stop, { once: true });
          if (opts.signal?.aborted) stop();
          child.on('error', () => { clearTimeout(timeout); resolve({ status: 1, out: '命令进程启动失败' }); });
          child.on('close', (status, signal) => {
            clearTimeout(timeout); clearTimeout(escalation); opts.signal?.removeEventListener('abort', stop);
            const exited = !registration || registration.unregister();
            resolve({ status: exited ? status ?? signal ?? 1 : 1, out: output + (exited ? '' : '\n制作工具组仍有活后代，保留进程登记与制作锁'), exited });
          });
        });
        if (r.exited !== false) childMarker(null);
        const out = r.out;
        log(out.split('\n').slice(-8).map(l => '    ' + l).join('\n'));
        return `exit=${r.status}\n${out}`;
      },
    },
    fetch_url: {
      desc: '抓取网页正文；assertion 填本次要核证的具体断言（非编号）。同一断言连续失败两次后停止换站重搜；未提供时至少按来源防重复失败。成功只证明取得正文，不代表事实核证通过。',
      params: { url: 'string', assertion: 'string（可选：本次要核证的断言原句）' },
      async run({ url, assertion }) {
        let ticket;
        if (!opts.readOnly) {
          try {
            const started = beginResearchAttempt(project, { url, assertion });
            if (started.blocked) return started.message;
            ticket = started.ticket;
          } catch (error) {
            return '拒绝：无法安全登记抓取尝试，未联网；请保留记录并检查：' + error.message;
          }
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.fetchTimeoutMs || 30000);
        const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
        try {
          let r = null, lastErr = null;
          for (let i = 0; i < 2 && !r; i++) {
            try {
              signal.throwIfAborted();
              r = await fetch(url, { signal, headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' }, redirect: 'follow' });
            } catch (e) { lastErr = e; if (signal.aborted) throw e; await new Promise(r2 => setTimeout(r2, 600)); }
          }
          if (!r) throw lastErr || new Error('fetch failed');
          if (!r.ok) { await r.body?.cancel(); throw new Error('HTTP ' + r.status); }
          const html = await readResponseText(r, { signal, limit: 4 * 1024 * 1024 });
          if (html.length < 200) throw new Error('返回内容过短（可能被拦截）');
          const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
             .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
          if (text.length < 200) throw new Error('返回正文过短（可能被拦截）');
          log(`  ⇣ 抓取 ${url}（${text.length} 字符）`);
          if (!opts.readOnly && !review?.required && ['article', 'topic'].includes(opts.mode) && reviewVersion(project) >= 3) {
            rememberReviewMaterial(project, 'url:' + url, { kind: 'fetched-text', url, finalURL: r.url, text, fetchedAt: new Date().toISOString() });
          }
          if (ticket) finishResearchAttempt(project, ticket, { ok: true });
          return text.slice(0, 24000);
        } catch (e) {
          if (controller.signal.aborted) e = new Error('抓取超时（含响应正文），请改用本地材料或其他来源');
          if (ticket) {
            const failureCode = controller.signal.aborted ? 'timeout' : opts.signal?.aborted ? 'cancelled' :
              /HTTP (\d{3})/.test(e.message) ? 'http-' + /HTTP (\d{3})/.exec(e.message)[1] :
                /过短/.test(e.message) ? 'short-body' : 'network';
            try { finishResearchAttempt(project, ticket, { ok: false, failureCode }); }
            catch { return '抓取失败：结果记录写入失败；本次结果未知，未宣称取得可用来源。请检查 out/.vh-research-attempts.jsonl，保留已有材料。'; }
          }
          log(`  ⚠ 抓取失败 ${url}：${e.message}`);
          return '抓取失败：' + e.message + '\n\n【本机网络受限时】改用本地材料；需要外部事实时在方案/脚本中注明待核与来源缺口' +
            (workflowPolicy(project).claimsRequired ? '，并登记到 claims.json' : '') + '；宁缺勿编。';
        } finally { clearTimeout(timer); }
      },
    },
  };
}

function visualFromSceneArgs(args) {
  const names = ['focus', 'hierarchy', 'restraint', 'rhythm'];
  return names.some(key => args['visual_' + key] !== undefined)
    ? Object.fromEntries(names.map(key => [key, args['visual_' + key]])) : undefined;
}

export function toolSchema(tools) {
  return Object.entries(tools).map(([name, t]) => ({
    type: 'function',
    function: {
      name, description: t.desc,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k, v.startsWith('array')
          ? { type: 'array', items: { type: v === 'array(string)' ? 'string' : 'object' }, description: v }
          : { type: v.startsWith('number') ? 'number' : 'string', description: v }])),
        required: Object.keys(t.params).filter(k => !/可选/.test(t.params[k])),
      },
    },
  }));
}

/* ---------------- 系统提示 ---------------- */
export function agentWorkflowPrompt(project) {
  return workflowPrompt(project) + '\n【当前政策优先于历史制作提示】旧消息中的强制两版、关键样片、形式分数/数字配额、审核表及全量重渲建议不再作为默认要求；用户明确要求与历史必需模型审稿合同仍保留。由执行器按当前文件选择最少失效阶段，不手改状态/回执，不强制重测、清缓存或全量渲染。' +
    (workflowPolicy(project).claimsRequired
      ? '\n本项目为审校模式或保留了 contentReview.required=true：claims.json 仍是必需关口，按真实来源登记，不自动启用新的模型审稿。'
      : '\n本项目不要求独立 claims.json 阶段；原文和关键出处仍保存在 research/ 与方案/脚本中，来源缺口如实注明，不虚构核证。');
}

// Apply current policy to the request only; saved system/user/tool history is
// evidence, not a place to rewrite old instructions after a workflow change.
export function currentAgentMessages(project, messages) {
  const policy = agentWorkflowPrompt(project);
  const firstSystem = messages.findIndex(message => message.role === 'system');
  const content = firstSystem < 0 ? '' : String(messages[firstSystem].content || '');
  return firstSystem < 0 ? [{ role: 'system', content: policy }, ...messages]
    : messages.map((message, index) => index === firstSystem
      ? content.endsWith(policy) ? message : { ...message, content: content + '\n\n' + policy } : message);
}

const SYSTEM = (project, vh, mode) => `你是 vh（视频 harness）里的制作 agent，在项目目录里干活。当前任务模式：${mode}。

【执行契约】阶段由程序按实际文件推进，本轮工具列表和末尾的当前关口是可执行接口。下文 CLI 命令只作人工参考；本轮未提供 run 时不得改用隐藏工具调用命令。制作命令用 run_stage；写场景直接按本轮给出的最小接口完成当前一场，不必为配方或特效反复查模板。首次文章是材料，不是限制写入的新插话。只读/审阅与用户插话始终优先。

${durationPrompt(project)}

【写文件边界（硬约束）】
${mode === 'edit-visual' ? '· 本次**只允许改画面**：scenes.src.js、engine.tpl.html。**不许动 脚本.md / 方案.md / claims.json**（用户会明确说要改才改）。' :
  mode === 'edit-script' ? '· 本次允许改：脚本.md、claims.json、scenes.src.js、发布文案.md。不要改 方案.md（除非用户要求）。' :
  mode === 'edit-copy' ? '· 本次只允许改：发布文案.md。不得重新渲染、配音或修改方案与脚本。' :
  '· 你负责从材料到成片的全流程。'}
· 越界写会被工具直接拒绝，别浪费步数去试。

【创作规则摘要（不必再去读 skill 文档）】
· 默认安静制作：不得调用 open、osascript、preview --open 或自动弹出网页；交付文件路径即可。headless 采样不等于打开用户浏览器。
· 取场景配方：node vh.mjs scene <配方> 默认只输出代码，不创建项目。不要创建 demo 项目；需要追加时才用 --append，或按当前脚本改写场景。
· 脚本格式：\`## S1 · 标题\` 分场，场内 \`1. 2. 3.\` 编号旁白；每场结尾一行 \`← 依赖：…\`（只能指向更早的场）；文末 \`## 术语\` 表 + \`## 数字与来源\` 表。
· 默认不自动调用模型内容审稿，写完并自查脚本、核对依据后直接制作分镜；不得因新建、提交脚本、改稿或续跑自行启用 review_content。仅项目明确要求审稿时才执行相应关口；可选审稿不代替事实核证、试听或人工发布审阅，未执行不标通过。
· 讲清楚：方案.md 必写「受众基线：已经知道 / 不知道」；术语首现要让目标观众理解。开场先说清主题、为什么讲和要回答什么，再用服务主线的例子；不强求悬念、反转或固定句式。
· 先通旁白再做画面：写完脚本先只读编号口播，不看标题、术语表、依赖行。主体首现说它做了什么或经历什么，不只报身份；用必要的具体例子解释条件怎样带来变化、结果怎样支持判断，不只列数字。方案中影响结论的关键限定必须进入旁白；删重复和支线，不删必要推导凑句长。自查不代表已经试听或观众听懂。
· 内容生成不是摘要拼接：先在方案写连贯讲述底稿，再分场、编号和切字幕。分清观察结果、机制假说与干预效果：相关不当因果，机制猜想不当有效干预；各来源只支持各自核到的环节，不跨来源硬拼证据，证据不足收窄结论。开头先解释对象与问题，不先报分数和限制。
· 假设或简化算例当场明说，交代设定条件，不当实测；类比说清两边对象、相似环节与差别，不把相似说成同一机制。故事/恐怖题材让人物遇事、判断、行动并承受后果，不用概念总结替代经历。
· 用户说“没听懂/逻辑跳步”时先改旁白的推导与场间承接，不先加动画或换版式；用户催交付时不扩展可选方案。集中一轮批量修稿；正式出片前看 plan，只执行失效步骤，不为试版式反复渲染 MP4，不关闭质量检查换速度。
· 文章改编：先读原文，在方案.md 写原文主题、核心判断、论述顺序和视频段落映射。默认沿原文主线，允许压缩与补足前提；不要让局部案例或表格取代整篇主旨，除非用户明确要求。
· 认为原文有误前先对照准确原句和可靠来源的对象、基数、时间、题目及单位；证据不足标待核，不把自己的推测说成原文错误。
· 深度：按内容讲清机制、条件和必要例子；vh depth 的句数、字数与关键词是检查线索，不为指标凑句子或添加无关信息。默认时长由内容决定，不先设分钟数再削薄讲述；只有用户明确要求限时时才在方案记录上限。
· 画面先决定内容和观看顺序：主体、辅助、背景要有关系；有证据或机制时展示具体对象，不为凑对象堆卡片。结论场可以有意留白。
· 默认视觉基线是「少组件、多空间」：优先留白、尺度、裁切、发丝线与同一主体的状态变化；卡片只表示真实独立对象（界面、文件、套餐、证据），不能用连续白底卡片替代机制。相邻场若没有新的关系或观察角度，不要只换标题和卡片文案。
· 秩序：明确第一眼的焦点和信息层级，不强制对称或相邻场换版式。克制：每条装饰、光与动作先说明作用；无益则省略。韵律：只在内容需要时切换尺度、明暗或取景。允许静止，不为指标增加动效。
· 字幕区由安全区决定；优先现有 VH_UI/VH_LAYOUT 与 VH_FILM，不因可用就叠加 FX；\`abs(mk(...))\` 定位、\`type(el,'h1'|'body'|'note')\` 定字号、\`enter(el,t,at,{dy,blur})\` 入场、\`P(t,起点,时长)\` 取进度；**不要用 \${} 模板字符串**。
· **可读性（必须自查，别等观众看不清）**：任何文字与它实际所在的底色至少 4.5:1（大字 ≥24px 或粗体 ≥19px 可 3:1）。
  灰字是最常翻车的地方：\`--ink3\`/\`--mut\` 一类次要色写在深色卡片上常常只有 3.x:1，小字号直接糊掉。
  次要信息也是信息，不要用"看起来更淡"来降级；要弱化就减字数、换位置，而不是把字调灰。
  写场景时先决定底色，再选字色；不要照抄别的主题的 \`var(--ink3,#6b7382)\` 这类深色主题回退值到浅底上。
  主动审校时可用：\`node "${vh}" contrast\`（按每个元素真实底色算 WCAG 对比度，报具体场景与颜色；不是默认前置阶段）。
· 长片场景用 \`write_scene({scene: 1, content: "root => { ... }"})\` 每次写一场，草稿保存在 out/；全部写齐后用 \`assemble_scenes({})\` 组装 scenes.src.js，再跑 build。不要一次输出十场，也不要只口头说“下一步写”。

【可选版式参考（按需，不是前置检查）】
\`node "${vh}" pick\` 会按旁白线索给每场一个建议 + 依据（有数字→条形对比，有先后→三步流程，
讲界面→窗口实拍，一句判断→大字断言）。**它会说"没把握，你定"——那就是你定，不要硬套。**
现状分布用 \`node "${vh}" variety\` 看：连续同版式、单版式占比过高都会报。

【版式配方（别每次从头手写坐标——90% 的画面翻车都在手算位置）】
用 \`node "${vh}" scene <配方>\` 生成可直接跑的骨架，再把文字换成你的内容：
· hero-statement（大字断言）：一个结论、一句判据、开场钩子 → 一屏只留一句
· compare-bars（条形对比）：两个量比大小（价格/占比/耗时）→ 长度比读数字快
· process-steps（三步流程）：有先后、有依赖 → 顺序本身是信息
· window-walkthrough（窗口实拍感）：讲"机器里发生的事" → 真实界面比示意图可信
· one-take（一镜到底）：同一主体多层推进 → 不切镜，靠推拉与文案交接换场
配方一律用 window.W / window.H 算坐标（横竖屏都能跑）；卡片别压字幕安全区（1080p 下 840px）。
用户主动要求视觉审核或启用审校模式时，可用 \`node "${vh}" contact\` 总览，再用 stills --at 看疑点 —— 只截每场中点会漏掉运镜中段（
真实事故：one-take 第 8 秒主体被推出画面，整屏空白，而按中点截图的检查全绿）。
\`node "${vh}" density\` 会按像素量"这一屏到底有多少东西"，空屏/大白卡片/主体出画都会报。

【讲述检查是提示，不是创作配额】
Muller 的研究针对特定教学情境中的既有误解，不证明所有视频都必须先误导观众。
有真实误解时可以纠正；操作说明、简报可以直接交代目标，不捏造反转。

1. **开场交代主题与去向**（vh hook 仅供提示）。真实疑问或误解可以作为入口，但无需强行设问、悬念或反常识断言；不能为了钩子让观众不知道这期讲什么。
2. **叙事弧仅作可选参考**（vh arc）：适合事故或冲突叙事时，可以检查背景、障碍、结果和影响；不必为了 ABT 或四段式编造冲突，更不能让结构代替原文主线。
3. **提出的问题要有交代**（vh loop）：需要回答的真实问题应在适当位置得到回答；不必强行设问或固定回答间隔，关键词匹配不能代替审稿。
4. **数字按需解释**：统计数字说清对象、单位、范围与比较基准，比例交代分母，不同口径不直接相除；例子为解释变化与因果服务，不设比例或次数配额。

【画面导演：先演事情，再排文字】
1. 先让观众认出对象，再展示条件改变后的状态；机制段不能用名词卡替代。数字用共同基线或前后对照呈现，旁白解释变化，不反复读标题。
2. 同一对象连续演进时，保留位置、编号或颜色参照；镜头只在需要观察新细节时推近。曲线近旁直接标注名称、单位和必要条件，减少对照图例；示意曲线不冒充实测。能延续主体就不另起同构白卡。
3. 真实照片/证据与原创示意分清。几何、形变、载荷若是说明用的，明示非仿真，不印假测量值。
4. 字体/色彩保持角色统一，允许为内容定制设计系统。现有 type / tokens 对 SVG 等覆盖有限；没识别到不算通过。
5. 静止可用于阅读与落点。不得为了 alive 分数添加无意义 drift；像素变化、版式数量、转场种类都不等于审美或讲清楚。
 6. 运动优先已有 SVG、transform / opacity 与 window.VH_FILM，把同一对象的状态变化接到旁白；不增加重型 FX / 3D 或默认素材搜索，不减画质。若本轮说明已启用按场混合，允许为具体讲解使用轻量 SDF；不强制。旧项目可显式 node "${vh}" enhance --film（有备份）。
   优先 const at = VH_FILM.sceneCue(root,'本场唯一触发句')；直接返回场内秒，无需手抄起点。也可 sceneCue(root,3) 取本场第3句（改句序须复核），句尾用 {edge:'e',offset:-.2}。缺句/歧义/越界会报错，不许退回0秒。
   compileMotion 的 cue 支持 {text:'唯一句'} 或 {line:3}。cameraAt / applyCamera 运镜，projectPoint 跟随标注，trace 描画变化；重测后这些锚点自动更新。
   可用 run 执行 cat "${path.join(VH_DIR, 'references/cinematic-direction.md')}" 读最小例子；不要把 comet 的机身造型套给所有主题。
7. 按内容制作简洁画面；两版试稿与关键样片仅在用户要求时另做，不作为默认制作关口。检查真实变化，不拿片头证明能力。
   素材、相机、文案的层级可不同，避免图表曲线与主对象结构线重叠。
8. // @transition cut|fade|push|wipe 按叙事选择；不为凑数换转场。保留 VH_UI.motion 的 countTo / slideTo / growTo 用于有意义的数值与状态变化。
9. 用户指定 Anthropic / OpenAI / OpenDesign 等视觉参考时，实际查看具体作品，再把观看顺序、主体连续性、字体分工和运动关系转译到当前内容；不把品牌名当皮肤或照搬 Logo。
    复制、替换、拆分、汇入等动作应演示内容关系，不只是给文字套入场特效。

【真实素材（别用 CSS 画框假装截图）】
讲产品就放真截图：\`node "${vh}" asset add ~/Desktop/shot.png\` 收进项目，
场景里用 \`VH_UI.shotEl(root, 'assets/shot.png', x, y, w, h, { mark: [0.1,0.2,0.5,0.3], tag: '看这里' })\`
（mark 是相对比例，会自动加聚光遮罩）。视频用 \`VH_UI.videoEl\`（每帧由 renderAt 决定，可复现）。
数据用 \`node "${vh}" asset csv data.csv\` 生成真 SVG 图（有坐标轴刻度，不是几个 div 假装），
再 \`VH_UI.chartEl(root, <内联 svg>, x, y, w, h)\`。
\`node "${vh}" asset check\` 会报"引用了不存在的文件"（那种情况画面是空白，而且不报错）。

【命令】
\`node "${vh}" status | build | measure | render [--scenes N,M] | voice [--srt] | stills [--at 3,8] | contact | density | variety | fit | pick | subtitle | asset | alive | hook | arc | loop | concrete | verify | reflect | type | tokens | rhythm | motion | transition | sizes | go | clarity | depth | pack\`

【引擎接口是固定的，别反复查模板】
engine.tpl.html 提供的就这些，写 scenes.src.js 时直接用，不需要 grep 源码：
· 元素：\`mk(tag, cls, html)\`、\`abs(el, x, y, w, h)\`、\`type(el, 'h1'|'body'|'note')\`；\`line(text, cls)\` 返回 \`{el, set(p)}\`，定位与字号操作用它的 \`.el\`
· 动画：\`enter(el, t, at, {dy, blur})\`、\`P(t, 起点, 时长)\`、\`pop(el, p, dy)\`；背景用 \`bg(root)\`
· 特效：\`window.FX\`（fxCanvas / glyphField / streaksInto / horizon / orbit / grain / breathe）
· 组件：\`window.VH_UI\`（windowMock / codeLine / glyphLayer / chartEl / shotEl）
· 场景：每块只写 \`root => { ...; return { render(t){} }; }\`，块间用 \`//---\` 分隔；块数等于脚本场数。不要手写 addScene 调用或起止时间，build 会注入。
· 坐标用 \`window.W\` / \`window.H\` 算，别写死像素
· 同一版本模板的无界搜索超过 6 次会被拦下；确需核对时用 read_file 的 start_line/max_lines 读具体范围。优先写一场可运行代码验证，不反复整份猜接口。

【改稿后的收尾（最容易漏，必须做）】
· 当前交付目标：${deliveryTarget(project) === 'video' ? '仅视频，不强制发布文案' : '视频＋发布包；全流程必须补齐发布文案并通过机械校验，人工审查不自动勾选'}。
· 回看用户的全部明确要求：除视频外若另要文章或其他成果，须单列产物与路径；尚未完成或当前模式无法写入时明确报告，不能把视频完成说成全部完成。程序的默认视频/发布包检查不保证识别所有自然语言要求。
· 改稿后由执行器检查 build / measure / render / voice 的真实失效原因，只补所需阶段；已有有效实测不退回估算，不手改状态或指纹。纯画面修改不重测旁白。
· measure 会复用刚测好的逐句音频导出风险句小样（out/voice-samples）；也可在画面之前用 voice-sample。生成不等于试听，ASR差异只记疑点，音素合理也不能证明听感。不要为一个转写差异无界改稿/整片重渲。
· 首个完整可看版本出来就主动给路径、是否最新、待审项；后续只修阻塞问题，别让用户催问才能拿到文件，不用未经实测的“最后几分钟”。
· cover 默认独立三比例排版并生成320px缩略图；不再先抽正文当封面。需要正文底图须显式 --style frame。
· 是否要求发布审阅由当前工作流决定；未看/未听就说明未验证，不为完成任务补签审核表。机器检查和打包不等于人工审阅或发布授权，不改指纹保留旧 pass。
· 来源 quote 只能写对应来源的原文；本机实测登记可核对的本地原始记录，不能把自写结果附进外部原文凑检查。证据不足就保留待核或删减断言，不靠更改标签、指纹或清单洗成通过。

【广告场（最容易出事）——硬规矩】
· **用户明确给出的内容，优先级高于你抓到的页面**：品牌名、链接、优惠码、卖点、价格口径，
  不要用"页面上没写"擅自删除用户要求；用户提供与外部核实分别登记，不能把用户说法冒充页面已核实。
  （真实事故：用户明说"S9JE6G 就是优惠码"，agent 因为首页没写"优惠码"就把指令绕开了，
   改写成价格与三条要点——用户要的是"简单点"，结果被执行成了"更复杂"。）
· **用户说"简单点 / 别太详细"→ 就真的简单**：只写链接 + 用户点名的要素（如优惠码）。
  不要自作主张补价格、前提、三条要点或用户未要求的风险提示、劝诫和评价。宁可短，不要加戏。
· 逐项对照用户要求检查广告口播、字幕、画面、简介与置顶评论。若已知重要服务限制或法律、平台要求与用户口径冲突，单独说明并确认，不隐瞒，也不擅自加进广告。
· 只有用户**没给**链接或卖点时，才用 fetch_url 补缺；抓取用于"补缺"，不用于"改口"。
· 抓不到 → 明说"我没法核实这个链接"，列出需要确认的事，**不许凭印象编**。
· 每段广告必须有一句"这是广告"的声明。
· 用户提供的推广信息在方案/脚本中注明「广告 · 用户提供」；需要 claims 时同样登记，不冒充外部核实。
· **用户点名的禁词就是禁词**：例如"不要提代充"——脚本、字幕、画面、发布文案里都不能出现，
  换一种中性说法讲清"这是什么、怎么用"。禁词不是建议，删掉这句就是没执行。
· **用户没给文案时，你负责写具体的话**：不要只留"链接见下"这类占位，也不要复述整篇原文；
  一段自然的口播（2–4 句）+ 画面上的链接与推广码即可。

【工作方式】
1. **先产出，再完善**：先读完必要的原文与用户要求，再写文件；其他参考按需读取，不做无界探索。
2. 每写完一个文件或跑完一步，回报一句。
3. 完成后总结：做了什么、产物在哪、哪些没验证。
4. 系统提示里若带有「本任务已做过的动作」台账，那是执行记录。同一文件不必反复整份重读；只读你确实需要的片段或行段。台账没写全不等于没做，别据此重做。
5. 单次执行有步数预算（默认 400 步）。接近上限时先把当前文件写完整、把进度留在磁盘上，不要留半截文件；达到上限会暂停并可继续，不算失败，也不会重做已完成步骤。
6. 反复读同一份 harness 源码通常说明你在猜接口。优先看 vh --help、现有项目文件与自己刚跑出的输出；确需源码时只读相关函数那一段。
7. 用户说明本片已发布、只要求以后吸取教训时，不修改或重做已发布内容；只有收到明确改片要求才另行制作。

${agentWorkflowPrompt(project)}`;

/* 哪些模式以"出片"为完成标准：只有从材料到成片的 full 流程。
 * 改画面/改稿/改文案是单点修改，不应因为项目没有成片就被判为未完成。 */
function requiresDeliverable(mode) {
  return mode === 'article' || mode === 'topic';
}

/* 关键产物（判断"是不是光汇报没干活"） */
function criticalMissing(project, mode) {
  const f = (n) => fs.existsSync(path.join(project, n));
  if (!requiresDeliverable(mode)) return [];      // 单点修改不要求重造全套
  const missing = [];
  if (!f('方案.md')) missing.push('方案.md');
  if (workflowPolicy(project).claimsRequired && !f('claims.json')) missing.push('claims.json');
  if (!f('脚本.md')) missing.push('脚本.md');
  if (!f('scenes.src.js')) missing.push('scenes.src.js');
  return missing;
}

/* 成片是否落后于源文件：完成不等于"生成了一个视频"，而是产物不比源文件旧。 */
function deliverableStale(project) {
  return deliverableState(project);
}

/* 收尾校验：产物是否一致（脚本改了但没重测/重渲 = 不一致） */
function finalCheck(project, log) {
  const st = loadState(project);
  const scriptNow = (() => { try { return fs.readFileSync(path.join(project, '脚本.md'), 'utf8'); } catch { return ''; } })();
  const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); };
  const hash = fnv(scriptNow);
  const measured = st.lastMeasure && st.lastMeasure.scriptHash;
  const warns = [];
  if (scriptNow && measured && measured !== hash) warns.push('脚本改过但没重新测量 → 时间轴与字幕可能不一致，由执行器核对失效的 build / measure');
  if (st.render && st.render.dur && fs.existsSync(path.join(project, 'scene.html'))) {
    const sceneDur = +(fs.readFileSync(path.join(project, 'scene.html'), 'utf8').match(/DURATION\s*=\s*([\d.]+)/) || [])[1];
    if (sceneDur && Math.abs(sceneDur - st.render.dur) > 0.5) warns.push(`成片时长 ${st.render.dur}s 与当前时间轴 ${sceneDur}s 不一致 → 需要重新渲染`);
  }
  const deliverable = deliverableStale(project);
  /* 交付物还没做出来（而不是"做出来但过期了"）是进度状态，不是不一致。
   * 任务中途暂停时把它写进"收尾检查发现不一致"，会让用户以为出了问题。 */
  if (deliverable.stale && deliverable.reason && !/还没生成|还没渲染|还没配音/.test(deliverable.reason)) {
    warns.push(deliverable.reason);
  }
  for (const w of warns) log('⚠ 收尾检查：' + w);
  return warns;
}

/* ---------------- 多轮记忆 ----------------
 * 为什么要有：指挥是"边看边改"的场景，用户会说"按刚才那个思路""再压短一点"。
 * 不带历史的话，每条指令都得从头说清，实际不可用。
 * 做法：只存「用户说了什么 + 这一轮做了什么（工具摘要）」，不存完整对话（省 token）。
 */
const MEMORY_FILE = (p) => path.join(p, 'out', '.vh-chat-memory.json');
const MEMORY_MAX = 8;          // 保留最近 8 轮

export function loadMemory(project) {
  try { const d = JSON.parse(fs.readFileSync(MEMORY_FILE(project), 'utf8')); return Array.isArray(d) ? d : []; }
  catch { return []; }
}

export function saveMemory(project, entry) {
  const all = loadMemory(project);
  const index = entry.taskId ? all.findIndex(m => m.taskId === entry.taskId) : -1;
  const next = { at: new Date().toISOString(), ...entry };
  if (index >= 0) all[index] = next; else all.push(next);
  const trimmed = all.slice(-MEMORY_MAX);
  try {
    fs.mkdirSync(path.join(project, 'out'), { recursive: true });
    fs.writeFileSync(MEMORY_FILE(project), JSON.stringify(trimmed, null, 2));
  } catch {}
  return trimmed;
}

/* 把记忆压成一段提示（只给结论与动作，不给完整对话） */
/* 把当前要求清单压成一段提示（每次运行都带上） */
function briefBlock(project) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(project, 'out', '.vh-brief.json'), 'utf8'));
    const lines = [];
    if (b.must?.length) b.must.forEach(m => lines.push('  ✓ 必须：' + m));
    if (b.mustNot?.length) b.mustNot.forEach(m => lines.push('  ✗ 不许：' + m));
    if (b.facts?.length) b.facts.forEach(f => lines.push(`  = 用户认定的事实：${f.subject} 就是 ${f.is}`));
    if (b.urls?.length) b.urls.forEach(u => lines.push('  ↗ 链接：' + u));
    if (!lines.length) return '';
    return `\n【用户对本次产出的明确要求（优先级最高，不许绕开）】\n${lines.join('\n')}\n` +
      `  说明：用户认定的事实（如"X 就是 Y"）直接采用，**不要用你抓到的页面去否定它**；` +
      `用户说"简单/不要详细"就真的别加戏。\n`;
  } catch { return ''; }
}

function memoryBlock(project) {
  const mem = loadMemory(project);
  if (!mem.length) return '';
  const lines = mem.slice(-6).map((m, i) =>
    `${i + 1}. 用户：${String(m.user || '').slice(0, 120)}\n   结果：${String(m.summary || '').slice(0, 160)}`);
  return `\n【最近几轮（供理解指代，不要重复已完成的工作）】\n${lines.join('\n')}\n`;
}

/* 判定"读 skill 文档/参考脚本"：这类读取不产生产出，读多了就是在猜接口。
 * 覆盖三种形式：read_file 读项目外文档、run 里 cat/grep 参考目录、list_files 翻 skill 目录。 */
const SKILL_DOC = /article-video|references\/|skills\/|\.config\/opencode/;
function isDocPoke(name, args) {
  try {
    if (name === 'read_file') {
      const p = String(args.path || '');
      return SKILL_DOC.test(p) && /\.(md|mjs|js|html|txt|json)$/.test(p);
    }
    if (name === 'list_files') return SKILL_DOC.test(String(args.path || ''));
    if (name === 'run') {
      const c = String(args.command || '');
      if (!SKILL_DOC.test(c)) return false;
      // 只读命令算；写/跑构建不算。
      return /^\s*(cat|head|tail|less|more|grep|rg|sed|awk|wc|ls|find|diff|stat)\b/.test(c) ||
        /^\s*(cat|head|tail|grep|rg|sed|awk|wc)\b/.test(c);
    }
  } catch {}
  return false;
}

/* 读取按内容版本和范围计数；只有对固定模板的无界 grep 合并计数。 */
const READ_ONLY_CMD = /^\s*(cat|head|tail|less|more|grep|rg|sed|awk|wc|ls|find|diff|stat|strings)\b/;
function probeScopes(project, name, args) {
  const out = new Map();
  try {
    const add = (file, scope) => {
      const abs = path.resolve(project, file), stamp = fileStamp(project, file);
      if (stamp) out.set(abs + '\0' + stamp + '\0' + scope, path.relative(project, abs));
    };
    if (name === 'read_file' && typeof args.path === 'string') {
      add(args.path, JSON.stringify([Number(args.start_line) || 0, Number(args.max_lines) || 0, Number(args.max_bytes) || 20000]));
    } else if (name === 'run' && READ_ONLY_CMD.test(args.command || '')) {
      const c = args.command.trim();
      const range = /\bsed\s+(?:-n\s+)?["']?(\d+(?:,\d+)?p)\b/.exec(c)?.[1];
      const tokens = [...c.matchAll(/"([^"]*)"|'([^']*)'|([^\s;|&]+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
      for (const token of tokens) {
        if (!/\.(?:html|mjs|js|md|json|txt|py|ts|css)$/.test(token)) continue;
        const templateLookup = /^(?:grep|rg)\b/.test(c) && path.basename(token) === 'engine.tpl.html';
        add(token, range ? 'lines:' + range : templateLookup ? 'template-lookup' : c.replaceAll(token, '<file>'));
      }
    }
  } catch {}
  return out;
}

/* 从实际文件推导下一关，不修改用户进度表，也不把勾选当成验收。 */
function nextWorkAction(work, sceneWork) {
  if (!work?.tool) return '';
  const target = work.path || (work.stage === 'draft_scenes' ? sceneWork ? 'S' + sceneWork.scene : 'scenes.src.js' : '');
  return '下一步：' + (work.tool === 'run_stage' ? `run_stage({stage:"${work.stage}"})`
    : work.tool + (target ? ' → ' + target : '')) + '。\n';
}

export function nextAgentStep(project, mode) {
  const exists = name => fs.existsSync(path.join(project, name));
  if (mode === 'edit-copy') return '只处理发布文案.md：先读脚本和已有文案，再补齐必填项或修复占位符；不重做视频。';
  if (!requiresDeliverable(mode)) return '只推进本次用户指定的修改范围；检查实际文件与 vh status，不重建项目。';
  for (const name of ['方案.md', '脚本.md']) {
    const document = authorDocumentState(project, name);
    if (!document.ok) return `${document.reason}；保留已有内容，用 append_file 继续分批补齐，写完用 finish_draft 提交当前全文版本，不重新初始化项目。`;
  }
  if (workflowPolicy(project).claimsRequired && !claimsDocumentState(project).ok) return '先用 append_file / patch_text 补齐有效 claims.json，保留已有方案与脚本，不重新初始化项目。';
  const scenes = parseScript(fs.readFileSync(path.join(project, '脚本.md'), 'utf8')).length;
  const chunks = parseChunks(path.join(project, 'scenes.src.js')).length;
  if (!scenes) return '脚本.md 尚无可解析的编号旁白；先按 ## S1 · 标题及编号句式修正脚本。';
  const sceneState = sceneAuthoringState(project);
  const currentDrafts = sceneDraftStatus(project);
  if (scenes !== chunks || sceneState.needed || currentDrafts && !currentDrafts.stale && !sceneAssemblyMatches(project)) {
    const drafts = sceneDraftStatus(project);
    const draftHint = drafts?.stale ? (sceneAssemblyMatches(project)
      ? '所有草稿已组装到 scenes.src.js；如上次组装中断，可用 assemble_scenes 核对补记清单，不必重写原文件。'
      : '分场草稿的脚本/原文件基线已改变，先核对，不能自动覆盖。')
      : drafts ? `分场草稿已保存 ${drafts.present.length}/${drafts.count} 场；${drafts.missing.length ? `下一场先写 S${drafts.missing[0]}。` : '下一步用 assemble_scenes 组装，然后 build。'}` : `用 write_scene 每次保存一场完整场景，${scenes} 场写齐后用 assemble_scenes 组装。`;
    return `脚本有 ${scenes} 场，scenes.src.js 有 ${chunks} 块，${sceneState.needed ? sceneState.reason : '尚未对应或尚未组装'}。${draftHint}每块 root => { ...; return { render(t){} }; }。保留已写方案、脚本与 claims；不要继续整份查模板。`;
  }
  if (!exists('scene.html')) return '场景块已齐；由执行器选择 build，按实际报错修正，不重复探索模板。';
  if (!exists('timing.json')) return '场景块数已对应，但不代表代码或视觉已验收；由执行器核对并补缺失的 build / measure，处理第一条报错。';
  return '由执行器核对过期关口，只补失效的 build / measure / render / voice，再检查交付物；不强制全量重渲。';
}

/* 恢复时清理历史里堆积的重复固定提示。
 * 只处理 harness 自己生成的提示（带固定标记），不碰用户原文与补充要求。
 * 真实事故：14 次恢复把"【继续原任务】"堆了 14 份，"【停止探索】"堆了 3 份，
 * 每次请求重发一遍，白占上下文。 */
const NOTICE_MARKERS = ['【继续原任务】', '【停止探索，现在就必须推进】', '【旧任务接续：没有可用的历史执行检查点'];
function collapseRepeatedNotices(messages) {
  const seen = new Set(), out = [];
  const originalUser = messages.find(m => m.role === 'user');
  for (const m of messages) {
    if (m !== originalUser && m.role === 'user' && typeof m.content === 'string') {
      const marker = NOTICE_MARKERS.find(k => m.content.startsWith(k));
      if (marker) {
        // 同一类提示只保留最后一份（最近的那次最有信息量）
        if (seen.has(marker)) {
          for (let i = out.length - 1; i >= 0; i--) {
            if (out[i] !== originalUser && out[i].role === 'user' && typeof out[i].content === 'string' && out[i].content.startsWith(marker)) { out.splice(i, 1); break; }
          }
        }
        seen.add(marker);
      }
    }
    out.push(m);
  }
  return out;
}

/* ---------------- 主循环 ---------------- */
export const DEFAULT_STEP_BUDGET = 400;

async function automatedDeliveryCheck(project) {
  try {
    exportSubtitles(project);
    const { productionQuality, productionQualityStatus } = await import('./production-quality.mjs');
    const profile = workflowPolicy(project).qualityProfile;
    const current = productionQualityStatus(project, { profile });
    const report = current.ok ? current : await productionQuality(project, { phase: 'final', profile, reuseRendered: true });
    return report.ok ? 'exit=0\n自动制作机器质量检查通过；非人工审片、非事实语义或发布授权。'
      : 'exit=1\n自动质量闸门未通过：' + JSON.stringify(report.checks?.filter(c => c.ok === false) || report);
  } catch (error) { return 'exit=1\n检查执行失败：' + error.message; }
}

function deliveryAnswer(project, { automated = false } = {}) {
  const result = projectDeliveryState(project);
  return (automated ? '自动制作完成' : '当前版本交付物机械检查通过') + '：\n' +
    '视频：' + path.resolve(project, result.video) + '\n脚本：' + path.join(project, '脚本.md') +
    (result.publish?.required ? '\n发布文案：' + path.join(project, '发布文案.md') : '') +
    '\n未验证：实际试听、人工审片与事实语义核验；未自动发布。';
}
/* 连续多少次请求都没有改动作者文件，就算"没有推进"。
 * 真实事故：400 步里第 367 步才第一次写方案，其余都在反复查模板/源码。 */
export const DEFAULT_STALL_STEPS = 60;
export const STALL_PAUSE_EXTRA = 40;
export function readStallSteps(env = process.env) {
  const raw = Number(env.VH_AGENT_STALL_STEPS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_STALL_STEPS;
}
/* 作者文件的指纹：只有真正的产出变化才算推进，读多少文件都不算。
 * 包含中间产物：build 生成的 scene.html、measure 生成的 timing.json、
 * render/voice 生成的成片与字幕 —— 这些也是实打实的推进。 */
const AUTHOR_FILES = ['方案.md', '脚本.md', 'claims.json', 'scenes.src.js', 'engine.tpl.html', 'timing.json',
  '发布文案.md', 'out/.vh-publish-revision.json', 'scene.html', 'out/video.mp4', 'out/video-voice.mp4', 'out/subtitles.srt',
  'PROGRESS.md', '审查.md', '审查-解释.md', 'out/voice.mp3', 'out/scene-audio.wav'];
function authorProgressStamp(project) {
  const drafts = sceneDraftStatus(project);
  return AUTHOR_FILES.map(name => name + ':' + (fileStamp(project, name) || '-')).join('|') +
    (drafts ? '|scene-drafts:' + drafts.manifestHash + ':' + drafts.present.map(i => i + ':' + fileStamp(project,
      `out/.vh-scene-drafts/${drafts.generation ? 'generations/' + drafts.generation + '/' : ''}S${i}.js`)).join(',') : '') +
    ['方案.md', '脚本.md'].map(name => '|submission:' + name + ':' + fileStamp(project, 'out/.vh-author-drafts/' + name + '.json')).join('');
}
export function readStepBudget(env = process.env) {
  const raw = Number(env.VH_AGENT_STEPS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_STEP_BUDGET;
}

/* A user edit on a finished film should not require the model to scan a
 * 900-line scene just to find where to append. Hand it the exact anchors and
 * current hashes so the first turn can be a write. Excerpts are bounded and
 * read-only; this does not bypass the base_hash CAS check. */
export function authorEditAnchors(project) {
  const out = [];
  for (const name of ['脚本.md', 'scenes.src.js']) {
    let text = '';
    try { text = fs.readFileSync(path.join(project, name), 'utf8'); } catch { continue; }
    const hash = createHash('sha256').update(text).digest('hex');
    const lines = text.split('\n');
    const isScript = name === '脚本.md';
    const from = isScript ? Math.max(0, text.lastIndexOf('\n## S', text.length - 2) >= 0
      ? text.slice(0, text.lastIndexOf('\n## S', text.length - 2)).split('\n').length - 1 : 0) : Math.max(0, lines.length - 30);
    const tail = lines.slice(from).join('\n');
    out.push(`\n【${name} 当前版本】base_hash=${hash}（共 ${lines.length} 行）` +
      (isScript ? `\n最后一个场次起的内容（在此之后追加新场，或在此处精确替换）：\n\`\`\`\n${tail.slice(-2500)}\n\`\`\``
        : `\n文件末尾（在此之后用 //--- 追加一场）：\n\`\`\`\n${tail.slice(-2000)}\n\`\`\``));
  }
  return out.join('\n');
}

/* The user's request may be about a visual fact the code cannot reveal by
 * reading it ("subtitles cover the text"). Measure it with the existing
 * deterministic checkers and hand over the finding. Cheap path only: no
 * browser, no rendering, no writes. */
export async function measuredEditFindings(project, request = '') {
  const out = [];
  const text = String(request || '');
  const wantsLayout = /字幕|遮挡|遮住|挡住|压住|遮|重叠|越界|溢出|看不清|版式|排版|文字|画面/.test(text);
  if (!wantsLayout) return '';
  try {
    const { fitPlan } = await import('./subtitle.mjs');
    const plan = fitPlan(project);
    const bad = (plan.scenes || []).filter(s => s.lines >= 3);
    if (bad.length) {
      out.push('【已实测的字幕占位】以下场次字幕排到 3 行，正文安全底边被压到 ' +
        bad.map(s => `S${s.n}=${s.safeBottom}px`).join('、') +
        '（其余场次为 ' + Math.max(...(plan.scenes || [{ safeBottom: 0 }]).map(s => s.safeBottom)) + 'px）。' +
        '\n解法二选一（不要删旁白）：把这些场的正文元素上移/收窄，或让该场文案更短以把字幕压回 2 行。');
    } else {
      out.push('【已实测的字幕占位】所有场次字幕均为 2 行以内，未测量到字幕压正文；用户看到的重叠可能来自具体元素，需按下面清单定位。');
    }
    if (Array.isArray(plan.scenes)) {
      out.push('各场字幕行数：' + plan.scenes.map(s => `S${s.n}:${s.lines}行`).join(' '));
    }
  } catch (error) { out.push('【字幕占位实测未完成】' + error.message + '；不要在代码里猜，先修检查器或改用 vh subtitle 复核。'); }
  try {
    const { analyze: layoutAnalyze } = await import('./layout-check.mjs');
    const lr = layoutAnalyze(project);
    const findings = (lr.findings || []).slice(0, 8).map(f => '- ' + (f.msg || f.message || JSON.stringify(f)));
    if (findings.length) out.push('【静态版式体检发现】\n' + findings.join('\n'));
  } catch {}
  return '\n' + out.join('\n') + '\n（以上是程序实测结果，不是让你再去读文件推导；直接按位置改。）\n';
}

/* Turn the quality gate's location list into concrete file/line edits. The
 * quality report has times and quotes but not source coordinates; resolve the
 * quoted text in the actual scene source so a resumed repair is actionable
 * instead of another generic "go fix contrast" round. */
export function repairHints(project, reason = '') {
  const quoted = [...String(reason).matchAll(/「([^」]{2,80})」/g)].map(match => match[1]);
  const unique = [...new Set(quoted)];
  let source = '';
  try { source = fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'); } catch {}
  const lines = source.split('\n');
  const hints = [];
  for (const text of unique) {
    const at = lines.findIndex(line => line.includes(text));
    hints.push(at >= 0 ? `- scenes.src.js:${at + 1} 「${text}」` : `- 未在 scenes.src.js 直接找到「${text}」（可能在模板或动态拼接里）`);
  }
  /* 质量报告的失败长什么样，就得按那个样子定位。真实事故：报告写的是
   *   FAIL 第 1 场: `eyebrow` 创建了但没 append
   * 旧实现只认中文引号，于是回了一句「没有可定位的原文」——模型只好把
   * 1455 行来回读了 96 轮、一处也没写。这里按结构解析，直接给行号与补丁。 */
  /* 「建了但没挂」必须从实际文件枚举，不能只依赖报告里的那几行：
   * build 的阶段回执只保留前 6 条 FAIL，真实事故里 6 个空白场只有第 1 场
   * 被写进报告，模型修完第 1 场仍不知道其余 5 场也是空的。 */
  const sceneChunksOf = (text) => text.split(/^\/\/---\s*$/m);
  /* 只有在失败确实属于「元素没挂上」时才展开这项：否则每次对比度/文案问题
   * 都会附带一串挂载建议，把真正要改的那一处淹没。 */
  const mountRelated = /创建了但没\s*append|没挂到画面|UNMOUNTED_ELEMENTS|empty-scene|采样未观测到文字或主体|不是 of type 'Node'/.test(String(reason));
  const allUnmounted = [];
  for (const [index, chunk] of mountRelated ? sceneChunksOf(source).entries() : []) {
    if (!chunk.trim()) continue;
    const missing = unmountedElements(chunk);
    if (missing.length) allUnmounted.push({ scene: index + 1, missing });
  }
  if (allUnmounted.length) {
    const offsetOf = (index) => sceneChunksOf(source).slice(0, index).join('').split('\n').length - 1;
    for (const { scene, missing } of allUnmounted.slice(0, 12)) {
      const base = offsetOf(scene - 1);
      const names = missing.slice(0, 4).map(item => `\`${item.name}\`(第 ${item.line} 行)`).join('、');
      hints.push(`- S${scene} 有 ${missing.length} 个元素没挂到画面：${names}${missing.length > 4 ? ' 等' : ''}` +
        `；在各自的 abs() 之后加 root.appendChild(name)。该场起点约在 scenes.src.js:${base + 1}`);
    }
    if (allUnmounted.length > 12) hints.push(`- 另有 ${allUnmounted.length - 12} 场同样整场空白，先修上面的。`);
  }
  const lineOf = (needle, from = 0) => {
    for (let i = from; i < lines.length; i++) if (lines[i].includes(needle)) return i;
    return -1;
  };
  /* 「X is not defined」是最容易定位的一类：给出第一次使用 X 的行，直接指到
   * 该删/该改的那一处，而不是让模型重新通读。必须整词匹配：`sLabel` 是
   * `resLabel` 的子串，子串匹配会把行号指到无关的一行。 */
  const seenMissing = new Set();
  for (const match of String(reason).matchAll(/([A-Za-z_$][\w$]*) is not defined/g)) {
    const name = match[1];
    if (seenMissing.has(name)) continue;
    seenMissing.add(name);
    const pattern = new RegExp(`(?:^|[^\\w$.])${name.replace(/\$/g, '\\$')}(?:\\s*\\(|[^\\w$]|$)`);
    const use = lines.findIndex(line => pattern.test(line));
    if (use >= 0) hints.push(`- scenes.src.js:${use + 1} \`${name}\` 被使用但没有定义：删掉这一行或改成本场已声明的变量名`);
  }
  return hints.length ? hints.join('\n')
    : '- 质量报告没有可定位的原文；先读最近失败日志和对应场景，再改实际字色/底色';
}


/* The failure record is not proof that the stage is still failing. These are
 * read-only observations of current files; the caller still runs the strict
 * checks after clearing the stale stop. */
async function stageSatisfiedByCurrentArtifacts(project, stage) {
  try {
    const state = loadState(project), stamp = state.genStamp;
    const scriptHash = hashFile(path.join(project, '脚本.md')), scenesHash = hashFile(path.join(project, 'scenes.src.js'));
    if (stage === 'build') return fs.existsSync(path.join(project, 'scene.html')) && !!stamp &&
      stamp.scriptHash === scriptHash && stamp.scenesHash === scenesHash;
    if (stage === 'measure') {
      const { timingVerdict } = await import('./state.mjs');
      return (await timingVerdict(project)).state === 'valid';
    }
    if (stage === 'render' || stage === 'voice' || stage === 'validate') {
      const { artifactStatus } = await import('./artifact-status.mjs');
      const status = artifactStatus(project);
      if (stage === 'render') return !status.stale.render;
      return !status.stale.render && !status.stale.voice && !status.stale.requirements && !status.stale.duration;
    }
  } catch { /* Unreadable current state is not evidence of success. */ }
  return false;
}

/* Does at least one deliverable-content author file differ from this run's
 * starting revision? Writing 发布文案.md alone must not satisfy an instruction
 * that asked for a change in the video itself. */
/* 每种模式各自负责哪些作者文件 —— 这是模式契约，不是措辞猜测。
 * 返回 null 表示"由 writeGuard 管范围，不要在这里额外判完成"。 */
function modeEditTargets(mode) {
  if (mode === 'article' || mode === 'topic') return ['脚本.md', 'scenes.src.js', 'engine.tpl.html'];
  if (mode === 'edit-visual') return ['scenes.src.js', 'engine.tpl.html'];
  if (mode === 'edit-script') return ['脚本.md', 'scenes.src.js'];
  if (mode === 'edit-copy') return ['发布文案.md'];
  return null;
}
function authorFilesChangedSince(project, baseline, files = ['脚本.md', 'scenes.src.js', 'engine.tpl.html']) {
  if (!baseline || typeof baseline !== 'object') return false;
  const current = authorRevision(project);
  return files.some(file => current[file] != null && current[file] !== baseline[file]);
}

// Each review phase gets a fresh pool as well as fresh messages: author context
// compaction anchors and reasoning must never leak into the review request.
export async function runIndependentContentReview(project, options = {}) {
  const { log = () => {}, signal, request, timeoutMs } = options;
  const configuredOutput = options.maxOutputTokens ?? (process.env.VH_AGENT_MAX_OUTPUT_TOKENS ? Number(process.env.VH_AGENT_MAX_OUTPUT_TOKENS) : undefined);
  if (configuredOutput !== undefined) configureMaxOutputTokens(configuredOutput);
  const candidates = options.providers || buildCandidates();
  const preferred = options.provider || (await pickProvider(project, candidates, undefined,
    options.providers ? { preferredProvider: null, models: {}, bases: {}, keys: {} } : readSettings()))?.name;
  let selected;
  const chat = async messages => {
    const pool = createProviderPool({ candidates, preferred, request, timeoutMs, log,
      onTiming: event => recordPerformance(project, { ...event, stage: '独立内容审稿', kind: 'model', failureCode: 'model-request-failed' }) });
    selected = pool.current();
    try { return await pool.chat(messages, [], signal, '', { maxOutputTokens: configuredOutput }); }
    finally {
      const used = pool.usage;
      if (used.requests) {
        const prior = loadState(project).usage || {};
        saveState(project, { usage: { ...Object.fromEntries(['requests', 'prompt', 'cached', 'uncached', 'completion', 'reasoning']
          .map(k => [k, (Number(prior[k]) || 0) + used[k]])), at: new Date().toISOString() } });
      }
    }
  };
  // Resolve the same fixed model alias as the author pool without a network call.
  selected = createProviderPool({ candidates, preferred }).current();
  return reviewContentIndependently(project, { chat, provider: selected.name, model: selected.model, signal, ...(options.full ? { full: true } : {}) });
}

export async function runAgent(project, task, options = {}) {
  const { mode = 'edit', log = () => {}, signal, request, timeoutMs, taskId = randomUUID(), attemptId,
    resume = false, instruction = '', instructions = [], stepBudget = readStepBudget(),
    stallSteps = readStallSteps() } = options;
  const configuredOutput = options.maxOutputTokens ?? (process.env.VH_AGENT_MAX_OUTPUT_TOKENS ? Number(process.env.VH_AGENT_MAX_OUTPUT_TOKENS) : undefined);
  if (configuredOutput !== undefined) configureMaxOutputTokens(configuredOutput);
  /* 显式注入渠道时，调用方已经决定了用哪些渠道：不再读本机设置，
     否则测试结果会随使用者本机配置变化。 */
  const injected = Object.hasOwn(options, 'providers');
  const providers = injected ? options.providers : buildCandidates();
  const settings = injected ? { preferredProvider: null, models: {}, bases: {}, keys: {} } : readSettings();
  if (!Number.isInteger(stepBudget) || stepBudget < 1) throw new Error('步数预算必须为正整数');
  if (!Number.isInteger(stallSteps) || stallSteps < 3) throw new Error('停滞判定步数必须 ≥ 3');
  const saved = resume ? readCheckpoint(project, taskId) : null;
  const automation = automationPolicy(project, options.automation ?? saved?.automation);
  if (saved && saved.mode !== mode) throw new Error('恢复模式与原任务不一致，未执行');
  /* A checkpoint still marked `finalizing` is a completion whose task record
   * was not committed (crash between the two writes). Do not silently resume
   * it as unfinished work: settle it from the recorded answer if the worker
   * can, otherwise surface the same resumable state. */
  if (saved?.status === 'completed') throw new Error('原任务已结束，不能当作未完成任务恢复');
  /* A checkpoint left in `finalizing` is a completed run whose task record was
   * not committed (crash between the two writes). Settle it from the recorded
   * answer after re-reading the actual delivery; never call the model again.
   * The caller must still refresh task status before exposing a resume button. */
  if (saved?.status === 'finalizing') {
    const deliverable = taskDeliveryState(project, mode);
    const answer = typeof saved.answer === 'string' ? saved.answer : '';
    const readOnlyCompletion = saved.mutationDeferred || saved.review?.required;
    if (!answer || !readOnlyCompletion && deliverable.stale) {
      const why = !answer ? '缺少已生成的回答' : deliverable.reason;
      throw new Error('上次执行已完成但尚未登记，且当前产物已变化（' + why + '）；请开始新一轮任务重新核验');
    }
    log('↻ 上次执行已完成但未登记：按已记录回答结算，不重新调用模型、不改作者文件');
    return { answer, warns: [], actions: [], status: 'completed', error: null, providerFailures: [],
      paused: null, deliverable, ok: true };
  }
  const changeContracts = restoreChanges(project, saved?.changeContracts, saved?.messages, options.instructionKind === 'material' && !saved ? '' : task);
  const scopeCopyChanges = () => {
    if (mode !== 'edit-copy') return;
    for (const change of changeContracts) {
      change.scope = 'publish';
      for (const rule of change.rules || []) rule.files = ['发布文案.md'];
    }
  };
  scopeCopyChanges();
  const preferred = await pickProvider(project, providers, undefined, settings);
  const pool = createProviderPool({ candidates: providers, preferred: preferred?.name, request, timeoutMs, log,
    onTiming: event => recordPerformance(project, { ...event, kind: 'model', failureCode: 'model-request-failed' }),
    onSuccess(prov) {
      saveState(project, { agent: { provider: prov.name, model: prov.model,
        requestModel: prov.model, at: new Date().toISOString() } });
    } });
  /* 渠道一开始就记下来，不等请求成功。
   * 真实事故：额度不足（402）时请求直接失败，onSuccess 不会触发，
   * 界面就一直显示"上一次成功用的渠道"，用户以为切换没生效。 */
  saveState(project, { agent: { provider: pool.current().name, model: pool.current().model,
    requestModel: pool.current().model, at: new Date().toISOString() } });
  log(`模型：${pool.current().model} / ${pool.current().name}　（模式 ${mode}；固定渠道，可识别临时故障最多重试一次，不重放工具；明确上下文超限/工具参数失败有界纠偏）`);
  const opts = { mode, signal, automation, uncertainCommands: saved?.uncertainCommands || [], _lastCmd: saved?.lastCommand,
    _readCache: new Map(), _seenWindows: new Map(), changeContracts, publishOnly: mode === 'edit-copy' || saved?.pipelineState?.stage === 'publish', publishInputs: saved?.publishInputs };
  opts.reviewContent = async signature => {
    if (signature !== contentReviewInputs(project).signature) throw new Error('内容审稿 signature 已过期，先读取当前旁白');
    const status = contentReviewStatus(project);
    if (status.record?.signature === signature && ['declared-pass', 'revise'].includes(status.state)) return status;
    log('独立内容审稿：先听述复原，再核对依据；不接收作者的通过理由。');
    return runIndependentContentReview(project, { providers, provider: pool.current().name, request, timeoutMs, log, signal, maxOutputTokens: configuredOutput });
  };
  /* 文档探索累计数仅用于提醒；不能以总次数拦住需要的新片段。 */
  let docPokes = 0;
  /* 按文件内容版本与读取范围计数；产物推进后清零。 */
  opts._probeCounts = new Map();
  opts._seenFetches = new Set();
  opts._windowStamps = new Map();
  /* 被拦截的次数：连续被拦还不改手，说明它没听懂，就该停下来问清楚。 */
  let blockedProbes = 0;
  const PROBE_LIMIT = 6;
  const probeTooOften = (name, args) => {
    let hot = null;
    for (const [key, file] of probeScopes(project, name, args)) {
      const n = (opts._probeCounts.get(key) || 0) + 1;
      opts._probeCounts.set(key, n);
      if (n > PROBE_LIMIT) hot = { file, count: n };
    }
    return hot;
  };
  const tools = makeTools(project, log, opts);
  const vh = path.join(VH_DIR, 'vh.mjs');
  let messages = saved?.messages || [
    { role: 'system', content: SYSTEM(project, vh, mode) + briefBlock(project) + memoryBlock(project) + worklogBlock(project) },
    { role: 'user', content: task },
  ];
  const schemas = toolSchema(tools);
  let answer = '';
  let emptyStreak = saved?.emptyStreak || 0;
  let truncationStreak = saved?.truncationStreak || 0;
  let toolRepairStreak = saved?.toolRepairStreak || 0;
  let lastToolSig = '';
  let stalled = 0;
  let failure = null;
  let paused = null;
  let providerFailures = [];
  let cancelled = false;
  const actions = saved?.actions || [];
  let pending = saved?.pending || [], totalSteps = saved?.totalSteps || 0;
  let attemptSteps = 0;
  const appliedInstructions = saved?.appliedInstructions || [];
  const pendingInstructions = (saved?.pendingInstructions || []).map(n => typeof n === 'string' ? { content: n } : n);
  const unreadInstructions = instructions.filter(n => !appliedInstructions.includes(n.id));
  for (const note of unreadInstructions) if (!pendingInstructions.some(n => n.id === note.id)) pendingInstructions.push(note);
  /* The initial instruction of an article/topic task is the source material
   * (whole articles are routinely pasted), not a "modification requirement".
   * Registering it as a change contract made every later edit look unverified
   * and blocked delivery forever. Only short, actionable instructions become
   * contracts; resume instructions with their own ids still do. */
  if (instruction.trim()) {
    const text = instruction.trim();
    if (!(options.instructionKind === 'material' && task.includes(text))) {
      pendingInstructions.push(text.length <= 1000 && options.instructionKind !== 'material' ? { id: randomUUID(), content: text } : { content: text });
    }
  }
  const hasNewInstruction = !!instruction.trim() || unreadInstructions.length > 0;
  if (hasNewInstruction) { truncationStreak = 0; toolRepairStreak = 0; }
  let resumingPending = !!saved;
  let staleNudged = false;
  /* 停滞计数**每次执行重新开始**。
   * 真实事故：计数被存进检查点并跨执行继承，导致第 10 次执行只跑了 2 步
   * 就因"连续 101 步"被暂停 —— 而且连"先警告再暂停"的流程都跳过了（stallPhase 也被继承）。
   * 停滞判定描述的是"本次执行内没有推进"，跨执行累计没有意义：
   * 新一次执行本来就是接着做，读文件是合理的。 */
  let progressStamp = authorProgressStamp(project);
  const repairWindowStart = progressStamp;
  let repairFinishAttempted = false;
  let noProgressSteps = 0;
  let stallPhase = 0;         // 0=正常，1=已警告要求动手
  let recordedPipelineKey = null;
  /* 本次执行只允许把"用户新要求"武装一次；成功后必须能回到正常收尾。 */
  let userEditArmed = false;
  /* 审阅不是改稿：先实际跑程序体检，模型只根据报告回答。未完成体检前不许直接完成。 */
  const requestText = [options.instructionKind === 'material' ? '' : instruction, ...unreadInstructions.map(n => n.content)].join('\n');
  const reviewTask = isReviewRequest(requestText), restoredReview = saved?.review?.required && !isExplicitMutation(requestText);
  const review = reviewTask || restoredReview ? { required: true, done: false,
    scopes: reviewTask ? reviewScopes(requestText) : saved.review.scopes || ['visual'] } : null;
  opts.review = review;
  /* Resume grants a new exploration window, not a fresh protocol/repair budget.
   * Real input/stage changes reset progress; old v1 recon/offStage fields are
   * ignored. totalTurns remains cumulative for observation only. */
  let pipelineState = saved?.pipelineState ? {
    ...saved.pipelineState,
    turns: 0,
    totalTurns: saved.pipelineState.totalTurns ?? saved.pipelineState.turns ?? 0,
    autoStageFailed: null,
    /* blocker 也要清：它表示"上次真实失败、尚未修复"，会抑制模型动手（directWork）。
     * 恢复任务时若还留着，就等于"一进来就处于被拦住的状态"，
     * 模型只能反复读文件，几轮后又被判偏离 —— 这就是"点继续秒退"的循环。
     * 失败本身记在检查点与日志里，下一轮真正重跑时若还失败会重新记录。 */
    blocker: null,
    blockerHint: null,
    /* A clicked resume is a new protocol window. Keep cumulative turns and the
     * repair budget, but reset transient violation/read/idle counters; otherwise
     * a saved violation count makes "continue" exit before sending one request. */
    progress: newStageProgress(),
  } : { version: 1, key: null, stage: null, turns: 0, totalTurns: 0, truncations: 0 };
  // Old checkpoints have no stopping input signature. Record the current
  // baseline once, so completing missing upstream drafts can unblock checking.
  if (pipelineState.productionRepairs?.stop && !pipelineState.productionRepairs.stoppedSignature) {
    pipelineState.productionRepairs.stoppedSignature = productionRepairSignature(project);
  }
  if (saved && automation.enabled) {
    const current = readTask(project);
    if (current?.id === taskId && (!attemptId || current.attemptId === attemptId)) {
      pipelineState.productionRepairs = applyRepairExtensions(pipelineState.productionRepairs, current.repairExtensions, automation);
    }
  }
  const publishProductionProgress = stage => {
    if (!automation.enabled) return;
    const repairs = pipelineState.productionRepairs || {};
    updateTask(project, taskId, { automationProgress: {
      stage: stage || pipelineState.stage || null, used: repairs.history?.length || 0, limit: automation.maxRepairs,
      phase: repairs.stop ? 'stopped' : repairs.pending ? 'repairing' : 'idle',
      lastIssue: repairs.stop || repairs.pending?.reason || repairs.history?.at(-1)?.reason || null,
      at: new Date().toISOString(),
    } }, attemptId);
  };
  const recordProductionFailure = (stage, reason) => {
    if (!automation.enabled) return;
    let stageResult;
    try {
      const receipt = parseStageResult(reason);
      stageResult = receipt || undefined;
      if (receipt) reason = `exit=${receipt.exitCode}\n阶段 ${receipt.stage}；完整日志 ${receipt.logPath}\n${receipt.output}`;
    } catch { /* Keep a damaged receipt as unknown, never manufacture success. */ }
    pipelineState.productionRepairs = productionFailure(pipelineState.productionRepairs, { stage, reason,
      stageResult, sourceSignature: productionRepairSignature(project), maxRepairs: automation.maxRepairs });
    // A new diagnosis starts a new repair window; stalled-window counting is
    // about one persistent pending transaction, not the whole task.
    if (pipelineState.productionRepairs?.pending) {
      pipelineState.repairStalledWindows = 0;
      pipelineState.repairWindowStalled = false;
    }
    pipelineState.blocker = reason.slice(0, 900);
    publishProductionProgress(stage);
  };
  opts.hasPendingRepair = () => !!pipelineState.productionRepairs?.pending;
  opts.finishRepair = () => {
    const repairs = pipelineState.productionRepairs, pendingRepair = repairs?.pending;
    const signature = productionRepairSignature(project);
    pipelineState.productionRepairs = submitProductionRepair(repairs, signature);
    pipelineState.blocker = null;
    publishProductionProgress(pendingRepair.stage);
    return { ok: true, message: '本轮修改已提交复检；累计修复次数保留，尚未检查通过' };
  };
  // Initial source material is data, not an editing/stop instruction. CLI marks
  // it explicitly; genuine requests and steering still govern the task scope.
  const scopeNotes = [options.instructionKind === 'material' ? '' : instruction, ...unreadInstructions.map(n => n.content)].filter(Boolean);
  let mutationDeferred = saved?.mutationDeferred || false;
  for (const note of scopeNotes) mutationDeferred = nextReadOnlyScope(mutationDeferred, note);
  opts.readOnly = mutationDeferred || !!review;
  if (mutationDeferred && isExplicitMutation(requestText)) mutationDeferred = false;
  opts.readOnly = mutationDeferred || !!review;
  const stallNudge = () => {
    const st = loadState(project);
    const last = st.lastMeasure && st.lastMeasure.scriptHash ? '已测量过' : '尚未测量';
    return '【停止探索，现在就必须推进】你连续 ' + noProgressSteps +
      ' 步没有改动任何作者文件（方案/脚本/claims/scenes/成片）。读文件不算推进。' +
      `当前状态：${last}；以实际文件与 vh status 为准，PROGRESS.md 可能未更新。` +
      nextAgentStep(project, mode) +
      '下一步只做一件能改变产物的事：用 write_scene 写一个完整场景、用 write_file 写缺失的文件，或跑 build/measure/render/voice 并处理报错。' +
      '不要再去读模板源码或重复查看目录；确需查接口只看 vh --help 中相关一小段。';
  };
  if (saved) pendingInstructions.push({ content: '【继续原任务】从已记录现场接着推进，不重新创建项目、不重做已有成功工具步骤。若上一步结果未知，先只读检查现有产物再决定；不要把未知当作未执行。' + nextAgentStep(project, mode) });
  /* 提示去重：这些提示每次恢复都会追加一遍，不去重就会无限累积。
   * 真实事故：同一句"【继续原任务】"在 14 次恢复后堆了 14 份，
   * "【停止探索】"堆了 3 份，白白占着每轮请求的上下文。 */
  const consumedSteers = saved?.consumedSteers || [];
  const checkpoint = phase => writeCheckpoint(project, { schemaVersion: 1, taskId, attemptId, mode,
    task: saved?.task || task, messages, pending, actions, emptyStreak, truncationStreak, toolRepairStreak, lastToolSig, stalled, totalSteps,
    uncertainCommands: opts.uncertainCommands, lastCommand: opts._lastCmd, pendingInstructions, appliedInstructions, consumedSteers, phase, status: 'running',
    progressStamp, noProgressSteps, stallPhase, changeContracts, pipelineState, automation, mutationDeferred, review, publishInputs: opts.publishInputs });
  if (resume && !saved) messages.push({ role: 'user', content: fileRecoveryContext(project) });
  if (saved) {
    /* 恢复时先清掉历史里堆积的重复固定提示。
     * 真实事故：14 次恢复把同一句"【继续原任务】"堆了 14 份、"【停止探索】"堆了 3 份，
     * 每次请求都要重发一遍，白占上下文。原始要求一个字不动。 */
    const before = messages.length;
    const cleaned = collapseRepeatedNotices(messages);
    messages = cleaned;
    if (cleaned.length !== before) {
      log(`↻ 恢复原任务检查点：保留 ${cleaned.length} 条消息（清理了 ${before - cleaned.length} 条重复提示）`);
    } else {
      log(`↻ 恢复原任务检查点：保留 ${cleaned.length} 条消息与已记录工具结果`);
    }
  } else if (resume) log('↻ 旧任务按已有文件接续（无精确检查点）；先核对，不从头初始化');
  checkpoint('ready');

  const steerPath = path.join(project, 'out', '.vh-steer.json');
  const drainSteer = () => {
    try {
      if (!fs.existsSync(steerPath)) return [];
      const q = JSON.parse(fs.readFileSync(steerPath, 'utf8'));
      if (Array.isArray(q) && q.length) {
          return q.filter(st => (!st.taskId || st.taskId === taskId) && !consumedSteers.includes(st.id || JSON.stringify(st)));
      }
    } catch {}
    return [];
  };

  const runFile = path.join(project, 'out', '.vh-run.json');
  const markStep = (step, doing) => {
    try {
      const cur = fs.existsSync(runFile) ? JSON.parse(fs.readFileSync(runFile, 'utf8')) : {};
      fs.writeFileSync(runFile, JSON.stringify({ ...cur, step, doing: String(doing || '').slice(0, 80), updatedAt: Date.now() }, null, 1));
    } catch {}
  };

  const performPending = async () => {
    const batch = { count: 0, blocked: 0, wrote: false, read: false, staleRead: false, violation: false };
    for (const item of pending) {
      if (signal?.aborted) break;
      if (item.status === 'done') continue;
      batch.count++;
      const c = item.call, name = c.function?.name;
      let args = {};
      const raw = c.function?.arguments;
      if (typeof raw === 'string' && raw.trim()) {
        try { args = JSON.parse(raw); }
        catch {
          try { args = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"')); }
          catch { log('  ⚠ 工具参数不是合法 JSON，按空对象处理'); }
        }
      }
      let result;
      if (item.rejection) {
        result = item.rejection;
        batch.violation = true;
      } else if (item.status === 'executing') {
        // 写入已发生但结果未落盘的崩溃窗口：只核对实际内容，不重写。
        let confirmedWrite = false;
        if (name === 'write_scene' && sceneDraftMatches(project, args.scene, args.content, { layout: args.layout, visual: visualFromSceneArgs(args) })) confirmedWrite = true;
        if (name === 'assemble_scenes' && sceneAssemblyMatches(project)) confirmedWrite = true;
        if (name === 'write_file' && typeof args.path === 'string') {
          const file = path.resolve(project, args.path);
          if (file.startsWith(project + path.sep)) {
            try { confirmedWrite = fs.readFileSync(file, 'utf8') === args.content; } catch {}
          }
        }
        if (confirmedWrite) result = '恢复核对：目标文件已存在，内容与上次请求逐字一致。未重复写入。';
        else {
          result = '上次进程在这个工具执行期间中断，结果未知。本执行器没有重放它。先只读核对相关文件、状态和产物，再判断下一步；不能假定它没执行。';
          if (name === 'run' && args.command && !opts.uncertainCommands.includes(args.command)) opts.uncertainCommands.push(args.command);
        }
        log('↻ 核对未落盘工具：' + name + (confirmedWrite ? '（文件已确认，未重写）' : '（结果未知，未自动重放）'));
      } else if (drainSteer().length && !['read_file', 'read_edit_file', 'read_scene', 'list_files'].includes(name)) {
        result = '拒绝：用户有尚未接收的新指令；本项尚未执行，先在下一轮应用新要求，再决定副作用。';
      } else if (hasNewInstruction && resumingPending) {
        result = '恢复时用户有新的补充要求。这项工具尚未开始，因此未执行。先处理接下来的用户要求，再规划下一步。';
      } else if (opts.activeContract?.validate(c)) {
        result = '拒绝：' + opts.activeContract.validate(c) + '；未执行，先按当前阶段重新规划';
        batch.violation = true;
      } else {
        const probes = probeScopes(project, name, args);
        const hot = probeTooOften(name, args);
        const sig = name + createHash('sha256').update(JSON.stringify(args) + [...probes.keys()].join('|')).digest('hex');
        if (sig === lastToolSig) stalled++; else { stalled = 0; lastToolSig = sig; }
        if (stalled >= 6) {
          result = '你已重复同一步 6 次。请换一个做法，不要重复。'; stalled = 0;
          batch.staleRead = true;
          if (probes.size) batch.blocked++;
        } else if (hot) {
          batch.staleRead = true;
          /* 同一个文件被反复读（命令可以不同）= 原地打转。
           * 真实事故：14 步里 10 步在 grep 同一份 engine.tpl.html，
           * 前后两条完全相同的命令隔了 6 步，"只比连续相同命令"比不出来。 */
          batch.blocked++;
          result = `你已经反复读 ${hot.file} 的同一版本/范围或反复搜索固定模板（${hot.count} 次）。` +
            '这次没有执行读取。确需新片段，请用 read_file 的 start_line/max_lines，改稿后可重新读取。' +
            nextAgentStep(project, mode) + '\n' + SCENE_CAPABILITIES;
          log(`  ⛔ 反复读同一文件（${hot.file}）→ 返回当前关口，要求停止无界查阅`);
        } else {
          if (isDocPoke(name, args) && ++docPokes === 13) {
            log('⚠ 已多次查阅参考文档；保留本次所需片段，下一步应验证实际产物');
          }
          // 未改动文件的重复读取：返回**本次请求的那一段**，而不是断言“内容就在上面”。
          const stamped = opts._readCache?.get(args.path);
          const stillVisible = (attemptSteps - (stamped?.step ?? -Infinity)) <= 5;
          const repeatRead = name === 'read_file' && typeof args.path === 'string' &&
            stamped && stamped.stamp === fileStamp(project, args.path) && stillVisible;
          /* 只看 read_file 是漏判：真实事故里 96 轮几乎全是 read_edit_file，
           * 每一段都被当成「新范围」，空转计数永远是 0，于是判定条件写的是
           * 「读取新范围不算空转」，实际上从未升级到「不许再读」。
           * 这里按行区间记录本次执行已经看过的内容；相邻或重叠 ≥60% 的窗口
           * 算重复读，只有真正没看过的新行才算定位。 */
          const windowKey = typeof args.path === 'string' ? args.path : null;
          let window = name === 'read_edit_file' && windowKey
            ? { start: Number(args.start_line) || 0, count: Number(args.max_lines) || 80 } : null;
          if (name === 'read_file' && windowKey) {
            const start = Math.max(0, Number(args.start_line) || 0);
            let count = Math.max(0, Number(args.max_lines) || 0);
            if (!count) {
              try { count = readSlice(fs.readFileSync(path.resolve(project, args.path), 'utf8'), args).split('\n').length; } catch {}
            }
            window = { start, count };
          }
          if (window) {
            try {
              const total = fs.readFileSync(path.resolve(project, windowKey), 'utf8').split('\n').length;
              window.count = Math.min(window.count, Math.max(0, total - window.start));
            } catch { window.count = 0; }
            if (!window.count) batch.staleRead = true;
            const stamp = fileStamp(project, windowKey);
            if (opts._windowStamps.get(windowKey) !== stamp) opts._seenWindows?.delete(windowKey);
            opts._windowStamps.set(windowKey, stamp);
            const seen = opts._seenWindows?.get(windowKey) || [];
            const freshLines = [];
            for (let i = window.start; i < window.start + window.count; i++) if (!seen.includes(i)) freshLines.push(i);
            const overlap = window.count ? 1 - freshLines.length / window.count : 0;
            if (overlap >= 0.6) batch.staleRead = true;
            opts._seenWindows?.set(windowKey, [...new Set([...seen, ...Array.from({ length: window.count }, (_, i) => window.start + i)])].sort((a, b) => a - b));
          }
          if (repeatRead) {
            const body = readSlice(stamped.content, args);
            result = `文件 ${args.path} 自上次读取后未改动；下面是按本次范围从缓存返回的内容，未重复读盘。\n` + body;
            // Cached bytes may contain a genuinely new requested range. The
            // versioned window overlap above, not cache reuse, decides spinning.
          } else {
            log(`· ${name} ${JSON.stringify(args).slice(0, 110)}`);
            markStep(totalSteps, name + ' ' + (args.path || args.url || args.command || '').slice(0, 50));
            item.status = 'executing'; checkpoint('tool-running');
            /* 动作要等执行成功后才记：否则失败的 patch_text 也算"写过了"，
             * 模型随后一句话收工，"改了但没改"就变成"已完成"。 */
            const pendingAction = name === 'write_file' ? '写 ' + (args.path || '?')
              : name === 'confirm_publish' ? '关联发布文案版本'
              : name === 'patch_text' ? '修改片段 ' + (args.path || '?')
                : name === 'replace_scene' ? '修改场景 S' + (args.scene || '?')
                  : name === 'run_stage' ? '阶段 ' + (args.stage || '?')
                    : name === 'write_scene' ? '写场景 S' + (args.scene || '?')
                      : name === 'assemble_scenes' ? '组装场景'
                : name === 'append_file' ? '追加 ' + (args.path || '?')
                        : name === 'run' && /vh\.mjs\s+(\w[\w-]*)/.test(args.command || '') ? '跑 vh ' + String(args.command).match(/vh\.mjs\s+([\w-]+)/)[1]
                          : name === 'fetch_url' ? '抓网页' : null;
            const isWriteTool = WRITE_TOOLS.has(name);
            const trackedRepairEdit = automation.enabled && pipelineState.productionRepairs?.pending &&
              ['patch_text', 'append_file', 'replace_scene'].includes(name);
            const repairBefore = trackedRepairEdit ? productionRepairObservation(project) : null;
            const authorBefore = automation.enabled && isWriteTool ? repairBefore?.signature || productionRepairSignature(project) : null;
            result = '未知工具';
            if (trackedRepairEdit && !currentProductionRepair(pipelineState.productionRepairs, repairBefore.signature)) {
              result = '拒绝：修复期间作者输入发生外部变化；本次补丁未执行，先重新核验当前版本。';
            } else if (tools[name]) { try { result = await tools[name].run(args); } catch (e) { result = '工具异常：' + e.message; } }
            if (name === 'fetch_url' && toolOutcome(result).ok) {
              const fetched = createHash('sha256').update(args.url + '\n' + String(result)).digest('hex');
              if (opts._seenFetches.has(fetched)) batch.staleRead = true;
              opts._seenFetches.add(fetched);
            }
            if (name === 'read_file' && typeof args.path === 'string' && opts._readCache) {
              // 只缓存完整的小文件。大文件按请求范围重新读盘，不能缓存前缀冒充全文。
              let cached = '';
              const abs = path.resolve(project, args.path);
              if (abs.startsWith(project + path.sep)) {
                try {
                  if (fs.statSync(abs).size <= 40000) {
                    cached = fs.readFileSync(abs, 'utf8');
                    opts._readCache.set(args.path, { stamp: fileStamp(project, args.path), step: attemptSteps, content: cached });
                  } else opts._readCache.delete(args.path);
                } catch { opts._readCache.delete(args.path); }
              }
            }
            const outcome = toolOutcome(result);
            if (trackedRepairEdit && outcome.ok) {
              const after = productionRepairObservation(project);
              const target = name === 'replace_scene' ? 'scenes.src.js' : typeof args.path === 'string'
                ? path.relative(project, path.resolve(project, args.path)) : '';
              const previous = pipelineState.productionRepairs;
              // The author's tool returns the SHA-256 of the bytes it committed.
              // An external same-file change after that commit must not be
              // attributed to this transaction merely because the target matches.
              let committed = false;
              try {
                const receipt = JSON.parse(result);
                committed = receipt.ok === true && receipt.changed === true && typeof receipt.base_hash === 'string' &&
                  readEditFile(project, target, { max_lines: 1 }).base_hash === receipt.base_hash;
              } catch {}
              if (committed) pipelineState.productionRepairs = recordProductionRepairEdit(previous, repairBefore, after, target);
              if (after.signature !== repairBefore.signature && previous === pipelineState.productionRepairs)
                log('⚠ 补丁的提交结果或其他输入发生变化；保留文件，不把未知变化记为本轮修复。');
            }
            if (outcome.ok && (READ_TOOLS.has(name) || name === 'run')) batch.read = true;
            if (name === 'read_scene' && outcome.ok) pipelineState.readyScene = args.scene;
            /* 审阅要求：模型可以自己跑只读体检，但引用现有报告不算“刚检查过”。 */
            if (review && name === 'run' && outcome.ok
              && /vh\.mjs\s+(?:screen|layout|variety|contrast|density|stills|contact)\b/.test(args.command || '')) review.done = true;
            /* blocker 会拼进下一轮提示。这里要保留 FAIL 明细，不能只留 exit=1；
             * 否则模型知道"失败了"却不知道"改什么"，只能反复读文件直到被判偏离。 */
            if (name === 'run_stage' && !outcome.ok) {
              /* 被拒绝的调用不是"阶段真实失败"：它说明模型用错了工具参数，
               * 例如把 shell 命令塞进 run_stage 的 stage 字段（真实事故）。
               * 若把它记成 blocker，下一轮 directWork（强制动手）会因为
               * `!pipelineState.blocker` 而永久关闭，模型只能反复读文件直到
               * 撞上轮次上限。这里改为给一句可照做的用法纠正，并清掉 blocker。 */
              if (String(result).startsWith('拒绝：')) {
                pipelineState.blocker = null;
                pipelineState.blockerHint = 'run_stage 只接受 stage 为 build/measure/render/voice/validate；' +
                  '要跑 shell 命令请用 run，要查看文件请用 read_file。';
              } else {
                pipelineState.blocker = outcome.summary.slice(0, 900);
                pipelineState.blockerHint = null;
                if (!String(result).startsWith('拒绝：')) recordProductionFailure(args.stage, String(result));
                if (!automation.enabled) {
                  pipelineState.autoStageFailed = pipelineState.key;
                  if (classifyProductionFailure(outcome.summary) === 'content') {
                    pipelineState.gateBlocked = args.stage;
                    pipelineState.gateBlocker = outcome.summary;
                  }
                }
              }
            }
            if (name === 'finish_draft') pipelineState.blocker = outcome.ok ? null : outcome.summary;
            if (name === 'finish_repair' && outcome.ok) {
              pipelineState.blocker = null;
              repairFinishAttempted = true;
              pipelineState.repairStalledWindows = 0;
              pipelineState.repairWindowStalled = false;
            } else if (name === 'finish_repair') pipelineState.blocker = outcome.summary;
            recordTool(project, { taskId, tool: name,
              target: name === 'run' ? String(args.command || '').replace(/\s+/g, ' ').slice(0, 180) :
                args.path || args.url || (args.scene ? 'scenes.src.js#S' + args.scene : args.stage || args.instruction_id || ''),
              ok: outcome.ok,
              note: outcome.ok ? (outcome.exit ? 'exit=' + outcome.exit : '') : outcome.summary.slice(0, 180) });
            /* 执行成功才记动作：失败的写入不能算"已经改了"。 */
            if (outcome.ok && pendingAction) actions.push(pendingAction);
            /* 只有真正的写入成功才算用户改稿落地；失败的 patch 不能清掉待修改标记。
             * 但“写成功”也要看写的是不是用户要求的那类文件：用户要求改片子，
             * 只写了 发布文案.md 不能把改稿标记清掉（真实事故：广告指令就这样被吞掉）。 */
            if (isWriteTool && outcome.ok && (!automation.enabled || productionRepairSignature(project) !== authorBefore)) {
              batch.wrote = true;
              /* 用同一套模式契约判断"改到位了没有"：article 要落到脚本/画面，
               * edit-copy 才是发布文案。写错类别不能清掉待改稿标记。 */
              const editTargets = modeEditTargets(mode);
              if (pipelineState.userEditPending && (!editTargets ||
                authorFilesChangedSince(project, pipelineState.userEditBaseline, editTargets))) {
                pipelineState.userEditPending = null;
                pipelineState.userEditBaseline = null;
              }
              if (pipelineState.gateBlocked) { pipelineState.gateBlocked = null; pipelineState.gateBlocker = null; }
              // A changed file is one patch, not completion of the whole repair
              // round. Only finish_repair releases the transaction for recheck.
            }
            if (isWriteTool && !outcome.ok) {
              /* 写没落地就是没推进。留下可执行的具体原因，下一轮先重读再改，
               * 不能因为"调用过写工具"就进入完成校验。 */
              pipelineState.blocker = name + ' 未成功：' + outcome.summary.slice(0, 500);
              log('  ✗ ' + name + ' 未成功：' + outcome.summary.slice(0, 120));
            }
          }
        }
      }
      const text = String(result);
      if ((READ_TOOLS.has(name) || name === 'run') && toolOutcome(text).ok) batch.read = true;
      messages.push({ role: 'tool', tool_call_id: c.id, content: text.length > 20000
        ? text.slice(0, 19700) + '\n…（工具结果已截断，请用更小的 start_line/max_lines 或命令范围读取）' : text });
      item.status = 'done'; checkpoint('tool-result');
    }
    if (!signal?.aborted) pending = [];
    checkpoint(signal?.aborted ? 'paused' : 'ready');
    return batch;
  };
  if (pending.length) {
    const restoredRepair = automation.enabled && currentProductionRepair(pipelineState.productionRepairs, productionRepairSignature(project));
    const restoredWork = opts.readOnly ? null : restoredRepair ? productionRepairWork(pipelineState.productionRepairs)
      : await nextPipelineWork(project, automation.enabled && mode === 'edit' ? 'article' : mode, changeContracts);
    opts.activeContract = stageContract(restoredWork, { schemas, readOnly: opts.readOnly, project,
      scene: restoredWork?.stage === 'draft_scenes' ? pendingSceneWork(project, mode) : null });
    const rejection = pending.filter(item => item.status === 'planned').map(item => opts.activeContract.validate(item.call)).find(Boolean);
    if (rejection) for (const item of pending) if (item.status === 'planned') item.rejection ||= '拒绝：' + rejection + '；整批未执行，按当前阶段重新规划';
    await performPending();
  }
  resumingPending = false;

  /* A repair window that ends without finish_repair must not become an endless
   * "resume → same reads → pause" loop. Count only windows that closed with the
   * same pending transaction and no author progress; after two, stop and state
   * the exact remaining locations. */
  if (automation.enabled && resume && pipelineState.productionRepairs?.pending && pipelineState.repairWindowStalled) {
    pipelineState.repairStalledWindows = (pipelineState.repairStalledWindows || 0) + 1;
    pipelineState.repairWindowStalled = false;
    if (pipelineState.repairStalledWindows >= 2) {
      paused = '连续两个恢复窗口都没有提交本轮修复（没有调用 finish_repair），继续重复同样的读取不会修好画面；已停止消耗。\n' +
        '剩余问题与可直接补丁的位置：\n' + repairHints(project, pipelineState.productionRepairs.pending.reason) +
        '\n下一步必须先用 read_edit_file 取当前 base_hash，再用 patch_text 修改上述行；修完 finish_repair，不要只读。';
      log('\n⏸ ' + paused);
      checkpoint('repair-window-stalled');
      answer = '';
    }
  }

  for (let step = 1; step <= stepBudget && !paused; step++) {
    if (signal?.aborted) { cancelled = true; log(`已取消（中断于第 ${step} 步）`); break; }
    // ⚠ 插话：用户随时可以补指令，下一步立刻生效（不打断当前工具调用）
    const steers = drainSteer();
    for (const st of steers) {
      truncationStreak = 0; toolRepairStreak = 0;
      mutationDeferred = nextReadOnlyScope(mutationDeferred, st.message);
      opts.readOnly = mutationDeferred || !!review;
      addChange(project, changeContracts, { id: st.id, text: st.message });
      log(`\n◆ 收到插话：${String(st.message).slice(0, 100)}`);
      messages.push({ role: 'user', content: '【用户中途补充指令，优先级高于原计划】' + st.message });
      if (!review && ['article', 'topic'].includes(mode) && reviewVersion(project) >= 3) rememberReviewMaterial(project,
        'steer:' + (st.id || JSON.stringify(st)), { kind: 'user-steer', text: st.message, priority: 'newer-overrides-older', receivedAt: new Date().toISOString() });
      consumedSteers.push(st.id || JSON.stringify(st));
    }
    /* 先记下本轮到没到新要求，再清空队列。
     * 真实事故：判断写在 splice(0) 之后，永远看到空数组，
     * 于是"用户提了新要求"从不成立，任务一进来就按 validate 判定完成退出。 */
    const freshThisTurn = pendingInstructions.length > 0 || steers.length > 0;
    for (const note of pendingInstructions.splice(0)) {
      if (note.id) addChange(project, changeContracts, { id: note.id, text: note.content });
      messages.push({ role: 'user', content: note.content });
      if (note.id && !review && ['article', 'topic'].includes(mode) && reviewVersion(project) >= 3) rememberReviewMaterial(project,
        'instruction:' + note.id, { kind: 'user-instruction', text: note.content, priority: 'newer-overrides-older', receivedAt: new Date().toISOString() });
      if (note.id && !appliedInstructions.includes(note.id)) appliedInstructions.push(note.id);
    }
    scopeCopyChanges();
    // A legacy-unreviewed task may enable v3 when finish_draft submits its first
    // script. Capture its original task even on resume, before building a signature.
    if (!opts.readOnly && !review && ['article', 'topic'].includes(mode) && reviewVersion(project) >= 3 && (saved?.task || task)) {
      rememberReviewMaterial(project, 'task:' + taskId, { kind: 'user-task', mode, text: saved?.task || task, receivedAt: new Date().toISOString() });
    }
    schemas.splice(0, schemas.length, ...toolSchema(tools));
    messages = collapseRepeatedNotices(messages);
    /* 每轮把"最近产出/失败"放进**发送投影的末尾**；不改动历史消息本身。
     * 恢复后历史可能很长，台账一旦折叠就看不到后期写入；这里给一个小而新的现场。
     *
     * 走 prepareRequestContext 的 tailNote 通道：它把内容挂到**整条请求的最末尾**，
     * system 与原始要求保持逐字节不变 → 前缀缓存能命中；
     * 挂在中间会让"从该位置到结尾"整段每轮失效，缓存等于没有。 */
    const pipelineMode = automation.enabled && mode === 'edit' ? 'article' : mode;
    // Discussion/review is not incomplete production. In particular, do not
    // resolve an edit contract against a script that this project does not have.
    let sceneWork = opts.readOnly ? null : pendingSceneWork(project, pipelineMode);
    let work = opts.readOnly ? null : await nextPipelineWork(project, pipelineMode, changeContracts);
    if (automation.enabled && !mutationDeferred && !review) {
      /* A stop record describes a failure that may already be gone: a user can
       * fix the environment and run the stage from the CLI, or finish delivery.
       * Clear the stale stop only when the actual current artifacts satisfy
       * that stage; never clear it just because resume was clicked. */
      if (pipelineState.productionRepairs?.stop) {
        const stoppedStage = stoppedFailureStage(pipelineState.productionRepairs);
        const satisfied = stoppedStage && await stageSatisfiedByCurrentArtifacts(project, stoppedStage);
        if (satisfied) {
          log('↻ 阶段 ' + stoppedStage + ' 的实际产物已就绪，清除旧的失败/暂停记录；保留已用修复次数');
          pipelineState.productionRepairs = { ...pipelineState.productionRepairs, stop: null, pending: null };
        }
      }
      if (pipelineState.productionRepairs?.stop) {
        const previous = pipelineState.productionRepairs;
        pipelineState.productionRepairs = reconsiderProductionStop(previous, productionRepairSignature(project));
        if (previous !== pipelineState.productionRepairs) log('↻ 作者输入已改变，重新核验；保留已用自动修复次数，不追加预算');
      }
      /* 本轮受控补丁更新 workingSignature，不结束修复。只有无法归属本轮
       * 的输入变化才作废旧诊断；保留已用预算，不能假称修复已提交。 */
      {
        const pendingNow = pipelineState.productionRepairs?.pending;
        const signatureNow = pendingNow ? productionRepairSignature(project) : null;
        if (pendingNow && pendingNow.sourceSignature && !currentProductionRepair(pipelineState.productionRepairs, signatureNow)) {
          log('↻ 修复期间输入发生外部或未知变化：旧诊断作废，按当前文件重新检查；保留已用修复次数，未视为已提交');
          pipelineState.productionRepairs = { ...pipelineState.productionRepairs, pending: null };
          pipelineState.blocker = null;
          pipelineState.blockerHint = null;
          pipelineState.mountRepairTried = false;
        }
      }
      // Duration trimming is an automatic repair too, not free initial writing.
      if (work?.key.startsWith('duration:') && !pipelineState.productionRepairs?.stop && !pipelineState.productionRepairs?.pending) {
        recordProductionFailure('measure', work.note);
      }
      const stopped = pipelineState.productionRepairs;
      const stopKind = stopped?.stop ? (stopped.stoppedKind || classifyProductionFailure(stopped.stop)) : null;
      const stoppedStage = stopped?.stop ? stoppedFailureStage(stopped) : null;
      const probeSignature = stopped?.stop ? productionRepairSignature(project) : null;
      /* 环境故障不是内容问题：用户修好环境后，普通“继续”不能永久拦死。
       * 但也不能让模型借机改稿或无限重试 —— 只对原失败阶段做一次探测，
       * 同一输入只探测一次；仍然失败就保留现场并再次停止。 */
      const environmentProbe = !!resume && !!stopped?.stop && stopKind === 'environment' && !!stoppedStage
        && ['build', 'measure', 'render', 'voice', 'validate'].includes(work?.stage)
        && !(stopped.probedSignatures || []).includes(probeSignature);
      if (environmentProbe) {
        pipelineState.productionRepairs = { ...stopped, stop: null, pending: null,
          probedSignatures: [...(stopped.probedSignatures || []), probeSignature] };
        log('↻ 环境故障恢复：对阶段 ' + stoppedStage + ' 做一次探测；不改稿、不追加内容修复预算');
      }
      // A legacy build may have been attempted on half a script or starter
      // scenes. Resume those missing authoring stages, not the failed render.
      const upstream = stopped?.stop && stopKind === 'content' &&
        (['draft_plan', 'draft_script', 'draft_claims', 'review_content', 'draft_scenes', 'define_change', 'verify_change'].includes(work?.stage)
          || work?.stage === 'author_edit' && work.key.startsWith('edit:'));
      if (pipelineState.productionRepairs?.stop && !upstream) {
        const currentKind = pipelineState.productionRepairs.stoppedKind || classifyProductionFailure(pipelineState.productionRepairs.stop);
        paused = pipelineState.productionRepairs.stop + (currentKind === 'content'
          ? '\n输入未修复时继续不会重置自动修复预算；请先修正作者输入，再继续核验。'
          : stoppedStage
            ? '\n已对原失败阶段做过一次环境探测仍未通过；请先排除环境/检查器故障，再继续。'
            : '\n请先核对环境或检查器故障，不通过改稿或重置预算绕过。');
        log('\n⏸ ' + paused); checkpoint('auto-repair-stopped'); break;
      }
    }
    /* 用户提了新要求时，不能停在 validate（那是"核对交付物"的脚步）。
     * 产物齐全不代表这一轮没有活干 —— 用户说"片尾加广告"就必须改稿。
     *
     * ⚠ 这个标记只能在本次执行的**第一轮**设置一次。
     * 真实事故：`!saved && instruction` 在整个新任务期间一直为真，写入成功后刚清掉，
     * 下一轮又设回去，任务永远回不到正常收尾，在 render → voice → 改稿 → build 之间循环 5 轮。
     * userEditArmed 是本次执行的本地标志，不写入检查点。
     *
     * ⚠ 但"恢复"也可能是用户带着新要求回来：点继续后在输入框写了"片尾加广告"。
     * 旧实现用 `!saved` 把这种情况一并排除了，新要求被读进上下文却从未落到作者文件。
     *
     * 判断口径是**结构性**的，不是词表：只要这一轮真的带来了新的用户发言
     * （不是纯"继续/重试"），并且不是明确要求先讨论，就当作用户要求。
     * 这样"片尾接广告""换标题""改字幕""补一句口播"都不需要逐个登记到词表里。 */
    const saidSomething = options.instructionKind !== 'material' && !isPureContinuation(instruction) && !isDiscussionOnly(instruction);
    const userAskedNew = saidSomething && !userEditArmed;
    const pendingChangeNow = pendingChanges(project, changeContracts).length > 0;
    if (userAskedNew && !pendingChangeNow && !review) {
      pipelineState.userEditPending = 'user-edit-active';
      // 记住真正该改的作者文件基线：写发布文案不能冒充"已落实修改"。
      pipelineState.userEditBaseline = authorRevision(project);
    }
    userEditArmed = true;
    /* A user edit must not have to rediscover measured facts by reading source.
     * Compute cheap deterministic findings once for the whole edit request,
     * regardless of which authoring sub-stage the scheduler happens to pick.
     * On resume `instruction` is empty, so fall back to the task transcript
     * (which carries the user's original words) before giving up. */
    if (pipelineState.userEditPending && !pipelineState.userEditFindings) {
      const request = [instruction, ...unreadInstructions.map(n => n.content)].join('\n').trim() ||
        pipelineState.userEditRequest ||
        String(task || '').split('用户的指令是：').pop() || '';
      pipelineState.userEditRequest = pipelineState.userEditRequest || request;
      try { pipelineState.userEditFindings = await measuredEditFindings(project, pipelineState.userEditRequest); }
      catch { pipelineState.userEditFindings = ''; }
    }
    if (pipelineState.userEditPending && work && !pendingChangeNow) {
      const stageNow = work.stage;
      /* Any stage that is not already authoring must yield to the user's new
       * content request: publish/validate would "finish" without touching the
       * video, and build/measure/render would merely regenerate old content. */
      if (!['author_edit', 'draft_plan', 'draft_script', 'draft_claims', 'draft_scenes', 'define_change'].includes(stageNow)) {
        work = {
          key: pipelineState.userEditPending,
          stage: 'author_edit',
          tool: 'patch_text',
          required: null,
          /* No run_stage here: this stage's contract is "current stage only",
           * so advertising build would invite a call that is then rejected.
           * The executor advances to build/measure/render/voice on its own once
           * the author files actually change. */
          allowed: ['read_file', 'read_edit_file', 'read_scene', 'patch_text', 'replace_scene', 'append_file', 'list_files'],
          auto: false,
          note: '【用户提出了新的修改要求】当前成片已完整，但那只是上一轮的产物。' +
            '\n本阶段只落盘作者文件；写成功后执行器会自动推进 build → measure → render → voice，你不必也不能在这里调用 run_stage。' +
            '\n⚠ 先花少量读取定位到确切位置（分段读、别整份通读），然后立刻动手；只读不写会被判空转而暂停。' +
            '\n做法：' +
            '\n1) 用 patch_text / replace_scene / append_file 修改 脚本.md 或 scenes.src.js；' +
            '\n2) 加片尾场次时：脚本.md 末尾加 ## S{n} + 编号旁白，scenes.src.js 用 //--- 分隔追加一场 root => {...}；' +
            '\n3) 不要把整片重写，也不要只回复"已完成"；执行器会核对文件指纹后才允许出片。' +
            (pipelineState.userEditFindings || '') +
            authorEditAnchors(project),
        };
      }
    }
    /* 闸门拦截后必须交还给改稿阶段。
     * 死结的成因：render 阶段只允许 run_stage，而闸门失败的修法通常是改脚本，
     * 这个阶段的工具清单里根本没有编辑工具 —— 模型只能反复读文件，被判偏离后暂停，
     * 用户点继续仍是同一处境，「成片还没生成」于是无限重复。
     * 这里把阶段临时换成 author_edit，并明确告诉它要修哪几条。 */
    if (work && ['build', 'measure', 'render', 'voice', 'validate'].includes(work.stage)
      && pipelineState.gateBlocked === work.stage && pipelineState.gateBlocker) {
      /* 一旦修完并重跑成功，标记要清掉（见 productive 分支），否则会永远卡在改稿模式。 */
      work = {
        key: 'gate-fix:' + work.stage + ':' + pipelineState.gateBlocker.slice(0, 40),
        stage: 'author_edit',
        tool: 'patch_text',
        required: null,
        allowed: ['read_file', 'read_edit_file', 'read_scene', 'patch_text', 'replace_scene', 'append_file', 'list_files'],
        auto: false,
        note: '【质量闸门未通过，先改内容】' + pipelineState.gateBlocker +
          '\n要用 patch_text / append_file 修改 脚本.md（以及 scenes.src.js 对应场）。' +
          '\n⚠ 本阶段不要用 run 或 node -e 读文件：那不算推进，连续几次会被判偏离而暂停。' +
          '要看内容就用 read_file / read_edit_file。' +
          '\n改完直接 run_stage build → measure → render 重跑。',
      };
    }
    if (automation.enabled && !review && !mutationDeferred && pipelineState.productionRepairs?.pending) {
      work = productionRepairWork(pipelineState.productionRepairs);
      /* The quality gate reports times and quoted labels, not source offsets.
       * Give the repair window concrete file:line candidates so it can patch
       * instead of scanning whole files until the idle limit stops it. */
      if (work) {
        const hints = repairHints(project, pipelineState.productionRepairs.pending.reason);
        work = { ...work, note: work.note + '\n【可直接定位的候选位置】\n' + hints +
          '\n同一段文字可能有多处：用 read_edit_file 只读目标范围确认当前 base_hash，再用 patch_text 并写明 expected_count；不要整份扫描。' };
      }
    }
  /* The user's own new instruction must survive publishOnly. Before this fix a
   * missing 发布文案.md forced the whole run into publish scope, so an "add an ad"
   * request could only ever write 发布文案.md and then pass validate. */
  opts.publishOnly = mode === 'edit-copy' || work?.stage === 'publish' && !pipelineState.userEditPending;
  if ((work?.key || null) !== pipelineState.key) {
      /* 保留闸门标记：它不是"当前阶段"的一部分，而是"上一阶段被拦下、待修"的跨轮状态。
       * 若跟着重置，下一轮又会拿回 render，继续撞同一堵墙。 */
      const carry = { gateBlocked: pipelineState.gateBlocked, gateBlocker: pipelineState.gateBlocker,
        blockerHint: pipelineState.blockerHint,
        productionRepairs: pipelineState.productionRepairs,
        /* 机械修复每个阶段只自动做一次：做过了仍失败，说明不是挂载问题，
         * 不能在同一处反复改文件。 */
        mountRepairTried: pipelineState.mountRepairTried,
        /* 修复窗口停滞计数描述的是同一笔待修事务，阶段切换不能把它清零。 */
        repairStalledWindows: pipelineState.repairStalledWindows,
        repairWindowStalled: pipelineState.repairWindowStalled,
        userEditPending: pipelineState.userEditPending,
        userEditBaseline: pipelineState.userEditBaseline,
        /* totalTurns 是跨小步骤的累计（"这个任务一共走了多少轮"），
         * 阶段切换时不能清零，否则会误以为一直在原地打转。 */
        totalTurns: pipelineState.totalTurns,
        // Protocol violations are not stage-specific exploration. Stage switching
        // must not launder a provider repeatedly ignoring the advertised tools.
        progress: { ...newStageProgress(), violations: pipelineState.progress?.violations || 0 } };
      pipelineState = { version: 2, key: work?.key || null, stage: work?.stage || null, turns: 0, truncations: 0, ...carry };
      if (work) log('制作阶段：' + work.stage + (work.path ? ' → ' + work.path : '') + (work.scene ? ' / S' + work.scene : ''));
      if (saved && !saved.pipelineState && work) truncationStreak = 0; // 新编辑策略只迁移一次，不盲目续用旧的大输出策略。
    }
    // 恢复同一关口时 key 可能没变，但当前 attempt 已变；仍须登记本次执行，不能沿用旧阶段身份。
    if (work && recordedPipelineKey !== work.key) {
      saveState(project, { pipeline: { stage: work.stage, since: Date.now(), taskId, attemptId } });
      publishProductionProgress(work.stage);
      recordedPipelineKey = work.key;
    }
    if (work) {
      pipelineState.totalTurns++;
      /* 这一步的上限防的是"原地打转"，不是"读得久"。
       * 真实事故：模型用十几轮读脚本、读场景、定位插入点，第 12 轮刚要动手就被
       * "连续12轮未完成"判死。轮次必须在**有产出时清零**，只累计无产出的连续轮次，
       * 否则"连续 N 轮未完成"这句话本身就是假的。 */
      const turnLimit = pipelineState.productionRepairs?.pending ? 24 : 12;
      /* Authoring stages get their budget counted by *stale* reads: a real
       * localization pass over a 900-line scene legitimately reads many new
       * ranges. Spinning means re-reading content already seen, not reading.
       * A hard overall cap still bounds a pathologically long window. */
      const authoring = AUTHOR_STAGES.has(work.stage);
      const spin = authoring ? (pipelineState.progress?.staleReads || 0) : (pipelineState.progress?.idle || 0);
      // Reading new ranges is a localization pass; a long one is still bounded,
      // but it must not be described as "spinning on the same content".
      const hardCap = authoring ? turnLimit * 4 : turnLimit;
      const spinStop = spin >= turnLimit;
      /* 只看「读了多少轮」会得出一个没用的结论：模型确实在「读新范围」。
       * 真正该问的是「还有没有没看过的内容」。把目标文件的有效行看过 90%
       * 以上、却一处都没写，就已经没有新信息可读了 —— 这时候停在 96 轮
       * （历史事故）只是在烧额度；应当在读满时就逼它落到写入。 */
      const coverage = (() => {
        if (!authoring) return 0;
        let best = 0;
        for (const [file, seen] of opts._seenWindows || []) {
          if (!['scenes.src.js', '脚本.md', 'engine.tpl.html', '方案.md', 'claims.json'].includes(file)) continue;
          let total = 0;
          try { total = fs.readFileSync(path.join(project, file), 'utf8').split('\n').length; } catch { continue; }
          if (total > 0) best = Math.max(best, seen.length / total);
        }
        return best;
      })();
      const coveredStop = coverage >= 0.9 && (pipelineState.progress?.idle || 0) >= turnLimit;
      const capStop = authoring && ((pipelineState.progress?.idle || 0) >= hardCap || coveredStop);
      if (spinStop || capStop) {
        /* 停止必须比「再试一次」更可操作：把能直接照抄的位置一并写出来，
         * 否则用户点「继续」只会重复同一次全盘扫描。 */
        const anchored = (() => {
          try { return ['author_edit', 'draft_scenes'].includes(work.stage) ? repairHints(project, pipelineState.blocker || work.note) : ''; } catch { return ''; }
        })();
        paused = nextWorkAction(work, sceneWork) + (capStop && !spinStop
          ? `当前小步骤 ${work.stage} 已 ${pipelineState.progress.idle} 轮没有任何落盘` +
            (coveredStop ? `（目标文件已看过约 ${Math.round(coverage * 100)}% 的行，继续读不会有新信息）` : '（读取新范围不算空转，但一直没有写入等于没有推进）') +
            `；停止继续消耗。` +
            (pipelineState.blocker || work.note.slice(0, 300)) +
            (anchored ? '\n可直接照抄的修改位置：\n' + anchored : '')
          : `当前小步骤 ${work.stage} 连续 ${spin} 轮没有推进产物；停止继续消耗。` +
            (authoring ? '\n（读取新范围本身不算空转；这里是同一内容反复读取或长期没有落盘。）' : '') +
            (pipelineState.blocker || work.note.slice(0, 240)));
        log('\n⏸ ' + paused); break;
      }
    }
    /* 机械核验不需要模型参与：公开文件没有登记词时直接执行并记录。
       模型即使再次登记清单或搜索内部证据，也不能把这一步无限拖住。 */
    /* ⚠ 但只有在"这一轮没有新要求"时才能这么判。
     * 真实事故：用户在已完成的片子上说"片尾加 15 秒广告"，进程 0.6 秒就回"已完成"退出，
     * 指令一个字都没读 —— 因为 validate 的机械检查只看"产物齐不齐"，不看"用户要什么"。
     * 有明确新要求时必须先让模型处理，否则输入框等于没用。 */
    const hasFreshRequest = freshThisTurn;
    const canDispatch = () => !signal?.aborted && !drainSteer().length;
    /* 审阅请求不能交给 validate 的“产物齐全”短路；先跑实际画面体检，未跑完不许回答。 */
    if (review?.required && review.scopes.includes('visual') && !review.done) {
      try {
        if (!fs.existsSync(path.join(project, 'scene.html'))) throw new Error('scene.html 缺失，本轮无法检查画面；只读审阅不会代为制作');
        const report = await runVisualReview(project);
        review.done = true; review.summary = reviewSummary(report); review.failed = report.failed;
        const failedNote = report.failed
          ? '\n⚠ 有 ' + report.failed + ' 项检查本身失败。回答必须明确说明这些项没有检查成功，不能说画面没问题。'
          : '';
        messages.push({ role: 'user', content: '【本轮审阅已执行】' + review.summary +
          '\n现在依据这份实际检查结果回答用户。逐条说明：哪些机器查过、哪些只能人工看；不得声称看过未检查的部分，也不得把“无机器疑点”说成画面正确。只回答，不改稿；用户明确要求修改时才改。' + failedNote });
        log('\n' + review.summary);
        checkpoint('reviewed');
        continue;
      } catch (e) {
        paused = '画面审阅未能执行：' + e.message + '。没有据此宣称检查通过。';
        log('\n⏸ ' + paused); break;
      }
    }
    if (!automation.enabled && work?.auto && work.stage === 'validate' && !mutationDeferred && !hasFreshRequest && !review
      && pipelineState.validateChecked !== work.key) {
      if (!canDispatch()) { checkpoint('steer-wait'); continue; }
      pipelineState.validateChecked = work.key;
      const result = projectDeliveryState(project);
      if (!result.stale) {
        answer = deliveryAnswer(project);
        log('\n' + answer);
        break;
      }
      pipelineState.blocker = result.reason;
      messages.push({ role: 'user', content: '【程序交付检查未通过】' + result.reason +
        '\n先补实际缺失阶段或修复真实报错，不要只汇报完成。' });
      checkpoint('validate-blocked');
      /* 只自动检查一次；随后让模型带着准确缺口继续，不在同一处反复空转。 */
    }
    if (work?.auto && work.stage === 'verify_change' && !mutationDeferred) {
      if (!canDispatch()) { checkpoint('steer-wait'); continue; }
      const change = changeContracts.find(c => c.id === work.changeId);
      if (change) {
        try {
          const verified = verifyChange(project, change, { summary: autoVerificationSummary(change) });
          log('  ✓ 执行器直接完成机械核验（不调用模型）：' + change.text.slice(0, 80) +
            (verified.review === 'needs-human' ? '；语义取舍已标记为待人工审阅' : ''));
          pipelineState.blocker = null;
          messages.push({ role: 'user', content: '【程序核验结果】' + JSON.stringify(verified) +
            '\n这一步已完成。下一步按当前阶段继续；不要重复登记清单，也不要为脱敏搜索内部证据文件。' });
          checkpoint('auto-verified');
          continue;
        } catch (e) {
          pipelineState.blocker = e.message;
          log('  ⚠ 机械核验未通过：' + e.message + '；回到实际缺口继续修改');
        }
      }
    }
    /* 机械缺陷不交给模型：元素已经建好、坐标已经算好，缺的只是一行
     * root.appendChild。让模型去 1400 行里逐处补丁，得到的必然是「读 96 轮、
     * 写 0 处」。这类改动由执行器直接做、直接校验、直接备份，模型只保留
     * 内容判断。判定入口是「当前失败原因是挂载类」或「场景里确实有未挂元素」。
     */
    if (work && AUTHOR_STAGES.has(work.stage) && !mutationDeferred && !review && !opts.readOnly
      && !hasFreshRequest && !opts.uncertainCommands.length && !pipelineState.mountRepairTried) {
      let plan = null;
      try { plan = mountRepairPlan(project); } catch { plan = null; }
      if (plan?.actionable) {
        pipelineState.mountRepairTried = true;
        if (!canDispatch()) { checkpoint('steer-wait'); continue; }
        const fixed = repairUnmountedScenes(project, { log });
        log('  ⚙ 执行器机械修复元素挂载：' + (fixed.repaired.map(item => 'S' + item.scene).join('、') || '无') +
          (fixed.skipped.length ? '；' + fixed.skipped.length + ' 场需内容判断' : ''));
        messages.push({ role: 'user', content: '【执行器已机械补全元素挂载】\n' +
          (fixed.repaired.length
            ? '已为这些场补上 root.appendChild（原文已备份，逐场校验通过）：' +
              fixed.repaired.map(item => `S${item.scene}(${item.count} 处)`).join('、') + '。这一项不需要你再改。'
            : '本次没有可安全机械修复的场。') +
          (fixed.skipped.length
            ? '\n这些场仍需你判断（容器内元素或数组结果，程序不能替你决定）：' +
              fixed.skipped.map(item => `S${item.scene}（缺 ${item.remaining.length} 处：${item.remaining.slice(0, 4).join('、')}）`).join('；')
            : '') +
          '\n下一步直接跑 build 复检，不要重新通读整份文件。' });
        checkpoint('mount-repaired');
        continue;
      }
    }
    if (!automation.enabled && work && MACHINE_STAGES.has(work.stage) && pipelineState.autoStageFailed === work.key && pipelineState.blocker) {
      paused = '阶段 ' + work.stage + ' 上次真实失败且尚未修复：' + pipelineState.blocker + '。未原样重跑，先修复实际问题。';
      log('\n⏸ ' + paused); checkpoint('stage-blocked'); break;
    }
    if ((automation.enabled || pipelineState.progress?.idle >= 2) && work && MACHINE_STAGES.has(work.stage)
      && !mutationDeferred && !hasFreshRequest && !review && !pipelineState.userEditPending && !opts.uncertainCommands.length) {
      if (!canDispatch()) { checkpoint('steer-wait'); continue; }
      const result = await tools.run_stage.run({ stage: work.stage });
      const outcome = toolOutcome(result);
      log((outcome.ok ? '  ✓ ' : '  ✗ ') + '自动制作阶段 ' + work.stage + '：' + outcome.summary);
      messages.push({ role: 'user', content: '【自动制作阶段 ' + work.stage + '】\n' + result });
      if (!outcome.ok) {
        recordProductionFailure(work.stage, result);
        if (!automation.enabled) {
          pipelineState.blocker = outcome.summary;
          pipelineState.autoStageFailed = work.key;
          if (classifyProductionFailure(outcome.summary) === 'content') {
            pipelineState.gateBlocked = work.stage; pipelineState.gateBlocker = outcome.summary;
          }
        }
      }
      else if (work.stage === 'validate') {
        answer = deliveryAnswer(project, { automated: true });
        log('\n' + answer); break;
      } else { pipelineState.blocker = null; }
      checkpoint('automatic-stage');
      continue;
    }
    if (work?.stage !== 'draft_scenes' || mutationDeferred || review) sceneWork = null;
    pipelineState.progress ||= newStageProgress();
    if (work?.stage === 'draft_scenes' && work.recovery && !mutationDeferred && !review && !hasFreshRequest && !opts.uncertainCommands.length) {
      if (!canDispatch()) { checkpoint('steer-wait'); continue; }
      if (work.recovery.transaction_recoverable && work.recovery.transaction_hash) {
        const result = await tools.recover_scene_transaction.run({ transaction_hash: work.recovery.transaction_hash,
          recovery_hash: work.recovery.recovery_hash });
        messages.push({ role: 'user', content: '【恢复已遗弃草稿事务】\n' + result });
        if (!toolOutcome(result).ok) { paused = '遗留草稿事务未能安全恢复：' + result; checkpoint('transaction-recovery-blocked'); break; }
        log('  ✓ 已核对死亡持有者与活动代，清理遗留事务门；草稿/历史未删除');
        pipelineState.progress = newStageProgress(); checkpoint('transaction-recovered'); continue;
      }
      if (!work.recovery.can_rebase) {
        paused = work.recovery.source_conflict
          ? '分场草稿与当前 scenes.src.js 有外部源码冲突；已保留两份内容，不能自动覆盖。请核对并完成当前作者场景后继续。'
          : '分场草稿有未结束事务或无法核验的基线；未覆盖草稿或作者文件，先核对事务现场。';
        log('\n⏸ ' + paused); checkpoint('draft-conflict'); break;
      }
      const r = work.recovery;
      const result = await tools.rebase_scene_drafts.run({ script_hash: r.script_hash, source_hash: r.source_hash,
        manifest_hash: r.manifest_hash, recovery_hash: r.recovery_hash, reuse_scenes: JSON.stringify(r.reusable) });
      messages.push({ role: 'user', content: '【受控恢复分场草稿】\n' + result });
      if (!toolOutcome(result).ok) { paused = '分场草稿恢复未成功：' + result; checkpoint('draft-recovery-blocked'); break; }
      log('  ✓ 旧草稿已归档；仅复用身份证据未变化的场次，继续制作缺场');
      pipelineState.progress = newStageProgress(); checkpoint('drafts-rebased'); continue;
    }
    // Deterministic tasks, including assembly, belong to the executor. Once the
    // inputs are ready there is no reason to ask a model which command to run.
    if (work?.stage === 'draft_scenes' && work.tool === 'assemble_scenes' && !mutationDeferred && !review &&
      !hasFreshRequest && !opts.uncertainCommands.length) {
      if (!canDispatch()) { checkpoint('steer-wait'); continue; }
      const result = await tools.assemble_scenes.run({});
      messages.push({ role: 'user', content: '【执行器组装分场】\n' + result });
      if (!toolOutcome(result).ok) {
        paused = '分场组装未成功，未覆盖冲突版本：' + result;
        log('\n⏸ ' + paused); checkpoint('assembly-blocked'); break;
      }
      pipelineState.progress = newStageProgress();
      if (pipelineState.userEditPending && authorFilesChangedSince(project, pipelineState.userEditBaseline, modeEditTargets(mode) || undefined)) {
        pipelineState.userEditPending = null; pipelineState.userEditBaseline = null;
      }
      checkpoint('assembled'); continue;
    }
    const contract = stageContract(work, { schemas, progress: pipelineState.progress, scene: sceneWork, project,
      readOnly: opts.readOnly, uncertain: !!opts.uncertainCommands.length,
      truncations: pipelineState.truncations, blocker: !!pipelineState.blocker });
    opts.activeContract = contract;
    const violationLimit = work?.stage === 'draft_scenes' ? 3 : 6;
    if (pipelineState.progress.violations >= violationLimit) {
      // Resume clears only the transient counter; the prompt must still explain
      // what was rejected so the next attempt can act differently.
      const lastRejection = pipelineState.lastViolation || '响应工具不符合当前阶段';
      const schedule = work?.stage === 'draft_scenes' && sceneWork
        ? `脚本现有 ${parseScript(fs.readFileSync(path.join(project, '脚本.md'), 'utf8')).length} 场，画面尚未完成；` +
          `下一场用 write_scene 保存 S${sceneWork.scene}，齐场后由执行器组装，再 build/measure/render/voice。`
        : AUTHOR_STAGES.has(work?.stage) && pipelineState.progress.reads >= 7
          ? '本轮工具已收窄到写入（修作者文件时仍可用 read_edit_file 取当前完整 base_hash）；先读当前版本再打一处短补丁。'
          : '';
      paused = nextWorkAction(work, sceneWork) + `阶段 ${work?.stage || '当前任务'} 的回应多次不符合本轮工具契约，没有推进任何产出；已拒绝未授权调用并停止继续消耗。` +
        (schedule ? '\n' + schedule : '') +
        '\n最后拒绝原因：' + lastRejection +
        '\n请检查当前渠道的工具调用兼容性；更正输入或提供新要求后可继续。' + (work?.note || '');
      log('\n⏸ ' + paused); checkpoint('contract-blocked'); break;
    }
    const directSceneWrite = contract.directed === 'write_scene';
    if (directSceneWrite) log(`⚠ 连续 ${pipelineState.progress.idle} 轮未保存当前场景；本轮定向调用 write_scene，先完成 S${sceneWork.scene}（执行端同样限制工具与场号）`);
    const refreshed = agentWorkflowPrompt(project) + '\n' + worklogBlock(project) + '\n【当前制作关口（以实际文件为准，不代表已验收；仍须服从用户范围）】\n' +
      (opts.readOnly ? '本轮只读：回答当前问题或审阅发现，不补生产文件、不执行制作。' : nextAgentStep(project, mode)) +
      (sceneWork ? '\n' + sceneWork.note : '') + '\n' + videoFormatPrompt(project) + '\n' + durationPrompt(project) +
      '\n' + changesPrompt(project, changeContracts) + (work ? '\n' + work.note : '') +
      (pipelineState.userEditFindings ? '\n' + pipelineState.userEditFindings : '') +
      (pipelineState.blocker ? '\n【上一步真实失败】' + pipelineState.blocker + '；先用小块编辑修第一条报错，禁止原样反复执行重型阶段。' : '') +
      (pipelineState.blockerHint ? '\n【工具用法纠正】' + pipelineState.blockerHint : '') +
      (directSceneWrite ? '\n【本轮调度】仅保存上述一场完整草稿，不要输出分析或查模板。若已有明确用户新要求，则以用户范围为准。' : '');
    const viewForRequest = () => currentAgentMessages(project, messages);
    const requestSchemas = contract.schemas;
    if (pipelineState.progress.reads >= 7 && !opts.readOnly) log('  ⚑ 收起只读工具，本轮只能写；执行端使用同一阶段契约');
    totalSteps++; attemptSteps++;
    checkpoint('requesting');
    if (steers.length) {
      try {
        const current = JSON.parse(fs.readFileSync(steerPath, 'utf8'));
        fs.writeFileSync(steerPath, JSON.stringify(current.filter(st => !consumedSteers.includes(st.id || JSON.stringify(st)))));
      } catch {}
    }
    const requestedTool = contract.directed;
    let resp;
    opts.publishInputs = publishInputs(project);
    try { resp = await pool.chat(viewForRequest(), requestSchemas, signal, refreshed, {
      toolChoice: requestedTool,
      maxOutputTokens: configuredOutput, stageContext: !!work, omitLatestPlainReasoning: !!work && pipelineState.truncations > 0,
    }); }
    catch (e) {
      if (signal?.aborted) { cancelled = true; log('已取消；不再发送模型请求'); }
      else if (e.failures?.length === 1 && (
        e.failures[0].kind === 'request' && e.failures[0].diagnostics?.apiCode === 'invalid_tool_call' ||
        e.failures[0].kind === 'response' && e.failures[0].diagnostics?.parseCode === 'invalid_tool_arguments')) {
        toolRepairStreak++;
        log(`⚠ 工具参数生成失败；整批工具未执行（本段未推进期间第 ${toolRepairStreak} 次）`);
        if (toolRepairStreak >= 2) {
          paused = '工具参数连续生成失败，已停止自动纠偏；整批工具均未执行，检查点已保留。' + nextAgentStep(project, mode);
          log('\n⏸ ' + paused);
        } else {
          messages.push({ role: 'user', content: '【工具参数纠偏】上一批工具参数无效，整批没有执行；不要假定文件已改动，不补接半截 JSON。下一步只生成一个完整、较小的工具调用，参数须为合法 JSON。场景制作只用 write_scene 写下一场，不一次生成整片代码。' });
          if (sceneWork) pipelineState.progress.idle = Math.max(4, pipelineState.progress.idle);
          continue;
        }
        break;
      }
      else if (e.failures?.length === 1 && e.failures[0].kind === 'truncated' && e.failures[0].diagnostics?.parseCode === 'output_truncated') {
        if (work) pipelineState.truncations++;
        truncationStreak++;
        log(`⚠ 模型工具调用被输出上限截断（连续 ${truncationStreak} 次）；整批工具未执行`);
        if (truncationStreak >= 2) {
          paused = `连续 ${truncationStreak} 次输出截断；未执行半截工具。检查点已保存。${nextAgentStep(project, mode)}`;
          log('\n⏸ ' + paused);
        } else {
          messages.push({ role: 'user', content: '【输出截断，工具未执行】上一步没有任何工具结果，不能假定文件已写入。不要继续生成整片或输出长段说明；现在只用 write_scene 写一个完整场景，完成后再写下一场。其他任务也请缩小为一个工具调用。' });
          continue;
        }
      } else { failure = e.message; providerFailures = e.failures || []; log('模型调用失败：' + failure); }
      break;
    }
    const choice = resp.choices?.[0];
    const msg = choice?.message;
    const finish = choice?.finish_reason;

    if (!msg) {
      if (++emptyStreak >= 3) { log('连续 3 次空响应，停止'); break; }
      log(`⚠ 空消息（第 ${emptyStreak} 次），催它继续…`);
      messages.push({ role: 'user', content: '继续。下一步就动手（写文件或跑命令），不要只解释。' });
      continue;
    }
    messages.push(msg);
    const calls = msg.tool_calls || [];
    const pendingChange = pendingChanges(project, changeContracts)[0];
    if (calls.length && !drainSteer().length) {
      let rejection = calls.map(call => contract.validate(call)).find(Boolean);
      for (const call of calls) {
        const name = call.function?.name;
        /* 脱敏只约束公开发布内容：翻内部证据会把修改范围越扩越大，且与验收口径不一致。 */
        if (pendingChange?.kind === 'redact' && ['read_file', 'read_edit_file'].includes(name)) {
          const target = callPath(call);
          if (target && !PUBLIC_AUTHORS.includes(target)) {
            rejection = '脱敏只处理公开交付文件（脚本.md / scenes.src.js / 发布文案.md）；' + target + ' 是内部证据，不为此改写或反复搜索。';
          }
        }
        if (name === 'define_change' && pendingChange?.forbidden?.length) {
          rejection = '清单已登记，不要重复登记。公开发布文件已无登记词时，执行器会直接核验；现在按下一步推进。';
        }
        /* 写草稿阶段禁止翻 harness 自己的源码：真实事故里模型为了猜 claims.json
         * 的字段名，连续 4 轮 sed/grep 读 lib/claims.mjs，最终按"偏离"暂停。
         * 字段规范已在阶段说明里给全，读源码既无必要，也会把项目步数耗光。 */
        const draftStage = ['draft_plan', 'draft_script', 'draft_claims', 'draft_scenes'].includes(work?.stage);
        if (draftStage && ['run', 'read_file', 'list_files'].includes(name) && touchesHarnessSource(call, project)) {
          rejection = '本阶段规范已在提示里给全，不需要读 harness 源码。按当前制作关口推进作者文件。';
        }
      }
      // Validate the ENTIRE batch before dispatch: an unadvertised call cannot
      // piggyback on a legitimate edit or consume a partial transaction.
      pending = calls.map(call => ({ call, status: 'planned', ...(rejection ? { rejection: '拒绝：' + rejection + '；整批未执行，请只调用当前允许的工具。' } : {}) }));
      if (rejection) { pipelineState.lastViolation = rejection; log('  ↻ 阶段契约拒绝响应：' + rejection); }
    }
    pending = pending.length ? pending : calls.map(call => ({ call, status: 'planned' }));
    checkpoint(calls.length ? 'tools-planned' : 'response');
    const hasText = !!(msg.content && msg.content.trim());

    if (!calls.length && drainSteer().length) {
      messages.push({ role: 'user', content: '【新要求待接收】本回复来自旧请求，不能作为最终完成；下一轮先接收插话，再按最新要求推进。' });
      checkpoint('ready');
      continue;
    }

    if (!calls.length) {
      pipelineState.progress = advanceStageProgress(pipelineState.progress, { violation: !!contract.directed });
      if (finish === 'length') {
        if (work) pipelineState.truncations++;
        truncationStreak++;
        if (truncationStreak >= 2) {
          paused = '模型连续达到输出上限，尚未形成完整结果；检查点已保存。继续时请拆分文件或缩小单步输出。';
          log('\n⏸ ' + paused); break;
        }
        log('⚠ 回复达到输出上限，不作为完成；要求拆分写入');
        messages.push({ role: 'user', content: work ? '上次回复达到输出上限。下一轮只执行当前小任务：' + work.note + '。不要输出长分析或重写整文件。'
          : '上次回复被输出上限截断，不能作为完成。请只用 write_scene 写一个完整场景，避免一次生成整份 scenes.src.js。' });
        continue;
      }
      truncationStreak = 0;
      if (work?.stage === 'draft_scenes' && !opts.readOnly) {
        messages.push({ role: 'user', content: '【画面制作尚未执行】没有保存当前场景，不能只回复说明。下一轮按本轮允许工具保存一场；整片组装由执行器负责。\n' + work.note });
        checkpoint('authoring-needed'); continue;
      }
      if (!hasText) {
        if (++emptyStreak >= 3) { log('连续 3 次空转，停止'); break; }
        log(`⚠ 没内容也没动作（finish=${finish || '?'}），催它继续…`);
        messages.push({ role: 'user', content: '继续。要么写文件、要么跑命令；不要只解释思路。' });
        continue;
      }
      const missing = opts.readOnly ? [] : criticalMissing(project, mode);
      const unverified = opts.readOnly ? [] : pendingChanges(project, changeContracts);
      if (unverified.length) {
        if (++emptyStreak >= 3) {
          paused = '用户要求尚未完成核验，不能标记完成。' + changesPrompt(project, changeContracts); log('\n⏸ ' + paused); break;
        }
        messages.push({ role: 'user', content: changesPrompt(project, changeContracts) });
        continue;
      }
      if (missing.length && emptyStreak < 2) {
        emptyStreak++;
        log(`⚠ 只汇报但缺少 ${missing.join('/')}，催它继续…`);
        messages.push({ role: 'user', content: `继续完成任务：还缺 ${missing.join('、')}。现在就用 write_file 或跑命令推进，不要只汇报。` });
        continue;
      }
      if (missing.length) {
        paused = `任务尚缺 ${missing.join('、')}，不能标记完成。检查点已保存；` + nextAgentStep(project, mode);
        log('\n⏸ ' + paused); break;
      }
      log('\n' + msg.content);
      /* 检查器失败时，模型仍然可能给出“看不清/没问题”的结论；这不能算审阅完成。 */
      if (review?.required && review.done && review.failed) {
        if (++emptyStreak >= 2) {
          paused = `画面审阅有 ${review.failed} 项检查失败，不能据此回答“没问题”。检查点已保存；可先修检查器或改用 vh screen / vh density 实际复查。`;
          log('\n⏸ ' + paused); break;
        }
        messages.push({ role: 'user', content: `本次审阅有 ${review.failed} 项检查本身失败，结论无效。请明确告诉用户哪几项没检查成功；如果要判断越界，用 vh stills --at 或 vh screen --frames 实际出图核对，不能凭代码推测。` });
        continue;
      }
      if (review?.required && !review.done) {
        if (++emptyStreak >= 2) {
          paused = '画面审阅尚未实际执行，不能回答为已检查。检查点已保存。';
          log('\n⏸ ' + paused); break;
        }
        messages.push({ role: 'user', content: '先执行画面审阅（程序体检），不要直接回答或宣称检查过。不要用 run/read_file 代替实际检查。' });
        continue;
      }
      /* 用户提了明确修改要求，但这一轮没有真正改到该改的文件就要收工 —— 不能接受。
       * 真实事故：用户要求"片尾接一个广告"，执行器当时被限定在 publish 阶段，
       * 只写了 发布文案.md 就 "validate 通过 → 完成"，脚本和画面一个字没动，
       * 而旧判断把"写 发布文案.md"也算成"写过了"，于是收尾检查被彻底绕过。
       * 现在只认用户要求真正落到的作者文件（脚本/场景/模板）。 */
      /* 判断“落实”看两部分，都来自结构而不是措辞：
       *   ① 这一轮有没有改到该模式负责的作者文件（基线比对，不是动作字符串）；
       *   ② 该模式是否根本不该被我在这里拦（通用 edit 由 writeGuard 管范围）。
       * 单一判据必然会在某个模式上过严或过松——真实事故是过松（写发布文案即算改片），
       * 而“继续出片”这类恢复又会被过严的判据误停。 */
      const targets = modeEditTargets(mode);
      const wroteSomething = !targets || authorFilesChangedSince(project, pipelineState.userEditBaseline, targets);
      if (!opts.readOnly && pipelineState.userEditPending && targets && !wroteSomething) {
        const copyChanged = authorFilesChangedSince(project, pipelineState.userEditBaseline, ['发布文案.md']);
        if (staleNudged) {
          paused = '收到修改要求，但 ' + targets.join(' / ') + ' 都没有变化，不能标记完成。' +
            (copyChanged ? '（只改发布文案不算落实视频修改。）' : '') + nextAgentStep(project, mode);
          log('\n⏸ ' + paused); break;
        }
        staleNudged = true;
        log('⚠ 还没有真正改动目标作者文件，不能当作完成；要求它动手');
        messages.push({ role: 'user', content:
          '你还不能结束：用户这次提了具体修改要求，而 ' + targets.join(' / ') + ' 都没有变化。' +
          (copyChanged ? '\n发布文案属于另一条任务（工作台「发布」页 / edit-copy），不能拿来顶替视频修改。' : '') +
          '\n现在就把要求写进 ' + targets[0] + (targets.includes('scenes.src.js') ? '（画面需要时同步改 scenes.src.js）' : '') +
          '，然后由执行器只补实际失效阶段。只回复"已通过检查"不算完成。' });
        continue;
      }
      // 说"完成"但成片落后 = 没做完。给一次明确纠正机会，别把半成品当完成。
      // 只对"要出片"的模式生效：纯改画面/改稿的对话不该被要求重渲整片。
      if (!opts.readOnly && requiresDeliverable(mode) && deliverableStale(project).stale) {
        if (staleNudged) {
          paused = '任务尚未交付：' + deliverableStale(project).reason + '。检查点已保存；' + nextAgentStep(project, mode);
          log('\n⏸ ' + paused); break;
        }
        staleNudged = true;
        const why = deliverableStale(project).reason;
        log('⚠ 成片落后：' + why + ' → 要求它补完再结束');
        messages.push({ role: 'user', content:
          `你还不能结束：${why}。保留已有有效产物，由执行器按当前输入补最少失效阶段；`
          + '不要强制全量渲染、重测或改状态/指纹冒充完成。' });
        continue;
      }
      const pub = publishStatus(project);
      if (!opts.readOnly && (mode === 'edit-copy' || requiresDeliverable(mode) && pub.required) && !pub.ok) {
        const reason = pub.errors.map(e => e.message).join('；');
        if (++emptyStreak >= 3) {
          paused = '发布文案尚未完成：' + reason + '。视频与已写文件保留，可单独继续文案任务。';
          log('\n⏸ ' + paused); break;
        }
        messages.push({ role: 'user', content: '不能标记完成，发布文案机械校验未通过：' + reason + '。只补发布文案，不重做视频；不编造缺失链接或替用户勾选人工审查。' });
        continue;
      }
      if (automation.enabled && mode !== 'edit-copy' && !review && !mutationDeferred) {
        const checked = await automatedDeliveryCheck(project), outcome = toolOutcome(checked);
        if (!outcome.ok) {
          recordProductionFailure('validate', checked);
          messages.push({ role: 'user', content: '【自动制作最终检查未通过】\n' + checked });
          checkpoint('automatic-validation-failed');
          continue;
        }
      }
      answer = automation.enabled && mode !== 'edit-copy' && !opts.readOnly
        ? deliveryAnswer(project, { automated: true }) : msg.content;
      break;
    }
    emptyStreak = 0;
    truncationStreak = 0;

    const batch = await performPending();
    if (msg.content && msg.content.trim()) log('  ' + msg.content.trim().slice(0, 300));

    /* 推进检测：实际产物变化才算前进，不能靠请求失败/被拒的构建清零。
     * 真实事故：400 步里 387 次 run、163 次查同一份画面模板，第 367 步才第一次写方案，
     * 到预算上限时画面仍与脚本对不上。单纯提高步数只会让空转更久。 */
    const now = authorProgressStamp(project);
    pipelineState.progress = advanceStageProgress(pipelineState.progress, { changed: now !== progressStamp, read: batch.read,
      fresh: batch.read && !batch.staleRead, violation: batch.violation });
    pipelineState.turns = pipelineState.progress.idle; // legacy observation field; not a second counter
    if (now !== progressStamp) {
      toolRepairStreak = 0;
      progressStamp = now; noProgressSteps = 0; stallPhase = 0; blockedProbes = 0;
      opts._probeCounts.clear(); docPokes = 0; lastToolSig = ''; stalled = 0;
      /* 真的推进了产物：这一步的"连续未完成"计数必须清零。
       * 否则同一小步骤里改三处、读十次会累加成"连续 12 轮未完成"，
       * 而实际上每一步都在前进（真实事故）。 */
      pipelineState.turns = 0;
    } else {
      noProgressSteps++;
      // 每个完整模型轮次至多计一次；混合批次中有效的新动作会打断拦截连击。
      blockedProbes = batch.count > 0 && batch.blocked === batch.count ? blockedProbes + 1 : 0;
    }
    /* 被反复拦下还不动手：继续烧额度没有意义，直接停下来并把下一步说清楚。 */
    if (blockedProbes >= 3) {
      paused = `连续 ${blockedProbes} 轮要求停止查阅后仍只请求被拦截的重复读取，未推进产物。`
        + '检查点已保存；继续原任务时从以下关口推进：' + nextAgentStep(project, mode);
      log('\n⏸ ' + paused);
      break;
    }
    if (noProgressSteps >= stallSteps && stallPhase === 0) {
      stallPhase = 1;
      log(`⚠ ${noProgressSteps} 步没有产出变化 → 要求它停止探索、立即推进`);
      messages.push({ role: 'user', content: stallNudge() });
      continue;
    }
    if (requiresDeliverable(mode) && stallPhase === 1 && noProgressSteps >= stallSteps + STALL_PAUSE_EXTRA) {
      paused = `连续 ${noProgressSteps} 步只读不改、没有推进任何产出（方案/脚本/claims/scenes/成片）。`
        + '已提示它停止探索并动手，仍未产生产物，因此在此暂停，不继续消耗额度。'
        + '检查点已保存；以实际文件与 vh status 为准，继续时先做：' + nextAgentStep(project, mode);
      log('\n⏸ ' + paused);
      break;
    }
  }
  /* Record a window that ended with the same repair still pending and no author
   * progress. The next resume counts it; two such windows stop spending. Only
   * mark it on resume windows so a first run ending at the step budget is not
   * penalised, and never after a successful finish_repair. */
  if (automation.enabled && resume && !repairFinishAttempted && pipelineState.productionRepairs?.pending &&
    progressStamp === repairWindowStart && !cancelled && !failure && !paused) {
    pipelineState.repairWindowStalled = true;
  }
  if (!answer && !failure && !cancelled && !paused) {
    paused = `单次执行到达 ${stepBudget} 步上限（累计 ${totalSteps} 步）。任务停在可恢复的位置，检查点已保存；点「继续原任务」会从当前进度接着做，不会重做已完成步骤。`;
    log('\n⏸ ' + paused);
  }

  if (answer && drainSteer().length) {
    answer = ''; paused = '收尾时收到新要求，尚未执行；检查点和插话已保留，不能把旧版本标记为完成。';
  }
  // 收尾校验（机器能判的"一致性" + 用户要求是否做到）
  const warns = finalCheck(project, log);
  if (failure) warns.push(failure);
  // 暂停不是"收尾检查发现不一致"，它有独立的暂停提示，不重复计为告警。
  try {
    const { load: loadBrief, selfCheck } = await import('./brief.mjs');
    const bw = selfCheck(project, loadBrief(project));
    for (const w of bw) { log('⚠ 要求自检：' + w); warns.push(w); }
  } catch {}
  // 写记忆：用户指令 + 这轮做了什么（去重、限长）
  const uniqActions = [...new Set(actions)].slice(0, 8);
  saveMemory(project, {
    taskId,
    user: task.split('用户的指令是：').pop().slice(0, 400),
    summary: (failure || cancelled || paused || !answer ? '未完成；' : '') +
      (uniqActions.join('；') || (answer ? '只回复未改动' : '无动作')),
    mode,
  });
  const status = cancelled ? 'cancelled' : failure ? 'failed' : paused ? 'paused' : answer ? 'completed' : 'incomplete';
  /* 修改类任务不强求整片；全流程只有交付关口满足后才接受最终答案。 */
  const deliverable = taskDeliveryState(project, mode);
  /* Completion is a two-part commit: persist the answer first (finalizing), then
   * the worker registers task completion, then commitCheckpointCompletion()
   * promotes this checkpoint to completed. A crash in between must never leave
   * a task that offers "continue" while the checkpoint refuses to resume. */
  writeCheckpoint(project, { schemaVersion: 1, taskId, attemptId, mode, task: saved?.task || task,
    messages, pending, actions, emptyStreak, truncationStreak, toolRepairStreak, lastToolSig, stalled, totalSteps,
    uncertainCommands: opts.uncertainCommands, lastCommand: opts._lastCmd, pendingInstructions, appliedInstructions, consumedSteers, phase: 'stopped',
    status: status === 'completed' ? 'finalizing' : status, answer, paused,
    progressStamp, noProgressSteps, stallPhase, changeContracts, pipelineState, automation, mutationDeferred, review, publishInputs: opts.publishInputs });
  /* 把本次真实用量写进项目状态：网关回的 usage 含 cached_tokens，
   * 所以能算出"这次花了多少钱"和"缓存命中率多少"——不再靠猜。 */
  try {
    const used = pool.usage;
    if (used && used.requests) {
      const prior = loadState(project).usage || {};
      const sum = key => (Number(prior[key]) || 0) + (Number(used[key]) || 0);
      saveState(project, { usage: {
        requests: sum('requests'), prompt: sum('prompt'), cached: sum('cached'),
        uncached: sum('uncached'), completion: sum('completion'), reasoning: sum('reasoning'),
        at: new Date().toISOString(),
      } });
    }
  } catch {}
  return { answer, warns, actions: uniqActions, status, error: failure, providerFailures, paused,
    deliverable, ok: status === 'completed' };
}
