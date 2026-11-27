#!/usr/bin/env node
/* vh.mjs —— 视频专属 harness 总入口
 *
 *   node vh.mjs new <dir>          开新项目（绑定 skill 脚手架）
 *   node vh.mjs status [dir]       哪些产物过期了、下一步最小代价是什么
 *   node vh.mjs build [--estimate] 生成 scene.html（自动判定要不要 estimate）
 *   node vh.mjs measure [--voice <音色> --speed <倍率>]   实测配音时长并回写（默认沿用项目参数）
 *   node vh.mjs render [--scenes 3,4] [--hq] [--name video]  增量渲染
 *   node vh.mjs voice [--srt] [--bgm x.mp3 --sfx 1.2:click]  配音+混流
 *   node vh.mjs stills [--at 3,7.5]  静帧（--at 按时间点截图，验证运镜）             每场一张真实静帧（分镜页用）
 *   node vh.mjs go                 一条命令：build → 增量 render → voice
 *   node vh.mjs ask "<指令>" [--mode article|topic|edit]  交给 agent 循环做（与网页「指挥」同一执行器）
 *   node vh.mjs theme [--list]         美术方向（warm-paper / dark-stage / documentary）
 *   node vh.mjs publish-done [目录] [--draft]   发布后打包并清可再生缓存，保留源文件
 *   node vh.mjs snap [标签] | undo [快照] | diff   快照 / 回滚 / 改动可见
 *   node vh.mjs score [--compare]       质量总分与改稿回归对比
 *   node vh.mjs pacing [--samples 6]    节奏检查（长停/活跃度）
 *   node vh.mjs lexicon [--prompt]      视觉语汇库（内容→手法）
 *   node vh.mjs doctor                 环境体检（运行时/渲染/TTS/凭证/项目/磁盘）
 *   node vh.mjs scene [--list]        场景配方（生成可直接运行的版式骨架）\n *   node vh.mjs brief "<你的指令>"   要求清单（必须/不许/事实/链接）\n *   node vh.mjs cost                  运行统计（步数/动作/轮次）
 *   node vh.mjs portrait [--check]    竖屏出片（1080×1920）
 *   node vh.mjs compare              改稿前后对比图（需先 snap）
 *   node vh.mjs cover [--at 秒]        生成三比例封面（16:9 / 4:3 / 3:4）
 *   node vh.mjs claims [--strict]      事实对账（数字 vs claims.json）
 *   node vh.mjs screen [--strict]       图文对应体检（具体对象/太空/长停）
 *   node vh.mjs variety            版式分布（全片是不是每屏一个样）\n *   node vh.mjs density            画面密度（按像素：空屏/大白卡片/主体出画）\n *   node vh.mjs layout [--strict]       版式体检（抄旁白/压字幕/越界/重叠）
 *   node vh.mjs depth [--strict]        内容深度体检（展示度/信息量/时长预算）
 *   node vh.mjs trim [--keep 3,5]      超时删减顾问：按依赖图给出可删的场与可省秒数
 *   node vh.mjs review-init              生成 审查.md 三关模板
 *   node vh.mjs clarity [--strict]      解释质量：术语定义/依赖闭合/隐性知识追问
 *   node vh.mjs dist [--prune|--purge]  交付包管理（清旧版本 / 全删）
 *   node vh.mjs pack [--with-stills]    打包交付物到 dist/（发布用）
 *   node vh.mjs prune [--all|--trash|--trash-all] [--keep-materials]   清理可再生缓存（--trash-all 彻底清空回收站，释放空间）
 *   出片后默认保留增量帧缓存；定稿后 prune 或 --clean-frames 清理
 *   node vh.mjs preview [--port 8144] [--open]   本地预览（默认不打开浏览器）
 *   node vh.mjs stop [--port 8144]      关掉工作台服务（--all：关掉所有在跑的）
 *
 * 设计原则（README 有完整说明）：
 *   - 只编排，不替代：渲染/生成/TTS 全部复用 skill 脚本，skill 升级不受影响。
 *   - 快：迭代回路不渲染 MP4（preview 页直接播 scene.html）；
 *     出片回路自动算「哪几场变了」+「边界/共享部分是否也变了」，
 *     只在安全时增量重渲，其余段复用已编码文件。
 *   - 记账在 out/.vh-state.json；「场景内容变化基线」只在 render 写入。
 */
import { selectVoiceScript, requireVoiceScript, voiceScriptSupportsConcurrency } from './lib/voice-script.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { beginTask, readTask, updateTask, finishTask, taskError, resumeTask, taskStatus, processAlive } from './lib/task-status.mjs';
import {
  skillDir, snapshot, saveState, loadState, parseChunks, parseSceneBodies, parseSceneRanges, hashFile, fnv1a, probeDuration, timingVerdict,
} from './lib/state.mjs';
import { currentArtifactInputs, createArtifactRecord, artifactStatus, mediaFingerprint } from './lib/artifact-status.mjs';
import { normalizeGeneratedMetadata, generatorCapabilityWarning } from './lib/generator-metadata.mjs';
import { normalizeScriptMetadata, scriptNumberingIssue } from './lib/script-metadata.mjs';
import { launchBrowser, closeLaunchedBrowsers } from './lib/browser.mjs';
import { renderCacheState } from './lib/render-cache.mjs';
import { repairRenderer, rendererIdentity, knownRendererReviewGate } from './lib/renderer-upgrade.mjs';
import { renderSettings, renderBudget, diskObservation, budgetReport, sameRenderSettings, renderRequestError } from './lib/render-budget.mjs';
import { pipelinePlan, planReport } from './lib/pipeline-plan.mjs';
import { exportSubtitles, subtitleStatus } from './lib/subtitle-export.mjs';
import { validAspectRatio, selectVideoFormat, enforceVideoFormat, assertVideoFormat, videoMediaFormatError } from './lib/video-format.mjs';
import { DOM_MODE, SDF_MODE, initializeVisualMode } from './lib/scene-sdf.mjs';
import { durationLimit, initializeDurationLimit, durationLimitError, assertDurationLimit, durationMeasurementRequired } from './lib/duration-limit.mjs';
import { trimPlan, report as trimReport } from './lib/trim.mjs';
import { publishStatus, parsePublish, deliveryTarget, setDeliveryTarget, DELIVERY_TARGETS } from './lib/publish.mjs';
import { freshInstructionFor, instructionKindFor } from './lib/cli-instruction.mjs';
import { runVisualReview } from './lib/visual-review.mjs';
import { automationPolicy, configureAutomation, webAutomationPolicy } from './lib/automation.mjs';
import { acquireProductionLock, registerProductionChild, readProductionLock } from './lib/production-lock.mjs';
import { cancelTaskProcesses, clearStoppedRun, stopRecordedChildren } from './lib/process-lifecycle.mjs';
import { recordPerformance, ingestRendererEvents, performanceRunId } from './lib/performance.mjs';
import { upgradeVoice } from './lib/voice-upgrade.mjs';
import { initializeContentReview, contentReviewStatus, contentReviewInputs, recordContentReview, assertContentReviewed } from './lib/content-review.mjs';
import { assertVoiceTimingCurrent } from './lib/timing-observation.mjs';
import { workflowPolicy, workflowPrompt, configureWorkflow } from './lib/workflow-policy.mjs';
import { DEFAULT_NARRATION, projectVoiceDefaults, voiceParameters } from './lib/voice-defaults.mjs';
const args = process.argv.slice(2);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const getArg = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const has = (k) => args.includes('--' + k);
/* 新项目默认值集中在 assets/voice-defaults.json；已有项目沿用自身测量与快照。 */
const cmd = args[0] || 'status';
let productionLock = null;
const productionChildren = new Map();
let productionStopping = false;

/* Async production tools keep the CLI responsive to cancellation. Direct CLI tools
 * get their own group; tools under an agent stage stay in that stage's group. */
async function productionCommand(command, cpArgs, { cwd = process.cwd(), stdio = 'inherit', timeout = 20 * 60 * 1000, onStdout = null, env = process.env } = {}) {
  const detached = !process.env.VH_PRODUCTION_IN_STAGE;
  const capture = typeof onStdout === 'function';
  return new Promise(resolve => {
    const child = spawn(command, cpArgs, { cwd, stdio: capture ? ['inherit', 'pipe', 'inherit'] : stdio, detached, env });
    let registration = null, timer, escalation, finished = false;
    if (capture) child.stdout.on('data', chunk => { try { onStdout(chunk); } catch {} });
    const stop = () => {
      try { process.kill(detached ? -child.pid : child.pid, 'SIGTERM'); } catch {}
      escalation ||= setTimeout(() => { try { process.kill(detached ? -child.pid : child.pid, 'SIGKILL'); } catch {} }, 3000);
    };
    try {
      if (child.pid && productionLock) registration = registerProductionChild(productionLock, child.pid, { group: detached });
      if (child.pid) productionChildren.set(child.pid, { group: detached });
    } catch (error) {
      stop(); child.once('close', () => resolve({ status: 1, error })); return;
    }
    timer = setTimeout(stop, timeout);
    const done = (status, error) => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(escalation);
      const cleared = !registration || registration.unregister();
      if (cleared) productionChildren.delete(child.pid);
      if (productionStopping) return; // Signal handler owns shutdown; no downstream writes after cancel.
      resolve({ status: cleared ? status : 1, error: error || (!cleared ? new Error('制作工具仍有活后代进程，保留制作锁，不能登记阶段成功') : null) });
    };
    child.once('error', error => done(1, error));
    child.once('close', (code, signal) => done(code ?? 1, signal ? new Error('制作工具被信号终止：' + signal) : null));
  });
}

function pipelineOptions() {
  const values = Object.fromEntries(['fps', 'crf', 'preset', 'voice', 'speed', 'maxspeed', 'bgm', 'sfx', 'bgmvol', 'sfxvol', 'scenes', 'from', 'to']
    .filter(k => has(k)).map(k => [k, getArg(k, null)]));
  for (const k of ['srt', 'all', 'hq', 'release', 'remeasure', 'force', 'unattended']) if (has(k)) values[k] = true;
  if (has('jobs')) values.jobs = getArg('jobs', null);
  else if (process.env.VH_RENDER_JOBS) values.jobs = process.env.VH_RENDER_JOBS;
  if (has('encode-only')) values.encodeOnly = true;
  if (has('no-cache')) values.noCache = true;
  if (values.release) values.hq = true;
  return values;
}

async function cmdPlan() {
  const project = resolveProject(getArg('dir', ''));
  let plan;
  try { plan = pipelinePlan(project, pipelineOptions()); }
  catch (error) { plan = { version: 1, readOnly: true, ok: false, blockers: [error.message], steps: [], next: error.message }; }
  console.log(has('json') ? JSON.stringify(plan, null, 2) : plan.settings ? planReport(plan) : '计划无法生成：' + plan.blockers.join('；'));
  if (!plan.ok) process.exitCode = 1;
  return plan;
}

async function cmdSubtitles() {
  const project = resolveProject(getArg('dir', ''));
  const result = exportSubtitles(project);
  say(result.changed ? '✓ 字幕 → out/subtitles.srt（未启动 TTS 或重混视频）' : '✓ 字幕已与当前时间轴一致，复用（未改写文件）');
  if (result.backup) say('  已保留旧字幕备份：' + path.relative(project, result.backup));
  return result;
}

function productionPolicy(project) {
  return automationPolicy(project, has('unattended') ? true : undefined);
}

async function cmdAutomation() {
  const project = resolveProject(getArg('dir', ''));
  if (has('enable') && has('disable')) die('--enable 与 --disable 不能混用');
  let policy = automationPolicy(project);
  if (has('enable') || has('disable') || has('max-repairs')) {
    const task = taskStatus(project);
    if (task.running || task.orphanRunning) die('制作任务尚未退出，不能中途修改自动制作策略');
    policy = configureAutomation(project, { enabled: has('enable') ? true : has('disable') ? false : policy.enabled,
      maxRepairs: has('max-repairs') ? Number(getArg('max-repairs', NaN)) : policy.maxRepairs });
  }
  say(`自动制作：${policy.enabled ? '已开启' : '未开启'}；每任务最多 ${policy.maxRepairs} 轮内容修复（恢复不清零）`);
  say('自动推进与审核独立：检查范围由 workflow 决定；不替人勾审阅、不自动发布。环境/未知故障停止并保留现场。');
}

async function cmdWorkflow() {
  const project = resolveProject(getArg('dir', ''));
  if (has('profile')) {
    const task = taskStatus(project);
    if (task.running || task.orphanRunning) die('制作任务尚未退出，不能中途修改工作流');
    configureWorkflow(project, getArg('profile', ''));
  }
  console.log(has('json') ? JSON.stringify(workflowPolicy(project), null, 2) : workflowPrompt(project));
}

/* schedule —— 选题队列（只读写数据；不建工程、不派发、不调用模型） */
async function cmdSchedule() {
  const { readSchedule, writeSchedule, addTopic, removeItem, listWithStatus, firstUnstarted } = await import('./lib/schedule.mjs');
  const queue = readSchedule(HERE);
  let changed = false;
  const topic = getArg('add', '');
  if (topic) { const item = addTopic(HERE, topic); say(`✓ 已加入队列：${item.topic}`); changed = true; }
  const removed = getArg('remove', '');
  if (removed) {
    const result = removeItem(HERE, removed);
    if (result) { say(`✓ 已移除 ${result.removed} 项`); changed = true; }
    else say('队列里没有这一项');
  }
  const limit = parseInt(getArg('limit', ''), 10);
  const interval = parseInt(getArg('interval', ''), 10);
  if (Number.isInteger(limit) || Number.isInteger(interval)) {
    const fresh = readSchedule(HERE);
    if (Number.isInteger(limit)) fresh.dailyLimit = Math.max(1, limit);
    if (Number.isInteger(interval)) fresh.intervalMinutes = Math.max(5, interval);
    writeSchedule(HERE, fresh);
    say(`✓ 每日上限 ${fresh.dailyLimit} 支，间隔 ${fresh.intervalMinutes} 分钟`);
    changed = true;
  }
  /* 两个定时开关：生成、发布。都默认关；显式 --build-on/--publish-on 才开。 */
  const buildOn = has('build-on'), buildOff = has('build-off');
  const publishOn = has('publish-on'), publishOff = has('publish-off');
  if (buildOn || buildOff || publishOn || publishOff) {
    const { setPlans, describePlans } = await import('./lib/timing-plan.mjs');
    const patch = {};
    if (buildOn || buildOff) patch.build = { enabled: buildOn };
    if (publishOn || publishOff) patch.publish = { enabled: publishOn };
    for (const [key, flag] of [['build', 'build-from'], ['publish', 'publish-from']]) {
      const value = getArg(flag, '');
      if (value) patch[key] = { ...(patch[key] || {}), from: value };
    }
    for (const [key, flag] of [['build', 'build-to'], ['publish', 'publish-to']]) {
      const value = getArg(flag, '');
      if (value) patch[key] = { ...(patch[key] || {}), to: value };
    }
    setPlans(HERE, patch);
    const view = describePlans(readSchedule(HERE));
    say(`生成：${view.build.state}`);
    say(`发布：${view.publish.state}`);
    changed = true;
  }
  if (has('discover-query') || has('discover-count') || has('discover') || has('no-discover')) {
    const fresh = readSchedule(HERE);
    const config = { ...(fresh.discoveryConfig || {}) };
    if (has('discover')) config.enabled = true;
    if (has('no-discover')) config.enabled = false;
    const query = getArg('discover-query', '');
    if (query) config.query = query;
    const count = parseInt(getArg('discover-count', ''), 10);
    if (Number.isInteger(count)) config.count = Math.max(1, Math.min(10, count));
    fresh.discoveryConfig = config;
    writeSchedule(HERE, fresh);
    say(`✓ 自动找选题：${config.enabled ? '开启' : '关闭'}${config.query ? '　方向：' + config.query : ''}${config.count ? '　每次 ' + config.count + ' 个' : ''}`);
    return;
  }

  /* 状态从项目算，不读队列里存的状态。CLI 里没有项目读取器就只显示"未开工 / 已指向"。 */
  const { deriveStatus } = await import('./lib/schedule.mjs');
  const inspect = project => {
    let task;
    try { task = JSON.parse(fs.readFileSync(path.join(HERE, project, 'out/.vh-task.json'), 'utf8')); }
    catch { return null; }
    return { status: task.status, delivered: fs.existsSync(path.join(HERE, project, 'out/video-voice.mp4')) };
  };
  const current = readSchedule(HERE);
  const next = firstUnstarted(current);
  if (has('json')) {
    console.log(JSON.stringify({ ...listWithStatus(HERE, inspect), next: next?.topic || null }, null, 2));
    return;
  }
  if (changed) return;
  if (!current.items.length) {
    say('队列是空的。加一个：node vh.mjs schedule --add "选题一句话"');
    say('定时派发：node scripts/schedule-daemon.mjs（常驻）或 --once（跑一轮，适合 cron/launchd）');
    return;
  }
  say(`选题队列（${current.items.length} 项）`);
  const label = { todo: '未开工', running: '进行中', done: '完成', failed: '失败', stopped: '停住' };
  for (const item of current.items) {
    const state = deriveStatus(item, inspect);
    say(`  [${label[state] || state}] ${item.topic}${item.project ? ' → ' + item.project : ''}`);
  }
  say(next ? `\n下一支待做：${next.topic}` : '\n没有未开工的选题。');
}

/* runner —— 谁负责写作者稿：opencode（带搜索、可续跑）或本地循环。 */
async function cmdRunner() {
  const project = resolveProject(getArg('dir', ''));
  const { runnerConfig, runnerReady, configureRunner, RUNNERS } = await import('./lib/runners/index.mjs');
  const wanted = getArg('set', '');
  if (wanted) {
    if (!RUNNERS[wanted]) die('runner 只能是 opencode 或 local');
    const task = taskStatus(project);
    if (task.running || task.orphanRunning) die('制作任务尚未退出，不能中途更换执行器');
    const next = configureRunner(project, { name: wanted, model: getArg('model', ''), agent: getArg('agent', '') });
    say(`✓ 已切换执行器：${next.name}`);
  }
  const config = runnerConfig(project);
  const ready = await runnerReady(project);
  const info = { ...config, ready };
  if (has('json')) { console.log(JSON.stringify(info, null, 2)); }
  else {
    say(`执行器：${config.name}`);
    say(`  模型：${config.model}`);
    if (config.name === 'opencode') say(`  agent：${config.agent}　服务：${config.service === 'private' ? '私有实例' : '共享后台服务'}`);
    say(ready.ok ? `  可用：${ready.version || (ready.providers || []).join(' / ') || 'ok'}` : `  不可用：${ready.reason}`);
  }
  if (!ready.ok) process.exitCode = 1;
}

async function checkProductionQuality(project, phase, profile = workflowPolicy(project).qualityProfile, reuseRendered = true) {
  const { productionQuality } = await import('./lib/production-quality.mjs');
  const report = await productionQuality(project, { phase, profile, reuseRendered });
  if (!report.ok) {
    console.error('✗ 制作技术检查未通过：' + JSON.stringify(report.checks?.filter(check => check.ok === false) || report));
    process.exitCode = 1;
  } else say(`✓ ${profile === 'strict' ? '完整机器检查' : '必要技术检查'}通过（${phase}；不代表人工审片或事实语义验证）`);
  return report;
}

async function cmdQuality() {
  const project = resolveProject(getArg('dir', ''));
  // Invoking quality is an explicit audit; automatic stages select their own policy.
  const profile = getArg('profile', 'strict');
  if (!['strict', 'technical'].includes(profile)) die('quality --profile 只能是 strict 或 technical');
  if (has('json')) {
    const { productionQuality } = await import('./lib/production-quality.mjs');
    const report = await productionQuality(project, { phase: has('pre-render') ? 'pre-render' : 'final', profile });
    console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
  } else await checkProductionQuality(project, has('pre-render') ? 'pre-render' : 'final', profile, false);
}

const say = process.env.VH_QUIET ? () => {} : (m) => console.log(m);
let performanceFailure = 'command-failed';
const die = (m, failureCode = 'command-failed') => { performanceFailure = failureCode; console.error('✗ ' + m); process.exit(1); };

/* ---------- 项目定位 ---------- */
/* 在 harness 根目录也能用：向上找项目，找不到就返回 null（不报错） */
function findProject(explicitDir) {
  let p = explicitDir ? path.resolve(explicitDir) : process.cwd();
  while (!fs.existsSync(path.join(p, 'PROJECT.json')) && path.dirname(p) !== p) p = path.dirname(p);
  if (fs.existsSync(path.join(p, 'PROJECT.json'))) return p;
  if (fs.existsSync(path.join(HERE, 'vh.mjs'))) return path.resolve(explicitDir || process.cwd());  // 退回 harness 根
  return null;
}

function resolveProject(explicitDir) {
  let p = explicitDir ? path.resolve(explicitDir) : process.cwd();
  while (!fs.existsSync(path.join(p, 'PROJECT.json')) && path.dirname(p) !== p) {
    p = path.dirname(p);
  }
  if (!fs.existsSync(path.join(p, 'PROJECT.json'))) {
    die('这里不是视频项目（没找到 PROJECT.json）。先 node vh.mjs new <目录>，或 cd 进项目目录。');
  }
  return p;
}
const SKILL = skillDir(getArg('skill', ''));
const SKILL_SCRIPTS = SKILL ? path.join(SKILL, 'scripts') : null;
if (!SKILL && !['preview', 'status', 'plan', 'subtitles', 'automation', 'workflow', 'quality', 'voice-sample', 'review-status', 'content-review', 'script-review', 'performance'].includes(cmd) && !has('dry-run')) {
  say('⚠ 没找到 skill 目录（默认 ~/.config/opencode/skills/article-video）——build/measure 会不可用');
} else if (!SKILL && ['preview', 'status'].includes(cmd)) {
  say('（提示：没找到 skill 目录，与 skill 相关的检查跳过）');
}

async function runStep(label, command, cpArgs, opts = {}) {
  const t = Date.now();
  say(`\n── ${label} ──`);
  const r = await productionCommand(command, cpArgs, { cwd: opts.cwd || process.cwd(), env: opts.env || process.env });
  if (fs.existsSync(path.join(opts.cwd || process.cwd(), 'PROJECT.json'))) recordPerformance(opts.cwd || process.cwd(), { kind: 'step', stage: label, elapsedMs: Date.now() - t, ok: r.status === 0, exitCode: r.status, failureCode: 'step-failed' });
  if (r.status !== 0) {
    performanceFailure = 'step-failed';
    say(`✗ ${label} 失败（${((Date.now() - t) / 1000).toFixed(0)}s）`);
    process.exit(r.status || 1);
  }
  say(`✓ ${label} 完成（${((Date.now() - t) / 1000).toFixed(1)}s）`);
}

/* =================================================================== */
/* new —— 开新项目                                                      */
/* =================================================================== */
async function cmdNew() {
  const target = getArg('delivery', 'publish-package');
  if (!DELIVERY_TARGETS.includes(target)) die('交付目标只能选择 --delivery video 或 --delivery publish-package');
  const aspectRatio = getArg('aspect', '16:9');
  if (!validAspectRatio(aspectRatio)) die('画幅只能选择 --aspect 16:9 或 --aspect 9:16');
  const dirArg = args.find((a, i) => i > 0 && !a.startsWith('--')) || '';
  if (!dirArg) die('用法：node vh.mjs new <项目目录>');
  const existingProject = fs.existsSync(path.join(path.resolve(dirArg), 'PROJECT.json'));
  const visual = getArg('visual', SDF_MODE);
  if (![DOM_MODE, SDF_MODE].includes(visual) || (has('visual') && args[args.indexOf('--visual') + 1] !== visual)) {
    die('画面模式只能选择 --visual hybrid-sdf 或 --visual dom');
  }
  if (existingProject && has('visual')) die('--visual 只用于新项目，不改已有工程');
  const { CONTENT_PROFILES, CONTENT_PROFILE_LABELS } = await import('./lib/content-profile.mjs');
  const { configureContentProfile } = await import('./lib/project-profile.mjs');
  const contentProfile = getArg('content-profile', 'auto');
  if (!CONTENT_PROFILES.includes(contentProfile) || (has('content-profile') && args[args.indexOf('--content-profile') + 1] !== contentProfile)) {
    die('内容定位只能选择 --content-profile auto|intel|science|opinion');
  }
  if (existingProject && has('content-profile')) die('--content-profile 在 new 中只用于新项目，不改已有工程');
  const sv = SKILL_SCRIPTS ? path.join(SKILL_SCRIPTS, 'new-video.mjs') : null;
  if (!sv || !fs.existsSync(sv)) die('需要 skill 目录（--skill <path>），且其中 scripts/new-video.mjs 存在');
  await runStep('脚手架（skill new-video）', process.execPath,
    [sv, '--dir', dirArg, ...(has('force') ? ['--force'] : [])]);
  const dir = path.resolve(dirArg);
  const rendererRepair = repairRenderer(dir);
  if (rendererRepair.changed) say('✓ 已升级已知项目渲染器：本机 Chrome、版本检查与沙箱（原文件已备份；不修改全局 skill）');
  const voiceRepair = upgradeVoice(dir);
  if (voiceRepair.changed) say('✓ 已升级项目配音脚本：缓存命中时不加载模型（原文件已备份）');
  /* 建完项目直接把配音引擎换成 edge-tts。
   *
   * 为什么放在 new 里而不是留给用户手动跑：本机已经不用 Kokoro（离线权重早删了，
   * 机械感明显且多音字不可控），但技能脚手架仍然生成 Kokoro 版脚本。
   * 不自动换的话，第一支新片就要人去跑一次 patch，而且遗忘时会去下载 312MB 权重——
   * 真实事故：2026-11-08 一支定时任务因为留着 Kokoro 脚本，又拉了一遍权重。
   * 只对「完整匹配已知 cache-v2 模板」的脚本生效，未知自定义一律不动。 */
  try {
    const patched = spawnSync('python3', [path.join(HERE, 'scripts/voice-edge-tts-patch.py'), dir], { encoding: 'utf8', timeout: 60000 });
    if (patched.status === 0) {
      const narration = projectVoiceDefaults(dir);
      say(`✓ 配音引擎：edge-tts（${narration.voice}，${narration.speed}×，句间留白约 ${(narration.timing.tail + narration.timing.gap).toFixed(2)}s）；保留旧脚本及备份`);
    }
    else if (!/已是 edge-tts/.test(patched.stdout || '')) say('⚠ 配音引擎未自动切换：' + (patched.stderr || patched.stdout || '').trim().slice(0, 120));
  } catch (error) { say('⚠ 配音引擎未自动切换：' + error.message.slice(0, 80)); }
  if (!existingProject) { initializeDurationLimit(dir); setDeliveryTarget(dir, target); initializeContentReview(dir); }
  saveState(dir, { harness: { version: '0.1.0', createdAt: new Date().toISOString() } });
  /* 建完项目就注入手法库：否则场景里用 VH_UI.safeArea / windowMock 会直接白屏，
     而且报错是 "Cannot read properties of undefined" —— 看不出是没跑 enhance
     （真实事故：新建项目写 8 场配方，全部白屏）。 */
  try {
    const tpl = path.join(dir, 'engine.tpl.html');
    if (fs.existsSync(tpl) && !fs.readFileSync(tpl, 'utf8').includes('fx.v2 —— 画面质量手法库')) {
      const block = fs.readFileSync(path.join(HERE, 'assets', 'fx-block.html'), 'utf8');
      fs.writeFileSync(tpl, fs.readFileSync(tpl, 'utf8').replace(/\s*$/, '') + '\n' + block + '\n', 'utf8');
      say('✓ 已注入画面手法库（FX / VH_UI：窗口、一镜到底、声明式排布、安全区）');
    }
  } catch (e) { say('⚠ 注入手法库失败：' + e.message.slice(0, 80)); }
  const { browserSource } = await import('./lib/film.mjs');
  const filmTpl = path.join(dir, 'engine.tpl.html');
  if (fs.existsSync(filmTpl) && !fs.readFileSync(filmTpl, 'utf8').includes('window.VH_FILM =')) {
    fs.appendFileSync(filmTpl, browserSource());
  }
  if (!existingProject) {
    initializeVisualMode(dir, visual);
    say(visual === SDF_MODE ? '✓ 画面：按场混合，兼容普通场景；只有选用 SDF 的场才启动 WebGL2' : '✓ 画面：纯 DOM / SVG');
    if (contentProfile !== 'auto') {
      configureContentProfile(dir, contentProfile);
      say(`✓ 内容定位：${contentProfile}（${CONTENT_PROFILE_LABELS[contentProfile]}）`);
    }
  }
  selectVideoFormat(dir, aspectRatio);
  // 新工程默认交给 opencode：它带 websearch，选题类任务才有真实调研能力。
  // 已有工程不自动改写；需要时用 `vh runner --set` 显式切换。
  try {
    const { configureRunner } = await import('./lib/runners/index.mjs');
    if (!existingProject) {
      const runner = configureRunner(dir, { name: 'opencode' });
      say(`✓ 执行器：${runner.name}（${runner.agent} / ${runner.model}）——选题可联网检索，任务可续跑`);
    }
  } catch (error) { say('⚠ 写入执行器配置失败：' + error.message.slice(0, 80)); }
  say(`✓ 项目画幅已选定：${aspectRatio}（工作台可切换）`);
  const limit = durationLimit(dir);
  if (limit) say(`✓ 时长限制：成片最多 ${limit.maxSeconds} 秒；脚本按约 ${limit.targetSeconds} 秒规划，配音实测超时必须删减后重测`);
  else say('✓ 时长策略：不设硬上限，由内容决定长度；不压掉必要解释，仍须测量与质检');
  say(contentReviewStatus(dir).required
    ? '✓ 保留该项目已显式启用的模型审稿合同'
    : '✓ 模型内容审稿：默认不启用，脚本提交、改稿和续跑不自动开启；事实核证与技术质检保留');
  say(`\n下一件事：写 脚本.md + scenes.src.js（结构要求见 skill references/）`);
  say(`日常回路：  改稿 → node vh.mjs go            （build→增量渲染→配音一条龙）`);
  say(`边改边看：  node vh.mjs preview             （浏览器直接播，不用渲染）`);
}

/* =================================================================== */
/* status —— 过期判定与下一步                                           */
/* =================================================================== */
async function cmdStatus() {
  const found = findProject(getArg('dir', ''));
  if (!found || !fs.existsSync(path.join(found, 'PROJECT.json'))) {
    // 在 harness 根目录：列出所有项目与产物
    const list = [];
    const walk = (d, depth) => {
      if (depth > 3) return;
      let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        if (!it.isDirectory() || it.name.startsWith('.') || it.name === 'node_modules' || it.name === 'out') continue;
        const abs = path.join(d, it.name);
        if (fs.existsSync(path.join(abs, 'PROJECT.json'))) list.push(abs); else walk(abs, depth + 1);
      }
    };
    walk(HERE, 0);
    say(`这是 harness 根目录（${HERE}）—— 下面是全部项目：\n`);
    for (const abs of list) {
      let vids = '';
      try {
        vids = fs.readdirSync(path.join(abs, 'out')).filter(f => f.endsWith('.mp4'))
          .map(f => `${f} ${(fs.statSync(path.join(abs, 'out', f)).size / 1048576).toFixed(1)}MB`).join('  ');
      } catch {}
      say(`  ${path.relative(HERE, abs).padEnd(34)} ${vids || '（还没有成片）'}`);
    }
    say(`\n进某个项目看细节：cd <项目目录> && node "${path.join(HERE, 'vh.mjs')}" status`);
    say(`看所有片子：node "${path.join(HERE, 'vh.mjs')}" preview`);
    return;
  }
  const project = found;
  const s = await snapshot(project);
  say(`项目 ${s.name} · ${project}`);
  say(`时间轴：${s.duration ? s.duration.toFixed(2) + 's' : '—'} · ${s.scenes.length} 场 · timing:${s.timing.state}`);
  const limit = durationLimit(project);
  if (limit) say(`时长限制：${limit.maxSeconds} 秒（脚本目标 ${limit.targetSeconds} 秒）`);
  const entries = Object.entries(s.stale);
  if (!entries.length) say('✓ 全部产物是新的');
  else {
    say(`\n过期项 ${entries.length}：`);
    for (const [k, v] of entries) say(`  [${k}] ${v}`);
  }
  say(`\n产物：${s.videos.map(v => `${v.file}(${(v.size / 1048576).toFixed(1)}MB)`).join('  ') || '（还没有 mp4）'}`);
  say(`静帧：${s.stillsCount} / ${s.scenes.length}`);
  try {
    const review = JSON.parse(fs.readFileSync(path.join(project, 'out', '.vh-visual-review.json'), 'utf8'));
    say(`最近画面体检：${review.at || '—'} · ${review.total} 处机器疑点（不改稿、不代表人工审片通过）`);
  } catch {}
  say(`交付目标：${s.delivery.target === 'video' ? '仅视频' : '视频＋发布包'}`);
  say(`发布文案：${s.delivery.publish.ok ? '机械检查通过（仍须人工审阅）' : s.delivery.publish.errors.map(e => e.message).join('；')}`);
  say(`人工审阅：${s.delivery.review.message}`);
  if (s.changedScenes) say(`相对上次渲染，内容变化的场：${s.changedScenes.join(', ') || '（无）'}`);
  if (s.rangesChanged) say(`⚠ 场景边界变了 → 本次必须整片重渲`);
  if (s.sharedChanged) say(`⚠ 引擎/CSS/配色等共享部分变了 → 本次必须整片重渲`);
  const next = suggestNext(s);
  if (next) say(`\n下一步：${next}`);
}

function suggestNext(s) {
  const st = s.stale;
  if (st.timing && s.timing.state === 'missing') return 'vh measure（正片前提）或 vh build --estimate 先看草稿';
  if (st.scene) return SKILL_SCRIPTS ? 'vh build（自动判断估算/实测）' : '先重建 scene.html';
  if (st.timing && s.timing.state === 'invalid') return 'vh measure --apply 后 vh build';
  if (st.measure) return 'vh build --estimate → vh measure --apply → 复核触发时间';
  /* 时长/分段不符时必须整片：说"自动增量"会让旧分段继续被复用，正是声画错位的来源。 */
  if (st.render && /整片|旧分段/.test(st.render)) return 'vh render --all（整片重渲，不能增量）→ vh voice --srt';
  if (s.rangesChanged || s.sharedChanged) return 'vh render（整片——边界/共享部分变了不能增量）';
  if (st.render) return 'vh go（自动增量渲染已变的场 + 配音）';
  if (st.voice) return 'vh voice --srt';
  if (st.stills) return 'vh stills';
  if (s.delivery?.publish.required && !s.delivery.publish.ok) return 'vh publish-check 查看缺项；在工作台「发布」页单独生成/修复文案（无需重做视频）';
  return null;
}

/* =================================================================== */
/* build —— 生成 scene.html（唯一真相生成器）                            */
/* =================================================================== */
async function cmdBuild() {
  const project = resolveProject(getArg('dir', ''));
  const diagnostics = workflowPolicy(project).editorialDiagnostics || has('audit');
  const scriptFile = path.join(project, '脚本.md');
  if (fs.existsSync(scriptFile)) {
    const issue = scriptNumberingIssue(fs.readFileSync(scriptFile, 'utf8'));
    if (issue) die(issue);
  }
  const metadata = normalizeScriptMetadata(project);
  if (metadata.changed) say('✓ 仅规范化 脚本.md 主体字段的 Markdown 格式（主体名称/多主体顺序未改）；原稿备份：' + metadata.backup_path);
  if (enforceVideoFormat(project)) say('✓ 已按项目保存的画幅纠正引擎方向');
  await repairSubtitles(project);
  const tv = (await timingVerdict(project)).state;
  let useEstimate = has('estimate');
  if (!useEstimate && tv === 'invalid') {
    say('⚠ timing.json 与当前脚本不符 —— 先用估算节奏生成（正片前 vh measure）');
    useEstimate = true;
  }
  if (!useEstimate && tv === 'missing') {
    say('⚠ 没有 timing.json —— 用估算节奏生成草稿（vh measure 之后自动用实测）');
    useEstimate = true;
  }
  if (!fs.existsSync(path.join(project, 'gen.mjs'))) die('项目里没有 gen.mjs（不是生成器路径项目）');
  if (useEstimate && tv === 'valid' && !has('estimate')) {
    // timing 有效但输入变了：gen.mjs 会用旧 timing 报新稿 —— 这是 skill 的护栏，交给它拦
    say('（timing 有效：gen.mjs 会自行校验是否适用）');
  }
  await runStep(`生成 scene.html（${useEstimate ? '估算节奏' : '当前节奏'}）`,
    process.execPath, ['gen.mjs', ...(useEstimate ? ['--estimate'] : []), '--force'], { cwd: project });
  normalizeGeneratedMetadata(project);
  const generatorWarning = generatorCapabilityWarning(project);
  if (generatorWarning) say('⚠ ' + generatorWarning);
  assertVideoFormat(project);
  const limit = durationLimit(project);
  if (limit) {
    const built = currentArtifactInputs(project);
    const error = durationLimitError(limit, built.timelineDur, useEstimate ? '草稿估算' : '配音实测时间轴');
    if (error) say('⚠ ' + error + '（草稿仍可预览，正式渲染会拦截）');
  }
  // Optional editorial diagnostics are deliberately not on the default critical path.
  if (diagnostics) {
  // Legacy skill diagnostics are advisory here; technical structure is checked at production boundaries.
  if (SKILL_SCRIPTS && fs.existsSync(path.join(SKILL_SCRIPTS, 'check.mjs'))) {
    const r = spawnSync(process.execPath, [path.join(SKILL_SCRIPTS, 'check.mjs'), 'scene.html'], {
      cwd: project, stdio: 'pipe', encoding: 'utf8',
    });
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.status !== 0) {
      /* check-scene 只认 `root.appendChild(name)` 这种直接写法。合法的
       * `[a,b,c].forEach(e => root.appendChild(e))`、挂进已挂载容器、由
       * helper 返回后挂载，都会被它报成「创建了但没 append」。这类误报会
       * 原样进入修复提示，把模型推去改本来正确的代码（真实事故：S2 已经
       * 正确渲染，检查器仍报它整场空白）。这里用同一套可达性判定过滤，
       * 只保留真正没挂到画面上的元素。 */
      const { unmountedElements } = await import('./lib/scene-mount.mjs');
      let accepted = 0, filtered = 0;
      const fails = [];
      for (const line of out.split('\n').filter(l => /FAIL|✗/.test(l))) {
        const named = /`([^`]+)`\s*创建了但没/.exec(line) || /`([^`]+)`\s*never appended/.exec(line);
        const sceneNo = Number(/第\s*(\d+)\s*场/.exec(line)?.[1]);
        if (named && sceneNo) {
          try {
            const chunks = fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8').split(/^\/\/---\s*$/m);
            const body = chunks[sceneNo - 1] || '';
            if (!body) { fails.push(line); continue; }
            // 该元素按可达性判定其实已挂上 → 是检查器误报，丢弃这条
            if (!unmountedElements(body).some(item => item.name === named[1])) { filtered++; continue; }
            accepted++;
          } catch { accepted++; }
        }
        fails.push(line);
      }
      if (fails.length) say(`⚠ check.mjs 未通过（不阻塞迭代，渲染闸门会再拦）：\n  ${fails.slice(0, 6).join('\n  ')}`);
      else say(`✓ check.mjs 结构检查通过${filtered ? `（忽略 ${filtered} 条误报：元素已通过数组/容器挂载，不会显示为空场）` : ''}`);
    } else say('✓ check.mjs 结构检查通过');
  }
  // 对比度：文字看不清是最伤的一类问题，而且机器能精确判断，必须每次 build 都报
  try {
    const { analyze: contrastAnalyze } = await import('./lib/contrast.mjs');
    const cr = contrastAnalyze(project);
    if (!cr.ok) {
      const fails = cr.findings.filter(f => f.kind !== 'contrast-warn').slice(0, 4);
      say(`✗ 文字对比度不足（vh contrast 看全部）：\n  ${fails.map(f => f.msg).join('\n  ')}`);
    } else if (cr.findings.length) {
      say(`⚠ 文字对比度 ${cr.findings.length} 项偏低（vh contrast 看清单）`);
    } else say('✓ 文字对比度达标');
  } catch {}
  // 解释质量（内容层闸门）：草稿期不阻塞，但必须报告
  try {
    const { analyze } = await import('./lib/clarity.mjs');
    const res = analyze(project);
    if (res.fail.length) say(`⚠ 解释质量 ${res.fail.length} 项未通过（vh clarity 看清单与逐场追问）`);
    else say('✓ 解释形式：未发现硬性缺项（不是内容审稿通过）');
    if (res.warn.length || res.pending.length) say(`⚠ 解释形式 ${res.warn.length} 条提示 / ${res.pending.length} 条待核：\n  ${[...res.warn, ...res.pending].slice(0, 6).join('\n  ')}\n  完整清单：vh clarity；先核对讲述再出片`);
  } catch (e) { say('（解释质量检查跳过：' + e.message + '）'); }
  // 内容深度（讲得够不够展开）——草稿不阻塞，但必须报
  try {
    const { analyze: depthAnalyze } = await import('./lib/depth.mjs');
    const d = depthAnalyze(project);
    if (!d.ok) say(`内容深度：${d.hard.length} 项形式线索（vh depth 查看，需人工核对）——现在 ${d.count} 场 / 估算 ${d.est.toFixed(0)}s`);
    else say('内容深度：未触发形式规则；是否充分仍需人工审阅');
  } catch {}
  // 事实对账（脚本里的数字有没有 claims 登记）
  try {
    const { analyze: ca } = await import('./lib/claims.mjs');
    const cr = ca(project);
    if (cr.findings.length) say(`⚠ 事实对账：${cr.findings.length} 处疑点（vh claims 看清单）`);
    else if (cr.numbers.length) say('✓ 事实对账：每个数字都有登记');
  } catch {}
  // 图文对应体检（画面是否只有文字、会不会太空）
  try {
    const { analyze: sc } = await import('./lib/screen-check.mjs');
    const r = sc(project);
    if (r.findings.length) say(`⚠ 图文对应：${r.findings.length} 处疑点（vh screen 看逐场表）`);
    else say('✓ 图文对应：每场都有具体对象');
  } catch {}
  // 版式体检（画面文字是否抄旁白 / 压字幕区 / 越界）
  try {
    const { analyze: layoutAnalyze } = await import('./lib/layout-check.mjs');
    const lr = layoutAnalyze(project);
    if (lr.findings.length) say(`⚠ 静态版式线索：${lr.findings.length} 项（vh layout 看清单）` + (lr.dupCount ? `，其中「画面文字抄旁白」${lr.dupCount} 处` : ''));
    else say('✓ 未发现静态版式疑点（实际布局以下方浏览器检查为准）');
  } catch {}
  // 素材/视频帧屏障与转场表已在 normalizeGeneratedMetadata 统一安装。
  // 真实盒子体检（压字幕/越界/文字重叠——静态检查查不出来的那类）
  try {
    const { analyze: fitAnalyze } = await import('./lib/fit.mjs');
    const fr = await fitAnalyze(project);
    fs.mkdirSync(path.join(project, 'out'), { recursive: true });
    fs.writeFileSync(path.join(project, 'out/.vh-layout-measured.json'), JSON.stringify(fr, null, 2) + '\n');
    if (!fr.sampled) {
      say('⚠ 检查执行失败：浏览器版式检查未完成；草稿可继续修，正式渲染不得视为通过。' + (fr.findings?.[0]?.msg || fr.note || ''));
    } else if (!fr.ok) {
      say(`⚠ 版式溢出/碰撞：${fr.findings.length} 处（草稿可修，正式渲染会阻断）：`);
      for (const f of fr.findings.slice(0, 6)) say(`  · S${f.scene || '?'} ${f.t?.toFixed(2) || '?'}s ${f.msg}`);
    } else {
      say(`✓ 浏览器版式检查：${fr.sampled} 帧未发现裁切、越界、压字幕区、文字重叠或组件碰撞`);
    }
  } catch (e) { say('⚠ 检查执行失败：浏览器版式检查未完成，不能视为通过：' + e.message); }
  // 字幕断行与正文让位（按最长字幕算，不按固定比例）
  try {
    const { fitPlan: fitSub } = await import('./lib/subtitle.mjs');
    const sp = fitSub(project);
    const worst = sp.scenes.reduce((a, b) => (a.safeBottom <= b.safeBottom ? a : b), sp.scenes[0] || null);
    if (worst && worst.lines >= 3) {
      say(`⚠ 字幕：S${worst.n} 到 ${worst.lines} 行（会压正文，正文底边要 ≤${worst.safeBottom}px，vh subtitle 看全片）`);
    } else if (worst) {
      say(`✓ 字幕：每场最多 ${Math.max(...sp.scenes.map(x => x.lines))} 行，正文安全区底边 ${worst.safeBottom}px`);
    }
  } catch {}
  }
  // 素材体检（引用了不存在的图 = 空白画面，而且不报错）
  try {
    const { check: checkAssets } = await import('./lib/assets.mjs');
    const ar = checkAssets(project);
    const missing = ar.findings.filter(f => f.kind === 'missing');
    if (missing.length) say(`⚠ 素材：${missing.length} 个引用的文件不存在（vh asset check 看清单）`);
    else if (ar.refs.length) say(`✓ 素材：${ar.refs.length} 个引用都在`);
  } catch {}
  if (diagnostics) {
  // 讲述方式只提供词面线索，不能判断观众是否理解或受到吸引。
  try {
    const { analyze: hookAnalyze } = await import('./lib/hook.mjs');
    const hk = hookAnalyze(project);
    if (hk.scenes.length) say(`开场形式：${hk.findings.length} 项线索（vh hook 查看；不要求设问或反转）`);
  } catch {}
  try {
    const { analyze: arcAnalyze } = await import('./lib/arc.mjs');
    const ar = arcAnalyze(project);
    if (!ar.note) say(`可选叙事弧：${ar.findings.length} 项词面线索（vh arc 查看；不是必备结构）`);
  } catch {}
  try {
    const { analyze: loopAnalyze } = await import('./lib/loop.mjs');
    const lp = loopAnalyze(project);
    if (lp.findings.length) say(`设问对应：${lp.findings.length} 项词面疑点（vh loop 查看，需人工核对）`);
    else if (lp.questions.length) say(`设问对应：${lp.questions.length} 处匹配无词面疑点，仍需人工核对`);
  } catch {}
  try {
    const { analyze: concreteAnalyze } = await import('./lib/concrete.mjs');
    const cc = concreteAnalyze(project);
    if (cc.findings.length) say(`⚠ 体感数字：${cc.findings.length} 场未换算（vh concrete 看清单）`);
    else if (cc.bigCount) say(`✓ 体感数字：${cc.bigCount} 个大数字里关键项都有换算`);
  } catch {}
  try {
    const { analyze: verifyAnalyze } = await import('./lib/verify.mjs');
    const vf = verifyAnalyze(project);
    if (vf.findings.length) say(`⚠ 换算验算：${vf.findings.length} 条算错（vh verify 看算式）`);
    else if (vf.verified) say(`✓ 换算验算：${vf.verified} 条可验算的换算都对`);
  } catch {}
  try {
    const { analyze: reflectAnalyze } = await import('./lib/reflect.mjs');
    const rf = reflectAnalyze(project);
    if (rf.findings.length) say(`⚠ 回望：${rf.findings.length} 项（vh reflect 看清单）`);
    else if (rf.count) say(`✓ 回望：${rf.count} 处（其中 ${rf.concreteCount} 处指向具体内容）`);
  } catch {}
  // 这些是静态线索，不是审美评分；与渲染安全闸门分离。
  const { buildVisualDiagnostics } = await import('./lib/build-visual-diagnostics.mjs');
  for (const item of buildVisualDiagnostics(project)) say(item.line);
  }
  if (!fs.existsSync(path.join(project, '发布文案.md'))) {
    say('提示：还没有 发布文案.md（发平台要用的标题/简介/封面）。模板见 skill 的 assets/发布文案.md');
  }
  if (has('density')) {
    // 按像素的密度只能浏览器算，慢一些 —— 显式要求才跑（agent 收尾时会跑）
    const { analyze: densityAnalyze, report: densityReport } = await import('./lib/density.mjs');
    const dr = await densityAnalyze(project);
    say(densityReport(dr));
  }
  // 不能只检查完整的 SUBS：旧断行器会在显示时悄悄删掉后半句。
  const { reviewSubtitles } = await import('./lib/subtitle-review.mjs');
  const subsReview = await reviewSubtitles(project);
  fs.mkdirSync(path.join(project, 'out'), { recursive: true });
  fs.writeFileSync(path.join(project, 'out', 'subtitle-review.json'), JSON.stringify(subsReview, null, 2));
  if (!subsReview.ok) die('字幕实际显示未通过（截字/隐藏/越界），见 out/subtitle-review.json；不将此生成记为成功');
  say(`✓ 字幕实际显示：${subsReview.cues} 句 / ${subsReview.probes} 个采样，文字完整且未裁切（非人工听检）`);
  // 记账：只记 build 用的输入指纹（场景内容基线在 render 写）
  saveState(project, {
    genStamp: {
      scriptHash: hashFile(path.join(project, '脚本.md')),
      scenesHash: hashFile(path.join(project, 'scenes.src.js')),
      sourceHashes: currentArtifactInputs(project).sourceHashes,
      generatorHash: hashFile(path.join(project, 'gen.mjs')),
      estimate: useEstimate, at: new Date().toISOString(),
    },
  });
}

/* =================================================================== */
/* measure —— 实测配音时长并回写 timing.json                             */
/* =================================================================== */
async function cmdMeasure() {
  const project = resolveProject(getArg('dir', ''));
  assertContentReviewed(project);
  /* 已升级过的项目可能带着旧的身份探针边界（repo 而不是 hub）。
   * 新版 huggingface 把模型文件放在 hub/blobs 里跨仓库去重，旧边界会把
   * 正常的本机缓存误判成"软链越界"，于是每次 measure 都失败。
   * 这是探针缺陷，不是用户配置问题：先修探针，再决定要不要重测。 */
  const probeRepair = await import('./lib/voice-upgrade.mjs').then(m => m.repairVoiceIdentityProbe(project));
  if (probeRepair.changed) {
    say('✓ 已修正配音身份探针的模型路径边界（repo → hub，新版 huggingface 缓存布局）；原稿已备份');
    say('  这是探针缺陷修正，合成逻辑与缓存键未变；已有 timing 需要重测一次');
  }
  const voiceRepair = upgradeVoice(project);
  if (voiceRepair.changed) say('✓ 已安全升级已知配音模板的缓存身份；旧测量须重测，原稿已备份：' + voiceRepair.backup);
  enforceVideoFormat(project);
  await repairSubtitles(project);
  const existing = loadState(project), verdict = await timingVerdict(project);
  let timing = {}; try { timing = JSON.parse(fs.readFileSync(path.join(project, 'timing.json'), 'utf8')); } catch {}
  const { voice, speed } = voiceParameters(project, { voice: getArg('voice', undefined), speed: getArg('speed', undefined) });
  if (typeof voice !== 'string' || !voice.trim() || !Number.isFinite(speed) || speed <= 0) die('音色不能为空，speed 必须为有限正数');
  const sameMeasurement = timing.measurement?.voice === voice && Number(timing.measurement?.speed) === speed;
  if (!has('remeasure') && !has('maxspeed') && (!has('voice') && !has('speed') || sameMeasurement) && verdict.state === 'valid' &&
    existing.lastMeasure?.scriptHash === hashFile(path.join(project, '脚本.md'))) {
    say('✓ 当前稿和测量参数未变，复用有效 timing.json；不清空渲染/配音基线（确需重测用 --remeasure）');
    assertDurationLimit(project, verdict.total, '配音实测');
    return;
  }
  const before = currentArtifactInputs(project);
  const extra = ['--voice', voice, '--speed', String(speed)];
  /* 并发合成的句数上限。只重叠 edge-tts 的网络等待，不改变请求内容、
     音色、语速或返回的音频字节（逐句 WAV 实测一致）。
     老项目的 Kokoro 脚本没有这个参数，不能硬塞；按脚本实际能力决定。 */
  const voiceScript = requireVoiceScript(project).name;
  const supportsConcurrency = voiceScriptSupportsConcurrency(project, voiceScript);
  const concurrency = Number(getArg('tts-concurrency', existing.measureParams?.ttsConcurrency ?? 4));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) die('tts-concurrency 必须是 1–8 的整数');
  if (supportsConcurrency) extra.push('--tts-concurrency', String(concurrency));
  else if (has('tts-concurrency')) die('当前配音脚本不支持 --tts-concurrency（仅 edge-tts 版支持）；换回默认并发或升级脚本');
  if (has('maxspeed')) { const v = Number(getArg('maxspeed', NaN)); if (!Number.isFinite(v) || v <= 0) die('maxspeed 必须为有限正数'); extra.push('--maxspeed', String(v)); }
  // 改稿后 measure 的前置：先用估算节奏同步 scene.html（skill 要求：先 gen --estimate 再测，不恢复旧稿）
  const stamp = existing.genStamp;
  const currentDraft = stamp?.estimate === true && stamp.generatorHash && stamp.generatorHash === hashFile(path.join(project, 'gen.mjs')) &&
    JSON.stringify(stamp.sourceHashes) === JSON.stringify(before.sourceHashes);
  if (currentDraft) say('✓ 当前估算稿及生成器未变，复用测量输入，不重复生成估算稿');
  else {
    await runStep('同步当前稿（估算节奏）', process.execPath, ['gen.mjs', '--estimate', '--force'], { cwd: project });
    normalizeGeneratedMetadata(project);
  }
  await runStep('测量配音时长', 'python3', [requireVoiceScript(project).name, '--measure', '--apply', ...extra], { cwd: project });
  await runStep('用实测节奏重建 scene.html', process.execPath, ['gen.mjs'], { cwd: project });
  normalizeGeneratedMetadata(project);
  const generatorWarning = generatorCapabilityWarning(project);
  if (generatorWarning) say('⚠ ' + generatorWarning);
  saveState(project, {
    lastMeasure: { scriptHash: hashFile(path.join(project, '脚本.md')), at: new Date().toISOString() },
    measureParams: { voice, speed, ttsConcurrency: concurrency, ...(has('maxspeed') ? { maxspeed: Number(getArg('maxspeed', '')) } : {}) },
    genStamp: { scriptHash: hashFile(path.join(project, '脚本.md')), scenesHash: hashFile(path.join(project, 'scenes.src.js')),
      sourceHashes: currentArtifactInputs(project).sourceHashes, generatorHash: hashFile(path.join(project, 'gen.mjs')), estimate: false, at: new Date().toISOString() },
    // 旧基线记录“实际渲染过什么”，不能删掉后再用时长相等证明旧片可复用。
  });
  const measured = await timingVerdict(project);
  if (durationMeasurementRequired(project) && measured.state !== 'valid') die('配音测量结果无效；不限时长也须有有效实测，请修复后重测');
  assertDurationLimit(project, measured.total, '配音实测');
  // Reuse the just-measured per-line WAVs. No second synthesis/ASR or MP4 needed.
  try {
    const { planVoiceSamples, createVoiceSamples } = await import('./lib/voice-samples.mjs');
    const plan = planVoiceSamples(project, { voice, speed });
    const samples = await createVoiceSamples(project, plan, { measured: true });
    say('✓ 风险句小样 → ' + path.relative(project, samples.directory) + '（复用测量音频；未试听，正式渲染前请核对）');
  } catch (error) { say('⚠ 未导出配音小样：' + error.message + '；可单独运行 vh voice-sample，不影响已完成的测量记录'); }
  say(before.sourceSignature === currentArtifactInputs(project).sourceSignature
    ? '\n✓ 测量输入输出内容未变，保留有效渲染基线。'
    : '\n测量已更新：按内容指纹判定下游是否过期；下一步核对 build / render / voice，不以时长相等代替版本一致。');
}

async function cmdVoiceSample() {
  const project = resolveProject(getArg('dir', ''));
  const { planVoiceSamples, createVoiceSamples, writeAuditionPage, runVoiceSampleAsr } = await import('./lib/voice-samples.mjs');
  const options = voiceParameters(project, { voice: getArg('voice', undefined), speed: getArg('speed', undefined) });
  if (has('lines')) options.lines = getArg('lines', '').split(',').map(Number);
  let plan; try { plan = planVoiceSamples(project, options); } catch (error) { die(error.message); }
  if (has('list')) { console.log(JSON.stringify(plan, null, 2)); return; }
  let result;
  try { result = await createVoiceSamples(project, plan, { run: productionCommand }); }
  catch (error) { die(error.message); }
  const audition = writeAuditionPage(result.directory, result.manifest);
  say(`✓ ${result.reused ? '复用' : '生成'} ${result.manifest.items.length} 句配音小样：${result.directory}`);
  for (const item of result.manifest.items) say(`  ${item.file} · S${item.scene} 第${item.line}句 · ${item.text}`);
  if (has('asr')) {
    const asr = await runVoiceSampleAsr(result.directory, result.manifest, { run: productionCommand });
    if (asr.ok) {
      say(`✓ 离线转写（${asr.model}，仅作复听线索，不凭拼写差异断言念错）：`);
      for (const row of asr.items || []) say(`  S${row.scene} 第${row.line}句 → ${row.transcript || row.error || '（空）'}`);
    } else {
      say(`· 离线转写跳过：${asr.reason}`);
    }
  }
  say(`  试听页：${audition}`);
  say(plan.scope);
}

/* =================================================================== */
/* render —— 渲染（自动增量，但不安全时升级为整片）                         */
/* =================================================================== */
async function cmdRender(extra = []) {
  if (has('dry-run')) return cmdPlan();
  const requestError = renderRequestError({ ...pipelineOptions(), all: has('all') || extra.includes('--all') });
  if (requestError) die(requestError);
  const project = resolveProject(getArg('dir', ''));
  const automation = productionPolicy(project);
  const workflow = workflowPolicy(project);
  assertContentReviewed(project);
  assertVoiceTimingCurrent(project);
  assertVideoFormat(project);
  const formatForBudget = (await import('./lib/video-format.mjs')).videoFormatState(project);
  const settings = renderSettings({ ...pipelineOptions(), width: formatForBudget.width || 1920, height: formatForBudget.height || 1080 });
  const budget = renderBudget({ duration: currentArtifactInputs(project).timelineDur, settings, freeBytes: diskObservation(project).freeBytes });
  if (!budget.ok) die(budgetReport(budget));
  const forceAll = has('all') || extra.includes('--all');
  const s = await snapshot(project);
  if (durationMeasurementRequired(project)) {
    /* ⚠ 这里不能只说"必须先 measure"：模板项目（没有 脚本.md）永远 measure 不出有效 timing，
       用户会被这条提示困住（真实事故：新建项目直接渲染，只看到"必须先 measure"，
       照做之后仍然被拦，因为 measure 找不到 脚本.md）。
       所以按实际原因分流，并给出能走通的那条路。 */
    if (s.timing.state !== 'valid') {
      const hasScript = fs.existsSync(path.join(project, '脚本.md'));
      if (!hasScript) die('这个项目还没有 脚本.md（生成器路径的前提），所以无法校验配音实测时长。' +
        '先写 脚本.md + scenes.src.js 走生成器；试画面可用 build --estimate、stills 或 preview。' +
        '不限片长也不能跳过配音实测直接正式渲染');
      const why = s.timing.note ? `（原因：${s.timing.note}）` : '';
      die(`正式视频必须先 vh measure 实测配音，再正式渲染；不限片长也不能把估算时长作为放行依据${why}`);
    }
    assertDurationLimit(project, s.timing.total, '配音实测');
    assertDurationLimit(project, currentArtifactInputs(project).timelineDur, '渲染时间轴');
  }
  const name = getArg('name', 'video');
  // Ordinary and automated checks must both apply to the exact inputs later
  // rendered. A successful check followed by an edit is not a current pass.
  const qualityInputs = currentArtifactInputs(project);
  let standardTiming = false;
  try { standardTiming = JSON.parse(fs.readFileSync(path.join(project, 'timing.json'), 'utf8')).schemaVersion === 1; } catch {}
  const qualityProfile = has('audit') ? 'strict' : workflow.qualityProfile;
  let strictReview = null;
  if (automation.enabled || standardTiming) {
    if (automation.enabled && name !== 'video') die('自动制作仅为主成片登记技术质量回执；备用输出请使用普通模式');
    strictReview = await checkProductionQuality(project, 'pre-render', qualityProfile);
    if (!strictReview.ok) return;
  } else if (workflow.visualAudit || has('audit')) {
  /* 可读性闸门：文字看不清属于"片子不能用"的硬缺陷，不能等到人看完才发现。
   * 优先用**实测**（浏览器计算样式 + 实际底色）：静态读 var() 会把
   * "回退值是浅色、变量实际是深色"算成通过（真实事故：1.17:1 被放行）。
   * --force 也不跳过；确实要带着问题出片用 --allow-low-contrast 并留记录。 */
  let visualSession;
  let rendered, layout;
  try {
    const { openMeasurementPage } = await import('./lib/measurement-page.mjs');
    const { measureContrast } = await import('./lib/contrast-rendered.mjs');
    const { measureLayout } = await import('./lib/layout-measured.mjs');
    visualSession = await openMeasurementPage(path.join(project, 'scene.html'));
    let checkStart = performance.now();
    rendered = await measureContrast(project, { session: visualSession });
    recordPerformance(project, { kind: 'check', stage: 'contrast', elapsedMs: performance.now() - checkStart, ok: rendered.ok === true });
    checkStart = performance.now();
    layout = await measureLayout(project, { session: visualSession });
    recordPerformance(project, { kind: 'check', stage: 'layout', elapsedMs: performance.now() - checkStart, ok: layout.ok === true });
  } catch (e) { throw new Error('检查执行失败：画面实测异常，未开始渲染：' + e.message); }
  finally { if (visualSession) await visualSession.close(); }
  {
    if (!rendered.sampled || !(rendered.subjects ?? rendered.measured) || !rendered.ok && !rendered.findings.length) {
      die('检查执行失败：对比度实测未完成，不能开始正式渲染：' + rendered.note);
    } else if (rendered.findings.length) {
      say('✗ 实测文字对比度不足，已阻止渲染（' + rendered.findings.length + ' 处，采样 ' + rendered.sampled + ' 帧）：');
      for (const f of rendered.findings.slice(0, 8)) say('  · ' + f.msg);
      fs.writeFileSync(path.join(project, 'out/.vh-contrast-rendered.json'), JSON.stringify({ ...rendered, sourceSignature: qualityInputs.sourceSignature }, null, 2) + '\n');
      say('\n明细见 out/.vh-contrast-rendered.json。改字色或底色后重跑 build；确实要带着问题出片用 --allow-low-contrast。');
    }
  }

  /* 版式实测闸门：文字压框、越界、压字幕区属于"成片不能用"的硬缺陷。
   * 静态检查只认 `abs(mk(...))` 写法，实际代码常先 const 再 abs，导致一个都不报
   * （真实事故：开关文字压在圆角框上，静态检查 0 命中）。 */
  {
    const { report: layoutReport } = await import('./lib/layout-measured.mjs');
    if (!layout.sampled || !layout.measured || !layout.ok && !layout.findings.length) {
      die('检查执行失败：版式实测未完成，不能开始正式渲染：' + layout.note);
    } else if (layout.findings.length) {
      say('✗ 实测版式未通过，已阻止渲染：');
      for (const line of layoutReport(layout).split('\n').slice(1, 12)) say(line);
      fs.writeFileSync(path.join(project, 'out/.vh-layout-measured.json'), JSON.stringify({ ...layout, sourceSignature: qualityInputs.sourceSignature }, null, 2) + '\n');
      say('\n明细见 out/.vh-layout-measured.json。改坐标/尺寸后重跑 build；确实要带着问题出片用 --allow-layout-issues。');
    }
  }
  if (rendered.findings.length && !has('allow-low-contrast') || layout.findings.length && !has('allow-layout-issues')) {
    die('画面实测未通过（已一次列出对比度与版式问题），未开始渲染；修完本轮问题再重试');
  }
  if (rendered.findings.length) say('⚠ 已按 --allow-low-contrast 放行 ' + rendered.findings.length + ' 处实测对比度不足；可读性由你承担。');
  if (layout.findings.length) say('⚠ 已按 --allow-layout-issues 放行 ' + layout.findings.length + ' 处实测版式问题。');
  } else {
    // Legacy non-automatic projects still need runtime/resource/subtitle health,
    // but no composition or contrast-policy audit before producing a first cut.
    const { reviewSubtitles } = await import('./lib/subtitle-review.mjs');
    const { assetInputs } = await import('./lib/asset-inputs.mjs');
    const assets = assetInputs(project);
    if (assets.issues.length) die('制作资源无效：' + assets.issues.slice(0, 4).join('；'));
    let review;
    try { review = await reviewSubtitles(project, { requireSubtitles: fs.existsSync(path.join(project, '脚本.md')) }); }
    catch (error) { die('检查执行失败：画面运行/字幕检查未完成：' + error.message); }
    if (!review.ok) die('检查执行失败：运行或字幕实际显示无效：' + JSON.stringify([...review.errors, ...review.failures].slice(0, 6)));
    say('✓ 画面运行、资源与字幕技术检查通过；未执行可选版式/对比度审核');
  }
  const jobs = settings.jobs;
  say(budgetReport(budget));
  const argv = ['render.mjs', '--name', name, '--jobs', String(jobs)];
  for (const flag of extra) if (!argv.includes(flag)) argv.push(flag);
  if (!has('hq') && !has('release')) argv.push('--fast');
  /* The standard renderer captures every frame in the selected range. File
   * mtimes/end markers do not prove source/runtime identity, nor make workers
   * skip existing frames. Do not delete frames or advertise missing-frame-only
   * resume here. Scene-level reuse below still uses its validated baseline. */
  // 编码参数透传；无逐帧来源证明的旧帧重编码/任意帧范围在入口拒绝。
  for (const k of ['crf', 'preset', 'fps']) { const v = getArg(k, ''); if (v) argv.push('--' + k, v); }
  if (has('force')) argv.push('--force');       // 透传给 render.mjs（跳过其渲染前闸门）
  /* 帧目录就是增量渲染的缓存 —— 默认**保留**，否则"改一场只渲一场"根本不可能。
     ⚠ 真实事故：默认永远清帧，导致每次改一场都整片重渲（实测 68s，本应 ~6s）。
     体积：JPEG 帧约 50KB/帧，3 分钟片 ≈ 270MB。定稿后 prune 清缓存；
     只有显式 --clean-frames 才清帧。 */
  if (has('clean-frames') && !has('encode-only')) argv.push('--clean-frames');

  const scenesArg = getArg('scenes', '');
  if (scenesArg) argv.push('--scenes', scenesArg);   // 手动指定就真的只渲这几场（原来只读没传）
  const st = loadState(project);
  const sceneSrcNow = fs.readFileSync(path.join(project, 'scene.html'), 'utf8');
  const baseline = name === 'video' ? st.render : st.alternateRenders?.[name];
  const rendererRepair = repairRenderer(project);
  if (rendererRepair.changed) say(rendererRepair.kind === 'performance'
    ? '✓ 已升级已知渲染器模板：性能优化及本机 Chrome 沙箱策略；备份：' + rendererRepair.backup
    : rendererRepair.kind === 'browser-security'
      ? '✓ 已升级渲染器：已修补的本机 Chrome、沙箱及临时用户目录；备份：' + rendererRepair.backup
      : '✓ 已修复 Chrome 回退丢失 GPU/色彩/字体参数；备份：' + rendererRepair.backup);
  const runtime = rendererIdentity(project);
  if ((automation.enabled || !workflow.visualAudit && !has('audit')) && !argv.includes('--force')) {
    const template = SKILL ? path.join(SKILL, 'assets/render.mjs') : '';
    const trusted = template && fs.existsSync(template) ? fs.readFileSync(template, 'utf8') : '';
    if (knownRendererReviewGate(fs.readFileSync(path.join(project, 'render.mjs'), 'utf8'), trusted)) {
      argv.push('--force');
      say('仅略过已知模板的重复审核清单；技术检查、沙箱和版本核验保留，不登记人工审阅通过。');
    }
  }
  const runtimeMatch = baseline?.rendererHash ? baseline.rendererHash === runtime.sha256 : !runtime.upgraded;
  const { incrementalTransitionError } = await import('./lib/transition.mjs');
  const transitionError = incrementalTransitionError(sceneSrcNow);
  if (transitionError && (scenesArg || has('from') || has('to'))) {
    die(transitionError + '；请使用 vh render --all，未开始截图');
  }
  if (transitionError && !has('all')) {
    say('⚠ ' + transitionError + ' → 整片渲染');
    argv.push('--all');
  }
  /* 基线判定：拿 render 时记下的逐场指纹 vs 现在的逐场指纹。
     ⚠ 不能用整份 scene.html 哈希：build 每次都重写整个文件（时间轴/SUBS 都在变），
     整份哈希永远不等 → 自动增量从未生效（真实事故：改一场也整片重渲 68s）。 */
  const bodiesNow = parseSceneBodies(sceneSrcNow).map(b => fnv1a(b));
  const prevBodies = baseline && Array.isArray(baseline.bodies) ? baseline.bodies : null;
  const bodiesMatch = !!(prevBodies && prevBodies.length === bodiesNow.length
    && prevBodies.every((h, i) => h === bodiesNow[i]));
  const changedNow = prevBodies && prevBodies.length === bodiesNow.length
    ? bodiesNow.map((h, i) => (h !== prevBodies[i] ? i + 1 : null)).filter(Boolean)
    : null;
  const rangesNow = [...sceneSrcNow.matchAll(/addScene\(\s*([\d.]+)\s*,\s*([\d.]+)/g)].map(m => [+m[1], +m[2]]);
  const sharedAt = sceneSrcNow.indexOf('const scenes = [];');
  const sharedNow = sharedAt > 0 ? fnv1a(sceneSrcNow.slice(0, sharedAt + 'const scenes = [];'.length)) : null;
  const rangesMatch = baseline && JSON.stringify(baseline.ranges) === JSON.stringify(rangesNow);
  const sharedMatch = baseline && baseline.shared === sharedNow;
  const assetsMatch = baseline?.artifact?.sourceHashes?.['local-assets'] === currentArtifactInputs(project).sourceHashes['local-assets'];
  const canIncrement = runtimeMatch && assetsMatch && !transitionError && !!prevBodies && changedNow !== null && rangesMatch && sharedMatch
    && s.videos.some(v => v.file === `${name}.mp4`);
  if (!forceAll && scenesArg) {
    const pick = scenesArg.split(',').map(Number);
    if (!/^\d+(?:,\d+)*$/.test(scenesArg) || pick.some(n => !Number.isInteger(n) || n < 1 || n > bodiesNow.length)) die('--scenes 场号无效，未开始截图');
    if (!canIncrement || !sameRenderSettings(baseline, settings)) die('无法证明局部渲染覆盖当前共享输入/时间轴/编码设置；请 vh render --all，未开始截图');
    const missed = changedNow.filter(n => !pick.includes(n));
    if (missed.length) die(`局部范围遗漏已改动的第 ${missed.join(',')} 场；请覆盖全部改动或 --all，未开始截图`);
  }
  if (!forceAll && !scenesArg && canIncrement && !s.stale.render && sameRenderSettings(baseline, settings) && changedNow.length === 0 && bodiesMatch && !has('force')) {
    say('✓ 相对上次渲染没有任何场景内容/边界/共享部分变化，跳过渲染（--all 强制整片）');
    return;
  }
  const format = JSON.parse(fs.readFileSync(path.join(project, 'PROJECT.json'), 'utf8')).videoFormat;
  const portrait = /const ORIENT\s*=\s*'portrait'/.test(sceneSrcNow);
  // A full render or an already-invalid baseline cannot use incremental
  // frames. Avoid stat-ing every cached frame when no branch can reuse them.
  // All potentially incremental paths still perform the complete check.
  const cache = !forceAll && canIncrement ? renderCacheState(project, {
    fps: Number(getArg('fps', '30')),
    width: format?.width || (portrait ? 1080 : 1920),
    height: format?.height || (portrait ? 1920 : 1080),
    preset: getArg('preset', argv.includes('--fast') ? 'medium' : 'slow'),
    crf: getArg('crf', argv.includes('--fast') ? '18' : '17'),
  }) : { canIncrementSafely: false, reason: '当前请求或基线不能增量复用' };
  if (!forceAll && scenesArg && !cache.canIncrementSafely && !has('encode-only')) {
    die(`局部渲染缓存不可用（${cache.reason}）；请先 vh render --all，未开始截图`);
  }
  if (!forceAll && !scenesArg && canIncrement && changedNow.length && changedNow.length < bodiesNow.length && cache.canIncrementSafely && sameRenderSettings(baseline, settings)) {
    argv.push('--scenes', changedNow.join(','));
    say(`自动增量：只重渲第 ${changedNow.join(', ')} 场（--all 则整片重渲）`);
  } else if (!forceAll && !scenesArg && (!cache.canIncrementSafely || !sameRenderSettings(baseline, settings)) && canIncrement) {
    say(`增量缓存不可用（${cache.reason}）→ 整片渲染`);
    argv.push('--all');
  } else if (!scenesArg && !has('all')) {
    const why = !runtimeMatch ? '渲染器已升级或改变，不能混用旧启动参数下的画面'
      : !prevBodies ? '没有渲染基线'
      : s.rangesChanged ? '场景边界变了'
      : s.sharedChanged ? '引擎/CSS等共享部分变了'
      : changedNow && changedNow.length >= bodiesNow.length ? '全部场都变了' : '整片渲染';
    say(why + ` → 整片渲染`);
  }
  if (!scenesArg && !argv.includes('--scenes') && !argv.includes('--all')) argv.push('--all');
  // 仅在参数/局部范围验证通过后清可重建缓存，拒绝请求不得先改用户缓存。
  const durNow = budget.duration, framesDir = path.join(project, 'out/frames');
  let trailing = false, manifestDuration = null;
  try { trailing = fs.readdirSync(framesDir).some(f => /^\d{5,}\.(jpg|png)$/.test(f) && Number(f.split('.')[0]) >= budget.frames); } catch {}
  try { manifestDuration = JSON.parse(fs.readFileSync(path.join(project, 'out/seg/manifest.json'), 'utf8')).duration; } catch {}
  if (!scenesArg && (trailing || manifestDuration && Math.abs(manifestDuration - durNow) > 0.5)) {
    say('⚠ 缓存与当前时间轴不一致 → 清缓存并整片重渲');
    for (const sub of ['frames', 'seg']) fs.rmSync(path.join(project, 'out', sub), { recursive: true, force: true });
    if (!argv.includes('--all')) argv.push('--all');
    const at = argv.indexOf('--scenes'); if (at >= 0) argv.splice(at, 2);
  }
  const expectedInputs = currentArtifactInputs(project);
  if (expectedInputs.sourceSignature !== qualityInputs.sourceSignature)
    die('质检期间制作输入发生变化，未开始渲染；请核对当前稿后重新质检', 'inputs-changed');
  if (strictReview) {
    const { productionQualityStatus } = await import('./lib/production-quality.mjs');
    if (!productionQualityStatus(project, { phase: 'pre-render', profile: qualityProfile }).ok) die('质检后制作输入发生变化，未开始渲染；请重新质检');
  }
  const renderStart = performance.now();
  /* The standalone renderer reports its own stage events. Forward them live so
   * long renders still show progress, and ingest only events tagged with this
   * run's ID. The renderer must receive that ID or its events are ignored. */
  let renderOutput = '';
  const renderRunId = performanceRunId();
  const optimizedRenderer = fs.readFileSync(path.join(project, 'render.mjs'), 'utf8').includes('VH_RENDER_STAGE ');
  const renderEnv = { ...process.env, ...(optimizedRenderer ? { VH_RENDER_RUN_ID: renderRunId } : {}) };
  const r = await productionCommand(process.execPath, argv, { cwd: project, env: renderEnv,
    ...(optimizedRenderer ? {
      onStdout: chunk => {
        const text = String(chunk);
        process.stdout.write(text);
        renderOutput += text;
        if (renderOutput.length > 2 * 1024 * 1024) renderOutput = renderOutput.slice(-1024 * 1024);
      } } : {}) });
  ingestRendererEvents(project, renderOutput, { runId: renderRunId });
  recordPerformance(project, { kind: 'step', stage: '渲染器（截图与编码）', elapsedMs: performance.now() - renderStart, ok: r.status === 0, exitCode: r.status, failureCode: 'renderer-failed' });
  if (r.status !== 0) {
    performanceFailure = 'renderer-failed';
    say('\n✗ 渲染失败。常见原因与修法：');
    say('  · 先看本次 renderer 输出，定位运行、资源、截图或编码阶段，不原样重跑整条管线');
    say('  · 自定义 renderer 的审核逻辑不会自动改写；已知模板在内容优先模式不等待人工清单');
    say('  · 核对当前输入和 vh plan，只补失败/失效阶段；不要盲目整片重渲或清缓存');
    process.exit(r.status || 1);
  }
  if (currentArtifactInputs(project).sourceSignature !== expectedInputs.sourceSignature)
    die('阶段运行期间制作输入发生变化，未登记渲染产物或备用输出为当前版本；请核对当前稿后重渲', 'inputs-changed');
  if (rendererIdentity(project).sha256 !== runtime.sha256) die('渲染期间渲染器改变，未登记新版本凭证；请核对后重渲', 'renderer-changed');
  if (durationLimit(project)) assertDurationLimit(project, probeDuration(path.join(project, 'out', `${name}.mp4`)), '实际成片');
  const sceneSrc = fs.readFileSync(path.join(project, 'scene.html'), 'utf8');
  const ranges = [...sceneSrc.matchAll(/addScene\(\s*([\d.]+)\s*,\s*([\d.]+)/g)].map(m => [+m[1], +m[2]]);
  const mark = sceneSrc.indexOf('const scenes = [];');
  const renderArtifact = name === 'video' ? createArtifactRecord(project, 'render', { expectedInputs }) : null;
  const renderMetadata = {
      at: new Date().toISOString(), name, params: argv.join(' '), settings, rendererHash: runtime.sha256,
      ...(renderArtifact ? { artifact: renderArtifact } : {}),
      // 真实成片时长，不是时间轴长度。两者不同正是"画面没渲完/复用了旧段"的信号。
      dur: probeDuration(path.join(project, 'out', `${name}.mp4`)),
      timelineDur: +(sceneSrc.match(/DURATION\s*=\s*([\d.]+)/) || [])[1] || null,
      sceneHtmlHash: fnv1a(sceneSrc),
      ranges,
      shared: mark > 0 ? fnv1a(sceneSrc.slice(0, mark + 'const scenes = [];'.length)) : null,
      // 逐场代码指纹：build 会重写整份 scene.html，只有逐场比对才认得出"只改了一场"
      bodies: parseSceneBodies(sceneSrc).map(b => fnv1a(b)),
  };
  saveState(project, name === 'video' ? {
    render: renderMetadata,
    chunksRendered: parseChunks(path.join(project, 'scenes.src.js')).map(c => fnv1a(c)),
  } : { alternateRenders: { ...(loadState(project).alternateRenders || {}), [name]: renderMetadata } });
  say('完成。配音通常几秒就好：vh voice --srt');
}

/* =================================================================== */
/* voice —— 配音 + 混流（逐句缓存，通常秒级）                             */
/* =================================================================== */
async function cmdVoice() {
  const project = resolveProject(getArg('dir', ''));
  assertContentReviewed(project);
  assertVideoFormat(project);
  if (durationLimit(project)) {
    assertDurationLimit(project, currentArtifactInputs(project).timelineDur, '混流时间轴');
    assertDurationLimit(project, probeDuration(path.join(project, 'out/video.mp4')), '静音成片');
  }
  const formatError = videoMediaFormatError(project, path.join(project, 'out/video.mp4'));
  if (formatError) die(formatError);
  const renderError = artifactStatus(project).stale.render;
  if (renderError) die('不能给过期/未知版本的画面混流：' + renderError);
  const voiceRepair = upgradeVoice(project);
  if (voiceRepair.changed) say('✓ 已升级已知配音脚本为缓存命中时不加载模型；备份：' + voiceRepair.backup);
  assertVoiceTimingCurrent(project);
  // 复用测量时的音色/语速：优先 timing.json（它是绑定测量参数的真相），其次 state，最后默认值
  let tjson = null;
  try { tjson = JSON.parse(fs.readFileSync(path.join(project, 'timing.json'), 'utf8')); } catch {}
  const tm = (tjson && tjson.measurement) || {};
  const mp = (loadState(project).measureParams) || {};
  const eff = (k, d) => getArg(k, '') || tm[k] || mp[k] || d;
  const extra = [];
  const defaults = projectVoiceDefaults(project);
  const voice = eff('voice', defaults.voice), speed = eff('speed', defaults.speed);
  extra.push('--voice', voice, '--speed', String(speed));
  const concurrency = Number(getArg('tts-concurrency', '') || mp.ttsConcurrency || 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) die('tts-concurrency 必须是 1–8 的整数');
  if (voiceScriptSupportsConcurrency(project, requireVoiceScript(project).name)) extra.push('--tts-concurrency', String(concurrency));
  else if (has('tts-concurrency')) die('当前配音脚本不支持 --tts-concurrency（仅 edge-tts 版支持）');
  const expectedInputs = currentArtifactInputs(project), expectedRenderMedia = mediaFingerprint(path.join(project, 'out/video.mp4'));
  for (const k of ['bgm', 'sfx', 'sfxvol', 'bgmvol']) { const v = getArg(k, ''); if (v) extra.push('--' + k, v); }
  await runStep('配音合成与混流', 'python3',   // 先混流（--srt 会只导字幕跳过合成，所以分开跑）
    [requireVoiceScript(project).name, ...extra, ...(has('no-cache') ? ['--no-cache'] : [])], { cwd: project });
  // 抽一条纯旁白音轨给预览页用（预览里也能听到配音，不用等成片）
  try {
    const src = path.join(project, 'out', 'video-voice.mp4');
    if (fs.existsSync(src)) {
      // ⚠ skill 的配音混流没加 +faststart（moov 在文件末尾）→ 浏览器要下完整个文件才能播、一拖就转圈。
      //   这里无损重封装一次（copy，不重编码），把 moov 挪到前面。
      if (await ensureFaststart(src)) say('✓ 已修正 out/video-voice.mp4 的 moov 位置（+faststart，可边下边播/秒拖进度）');
      const audio = await productionCommand('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vn', '-c:a', 'aac', '-b:a', '128k',
        path.join(project, 'out', 'narration.m4a')], { cwd: project });
      if (audio.status === 0) say('✓ 旁白音轨 → out/narration.m4a（预览页同步播放）');
      else say('⚠ 预览音轨提取失败，未宣称更新成功；正式成片另行验收');
    }
  } catch {}
  saveState(project, { voice: { at: new Date().toISOString(), srt: subtitleStatus(project).ok, artifact: createArtifactRecord(project, 'voice', { expectedInputs, expectedRenderMedia }),
    // 用真实媒体时长记账；同时记录它对应的时间轴，供过期判定比对。
    dur: probeDuration(path.join(project, 'out', 'video-voice.mp4')),
     timelineDur: +(fs.readFileSync(path.join(project, 'scene.html'), 'utf8').match(/DURATION\s*=\s*([\d.]+)/) || [])[1] || null } });
  if (has('srt')) await cmdSubtitles();
}


/* =================================================================== */
/* contact —— 联系表（整片拼成一张图，不用逐张看）                        */
/* =================================================================== */
async function cmdContact() {
  const project = resolveProject(getArg('dir', ''));
  const { build, report } = await import('./lib/contact.mjs');
  const r = await build(project, {
    times: Number(getArg('times', '1')),
    ...(has('cols') ? { cols: Number(getArg('cols', '')) } : {}),
    ...(has('scenes') ? { scenes: getArg('scenes', '').split(',').map(n => n.trim() ? Number(n) : NaN) } : {}),
  });
  say(report(r));
  if (!r.ok) process.exit(1);
  return r;
}

/* =================================================================== */
/* stills —— 每场一张真实渲染静帧（分镜页审片用）                          */
/* =================================================================== */

async function cmdStills() {
  const project = resolveProject(getArg('dir', ''));
  const expectedInputs = currentArtifactInputs(project);
  const s = await snapshot(project);
  if (!s.scenes.length) die('scene.html 里没有可截的场景（先 build）');
  const outDir = path.join(project, 'out', 'stills');
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  let count = 0;
  let atList = null;
  let preview;
  try {
    const { openPreviewPage } = await import('./lib/preview-page.mjs');
    preview = await openPreviewPage(path.join(project, 'scene.html'));
    const { page } = preview;

    // --at 3,7.5,11：按时间点截图（验证运镜中段，而不是只截每场中点）
    const atArg = getArg('at', '');
    atList = atArg ? atArg.split(',').map(x => +x).filter(n => Number.isFinite(n)) : null;
    if (atList) {
      for (const t of atList) {
        await page.evaluate(tt => window.renderAt(tt), t);
        await page.waitForTimeout(40);
        await page.screenshot({
          path: path.join(outDir, `t-${String(t).replace('.', '_')}.jpg`),
          type: 'jpeg', quality: 88, animations: 'disabled',
        });
      }
      count = atList.length;
    } else {
      for (const sc of s.scenes) {
        const mid = Math.round(((sc.start + sc.end) / 2) * 10) / 10;
        await page.evaluate(t => window.renderAt(t), mid);
        await page.waitForTimeout(40);
        await page.screenshot({
          path: path.join(outDir, `s-${String(sc.i).padStart(2, '0')}.jpg`),
          type: 'jpeg', quality: 88, animations: 'disabled',
        });
      }
      count = s.scenes.length;
    }
  } finally {
    // 出错也要关：否则一次异常就留一堆无头 Chromium
    if (preview) await preview.close();
  }
  if (currentArtifactInputs(project).sourceSignature !== expectedInputs.sourceSignature) die('截图期间输入发生变化，未登记静帧为当前版本；请重新截图');
  const files = atList ? [] : s.scenes.map(sc => {
    const file = `s-${String(sc.i).padStart(2, '0')}.jpg`, media = mediaFingerprint(path.join(outDir, file));
    if (!media) throw new Error('静帧无法读取：' + file);
    return { file, sha256: media.sha256, size: media.size };
  });
  saveState(project, { lastStills: { at: new Date().toISOString(), count, sourceSignature: expectedInputs.sourceSignature, kind: atList ? 'times' : 'scenes', files } });
  say(`✓ ${count} 张静帧${atList ? '（按时间点）' : ''} → out/stills/（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
}

/* =================================================================== */
/* go —— 一条命令：build → 增量 render → voice                           */
/* =================================================================== */
async function cmdGo() {
  if (has('dry-run')) return cmdPlan();
  const requestError = renderRequestError(pipelineOptions());
  if (requestError) die(requestError);
  const project = resolveProject(getArg('dir', ''));
  assertContentReviewed(project);
  await repairSubtitles(project);
  const before = await snapshot(project);
  if (before.stale.requirements) die(before.stale.requirements + '；先完成小块编辑并 verify_change，不能用旧稿直接出片');
  const built = before.stale.scene || !fs.existsSync(path.join(project, 'scene.html'));
  if (built) await cmdBuild();
  else say('✓ scene.html 是新的（输入没变），跳过生成');

  /* 改稿后 timing 过期 → 自动重测（否则配音会拒绝、时间轴与字幕不一致）。
     ⚠ timing **不存在**也要测：字幕/配音/时间轴全靠它，缺了只能拿估算节奏出片，
     声画会对不上（真实事故：go 静默跳过测量，成片用的是估算时间轴）。 */
  let after = built ? await snapshot(project) : before;
  let measurement = {}; try { measurement = JSON.parse(fs.readFileSync(path.join(project, 'timing.json'), 'utf8')).measurement || {}; } catch {}
  const changedVoice = has('voice') && getArg('voice', null) !== measurement.voice || has('speed') && Number(getArg('speed', NaN)) !== Number(measurement.speed);
  if (after.timing.state !== 'valid' || after.stale.measure || changedVoice || has('remeasure') || has('maxspeed')) {
    const why = after.timing.state === 'missing' ? '还没有 timing（首次出片）'
      : after.timing.state === 'invalid' ? 'timing 与当前脚本不符'
      : '脚本改过还没重新测量';
    say(`\n（${why} → 自动测量）`);
    await cmdMeasure();
    after = await snapshot(project);
  }
  const explicitRender = ['all', 'hq', 'release', 'fps', 'crf', 'preset', 'scenes', 'from', 'to', 'encode-only', 'force'].some(has);
  if (after.stale.render || explicitRender) {
    /* 时长/分段与当前时间轴不符时，增量会继续复用旧分段 → 中段声画错位。
       这类情况必须整片重渲，不能只重渲"内容变了"的场。 */
    const mustFull = /整片|旧分段/.test(after.stale.render || '');
    if (mustFull) say(`\n⚠ ${after.stale.render}\n  → 本次强制整片重渲（不走增量）`);
    await cmdRender(mustFull ? ['--all'] : []);
  } else say('✓ out/video.mp4 是新的，跳过渲染');

  after = await snapshot(project);
  const explicitMix = ['voice', 'speed', 'bgm', 'sfx', 'bgmvol', 'sfxvol', 'no-cache'].some(has);
  if (after.stale.voice || explicitMix) await cmdVoice();
  else say('✓ out/video-voice.mp4 是新的，跳过配音');
  if (has('srt') || productionPolicy(project).enabled) await cmdSubtitles();
  if (productionPolicy(project).enabled && !(await checkProductionQuality(project, 'final')).ok) return;

  /* 当前 renderer 重编边界相邻段需要完整帧缓存，默认删除会让下一次单场
     修改也整片重渲。编辑期保留，用户显式清理或发布后 prune 再回收。 */
  const fr = path.join(project, 'out', 'frames');
  if (fs.existsSync(fr) && has('clean-frames')) {
    let sz = 0;
    try { sz = dirSize(fr); } catch {}
    try {
      fs.rmSync(fr, { recursive: true, force: true });
       say(`✓ 已清理渲染帧缓存（释放 ${(sz / 1048576).toFixed(0)}MB；分段与成片保留，下次改场会安全回退整片重渲）`);
    } catch {}
  } else if (fs.existsSync(fr)) {
    say('✓ 保留增量帧缓存；定稿后 vh prune 清理（--clean-frames 可立即清理，下次修改可能整片重渲）');
  }
  const final = await snapshot(project);
  say('\n── 结果 ──');
  for (const v of final.videos) say(`  ${v.file}  ${(v.size / 1048576).toFixed(1)}MB`);
  const left = Object.keys(final.stale);
  say(left.length ? `仍有过期项：${left.join(', ')}（vh status 看明细）` : '✓ 全部产物是新的');
  await autoAppendReferences(project);
  const pub = publishStatus(project);
  if (pub.required && !pub.ok) say('⚠ 视频流程已结束，但发布包未齐：' + pub.errors.map(e => e.message).join('；') + '。go 不调用模型；请在「发布」页单独生成文案。');
}

/* 出片/打包时自动把参考链接补到简介底部。
 *
 * 来源有四个，全部由 collectReferences 合并，只写一次盘、只用一个标题：
 *   1. claims.json 的 external 证据（审校模式的项目）
 *   2. 脚本.md 的「数字与来源」
 *   3. materials/选题.md、原文.md 的「检索来源」（入队时保存，常含 DOI）
 *   4. research/ 下调研资料里的小标题链接
 *
 * 为什么必须报结果：第一支片子没有 claims.json、脚本也没写 URL，
 * 提取结果为空时旧实现静默跳过，用户只看到简介里没有链接，不知道原因。
 *
 * 不核证：只提取作者写下的链接，不判断它是否支持断言、是否可达。
 * 失败不阻断制作，但必须说清是什么情况。 */
async function autoAppendReferences(project) {
  let result;
  try {
    const { appendReferencesToCopy } = await import('./lib/reference-sources.mjs');
    result = appendReferencesToCopy(project);
  } catch (error) {
    say('⚠ 参考资料未能写入简介：' + error.message + '（不影响成片，可稍后运行 vh refs --append）');
    return null;
  }
  if (result.ok && result.added) {
    say(`✓ 已补充 ${result.added} 条参考资料到简介` + (result.dropped ? `（${result.dropped} 条因超出 2000 字未放）` : '') + '；未核证链接与断言');
    // 程序追加改变文案字节，会把已关联的文案打成「有手动修改」。
    // 重新关联，但标记为 system：不是人工核对，也不覆盖用户的核对结论。
    try {
      const { confirmPublishRevision, publishRevision } = await import('./lib/publish.mjs');
      const current = publishRevision(project);
      if (current.state === 'edited' || current.state === 'untracked') {
        confirmPublishRevision(project, { sourceSignature: current.sourceSignature, publishHash: current.publishHash, by: 'system' });
      }
    } catch { /* 关联失败只影响展示口径，不影响文件已写入 */ }
  } else if (result.reason === 'already-present') {
    say(`✓ 简介已含可收集的全部 ${result.available} 条参考链接`);
  } else if (result.reason === 'no-room') {
    say('⚠ 简介已到 2000 字上限，参考资料没有放进去；可删短简介后重跑 vh refs --append');
  } else if (result.reason === 'no-sources') {
    say('· 简介未加参考资料：claims.json、脚本「数字与来源」、materials 检索来源、research 里都没有可用的 URL 或 DOI');
  } else if (result.reason === 'missing-copy') {
    say('· 简介未加参考资料：还没有 发布文案.md');
  } else if (result.reason === 'no-desc-section') {
    say('⚠ 发布文案里没有「## 简介」小节，参考资料没有写入');
  }
  return result;
}

/* =================================================================== */
/* preview —— 播放/预览页                                               */
/* =================================================================== */
async function cmdPreview() {
  const raw = findProject(getArg('dir', ''));
  let project = null;
  if (raw && fs.existsSync(path.join(raw, 'PROJECT.json'))) project = raw;
  else {
    // 在 harness 根目录：列出所有项目，默认挑最新有项目的那个
    const list = [];
    const walk = (d, depth) => {
      if (depth > 3) return;
      let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        if (!it.isDirectory() || it.name.startsWith('.') || it.name === 'node_modules' || it.name === 'out') continue;
        const abs = path.join(d, it.name);
        if (fs.existsSync(path.join(abs, 'PROJECT.json'))) list.push(abs); else walk(abs, depth + 1);
      }
    };
    walk(HERE, 0);
    project = list[0] || null;
    if (project) say(`（在 harness 根目录启动：默认项目 ${path.relative(HERE, project)}；页面上可切换全部项目）`);
  }
  let port = parseInt(getArg('port', '8144'), 10);
  // 默认只提供地址。只有用户显式 --open 才触发系统浏览器。
  const probe = spawnSync('/bin/zsh', ['-lc', `curl -s -o /dev/null --max-time 1 http://127.0.0.1:${port}/_api/projects && echo up || echo down`], { encoding: 'utf8' }).stdout.trim();
  if (probe === 'up') {
    say(`✓ 工作台已经在运行：http://127.0.0.1:${port}/（不重复启动）`);
    say(`  要关掉它：node vh.mjs stop  （或 Ctrl+C 停掉原来的终端）`);
    if (has('open') && process.platform === 'darwin') spawn('open', [`http://127.0.0.1:${port}/`], { stdio: 'ignore' });
    return;
  }
  const { startServer } = await import('./lib/server.mjs');
  // 端口避让：被别的程序占着就往后找（最多 10 个）
  let usePort = port;
  for (let i = 0; i < 10; i++) {
    const busy = spawnSync('lsof', ['-nP', '-t', '-iTCP:' + usePort, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim();
    if (!busy) break;
    usePort++;
  }
  if (usePort !== port) say(`（${port} 被占用，改用 ${usePort}）`);
  startServer(project, usePort);
  port = usePort;
  say(`\n预览页 → http://127.0.0.1:${port}/   (Ctrl+C 停止)`);
  say('页内可：直接播放 scene.html（不用渲染）、逐句对照脚本、看分镜静帧、看成片 MP4');
  if (has('open') && process.platform === 'darwin') spawn('open', [`http://127.0.0.1:${port}/`], { stdio: 'ignore' });
  await new Promise(() => {});   // 前台驻留
}

/* =================================================================== */
/* enhance —— 把 fx 手法库注入项目 engine.tpl.html（幂等、先备份）        */
/* =================================================================== */
async function repairSubtitles(project) {
  const { repairSubtitleTemplate } = await import('./lib/subtitle.mjs');
  const result = repairSubtitleTemplate(project, fs.readFileSync(path.join(HERE, 'assets/fx-block.html'), 'utf8'));
  if (result.changed) {
    say('✓ 已修复旧字幕断行截字（只更新字幕块，已备份 ' + path.basename(result.backup) + '）');
    saveState(project, { genStamp: null }); // 模板改过，go 不得静默复用旧 scene.html。
  }
  if (result.note) say('⚠ ' + result.note);
  return result;
}

async function cmdEnhance() {
  const project = resolveProject(getArg('dir', ''));
  if (has('subtitles')) {
    const result = await repairSubtitles(project);
    if (!result.changed) say('字幕块无需修复；未改动其他模板内容');
    return;
  }
  const tpl = path.join(project, 'engine.tpl.html');
  if (!fs.existsSync(tpl)) die('项目里没有 engine.tpl.html');
  const src = fs.readFileSync(tpl, 'utf8');
  if (has('film')) {
    const { installFilm } = await import('./lib/film-install.mjs');
    let result;
    try { result = installFilm(project, { force: has('force') }); } catch (error) { die(error.message); }
    if (!result.changed) { say(result.note || '✓ VH_FILM 已是最新版（未改现有模板）'); return; }
    saveState(project, { genStamp: null });
    say(`✓ 已${result.updated ? '升级' : '安装'}字幕锚定编排与确定性镜头助手（备份：${path.basename(result.backup)}）`);
    say('  改完场景后 vh build；不会打开网页。用法见 references/cinematic-direction.md');
    return;
  }
  const hasOld = src.includes('fx.v2 —— 画面质量手法库');
  if (hasOld && !has('force')) { say('✓ fx 手法库已在 engine.tpl.html 里（要更新手法库加 --force）'); return; }
  let block = fs.readFileSync(path.join(HERE, 'assets', 'fx-block.html'), 'utf8');
  if (hasOld) {
    // 整段替换：从 `const FX = (() => {` 到**注入块的结尾**（资产尾部含 FX + VH_UI 全部助手）
    // ⚠ 不能直接替换到文件末尾：模板里注入块后面还有 gen.mjs 要用的东西
    //   （真实事故：新增 shotEl/videoEl 后 enhance 没更新，场景调用 U.shotEl 直接白屏）
    const a = src.indexOf('const FX = (() => {');
    if (a >= 0) {
      const assetTail = block.slice(block.indexOf('const FX = (() => {'));
      const bak = tpl + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(tpl, bak);
      // 若模板尾部还留着上次注入的旧块，从 a 到"注入块末尾"替换；否则接到末尾
      const remain = src.slice(a);
      // 明确边界，不能拿“最后一个 VH_UI 赋值”猜：后面可能是作者自己的助手。
      const endMarker = remain.includes('/* vh:fx-end */') ? '/* vh:fx-end */'
        : remain.includes('window.__assetsReady = assetsReady;') ? 'window.__assetsReady = assetsReady;' : null;
      if (!endMarker) die('旧手法库的结束边界无法安全识别；未覆盖模板，请先人工核对注入段');
      const cut = a + remain.indexOf(endMarker) + endMarker.length;
      fs.writeFileSync(tpl, src.slice(0, a) + assetTail + src.slice(cut), 'utf8');
      saveState(project, { enhance: { at: new Date().toISOString(), updated: true, backup: path.basename(bak) } });
      say('✓ 手法库已更新为最新版（原文件已备份）');
      say('  含：FX 手法库（字符场/粒子/地平线/环绕/镜头表）+ VH_UI 助手（窗口/代码行/字符层）');
      return;
    }
  }
  const bak = tpl + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(tpl, bak);
  // 注到模板最末（gen.mjs 会把 SUBS/场景接在它后面 —— 助手先于场景定义，顺序正确）
  fs.writeFileSync(tpl, src.replace(/\s*$/, '') + '\n' + block + '\n', 'utf8');
  saveState(project, { enhance: { at: new Date().toISOString(), backup: path.basename(bak) } });
  say(`✓ fx 手法库已注入 engine.tpl.html（原文件备份为 ${path.basename(bak)}）`);
  say('  用法：场景里 FX.fxCanvas(root,{fps,draw}) / FX.grain / FX.breathe / FX.dolly / FX.camBlur');
  say('  ⚠ 之后要 node gen.mjs 重新生成 scene.html 才生效；升级 skill 前先 vh upgrade-check（壮大守卫见 SKILL）');
}

/* =================================================================== */
/* jitter —— 停稳两帧逐像素校验（抖动的唯一自动检测）                       */
/*   vh jitter [--at 12.5,20.0] [--gap 0.03] 对每个 t：renderAt(t) vs t+gap  */
/*   全片无参数 = 每场中点各测一对                                          */
/* =================================================================== */
async function cmdJitter() {
  const project = resolveProject(getArg('dir', ''));
  const s = await snapshot(project);
  if (!s.scenes.length) die('先 build 出 scene.html');
  const gap = parseFloat(getArg('gap', (1 / 30).toFixed(4)));
  const atArg = getArg('at', null);
  // 默认：同一时刻渲两次（确定性检查——抓残留 CSS 动画/非纯函数）；
  // --at t1,t2,..：测 t 与 t+gap 两帧（作者指定的停稳段——抓亚像素漂移/漏保持点）
  let pairs;
  if (atArg) pairs = atArg.split(',').map(Number).map(t => [t, t + gap]);
  else pairs = s.scenes.map(sc => { const mid = (sc.start + sc.end) / 2; return [mid, mid]; });
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { die('node 解析不到 playwright'); }
  const browser = await launchBrowser(chromium, {
    headless: true,
    args: ['--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(project, 'scene.html')).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  const W = await page.evaluate(() => window.W || 1920);
  const H = await page.evaluate(() => window.H || 1080);
  if (W !== 1920 || H !== 1080) await page.setViewportSize({ width: W, height: H });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-jitter-'));
  let bad = 0;
  say(atArg
    ? `停稳校验：${pairs.length} 对，t vs t+${gap}s —— 停稳段两帧应逐像素相同（promo-film 口径）`
    : `确定性校验：同一时刻渲两次 —— 两帧应逐像素相同（抖 = 残留 CSS 动画或非纯函数画面）`);
  for (let i = 0; i < pairs.length; i++) {
    const [a, b] = pairs[i];
    const fa = path.join(tmp, `a${i}.png`), fb = path.join(tmp, `b${i}.png`);
    const shot = async (t, f) => {
      await page.evaluate(t2 => window.renderAt(Math.round(t2 * 30) / 30), t);
      await page.waitForTimeout(60);
      await page.screenshot({ path: f, type: 'png', animations: 'disabled' });
    };
    await shot(a, fa); await shot(b, fb);
    const r = spawnSync('ffmpeg', ['-loglevel', 'info', '-i', fa, '-i', fb,
      '-filter_complex', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /PSNR.*?average:([\d.]+|inf|nan)/i.exec((r.stderr || '') + (r.stdout || ''));
    const psnr = m ? m[1] : '?';
    const ok = psnr === 'inf' || parseFloat(psnr) >= 60;
    const label = atArg ? `${a}s vs ${b.toFixed(2)}s` : `第 ${s.scenes[i] ? s.scenes[i].i : '?'} 场 ${a.toFixed(1)}s`;
    const fix = atArg
      ? '（停稳段在抖——查镜头/缓动是否漏了保持点，或背景在跑 60fps 颗粒）'
      : '（同一时刻两次不一样——找非确定性画法：Math.random、CSS animation、未验证的自动播放媒体）';
    say(`  ${ok ? '✓' : '✗'} ${label}  PSNR ${psnr} dB ${ok ? '' : fix}`);
    if (!ok) bad++;
  }
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (bad) { say(`\n✗ ${bad} 对未通过。修法见 references/quality.md。`); process.exit(1); }
  say('\n✓ 全部通过');
}

/* =================================================================== */
/* clarity —— 解释质量评估器（references/clarity.md 的机器可查部分）       */
/* =================================================================== */
async function cmdClarity() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, writeReport } = await import('./lib/clarity.mjs');
  const res = analyze(project);
  const rp = writeReport(project, res);
  say(`解释质量：${res.fail.length} 个硬性未通过 · ${res.warn.length} 个提示 · ${res.pending.length} 条待人工判定`);
  for (const f of res.fail.slice(0, 12)) say('  ✗ ' + f);
  if (res.fail.length > 12) say(`  …（还有 ${res.fail.length - 12} 条）`);
  for (const w of res.warn.slice(0, 5)) say('  · ' + w);
  say(`\n完整清单（含逐场「隐性知识追问」）→ ${path.relative(process.cwd(), rp)}`);
  say('机器只查依赖闭合的可判定部分；机制与隐性知识必须人工过（references/clarity.md）。');
  if (has('strict') && res.fail.length) process.exit(1);
}

async function cmdAuthorCheck() {
  const project = resolveProject(getArg('dir', ''));
  const { runAuthorCheck } = await import('./lib/author-check.mjs');
  const result = runAuthorCheck(project, { kind: getArg('kind', 'clarity'), terms: getArg('terms', ''), skill: getArg('skill', ''), show: has('show') });
  // The full result is reusable without another checker execution. Exit status
  // is the actual checker status, never the status of grep/sed in an inner shell.
  if (has('json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.error(result.cached ? '↻ 当前输入版本的完整作者检查结果（仍未证明语义正确）' : '· 作者检查已执行（仍未证明语义正确）');
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}





/* =================================================================== */
/* dist —— 交付包管理（列清单 / 清旧版本 / 全删）                          */
/* =================================================================== */
async function cmdDist() {
  const dir = path.join(HERE, 'dist');
  if (!fs.existsSync(dir)) { say('还没有 dist/（跑 vh pack 生成交付包）'); return; }
  const packs = fs.readdirSync(dir).filter(d => fs.statSync(path.join(dir, d)).isDirectory()).sort();
  const groups = {};
  for (const d of packs) {
    const name = d.replace(/-\d{12}$/, '');
    (groups[name] = groups[name] || []).push(d);
  }
  say(`交付包 ${packs.length} 个，共 ${(duOf(dir) / 1048576).toFixed(0)}MB\n`);
  for (const [name, list] of Object.entries(groups)) {
    say(`  ${name}`);
    list.sort().forEach((d, i) => {
      const mb = (duOf(path.join(dir, d)) / 1048576).toFixed(0);
      const tag = i === list.length - 1 ? '最新' : '旧';
      say(`    ${tag === '最新' ? '✓' : '·'} ${d}  ${mb}MB`);
    });
  }
  // 删除前必须让人看清"删什么、多少、还能不能救"
  // 真实事故：dist/ 被清空，5 个交付包没了，没有回收站、没有确认，成片只能重做。
  const confirms = (what, list) => {
    say(`\n将要删除 ${list.length} 个交付包（${what}）：`);
    for (const d of list) say(`    · ${d}  ${(duOf(path.join(dir, d)) / 1048576).toFixed(0)}MB`);
    say(`  合计 ${(list.reduce((s, d) => s + duOf(path.join(dir, d)), 0) / 1048576).toFixed(0)}MB`);
    if (has('yes') || has('force')) return true;
    die('为防误删，必须加 --yes 确认（交付包删掉不一定能重建：源项目可能已清理）');
  };
  const toTrash = (list) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bin = path.join(HERE, '.vh-trash', 'dist-' + stamp);
    fs.mkdirSync(bin, { recursive: true });
    for (const d of list) {
      try { fs.renameSync(path.join(dir, d), path.join(bin, d)); }
      catch { fs.cpSync(path.join(dir, d), path.join(bin, d), { recursive: true }); fs.rmSync(path.join(dir, d), { recursive: true, force: true }); }
    }
    return bin;
  };

  if (has('purge')) {
    if (!packs.length) { say('\n（dist/ 里没有交付包）'); return; }
    if (!confirms('全部', packs)) return;
    const before = duOf(dir);
    const bin = toTrash(packs);
    say(`\n✓ 已移入回收站：${path.relative(HERE, bin)}（${packs.length} 个，${(before / 1048576).toFixed(0)}MB）`);
    say('  确认不要了再删 .vh-trash/；要恢复就 mv 回 dist/。');
    say('  注意：projects/ 里如果没有对应项目，影片源文件就只剩你自己留存的那份了。');
    return;
  }
  if (has('prune')) {
    const victims = [];
    for (const [, list] of Object.entries(groups)) {
      list.sort();
      victims.push(...list.slice(0, -1));           // 保留最新一份
    }
    if (!victims.length) { say('\n✓ 每个项目都只有一份，无需清理'); return; }
    if (!confirms('旧版本', victims)) return;
    const freed = victims.reduce((s, d) => s + duOf(path.join(dir, d)), 0);
    const bin = toTrash(victims);
    say(`\n✓ 已清理 ${victims.length} 个旧版本，移入 ${path.relative(HERE, bin)}（${(freed / 1048576).toFixed(0)}MB）`);
    return;
  }
  // 备份/源文件提示：交付包删了还能不能重建，取决于 projects/ 还在不在
  const projects = fs.existsSync(path.join(HERE, 'projects'))
    ? fs.readdirSync(path.join(HERE, 'projects')).filter(d => !d.startsWith('.') && fs.existsSync(path.join(HERE, 'projects', d, 'PROJECT.json')))
    : [];
  if (!projects.length && packs.length) {
    say('⚠ projects/ 里没有可用项目 —— 这些交付包删了就重建不了（成片+字幕+封面只在这里）');
  }
  say('\n用法：node vh.mjs dist --prune --yes   （每个项目只留最新一份，旧版进回收站）');
  say('      node vh.mjs dist --purge --yes   （全部移入回收站，可恢复）');
}

/* =================================================================== */
/* theme —— 美术方向（按内容选；只改 :root，场景代码不动）                  */
/* =================================================================== */
async function cmdTheme() {
  const { THEMES, applyTheme, suggestTheme } = await import('./lib/theme.mjs');
  if (has('suggest')) {
    const project = resolveProject(getArg('dir', ''));
    const rec = suggestTheme(project);
    if (has('json')) { console.log(JSON.stringify(rec, null, 2)); return; }
    say(`建议美术方向：${rec.key}（${rec.name}）`);
    say(`  依据：${rec.reason}`);
    say(`  应用：node vh.mjs theme ${rec.key} --dir ${path.relative(process.cwd(), project) || '.'}（只给建议，不自动改写）`);
    return;
  }
  const key = args.slice(1).find(a => !a.startsWith('--'));
  if (!key || has('list')) {
    say('可选美术方向（references/art-directions.md）：\n');
    for (const [k, t] of Object.entries(THEMES)) say(`  ${k.padEnd(14)} ${t.name}\n      适合：${t.best}`);
    say('\n用法：node vh.mjs theme <方向>   （改 engine.tpl.html 的 :root，先备份）');
    say('      node vh.mjs theme --suggest --dir <项目>  （按脚本线索推荐方向，只读）');
    say('应用后要 node vh.mjs build 重新生成 scene.html；再 vh stills 看对比度。');
    return;
  }
  const project = resolveProject(getArg('dir', ''));
  const r = applyTheme(project, key);
  if (!r.ok) die(r.error);
  say(`✓ 已应用方向「${r.theme.name}」（改了 ${r.applied} 个变量，原文件备份 ${r.backup}）`);
  if (r.missing.length) say(`  ⚠ 引擎里没有这些变量（跳过）：${r.missing.join(' ')}`);
  say('  下一步：node vh.mjs build   然后再 vh stills 逐场看一遍对比度');
}




/* =================================================================== */
/* publish-done —— 发布后打包并清理可再生缓存；公开包不是工程备份。          */
/*   node vh.mjs publish-done [项目目录] [--draft] [--out <新目录>]        */
/* =================================================================== */
async function cmdPublishDone() {
  const project = resolveProject(getArg('dir', ''));
  const name = path.basename(project);
  const before = duOf(project);
  say(`项目 ${name}（当前 ${(before / 1048576).toFixed(0)}MB）\n`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const packDir = path.resolve(getArg('out', path.join(HERE, 'dist', `${name}-${stamp}`)));
  const packArgs = [path.join(HERE, 'vh.mjs'), 'pack', '--dir', project, '--out', packDir];
  if (has('with-stills')) packArgs.push('--with-stills');
  if (has('reviewed')) packArgs.push('--reviewed');
  if (has('video-only')) packArgs.push('--video-only');
  if (has('draft') || has('force')) packArgs.push('--draft');
  const packed = spawnSync(process.execPath, packArgs, { cwd: project, encoding: 'utf8' });
  if (packed.status !== 0) {
    if (packed.stdout) say(packed.stdout.trim());
    if (packed.stderr) say(packed.stderr.trim());
    die('打包失败，未清理缓存或源文件；若仅需待审包，显式使用 --draft');
  }
  if (packed.stdout) say(packed.stdout.trim());
  const { stripProjectCaches } = await import('./lib/disk-hygiene.mjs');
  const cleaned = stripProjectCaches(project, { keepSeg: false });
  say(`✓ 已清可再生缓存 ${(cleaned.freed / 1048576).toFixed(0)}MB（${cleaned.removed.join('、') || '无'}）`);
  say(`交付物在：${packDir}`);
  say('源文件、原始素材、备份和审阅依据均保留；公开交付包不是完整工程备份。');
}

/* =================================================================== */
/* snap / undo / diff —— 快照、回滚、改动可见                            */
/* =================================================================== */
async function cmdSnap() {
  const project = resolveProject(getArg('dir', ''));
  const { create, list } = await import('./lib/snapshot.mjs');
  const label = args.slice(1).find(a => !a.startsWith('--')) || '';
  if (has('list')) {
    const all = list(project);
    if (!all.length) { say('还没有快照'); return; }
    say(`快照 ${all.length} 个：`);
    for (const s of all) say(`  ${s.id}${s.label ? '  「' + s.label + '」' : ''}  ${s.files.length} 个文件`);
    return;
  }
  const r = create(project, label);
  say(`✓ 已创建快照 ${path.basename(r.dir)}（${r.saved.length} 个文件：${r.saved.join(' ')}）`);
}

async function cmdUndo() {
  const project = resolveProject(getArg('dir', ''));
  const { restore, list, create } = await import('./lib/snapshot.mjs');
  const all = list(project);
  if (!all.length) die('还没有快照，无法回滚（用 vh snap 先存一版）');
  // 目标：显式指定的快照，或"最近一个非 before-undo 的快照"
  let id = args.slice(1).find(a => !a.startsWith('--')) || '';
  if (!id) {
    const candidates = all.filter(s => !/before-undo/.test(s.id));
    if (!candidates.length) die('没有可回滚的快照（只有 before-undo 记录）');
    id = candidates[0].id;                      // list() 已按时间倒序
  }
  // 回滚前先自动存一份"回滚前"的快照，避免连退回能力都丢了
  create(project, 'before-undo');
  const r = restore(project, id);
  if (!r.ok) die(r.error);
  say(`✓ 已回滚到快照 ${r.id}（恢复 ${r.restored.length} 个文件）`);
  say('  如果回滚错了：vh snap --list 找到 before-undo 再 undo 一次');
  say('  回滚后需要 node vh.mjs build 重新生成 scene.html');
}

async function cmdDiff() {
  const project = resolveProject(getArg('dir', ''));
  const { diff } = await import('./lib/snapshot.mjs');
  const r = diff(project);
  if (!r.ok) die(r.error);
  say(`与快照 ${r.snapshot.id} 相比：`);
  if (!r.changes.length) { say('  （没有变化）'); return; }
  for (const c of r.changes) {
    const tag = c.isNew ? '新增' : c.isDeleted ? '删除' : '修改';
    say(`  ${tag} ${c.file}  +${c.added} / -${c.removed} 行`);
  }
}





/* =================================================================== */
/* score —— 质量总分与回归对比                                          */
/* =================================================================== */
async function cmdScore() {
  const project = resolveProject(getArg('dir', ''));
  const { compute, save, compare, report } = await import('./lib/score.mjs');
  const cur = compute(project);
  const cmp = has('compare') || has('save') ? compare(project, cur) : compare(project, cur);
  say(report(cur, cmp));
  if (has('save') || !has('compare')) {
    const p = save(project, cur);
    say(`\n已保存评分快照 → ${path.relative(process.cwd(), p)}`);
  }
}

/* =================================================================== */
/* pacing —— 节奏检查（画面有没有在变）                                  */
/* =================================================================== */
async function cmdPacing() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/pacing.mjs');
  const res = await analyze(project, { samples: parseInt(getArg('samples', '6'), 10) });
  say(report(res));
  if (has('strict') && !res.ok) process.exit(1);
  return res;
}

/* =================================================================== */
/* lexicon —— 视觉语汇库（什么内容用什么手法）                            */
/* =================================================================== */
async function cmdLexicon() {
  const { LEXICON, promptHint } = await import('./lib/lexicon.mjs');
  say(`视觉语汇库：${LEXICON.length} 类内容关系 → 对应手法（references/lexicon.md）\n`);
  for (const l of LEXICON) {
    say(`  ${l.when}`);
    say(`    → ${l.how}　（${l.why}）`);
  }
  if (has('prompt')) { say(''); say(promptHint()); }
  say('\n用法：node vh.mjs lexicon --prompt  （输出可直接给 agent 的精简版）');
}




/* =================================================================== */
/* doctor —— 环境体检                                                   */
/* =================================================================== */
async function cmdDoctor() {
  const { doctor, report } = await import('./lib/doctor.mjs');
  const found = findProject(getArg('dir', ''));
  const project = found && fs.existsSync(path.join(found, 'PROJECT.json')) ? found : null;
  const res = await doctor(project);
  say(report(res));
  if (res.failed.length) say('\n修完上面的 ✗ 项再试；不确定的可以在对话里问。');
  if (has('strict') && res.failed.length) process.exit(1);
}













async function cmdTokens() {
  const project = resolveProject(getArg('dir', ''));
  const { scan, report } = await import('./lib/token-audit.mjs');
  const res = scan(project);
  say(report(res));
  if (has('strict') && res.findings.length) process.exit(1);
  return res;
}
async function cmdRhythm() {
  const project = resolveProject(getArg('dir', ''));
  const { scan, report } = await import('./lib/rhythm.mjs');
  const res = scan(project);
  say(report(res));
  if (has('strict') && res.findings.length) process.exit(1);
  return res;
}
async function cmdVisualFast() {
  const project = resolveProject(getArg('dir', ''));
  const { runVisualFastGuard, report } = await import('./lib/visual-fast-guard.mjs');
  const res = await runVisualFastGuard(project);
  console.log(has('json') ? JSON.stringify(res, null, 2) : report(res));
  if ((has('strict') || !res.sampled) && !res.ok) process.exit(1);
  return res;
}
async function cmdScriptPacing() {
  const project = resolveProject(getArg('dir', ''));
  const { analyzeScriptPacing, report } = await import('./lib/script-pacing.mjs');
  const res = analyzeScriptPacing(project);
  console.log(has('json') ? JSON.stringify(res, null, 2) : report(res));
  if (has('strict') && !res.ok) process.exit(1);
  return res;
}
async function cmdScriptReview() {
  const project = resolveProject(getArg('dir', ''));
  const { runScriptReview, formatReviewMarkdown, resolveReviewModel } = await import('./lib/script-review.mjs');
  const { CONTENT_PROFILES } = await import('./lib/content-profile.mjs');
  const explicit = getArg('model', '');
  const contentProfile = getArg('content-profile', '');
  if (contentProfile && !CONTENT_PROFILES.includes(contentProfile)) {
    die('内容定位只能选择 --content-profile auto|intel|science|opinion');
  }
  if (!has('json')) {
    try {
      const picked = resolveReviewModel({ explicit });
      say(`→ 正在以干净上下文独立校对脚本（模型 ${picked.model}，约 15–60 秒）…`);
    } catch {}
  }
  const res = await runScriptReview(project, { model: explicit, contentProfile });
  if (has('json')) console.log(JSON.stringify(res, null, 2));
  else {
    console.log(formatReviewMarkdown(res));
    say(`已保存审校结果 → ${path.relative(process.cwd(), res.reportPath)}`);
  }
  if (has('strict') && res.review.verdict !== 'pass') process.exit(1);
  return res;
}
async function cmdMotion() {
  const project = resolveProject(getArg('dir', ''));
  const { scan, report } = await import('./lib/motion.mjs');
  const res = scan(project);
  say(report(res));
  if (has('strict') && !res.ok) process.exit(1);
  return res;
}
/* =================================================================== */
/* transition —— 转场语法（是不是全片一个淡入）                            */
/* =================================================================== */
async function cmdTransition() {
  const project = resolveProject(getArg('dir', ''));
  const T = await import('./lib/transition.mjs');
  if (has('inject')) {
    const r = T.inject(project);
    if (!r.ok) die(r.error);
    say(r.already ? '✓ 引擎已支持多转场（cut / fade / push / wipe）' : '✓ 已给引擎注入 4 种转场（cut / fade / push / wipe）');
    say('  场景里用法：在 addScene 上方写 // @transition push（可选 cut / fade / push / wipe）');
    say('  下一步：node vh.mjs build 重新生成（会带上转场标签）');
    return r;
  }
  const res = T.scan(project);
  say(T.report(res));
  if (has('strict') && res.findings.length) process.exit(1);
  return res;
}



/* =================================================================== */
/* 讲述方式四件套：hook / arc / loop / concrete                          */
/* 依据：Ira Glass（anecdote+reflection）/ Olson ABT / Muller 实验 / Story Spine */
/* =================================================================== */


async function cmdVerify() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/verify.mjs');
  const res = analyze(project);
  say(report(res));
  if (has('strict') && res.findings.length) process.exit(1);
  return res;
}

async function cmdReflect() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/reflect.mjs');
  const res = analyze(project);
  say(report(res));
  if (has('strict') && res.findings.length) process.exit(1);
  return res;
}

async function cmdHook() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/hook.mjs');
  const res = analyze(project);
  say(report(res));
  if (has('strict') && res.findings.some(f => f.severity !== 'info')) process.exit(1);
  return res;
}
async function cmdArc() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/arc.mjs');
  const res = analyze(project);
  say(report(res));
  if (has('strict') && res.findings.length) process.exit(1);
  return res;
}
async function cmdLoop() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/loop.mjs');
  const res = analyze(project);
  say(report(res));
  if (has('strict') && res.findings.length) process.exit(1);
  return res;
}
async function cmdConcrete() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/concrete.mjs');
  const res = analyze(project);
  say(report(res));
  if (has('strict') && res.findings.length) process.exit(1);
  return res;
}

/* =================================================================== */
/* alive —— 逐秒可见度（真的每秒截帧比像素，验收"画面在动吗"）             */
/* =================================================================== */
async function cmdAlive() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/alive.mjs');
  say('正在逐秒抽帧比像素（约 1 秒/帧，稍等）…');
  const res = await analyze(project, { step: +(getArg('step', '1')) || 1 });
  say(report(res));
  if (has('strict') && res.findings.length) process.exit(1);
  return res;
}

/* =================================================================== */
/* type —— 字号纪律（阶梯 + 一屏最多 3 档）                               */
/* =================================================================== */
async function cmdType() {
  const project = resolveProject(getArg('dir', ''));
  const { scan, report, ladderOf } = await import('./lib/type-audit.mjs');
  if (has('ladder')) {
    const l = ladderOf(project);
    say(`当前方向 ${l.orient} 的合法字号：`);
    for (const [k, v] of Object.entries(l.sizes)) say(`  --fs-${k.padEnd(8)} ${v}px`);
    return l;
  }
  const res = scan(project);
  say(report(res));
  if (has('strict') && res.findings.length) process.exit(1);
  return res;
}

/* =================================================================== */
/* fit —— 真实盒子体检（在浏览器里量：压字幕 / 越界 / 文字重叠）            */
/* =================================================================== */
async function cmdFit() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/fit.mjs');
  say('正在量真实盒子（每场取中点）…');
  const res = await analyze(project);
  say(report(res));
  if (has('strict') && res.findings.length) process.exit(1);
  return res;
}

/* =================================================================== */
/* subtitle —— 字幕断行与正文让位（按最长字幕算安全区）                     */
/* =================================================================== */
async function cmdSubtitle() {
  const project = resolveProject(getArg('dir', ''));
  const { breakLine, fitPlan, report } = await import('./lib/subtitle.mjs');
  if (has('wrap')) {
    const text = args.slice(1).filter(a => !a.startsWith('--') && a !== 'wrap').join(' ').trim();
    if (!text) die('用法：node vh.mjs subtitle --wrap "要断行的字幕" [--max 18]');
    const maxW = +(getArg('max', '18')) || 18;
    const lines = breakLine(text, maxW, 3);
    say(`每行预算 ${maxW} 个中文字宽 → ${lines.length} 行`);
    lines.forEach((l, i) => say(`  ${i + 1}. ${l}`));
    return;
  }
  const plan = fitPlan(project);
  say(report(plan));
  if (has('strict')) {
    const bad = plan.scenes.filter(s => s.lines >= 3);
    if (bad.length) { say(`\n✗ ${bad.length} 场字幕到 3 行（会压正文）`); process.exit(1); }
  }
  return plan;
}

/* =================================================================== */
/* pick —— 版式建议（按旁白线索，给依据而不是猜意图）                       */
/* =================================================================== */
async function cmdPick() {
  const project = resolveProject(getArg('dir', ''));
  const { pick, report } = await import('./lib/recipe-pick.mjs');
  const res = pick(project);
  say(report(res));
  if (has('json')) say('\n' + JSON.stringify(res.scenes, null, 2));
  return res;
}

/* =================================================================== */
/* asset —— 真实素材（图片 / 视频 / CSV），以及素材体检                     */
/* =================================================================== */
async function cmdAsset() {
  const A = await import('./lib/assets.mjs');
  const sub = args[1] || '';
  // list / check 需要项目；add 也需要（要放进项目的 assets/）
  const project = resolveProject(getArg('dir', ''));

  if (sub === 'add') {
    const src = args.slice(2).find(a => !a.startsWith('--'));
    if (!src) die('用法：node vh.mjs asset add <文件> [--name 名字]');
    let r;
    try { r = A.add(project, src, { name: getArg('name', '') }); }
    catch (e) { die(e.message); }
    say(`✓ 已收进项目：${r.rel}（${(r.bytes / 1024).toFixed(0)}KB${r.size ? `，${r.size.w}×${r.size.h}` : ''}）`);
    say(`  场景里用：VH_UI.shotEl(root, '${r.rel}', x, y, w, h, { mark: [0.1,0.2,0.5,0.3], tag: '看这里' })`);
    say(`  或铺满：bgImg(el, '${r.rel}')`);
    return;
  }

  if (sub === 'csv') {
    const src = args.slice(2).find(a => !a.startsWith('--'));
    if (!src) die('用法：node vh.mjs asset csv <文件.csv> [--type bar|line] [--unit 单位]');
    const { parseCsv, chartSvg } = A;
    const { header, rows, numeric } = parseCsv(fs.readFileSync(src, 'utf8'));
    if (!numeric) die('这个 CSV 第 2 列起不是数字，画不了图（需要一类一值：name,value）');
    const items = rows.map(r => ({ label: r[0], value: +r[1] }));
    const svg = chartSvg({ type: getArg('type', 'bar'), unit: getArg('unit', ''), items, w: 760, h: 420 });
    const out = path.join(project, 'out', 'chart.svg');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, svg, 'utf8');
    say(`✓ 已生成图表 → ${path.relative(process.cwd(), out)}（${items.length} 条）`);
    say('  场景里用：VH_UI.chartEl(root, <把 svg 内容内联>, x, y, w, h)');
    say('  ⚠ 图表要内联进场景：scene.html 是单文件，外部 svg 引用在渲染时会丢。');
    say('  做法：把 out/chart.svg 的内容粘进 scenes.src.js 的 chartEl(...) 第一个参数。');
    return;
  }

  if (sub === 'check' || !sub) {
    const r = A.check(project);
    if (!r.assets.length && !r.refs.length) {
      say('项目里还没有素材（assets/ 为空，场景也没引用）。');
      say('加一个：node vh.mjs asset add ~/Desktop/shot.png');
      return r;
    }
    say(`素材 ${r.assets.length} 个，被引用 ${r.refs.length} 个\n`);
    for (const a of r.assets) {
      const used = r.refs.includes(a.name) ? '✓' : '·';
      const kind = a.kind.img ? '图' : a.kind.vid ? '视频' : a.kind.data ? '数据' : '文件';
      say(`  ${used} ${a.rel.padEnd(34)} ${kind}  ${(a.bytes / 1024).toFixed(0)}KB`);
    }
    if (r.findings.length) {
      say('');
      for (const f of r.findings) { say(`⚠ ${f.msg}`); if (f.fix) say(`   → ${f.fix}`); }
      if (has('strict')) process.exit(1);
    } else if (r.assets.length) {
      say(r.refs.length ? '\n✓ 素材齐、尺寸够、都被引用' : '\n✓ 素材尺寸都没问题（但还没接进场景）');
    }
    return r;
  }
  die('用法：node vh.mjs asset [add <文件> | check | csv <文件>]');
}

/* =================================================================== */
/* scene —— 场景配方（生成可直接运行的场景骨架，不用手算坐标）             */
/* =================================================================== */
async function cmdScene() {
  const R = await import('./lib/scene-recipes.mjs');
  const key = args.slice(1).find(a => !a.startsWith('--'));
  if (!key || has('list')) {
    say('场景配方（每条都能直接跑，坐标按 window.W/H 算，横竖屏可用）：\n');
    for (const r of R.list()) say(`  ${r.key.padEnd(18)} ${r.name}\n      ${r.when}`);
    say('\n用法：node vh.mjs scene <配方> [--append | --demo]');
    say('  默认只输出配方代码，不写文件；--append 追加到当前项目；--demo 显式新建示例项目。');
    return;
  }
  const project = has('append') ? resolveProject(getArg('dir', '')) : null;
  const rec = R.get(key);
  if (!rec) die('没有这个配方：' + key + '（vh scene --list 看全部）');
  const code = rec.code();
  if (has('append') && has('demo')) die('--append 与 --demo 不能同时使用');
  if (has('demo') && process.env.VH_AGENT_PROJECT) die('制作 Agent 不得创建示例项目；去掉 --demo 只读配方代码');
  if (!has('append') && !has('demo')) { say('// @layout ' + rec.name + '\n' + code); return; }

  if (has('append')) {
    const p = path.join(project, 'scenes.src.js');
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\s*$/, '') : '';
    fs.writeFileSync(p, cur + '\n\n//---\n\n// @layout ' + rec.name + '\n' + code + '\n', 'utf8');
    say(`✓ 已追加配方「${rec.name}」到 scenes.src.js（记得在 脚本.md 里加一场，块数必须相等）`);
    say('  然后：node vh.mjs build');
    return;
  }

  // 新建一个 demo 项目，把配方放进去（可直接出片验证）
  const dir = path.join(HERE, 'projects', key + '-demo');
  if (fs.existsSync(dir) && !has('force')) die(`已存在 ${path.relative(HERE, dir)}（要覆盖加 --force）`);
  const newVideo = path.join((await import('./lib/state.mjs')).skillDir(getArg('skill', '')) || '', 'scripts', 'new-video.mjs');
  if (!fs.existsSync(newVideo)) die('找不到 skill 的 new-video.mjs');
  const r = spawnSync(process.execPath, [newVideo, '--dir', dir, '--force'], { encoding: 'utf8' });
  if (r.status !== 0) die('脚手架失败：' + (r.stderr || '').slice(-200));
  spawnSync(process.execPath, [path.join(HERE, 'vh.mjs'), 'enhance', '--dir', dir], { encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, '脚本.md'),
    `# ${rec.name}（示例）\n\n**主体**：${rec.name}\n**目标时长：20 秒**\n\n## S1 · ${rec.name}\n1. 这是「${rec.name}」示例，这一期带你把它看明白。\n2. 适合的场合：${rec.when}。\n3. 把画面里的字换成你自己的内容，先看静帧再决定要不要配音。\n\n← 依赖：无\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), '// @layout ' + rec.name + '\n' + code + '\n', 'utf8');
  say(`✓ 已生成配方项目 → ${path.relative(HERE, dir)}`);
  say(`  配方：${rec.name}　适用：${rec.when}`);
  say(`  下一步：cd ${path.relative(HERE, dir)} && node ../../vh.mjs build && node ../../vh.mjs render --all`);
}

/* =================================================================== */
/* brief —— 要求清单（把你的一句话变成可核对的要求）                       */
/* =================================================================== */
async function cmdBrief() {
  const project = resolveProject(getArg('dir', ''));
  const { parseBrief, amend, save, load, report, selfCheck } = await import('./lib/brief.mjs');
  const text = args.slice(1).filter(a => !a.startsWith('--')).join(' ').trim();
  if (!text) {
    // 无参数：显示当前要求 + 自检
    const b = load(project);
    say(report(b));
    if (b) {
      const warns = selfCheck(project, b);
      if (warns.length) {
        say('\n自检发现问题：');
        for (const w of warns) say('  ⚠ ' + w);
      } else say('\n✓ 自检：当前产物没发现违反要求');
    }
    return;
  }
  const b = has('amend') ? amend(load(project), text) : parseBrief(text);
  save(project, b);
  say(report(b));
  if (b.conflicts && b.conflicts.length) {
    say('\n⚠ 上面有冲突的要求 —— 先定一个再跑 agent，否则它会自己猜。');
    process.exit(2);
  }
  say(has('amend')
    ? '\n已合并到 out/.vh-brief.json（旧要求按新指令撤销）'
    : '\n已保存 → out/.vh-brief.json（agent 会读它，并在收尾时自检）');
}

/* =================================================================== */
/* cost —— 运行统计（步数 / 动作 / 轮次；不编造金额）                     */
/* =================================================================== */
async function cmdCost() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/cost.mjs');
  say(report(analyze(project)));
}

/* =================================================================== */
/* portrait —— 竖屏出片（切 ORIENT + 适配检查 + 渲染）                   */
/* =================================================================== */
async function cmdPortrait() {
  const project = resolveProject(getArg('dir', ''));
  const P = await import('./lib/portrait.mjs');
  const which = getArg('size', has('square') ? 'square' : has('landscape') ? 'landscape' : 'portrait');
  const spec = P.SIZES[which];
  if (!spec) die(`没有这个尺寸：${which}（可选 ${Object.keys(P.SIZES).join(' / ')}）`);

  if (has('check')) {
    const fit = P.inspect(project);
    say(`竖屏适配检查（目标 ${spec.size}）`);
    if (fit.ok) {
      say('✓ 场景坐标都用相对量（window.W/H 或 safeArea），竖屏能直接重排');
      say(`  （字面量坐标 ${fit.hardcodedCount} 个，都在 1080 宽以内）`);
    } else {
      say(`✗ ${fit.problems[0].count} 处按 1920 宽写的字面量坐标会溢出：${fit.problems[0].sample}`);
      say('  → 改成按 window.W/H 或 VH_UI.safeArea() 算（配方库里的写法可以直接抄）');
    }
    return fit;
  }

  const fit = P.inspect(project);
  say(`当前方向：${P.orientOf(project)}　目标：${spec.label}（${spec.size}）`);
  if (!fit.ok) say(`⚠ 有 ${fit.problems[0].count} 处硬编码坐标，竖屏可能溢出（先 vh portrait --check）`);
  say('出片中（切方向 → gen → render）…');
  const t0 = Date.now();
  const r = P.renderSize(project, which, { crf: getArg('crf', '22'), force: !has('strict') });
  for (const st of r.steps) say(`  ${st.ok ? '✓' : '✗'} ${st.label}  ${st.ok ? '' : st.tail.slice(-160)}`);
  if (r.ok) {
    const mb = (fs.statSync(r.out).size / 1048576).toFixed(1);
    say(`\n✓ ${spec.label}：${path.relative(project, r.out)}（${mb}MB，${((Date.now() - t0) / 1000).toFixed(0)}s）`);
    say(`  方向已还原为 ${r.revertedTo}`);
  } else {
    say('\n✗ 出片失败（横屏工程未受影响）');
  }
  return r;
}

/* =================================================================== */
/* sizes —— 一次出三种尺寸（横屏 / 竖屏 / 方屏）                          */
/* =================================================================== */
async function cmdSizes() {
  const project = resolveProject(getArg('dir', ''));
  const P = await import('./lib/portrait.mjs');
  const want = (getArg('only', '') || 'landscape,portrait,square').split(',').map(s => s.trim()).filter(Boolean);
  const fit = P.inspect(project);
  if (!fit.ok) {
    say(`⚠ 有 ${fit.problems[0].count} 处硬编码坐标：${fit.problems[0].sample}`);
    say('  竖屏/方屏可能溢出；场景应改用 window.W/H 或 VH_UI.safeArea()。\n');
  }
  const results = [];
  for (const key of want) {
    const spec = P.SIZES[key];
    if (!spec) { say(`· 跳过未知尺寸 ${key}`); continue; }
    process.stdout.write(`▸ ${spec.label}（${spec.size}）…`);
    const t0 = Date.now();
    const r = P.renderSize(project, key, { crf: getArg('crf', '22') });
    const dt = ((Date.now() - t0) / 1000).toFixed(0);
    if (r.ok) {
      const mb = (fs.statSync(r.out).size / 1048576).toFixed(1);
      process.stdout.write(` ✓ ${path.basename(r.out)} ${mb}MB ${dt}s\n`);
    } else {
      process.stdout.write(` ✗ ${dt}s\n`);
      for (const st of r.steps.filter(s => !s.ok)) say(`    ${st.label}: ${st.tail.slice(-200)}`);
    }
    results.push({ key, ...r, dt });
  }
  const ok = results.filter(r => r.ok);
  say(`\n${ok.length}/${results.length} 个尺寸出片成功`);
  for (const r of ok) say(`  ${r.spec.label.padEnd(10)} ${path.relative(project, r.out)}`);
  return results;
}

/* =================================================================== */
/* compare —— 改稿前后对比图（左旧右新，每场一行）                        */
/* =================================================================== */
async function cmdCompare() {
  const project = resolveProject(getArg('dir', ''));
  const { compare } = await import('./lib/compare.mjs');
  say('正在对比（改前快照 vs 当前）…');
  const r = await compare(project);
  if (!r.ok) die(r.error);
  say(`✓ 已生成对比图：${path.relative(process.cwd(), r.file)}`);
  say(`  ${r.rows} 行 × （左：改前 ${r.before} 场 / 右：改后 ${r.after} 场）`);
  say('  看图：哪几场的构图/文字变了，一眼可见。');
}

/* =================================================================== */
/* cover —— 三比例封面（16:9 / 4:3 / 3:4）                              */
/* =================================================================== */
async function cmdCover() {
  const project = resolveProject(getArg('dir', ''));
  const { render } = await import('./lib/cover.mjs');
  const r = await render(project, { at: has('at') ? Number(getArg('at', NaN)) : null,
    main: getArg('main', ''), sub: getArg('sub', ''), brand: getArg('brand', ''), style: getArg('style', 'editorial') });
  if (!r.ok) die(r.error);
  say(`✓ 封面已生成（${r.style === 'frame' ? '预览画面 ' + r.frameAt + 's 处作底图' : '三种比例独立排版，不依赖成片'}）`);
  say(`  标题：${r.copy.main}`);
  if (r.copy.sub) say(`  副标：${r.copy.sub}`);
  say('');
  for (const m of r.made) say(`  ${m.w}×${m.h}  ${m.ratio.padEnd(6)} ${m.label}  → ${path.relative(process.cwd(), m.file)}`);
  say('\n请实际查看三种比例及 thumb-*.png（320px）；生成不等于审阅。显式使用正文底图：vh cover --style frame --at <秒>');
}

/* =================================================================== */
/* claims —— 事实对账（脚本里的数字 vs claims.json 的登记）               */
/* =================================================================== */
async function cmdClaims() {  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/claims.mjs');
  const res = analyze(project);
  if (has('review')) {
    const { reviewTable } = await import('./lib/claims.mjs');
    const out = path.join(project, '审查-事实.md');
    fs.writeFileSync(out, reviewTable(res.claims));
    say(`✓ 事实核对表 → ${path.relative(process.cwd(), out)}（${res.claims.length} 条，断言与原文并排，人扫一遍）`);
    return res;
  }
  say(report(res));
  if (has('strict') && !res.ok) process.exit(1);
  return res;
}

/* =================================================================== */
/* screen —— 图文对应体检（每场有没有具体对象 / 会不会太空 / 长停）        */
/* =================================================================== */
/* contrast —— 文字对比度体检（WCAG）
 * 真实事故：场景沿用深色配色而引擎是浅色纸底，整片文字"看起来透明"。 */
async function cmdContrast() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/contrast.mjs');
  const res = analyze(project);
  for (const line of report(res)) say(line);
  if (!res.ok) process.exitCode = 1;
}

async function cmdScreen() {
  const project = resolveProject(getArg('dir', ''));
  const screenInputs = has('frames') ? currentArtifactInputs(project) : null;
  const { analyze, report } = await import('./lib/screen-check.mjs');
  const res = analyze(project);
  say(report(res));
  if (has('review')) {
    const { runVisualReview, reviewSummary } = await import('./lib/visual-review.mjs');
    say('\n' + reviewSummary(await runVisualReview(project)));
  }

  // --frames：生成"静音审阅"静帧（每场中点，藏掉字幕层），供人逐场看"画面自己会不会说话"
  if (has('frames')) {
    const sceneHtml = path.join(project, 'scene.html');
    if (!fs.existsSync(sceneHtml)) die('还没有 scene.html（先 build）');
    const ranges = parseSceneRanges(fs.readFileSync(sceneHtml, 'utf8')).ranges;
    if (!ranges.length || ranges.length !== res.scenes.length || ranges.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a))
      die('静音静帧生成失败：当前场景区间缺失或与源码不符，请先 build');
    // Use the actual start/end, not accumulated rounded scene durations: gaps
    // and a nonzero first start otherwise sample the wrong frames.
    const mids = ranges.map(([a, b]) => Number(((a + b) / 2).toFixed(6)));
    const relative = path.join('out', 'silent', 'run-' + randomUUID());
    const dir = path.join(project, relative);
    fs.mkdirSync(dir, { recursive: true });
    const start = performance.now();
    let preview, ok = false;
    try {
      const { openPreviewPage } = await import('./lib/preview-page.mjs');
      preview = await openPreviewPage(sceneHtml);
      await preview.page.addStyleTag({ content: '#subs,#subbox,#bar{display:none !important}' });
      for (const [i, t] of mids.entries()) {
        await preview.page.evaluate(tt => window.renderAt(tt), t);
        await preview.page.waitForTimeout(40);
        await preview.page.screenshot({ path: path.join(dir, `s-${String(i + 1).padStart(2, '0')}-${String(t).replace('.', '_')}.png`), animations: 'disabled' });
      }
      ok = true;
    } finally {
      try {
        if (preview) await preview.close();
        if (ok && currentArtifactInputs(project).sourceSignature !== screenInputs.sourceSignature) throw new Error('截图期间输入发生变化，请重新截图');
      }
      catch (error) { ok = false; throw error; }
      finally { recordPerformance(project, { kind: 'step', stage: '静音审阅静帧', elapsedMs: performance.now() - start, ok }); }
    }
    say(`\n✓ 静音静帧已生成 → ${relative}/（每场中点；已隐藏常见字幕/进度层，自定义字幕仍需检查。逐张看画面是否清楚）`);
  }
  if (has('strict') && !res.ok) process.exit(1);
  return res;
}


/* =================================================================== */
/* variety —— 版式多样性（全片是不是每屏一个样）                          */
/* =================================================================== */
async function cmdVariety() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/variety.mjs');
  const res = analyze(project);
  say(report(res));
  if (has('strict') && res.findings.length) process.exit(1);
  return res;
}

/* =================================================================== */
/* layout —— 版式体检（画面文字抄旁白 / 压字幕区 / 越界 / 重叠）          */
/* =================================================================== */
async function cmdLayout() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/layout-check.mjs');
  const res = analyze(project);
  say(report(res));
  if (has('strict') && res.findings.length) process.exit(1);
  return res;
}


/* =================================================================== */
/* density —— 画面密度体检（按像素算：有没有空屏/大白卡片/主体出画）        */
/* =================================================================== */
async function cmdDensity() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/density.mjs');
  say('正在按像素测量（每场取 5 帧）…');
  const res = await analyze(project);
  say(report(res));
  if (has('strict') && res.findings.length) process.exit(1);
  return res;
}

/* =================================================================== */
/* depth —— 内容深度体检（讲得够不够展开）                                */
/* =================================================================== */
async function cmdDepth() {
  const project = resolveProject(getArg('dir', ''));
  const { analyze, report } = await import('./lib/depth.mjs');
  const res = analyze(project);
  say(report(project, res));
  if (!res.ok) say('\n逐条对照原文、受众和实际目标，只补需要的内容；不为形式规则凑句子。');
  if (has('strict') && !res.ok) process.exit(1);
  return res;
}

/* =================================================================== */
/* trim —— 超时删减顾问（只读；不替用户做取舍）                            */
/* =================================================================== */
async function cmdTrim() {
  const project = resolveProject(getArg('dir', ''));
  const limit = durationLimit(project);
  const keep = (getArg('keep', '') || '').split(',').map(s => s.trim()).filter(Boolean);
  const plan = trimPlan(project, { limit, keepScenes: keep });
  say(trimReport(project, plan).join('\n'));
  if (has('json')) say('\n' + JSON.stringify(plan, null, 2));
  // 超时是真实阻塞：默认退出非零，便于挂进脚本；--report 只打印
  if (plan.ok && plan.over > 0 && !has('report')) process.exit(1);
  return plan;
}

/* =================================================================== */
/* review-init —— 生成 审查.md 三关模板（开场 / 台阶 / 事实与承诺）         */
/* =================================================================== */
async function cmdReviewInit() {
  const project = resolveProject(getArg('dir', ''));
  if (has('snapshot')) {
    const { initReviewSnapshot } = await import('./lib/release-review.mjs');
    try { initReviewSnapshot(project, { refresh: has('force') }); }
    catch (error) { die(error.message); }
    say('✓ review.json 已生成待审快照；内容、画面、音频均为 pending，未批准任何审阅');
    return;
  }
  const p = path.join(project, '审查.md');
  if (fs.existsSync(p) && !has('force')) { say('✓ 审查.md 已存在（要重写加 --force）'); return; }
  const { analyze } = await import('./lib/depth.mjs');
  const res = analyze(project);
  const tpl = `# 内容审稿（人工，机器判不了）

> 规则：\`vh clarity\` / \`vh depth\` 只提供结构与词面线索，不证明讲清楚。下列各关必须人过。
> 完成一关就把 [ ] 改成 [x]，并在下面写一句你的实际结论（可以写"需改"）。

## 一、开场审稿（前 15 秒：观众会不会继续看）
- [ ] **原文主线**（有原文时）：这条视频讲的问题、主要判断和展开顺序是否承接原文；若有调整，是否有依据
- [ ] **先交代主题**：不看标题，仅听开头能否知道讲什么、为什么讲、接下来要回答什么
- [ ] **例子服务主题**：例子、数据与术语出现时，观众能否知道它们和主问题有什么关系
- [ ] **对象清楚**：观众能理解主要对象或过程吗？适用时用具体场景帮助理解（写下来：______）
- [ ] **主体名**：开头是否明确主体，不让"它/这件事"失去指代
- [ ] **去向**：有一句说清这条片子要讲什么
- [ ] **表达方式**：悬念或结论前置是否服务内容，而不是为形式遮住主题
- [ ] **无杂物**：没有年份/履历/版本号这类与主线无关的东西
- [ ] **第一句听得懂**：不依赖背景知识

实际结论：

## 二、概念台阶审稿（观众能不能跟着走）
- [ ] 最低一级是不是"最小约束"（观众已经知道的那一点）
- [ ] 每一级**只依赖已立起来的前几级**（对照脚本里的 ← 依赖 行）
- [ ] **表示法**：上屏的数字/符号，按受众基线读得出来吗
- [ ] 每级讲了"为什么"，不是只有"是什么"
- [ ] 走查里的数值都自己算过一遍
- [ ] **静音看一遍**：关掉旁白，画面能不能走到最后

实际结论：

## 三、逐场画面核对（图文对应，机器只能提示"太空"）
> 每场一行：画面画的是什么 → 对应旁白第几句 → 有没有具体对象（数字/文件/对比/步骤/窗口）。
> 判据：**遮住字幕，这一帧还能让人知道"在说什么"吗？**

| 场 | 画面画什么 | 对应旁白 | 具体对象 | 遮住字幕能看懂？ |
|---|---|---|---|---|
| S1 | | | | |
| S2 | | | | |
| S3 | | | | |

实际结论：

## 三b、广告核对（有广告场才需要）
> 机器只能查「有没有登记来源」，查不出「写的内容对不对」——必须人对着链接看。

- [ ] 我打开过广告链接，确认它**卖什么**（不是"社区/资料库"这类猜测）
- [ ] 如提及价格/费用，已核对页面与时间；用户要求不提价格时未擅自加入
- [ ] 前提条件写对了（例如"需自备账号"）
- [ ] 用户提供的信息与页面已核实事实分别登记；页面未核实或有冲突时，不冒充已核实，也不擅自删改，需说明并确认
- [ ] 口播、字幕、画面、简介、置顶评论逐项对照用户要求；没有擅加未要求的风险提示、劝诫、优惠或评价
- [ ] 若已知重要服务限制或法律、平台要求与用户口径冲突，已单独说明并确认处理方式，不隐瞒也不擅自改写广告
- [ ] 明确标注「这是广告」
- [ ] **广告已人工核对**

## 四、事实与承诺审稿
- [ ] 每个断言都能追到 claims.json 的来源与口径
- [ ] 如认为原文有误，已核对原文原句和来源的对象、基数、时间、题目与单位；未核实的不作定论
- [ ] 区分了 事实 / 厂商主张 / 实测 / 推导 / 建议 / 假设
- [ ] 承诺与交付层级一致（没夸大）
- [ ] 没有虚构亲历、实测或截图
- [ ] 没有把"经验建议"说成"研究结论"

实际结论：

---

## 机器体检快照（自动填，随改稿会过期）

- 场数：${res.count}　估算时长：${res.est.toFixed(0)}s${res.target ? `　目标：${Math.round(res.target)}s` : ''}
${res.hard.length ? res.hard.map(h => '- · ' + h).join('\n') : '- 未触发展开度形式规则；不代表内容充分'}
`;
  fs.writeFileSync(p, tpl);
  say(`✓ 已生成 ${path.relative(process.cwd(), p)}（三关模板 + 当前体检快照）`);
}

async function cmdReviewStatus() {
  const project = resolveProject(getArg('dir', ''));
  const { releaseReviewStatus } = await import('./lib/release-review.mjs');
  const result = releaseReviewStatus(project);
  if (has('json')) console.log(JSON.stringify(result, null, 2));
  else {
    say(result.ok ? '✓ 当前发布审阅声明与证据版本一致（不代表程序看过/听过）' : '待审：发布审阅尚未通过');
    for (const issue of result.issues) say('  · ' + issue.message);
    say(result.scope);
  }
  if (!result.ok) process.exitCode = 1;
}

async function cmdPerformance() {
  const project = resolveProject(getArg('dir', ''));
  const { performanceSummary, performanceReport } = await import('./lib/performance.mjs');
  const result = performanceSummary(project);
  console.log(has('json') ? JSON.stringify(result, null, 2) : performanceReport(result));
}

/* =================================================================== */
/* ask —— 把一句话交给 harness 自带的 agent 循环（与网页「指挥」同一个执行器）*/
/*   node vh.mjs ask "把这个项目做成视频" [--mode article|topic|edit] [--bg]     */
/* =================================================================== */

async function cmdAsk() {
  if (has('resume') && has('new')) die('--resume 与 --new 不能同时使用');
  const messageArgs = [];
  for (let i = 1; i < args.length; i++) {
    if (['--mode', '--dir', '--task-id', '--attempt-id', '--input-file', '--content-profile'].includes(args[i])) { i++; continue; }
    if (['--bg', '--resume', '--new', '--unattended'].includes(args[i])) continue;
    if (args[i] === '--') { messageArgs.push(...args.slice(i + 1)); break; }
    messageArgs.push(args[i]);
  }
  let raw = messageArgs.join(' ').trim();
  if (has('input-file')) {
    if (raw || !getArg('input-file', '')) die('请指定一个制作输入文件，不要同时传入指令正文');
    raw = fs.readFileSync(getArg('input-file', ''), 'utf8').trim();
  }
  const project = resolveProject(getArg('dir', ''));
  const requestedTask = getArg('task-id', '');
  const existingTask = readTask(project);
  if (requestedTask && existingTask?.id !== requestedTask) die('任务已被另一轮替代，未执行旧请求');
  if (requestedTask && existingTask?.attemptId !== getArg('attempt-id', '')) die('任务已由新的执行接管，未运行旧进程');
  if (requestedTask) raw = existingTask.message;
  // 网页启动新任务时没有命令行正文：任务记录里的 message 才是本轮指令。
  // 只有“恢复”才不带新指令；两种入口都不能把用户刚写的要求丢掉。
  const explicitInstruction = String(raw || '').trim();
  const previous = taskStatus(project);
  if (!requestedTask && (previous.running || previous.orphanRunning)) die('当前项目仍有执行进程，未重复派发');
  const shouldResume = requestedTask ? !!existingTask.resume : has('resume') || (!has('new') && previous.canResume);
  if (!raw && !shouldResume) die('用法：node vh.mjs ask "<指令>" [--new]；继续未完成任务：node vh.mjs ask --resume');
  if ((requestedTask || shouldResume) && has('mode') && existingTask?.mode && getArg('mode', '') !== existingTask.mode) die('恢复模式与原任务不一致，未执行');
  const { createTaskContract } = await import('./lib/task-contract.mjs');
  let newMode = getArg('mode', 'article');
  if (!requestedTask && !shouldResume && !has('mode') && fs.existsSync(path.join(project, '脚本.md')) &&
      ['video-voice.mp4', 'video.mp4'].some(name => fs.existsSync(path.join(project, 'out', name)))) newMode = 'edit';
  let job = requestedTask ? existingTask : shouldResume ? resumeTask(project, explicitInstruction) : beginTask(project, raw, newMode);
  if ((requestedTask || shouldResume) && has('mode') && getArg('mode', '') !== job.mode) die('恢复模式与原任务不一致，未执行');
  if (!job.contract) job = updateTask(project, job.id, { contract: createTaskContract(project, { mode: job.mode, message: explicitInstruction || job.message }) }, job.attemptId);
  raw = job.message;
  const mode = job.mode;
  const attemptId = job.attemptId;
  // Web-spawned workers load current code even if the already running server is
  // older. Resolve the same web default here too; never hot-switch a live worker.
  const automation = has('unattended') ? automationPolicy(project, true) : requestedTask
    ? webAutomationPolicy(project, mode, job.message)
    : automationPolicy(project, shouldResume && job.automation ? job.automation : undefined);
  updateTask(project, job.id, { automation }, attemptId);
  const lockPath = path.join(project, 'out/.vh-agent.lock');
  if (fs.existsSync(lockPath)) {
    let owner;
    try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch {}
    if (!owner || processAlive(owner.pid)) die('执行锁仍被另一进程占用，未重复启动');
    fs.unlinkSync(lockPath);
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, taskId: job.id, attemptId }), { flag: 'wx', mode: 0o600 });
  process.on('exit', () => {
    try { if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).attemptId === attemptId) fs.unlinkSync(lockPath); } catch {}
  });
  /* 执行器是可选的一层：opencode（带搜索、可续跑）或仓库自带的本地循环。
   * vh.mjs 只负责任务记录、锁与收尾，不关心模型循环长什么样。 */
  const { selectRunner } = await import('./lib/runners/index.mjs');
  let runner;
  try { runner = await selectRunner(project); }
  catch (error) {
    updateTask(project, job.id, { status: 'failed', finishedAt: Date.now(),
      error: { kind: error.code || 'configuration', message: error.message }, execution: error.snapshot || null }, attemptId);
    throw error;
  }
  updateTask(project, job.id, { execution: runner.execution || { runner: runner.name, model: runner.model || null } }, attemptId);
  const vh = path.join(HERE, 'vh.mjs');
  const { composeTask } = await import('./lib/task-prompts.mjs');
  const { CONTENT_PROFILES } = await import('./lib/content-profile.mjs');
  const { resolveProjectContentProfile } = await import('./lib/project-profile.mjs');
  const explicitProfile = getArg('content-profile', '');
  if (explicitProfile && !CONTENT_PROFILES.includes(explicitProfile)) {
    die('内容定位只能选择 --content-profile auto|intel|science|opinion');
  }
  const resolvedProfile = resolveProjectContentProfile(project, { explicit: explicitProfile, message: raw });
  const task = composeTask({
    project, repo: HERE, mode, message: raw,
    policyNote: workflowPrompt(project),
    contentProfile: resolvedProfile.profile,
    checkedAt: resolvedProfile.checkedAt,
  });
  const logPath = path.join(project, 'out', '.vh-chat.log');
  const runPath = path.join(project, 'out', '.vh-run.json');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  updateTask(project, job.id, { status: 'running', pid: process.pid, error: null }, attemptId);
  const header = '\n══ ' + (shouldResume ? '继续原任务 · 第 ' + job.attemptNumber + ' 次执行' : '用户') + ' ' + new Date().toLocaleTimeString('zh-CN') + '（CLI ask · ' + mode + '）：' + raw.slice(0, 120) + '\n';
  if (shouldResume) fs.appendFileSync(logPath, header); else fs.writeFileSync(logPath, header, 'utf8');
  // 运行标记落盘：网页靠它显示进度（服务重启也能看到），正常结束就删掉
  fs.writeFileSync(runPath, JSON.stringify({ pid: process.pid, childPid: null, taskId: job.id, attemptId, mode, startedAt: job.attemptStartedAt || job.startedAt, label: raw.slice(0, 40) }, null, 1));
  const clearRun = () => { try { clearStoppedRun(project, { taskId: job.id, attemptId, pid: process.pid, exitingPid: process.pid }); } catch {} };
  process.on('exit', () => {
    const current = readTask(project);
    if (current?.id === job.id && ['starting', 'running'].includes(current.status)) {
      updateTask(project, job.id, { status: 'failed', error: taskError('', 'interrupted'), finishedAt: Date.now() }, attemptId);
    }
    clearRun();
  });
  const controller = new AbortController();
  let cancellation = null;
  const cancel = code => {
    if (cancellation) return cancellation;
    productionStopping = true;
    cancellation = cancelTaskProcesses(project, { taskId: job.id, attemptId, selfPid: process.pid,
      extraChildren: [...productionChildren].map(([pid, info]) => ({ pid, group: info.group })).concat(readProductionLock(project).children || []) });
    controller.abort();
    let browserTimer;
    const closeBrowsers = Promise.race([closeLaunchedBrowsers(), new Promise(resolve => { browserTimer = setTimeout(resolve, 1500); })]).finally(() => clearTimeout(browserTimer));
    cancellation = Promise.allSettled([cancellation, closeBrowsers, runner.waitForCancellation?.()]).finally(() => process.exit(code));
    return cancellation;
  };
  process.on('SIGINT', () => cancel(130));
  process.on('SIGTERM', () => cancel(143));
  const log = (m) => { say(m); try { fs.appendFileSync(logPath, m + '\n'); } catch {} };
  const t0 = Date.now();
  say(`→ 交给 ${runner.name} 执行器（模型 ${runner.model || '按本机模型设置'}，模式 ${mode}）\n`);
  let out;
  try {
    /* instruction 是本轮新增的要求，和 task（整个任务的累积目标）不是一回事。
     * 不传的话，agent 判断"有没有新要求"时永远为假 —— 真实事故：
     * 用户在已完成的片子上说"片尾加广告"，进程 0.6 秒回"已完成"就退出，
     * 指令一个字都没被读到。 */
    const freshInstruction = freshInstructionFor({
      shouldResume, raw: explicitInstruction, resumeInstructions: job.resumeInstructions,
    });
    out = await runner.run({ prompt: task, log, signal: controller.signal, taskId: job.id, attemptId,
      resume: shouldResume, instruction: freshInstruction, instructions: job.resumeInstructions || [],
      mode, automation, contract: job.contract,
      instructionKind: instructionKindFor({ mode, shouldResume, hasScript: fs.existsSync(path.join(project, '脚本.md')), text: freshInstruction }),
      onStage: stage => { try { saveState(project, { pipeline: { stage, since: Date.now(), taskId: job.id, attemptId } }); } catch {} } });
    if (cancellation) { await cancellation; return; }
    // runner 只回一条可读的失败文案；finishTask 按既有词表归类（额度/认证/超时…）。
    finishTask(project, job.id, out, attemptId);
    try {
      const { commitCheckpointCompletion } = await import('./lib/checkpoint.mjs');
      commitCheckpointCompletion(project, job.id, attemptId);
    } catch (error) { log('⚠ 任务已完成，但检查点尚未同步为 completed：' + error.message + '（下次继续会按已记录回答结算，不改稿）'); }
  }
  catch (e) {
    if (readTask(project)?.status === 'cancelled') { process.exitCode = 130; return; }
    updateTask(project, job.id, { status: 'failed', error: taskError(e.message), finishedAt: Date.now() }, attemptId);
    throw e;
  }
  finally { clearRun(); }
  const answer = out && out.answer;
  if (out && out.warns && out.warns.length) {
    say('\n⚠ 收尾检查发现不一致（需要补做）：');
    for (const w of out.warns) say('  · ' + w);
  }
  if (!out?.ok) {
    if (out?.status === 'paused') {
      say(`\n⏸ 任务已暂停（${((Date.now() - t0) / 1000).toFixed(0)}s）：${out.paused || '达到单次执行步数上限'}`);
      say('进度与检查点已保存。点工作台「继续原任务」或运行 node vh.mjs ask --resume 接着做，不会重做已完成步骤。');
      // 暂停不是失败：说清"还差哪些产物"，让用户知道这在制作流程里的位置。
      try {
        const { artifactStatus } = await import('./lib/artifact-status.mjs');
        const missing = Object.entries(artifactStatus(project).stale)
          .filter(([k]) => ['scene', 'render', 'voice', 'timing', 'stills'].includes(k))
          .map(([k, v]) => ({ scene: '画面预览', render: '成片', voice: '配音', timing: '时间轴', stills: '分镜静帧' }[k] + '：' + v));
        if (missing.length) {
          say('\n当前进度（这些还没做完，不是出错）：');
          for (const m of missing) say('  · ' + m);
        }
      } catch {}
      say(`日志：${path.relative(process.cwd(), logPath)}`);
      process.exitCode = 0;
      return answer;
    }
    say(`\n✗ 任务未完成（${out?.status || 'failed'}，${((Date.now() - t0) / 1000).toFixed(0)}s）`);
    process.exitCode = out?.status === 'cancelled' ? 130 : 1;
  } else say(`\n✓ 结束（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  say(`日志：${path.relative(process.cwd(), logPath)}`);
  say(`下一步可看：node "${vh}" status`);
  return answer;
}

/* =================================================================== */
/* key —— 保存 OpenDesign API Key（harness 自己的模型凭证）               */
/* =================================================================== */
async function cmdKey() {
  if (has('secure')) { await import('./scripts/configure-opendesign.mjs'); return; }
  const k = args.slice(1).find(a => !a.startsWith('--')) || '';
  const { saveHarnessKey } = await import('./lib/agent.mjs');
  if (!k) {
    const { readHarnessKeyHint } = await import('./lib/agent.mjs');
    say('安全输入：node vh.mjs key --secure（macOS 本机隐藏输入，不要把 key 写进命令行或聊天）');
    say('当前：' + (readHarnessKeyHint() ? '已配置 ✓' : '未配置'));
    return;
  }
  const saved = saveHarnessKey(k);
  say(`✓ 已保存到 ${saved.target}（权限 600，只用于 harness 自带的 agent 循环）`);
  say(`指纹 ${saved.fingerprint}：工作台设置页会显示同一个指纹，可用来核对换对了。`);
  say('模型固定：opendesign / deepseek-v4.1-flash');
}

/* 整棵树的体积（用于统计释放量） */
function duOf(dir) {
  let total = 0;
  const walk = (d) => {
    let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const fp = path.join(d, it.name);
      try { if (it.isDirectory()) { if (it.name !== '.git' && it.name !== 'node_modules') walk(fp); } else total += fs.statSync(fp).size; } catch {}
    }
  };
  walk(dir);
  return total;
}

/* 目录体积（递归，跳过 .git/node_modules） */
function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name === '.git' || it.name === 'node_modules') continue;
      const fp = path.join(d, it.name);
      try {
        if (it.isDirectory()) walk(fp);
        else total += fs.statSync(fp).size;
      } catch {}
    }
  };
  walk(p);
  return total;
}

/* mp4 的 moov 是否在文件前部（可边下边播）；不在就无损重封装一次 */
async function ensureFaststart(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    // 在前 4KB 内找不到 moov，说明它在末尾（或很靠后）→ 需重封装
    if (buf.includes('moov')) return false;
    const tmp = file.replace(/\.mp4$/, '.faststart.mp4');
    const r = await productionCommand('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-c', 'copy', '-movflags', '+faststart', tmp]);
    if (r.status === 0 && fs.existsSync(tmp)) { fs.renameSync(tmp, file); return true; }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return false;
  } catch { return false; }
}


/* =================================================================== */
/* stop —— 关掉工作台服务（不记 PID 也能关：按端口找）                     */
/* =================================================================== */

/* 只取「正在监听」的进程：lsof -ti :port 会把客户端连接（浏览器）一起列出来，
   拿它当服务判据就会误报「端口仍占用」——服务其实已经关了。 */
function listenPids(port) {
  const r = spawnSync('/bin/zsh', ['-lc', `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
}
/* 连着该端口但不是服务端（通常是浏览器标签页）的进程 */
function clientPids(port) {
  const all = spawnSync('/bin/zsh', ['-lc', `lsof -ti :${port} 2>/dev/null`], { encoding: 'utf8' }).stdout || '';
  const lis = new Set(listenPids(port));
  return all.split('\n').map(s => s.trim()).filter(p => p && !lis.has(p));
}
const pidCmd = (pid) => (spawnSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).stdout || '').trim();
const isVhServer = (c) => /vh\.mjs preview|lib\/server\.mjs/.test(c);

/* 清掉 pid 已经不在的 .vh-run.json（上次进程被 kill 留下的假进度）。
   用 Node 走目录，不依赖 shell glob——zsh 下无匹配的通配符会直接报错。 */
function sweepStaleRunMarkers() {
  const projects = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (!it.isDirectory() || it.name.startsWith('.') || it.name === 'node_modules' || it.name === 'out') continue;
      const abs = path.join(d, it.name);
      if (fs.existsSync(path.join(abs, 'PROJECT.json'))) projects.push(abs); else walk(abs, depth + 1);
    }
  };
  walk(HERE, 0);
  let removed = 0;
  for (const proj of projects) {
    const rp = path.join(proj, 'out', '.vh-run.json');
    if (!fs.existsSync(rp)) continue;
    try { if (clearStoppedRun(proj)) removed++; } catch {}
  }
  return removed;
}

async function cmdStop() {
  // --all：扫一圈常用端口，把所有 vh 工作台服务都关掉
  const ports = has('all')
    ? Array.from({ length: 11 }, (_, i) => 8140 + i)
    : [parseInt(getArg('port', '8144'), 10)];

  const found = [], foreign = [];
  for (const pt of ports) {
    for (const pid of listenPids(pt)) {
      const cmd = pidCmd(pid);
      if (isVhServer(cmd)) found.push({ pid, port: pt, cmd });
      else foreign.push({ pid, port: pt, cmd });
    }
  }

  if (!found.length) {
    say(has('all') ? '✓ 没有发现任何在跑的 vh 工作台服务' : `✓ ${ports[0]} 端口没有在跑的 vh 工作台服务（已经是关着的）`);
  } else {
    say(`找到 ${found.length} 个：`);
    for (const f of found) say(`  端口 ${f.port}  PID ${f.pid}  ${f.cmd.slice(0, 60)}`);
    const ids = found.map(f => f.pid).join(' ');
    spawnSync('/bin/zsh', ['-lc', `kill ${ids} 2>/dev/null; sleep 1; kill -9 ${ids} 2>/dev/null; true`]);
    await new Promise(r2 => setTimeout(r2, 900));
  }

  // 复查：只说「还有没有在监听」；浏览器残留的连接不算没关掉
  const still = [];
  for (const pt of ports) for (const pid of listenPids(pt)) still.push({ pid, port: pt, cmd: pidCmd(pid) });
  const stillVh = still.filter(s => isVhServer(s.cmd));
  if (stillVh.length) {
    say(`⚠ 还有 ${stillVh.length} 个 vh 服务没关掉：`);
    for (const s of stillVh) say(`  端口 ${s.port}  PID ${s.pid}`);
    say(`  可手动：kill -9 ${stillVh.map(s => s.pid).join(' ')}`);
  } else if (found.length) {
    say(`✓ 已全部关闭（${found.map(f => f.port).join(', ')} 端口现在没有服务在监听）`);
  }
  for (const f of foreign) say(`  · 端口 ${f.port} 上是别的程序（PID ${f.pid}），没动它`);

  const clients = [...new Set(ports.flatMap(pt => clientPids(pt)))];
  if (clients.length) say(`  · 另有 ${clients.length} 个浏览器连接还挂在这些端口上（页面没关，不占服务）`);

  const swept = sweepStaleRunMarkers();
  if (swept) say(`  · 清掉 ${swept} 个残留的运行标记（.vh-run.json，对应进程已不存在）`);
}

/* =================================================================== */
/* clean —— 清理渲染缓存（frames 是大头；seg 影响局部重渲）               */
/* =================================================================== */
async function cmdClean() {
  const project = resolveProject(getArg('dir', ''));
  const { stripProjectCaches } = await import('./lib/disk-hygiene.mjs');
  const { freed } = stripProjectCaches(project, { only: has('all') ? ['frames', 'seg'] : ['frames'] });
  say(`✓ 已清理缓存，释放 ${(freed / 1048576).toFixed(0)}MB`);
  say(has('all')
    ? '  （frames + seg 已清；成片、静帧和过程图保留；下次修改会重建所需缓存）'
    : '  （只删了 frames，seg 保留；缺帧时下次修改可能回退整片重渲）');
}

/* =================================================================== */
/* rm —— 删项目（默认进 .vh-trash 可恢复；--purge 直接删）                 */
/* =================================================================== */
async function cmdRm() {
  const target = args.slice(1).find(a => !a.startsWith('--')) || '';
  if (!target) die('用法：node vh.mjs rm <项目目录> [--purge --yes]');
  const abs = path.resolve(target);
  if (!fs.existsSync(path.join(abs, 'PROJECT.json'))) die(`${abs} 不是视频项目（没有 PROJECT.json），拒绝删除`);
  if (has('purge') && !has('yes')) die('彻底删除会永久移除成片、脚本、素材和依据；确认范围后使用 --purge --yes，未删除任何文件');
  const { stripProjectCaches } = await import('./lib/disk-hygiene.mjs');
  // 渲染帧/TTS 缓存可由源文件重建：删除项目时先清掉，不把几 GB 搬进回收站。
  const cleaned = stripProjectCaches(abs, { keepSeg: false });
  const size = dirSize(abs);
  if (has('purge')) {
    fs.rmSync(abs, { recursive: true, force: true });
    say(`✓ 已彻底删除 ${abs}（释放 ${(size / 1048576).toFixed(0)}MB${cleaned.freed ? '，已先清可再生缓存 ' + (cleaned.freed / 1048576).toFixed(0) + 'MB' : ''}）`);
    return;
  }
  const trash = path.join(HERE, '.vh-trash', new Date().toISOString().replace(/[:.]/g, '-') + '-' + path.basename(abs));
  fs.mkdirSync(path.dirname(trash), { recursive: true });
  fs.renameSync(abs, trash);
  say(`✓ 已移入回收站：${path.relative(HERE, trash)}（${(size / 1048576).toFixed(0)}MB；成片与文稿保留）`);
  if (cleaned.freed) say(`  已清渲染帧/TTS 缓存 ${(cleaned.freed / 1048576).toFixed(0)}MB（可由源文件重建）`);
}

/* =================================================================== */
/* pack —— 打包公开交付物；公开包不等于项目备份                            */
/* =================================================================== */
async function cmdPack() {
  const project = resolveProject(getArg('dir', ''));
  const policy = workflowPolicy(project);
  if (has('reviewed') && (has('draft') || has('force'))) die('--reviewed 不能与 --draft/--force 混用；导出不等于审阅通过');
  const release = !has('force') && !has('draft') && (has('reviewed') || policy.releaseReviewRequired);
  const packTarget = has('video-only') ? 'video' : deliveryTarget(project);
  // 打包前把已登记的来源补齐，避免"文案写完却漏了参考链接"要人工发现
  if (packTarget === 'publish-package') await autoAppendReferences(project);
  const pubStatus = publishStatus(project);
  // 时长是用户硬约束，--force 也不能跳过。旧项目没有限制则保持原行为。
  if (durationLimit(project)) {
    assertDurationLimit(project, currentArtifactInputs(project).timelineDur, '交付时间轴');
    for (const name of ['video.mp4', 'video-voice.mp4']) {
      const file = path.join(project, 'out', name);
      if (fs.existsSync(file)) assertDurationLimit(project, probeDuration(file), name);
    }
  }
  // Requested copy and media integrity remain required; formal release records are opt-in.
  if (packTarget === 'publish-package' && !pubStatus.ok) {
    die('发布包不完整：' + pubStatus.errors.map(e => e.message).join('；') + '。先补文案；确实只交付视频可用 --video-only（不会携带发布文案）。--force 不跳过此检查');
  }
  for (const warning of pubStatus.warnings) if (packTarget === 'publish-package') say('⚠ ' + warning.message);
  const videoDelivery = artifactStatus(project).deliverable;
  if (videoDelivery.stale) die('不能打包未完成的视频：' + videoDelivery.reason + '。--force 不跳过媒体有效性检查');
  const name = path.basename(project);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const outDir = path.resolve(getArg('out', path.join(HERE, 'dist', `${name}-${stamp}`)));
  const { createPublicPackage } = await import('./lib/public-package.mjs');
  let result;
  try { result = createPublicPackage(project, outDir, { target: packTarget, force: has('force'), draft: has('draft'),
    release, withStills: has('with-stills') }); }
  catch (error) { die(error.message); }
  const { copied } = result;
  for (const warning of result.warnings) say('⚠ ' + warning);
  say(`✓ ${release ? '带发布审阅记录的交付包已导出' : has('force') || has('draft') ? '待审包已导出（未通过发布验收）' : '交付包已导出（人工审阅可选，未自动发布）'} → ${path.relative(process.cwd(), outDir)}（${(dirSize(outDir) / 1048576).toFixed(1)}MB）`);
  for (const c of copied) say(`   ${c.file}  ${(c.bytes / 1048576).toFixed(2)}MB  · ${c.why}`);
  say('\n公开交付包不是工程备份；如需移除项目，可用 node vh.mjs rm <项目目录> 移入回收站。');
}

/* =================================================================== */
/* prune —— 发布后清理：只留成品与内容记录，删掉一切可再生缓存             */
/* =================================================================== */
async function cmdPrune() {
  // --trash-all：彻底清空回收站（真正释放磁盘空间）。
  // 回收站里的项目是被"删除"的，恢复才有意义；确认不要时这一步才释放空间。
  if (has('trash-all')) {
    const bin = path.join(HERE, '.vh-trash');
    const { trashNames, emptyTrash } = await import('./lib/trash.mjs');
    const items = trashNames(HERE);
    if (!items.length) { say('回收站没有可见项目（隐藏与非目录文件不会清理）'); return; }
    const before = items.reduce((total, name) => total + dirSize(path.join(bin, name)), 0);
    if (!has('yes')) {
      say(`回收站有 ${items.length} 项，占用 ${(before / 1048576).toFixed(1)}MB：`);
      for (const name of items) say(`  · ${name}（${(dirSize(path.join(bin, name)) / 1048576).toFixed(1)}MB）`);
      say('\n彻底删除后不可恢复。确认请加 --yes：node vh.mjs prune --trash-all --yes');
      return;
    }
    emptyTrash(HERE, items);
    say(`✓ 已删除 ${items.length} 个回收站项目：约释放 ${(before / 1048576).toFixed(1)}MB`);
    return;
  }
  // --trash：清理回收站里项目的可再生缓存（回收项目不会再渲染，帧没有保留价值）
  if (has('trash')) {
    const { cleanTrashCaches } = await import('./lib/disk-hygiene.mjs');
    const result = cleanTrashCaches(HERE);
    if (!result.projects.length) say('回收站没有可清理的渲染缓存');
    else {
      for (const p of result.projects) say(`  ${p.name}：释放 ${(p.freed / 1048576).toFixed(0)}MB（${p.removed.join('、')}）`);
      say(`✓ 回收站缓存已清理：共释放 ${(result.freed / 1048576).toFixed(0)}MB；成片、字幕、文稿保留`);
    }
    return;
  }
  // --all：把所有项目的可再生缓存都清一遍（不用一个个进目录）
  if (has('all')) {
    const list = [];
    const walk = (d, depth) => {
      if (depth > 3) return;
      let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        if (!it.isDirectory() || it.name.startsWith('.') || it.name === 'node_modules' || it.name === 'out') continue;
        const abs = path.join(d, it.name);
        if (fs.existsSync(path.join(abs, 'PROJECT.json'))) list.push(abs); else walk(abs, depth + 1);
      }
    };
    walk(HERE, 0);
    const { stripProjectCaches } = await import('./lib/disk-hygiene.mjs');
    let cleaned = 0, skipped = 0, freed = 0;
    for (const abs of list) {
      let lock;
      try {
        lock = acquireProductionLock(abs, { command: 'prune-all' });
        freed += stripProjectCaches(abs, { keepSeg: false }).freed;
        cleaned++;
      } catch (error) { skipped++; say(`⚠ 跳过 ${path.relative(HERE, abs)}：${error.message}`); }
      finally { lock?.release(); }
    }
    say(`${skipped ? '⚠' : '✓'} 已清理 ${cleaned} 个项目，跳过 ${skipped} 个，释放 ${(freed / 1048576).toFixed(0)}MB`);
    say('  保留：成片、字幕、原始素材、备份、方案/脚本/claims/审查/发布文案');
    if (skipped) process.exitCode = 1;
    return;
  }
  const project = resolveProject(getArg('dir', ''));
  /* --dedupe：把字节完全相同的帧换成硬链接。渲染与编码无感，只是不再重复占盘。 */
  if (has('dedupe')) {
    const { dedupeFrames } = await import('./lib/frame-dedupe.mjs');
    const frames = path.join(project, 'out/frames');
    if (!fs.existsSync(frames)) { say('没有帧缓存（out/frames 不存在）'); return; }
    const result = dedupeFrames(frames, { dryRun: has('dry-run') });
    if (!result.count) { say('帧目录是空的'); return; }
    if (!result.linked) { say(`✓ 已是去重状态：${result.count} 帧，占用 ${(result.afterBytes / 1073741824).toFixed(2)}GB`); return; }
    say(`${has('dry-run') ? '预览（未改盘）' : '✓ 已去重'}：${result.count} 帧 → 唯一内容 ${result.distinct} 份`);
    say(`  相同帧 ${result.linked} 张改指向同一份；占用 ${(result.beforeBytes / 1073741824).toFixed(2)}GB → ${(result.afterBytes / 1073741824).toFixed(2)}GB（省 ${(result.savedBytes / 1073741824).toFixed(2)}GB）`);
    say('  帧仍可逐张读取、删除或重渲；硬链接不会改变任何一帧的字节');
    return;
  }
  /* --frames：只清渲染帧；保留 seg，但缺帧时不能承诺还能增量。 */
  if (has('frames')) {
    const { stripProjectCaches } = await import('./lib/disk-hygiene.mjs');
    const { freed, removed } = stripProjectCaches(project, { only: ['frames'] });
    if (!removed.length) { say('没有渲染帧缓存（out/frames 不存在）'); return; }
    say(`✓ 已清理渲染帧（${(freed / 1048576).toFixed(0)}MB）；out/seg 与成片保留，缺帧时下次修改可能回退整片重渲`);
    return;
  }
  const { stripProjectCaches } = await import('./lib/disk-hygiene.mjs');
  const { freed, removed } = stripProjectCaches(project, { keepSeg: false });
  say(`✓ 已清理 ${(freed / 1048576).toFixed(0)}MB（${removed.join('、') || '无'}）`);
  say(`  保留：成片、字幕、原始素材、备份、过程图和文稿（共约 ${(dirSize(project) / 1048576).toFixed(0)}MB）`);
}

/* =================================================================== */
/* provider —— 命令行里选模型渠道与模型（网页设置页的等价入口）            */
/* =================================================================== */
async function cmdProvider() {
  const { listProviders, setSelection, currentSelection, seedExisting } = await import('./lib/provider-settings.mjs');
  const use = getArg('use', '');
  const model = getArg('model', '');
  if (has('seed')) { seedExisting(); say('已把本机现有渠道预先保存到设置文件。'); }
  if (use) {
    const result = setSelection({ provider: use, model: model || undefined });
    say(`✓ 已选择 ${result.provider} / ${result.model}`);
    say('只影响之后启动的任务；正在跑的任务不受影响。');
    return;
  }
  const current = currentSelection();
  say('模型渠道设置（配置文件：~/.config/video-harness/providers.json）');
  say('');
  for (const p of listProviders()) {
    const mark = p.name === current.provider ? '→' : ' ';
    const key = p.hasKey ? '已配密钥（' + p.keySource + '）' : '缺密钥';
    say(`${mark} ${p.label}（${p.name}）  模型 ${p.model}  ${key}`);
    if (p.base) say(`    地址 ${p.base}`);
  }
  say('');
  say('当前：' + current.provider + ' / ' + current.model);
  say('切换：node vh.mjs provider --use <渠道> [--model <模型>]');
  say('网页设置页：http://127.0.0.1:8144/settings');
}

/* =================================================================== */
/* duration —— 查看/调整成片时长上限（由用户决定，不由模型自行放宽）        */
/* =================================================================== */
async function cmdDuration() {
  const found = findProject(getArg('dir', ''));
  if (!found) { say('✗ 找不到项目。用 --dir <目录> 指定，或在项目目录里运行。'); process.exitCode = 1; return; }
  const { durationLimit, setDurationLimit } = await import('./lib/duration-limit.mjs');
  const max = getArg('max', '');
  const target = getArg('target', '');
  const unlimited = has('unlimited');
  if (!max && !target && !unlimited) {
    const limit = durationLimit(found);
    say(`项目：${path.relative(process.cwd(), found) || found}`);
    if (!limit) say('当前不设时长硬上限，由内容决定长度。');
    else say(`当前上限：${limit.maxSeconds} 秒（${(limit.maxSeconds / 60).toFixed(1)} 分钟）；脚本目标 ${limit.targetSeconds} 秒`);
    say(`\n调整：node vh.mjs duration --max <秒> [--target <秒>]`);
    say('取消上限：node vh.mjs duration --unlimited');
    say('新建项目默认不限时长；仅在用户明确要求时设置正有限秒数，不设十五分钟天花板。');
    return;
  }
  try {
    const result = setDurationLimit(found, {
      unlimited,
      ...(max ? { maxSeconds: Number(max) } : {}),
      ...(target ? { targetSeconds: Number(target) } : {}),
    });
    say(result ? `✓ 已更新：上限 ${result.maxSeconds} 秒（${(result.maxSeconds / 60).toFixed(1)} 分钟），目标 ${result.targetSeconds} 秒` : '✓ 已取消时长硬上限：按内容需要讲完整，配音测量与质量检查保持不变');
    say('只改了允许的片长，不会自动重渲；已有成片不受影响。');
  } catch (e) {
    say('✗ ' + e.message);
    process.exitCode = 1;
  }
}

async function cmdPublishCheck() {
  const project = resolveProject(getArg('dir', ''));
  const status = publishStatus(project);
  // 参考资料只做提示，不阻断发布：题材不同，并非每条断言都要附链接。
  const { collectReferences } = await import('./lib/reference-sources.mjs');
  const { missingReferences } = await import('./lib/publish-refs.mjs');
  const sources = collectReferences(project);
  const copy = parsePublish(fs.readFileSync(path.join(project, '发布文案.md'), 'utf8'));
  const missing = copy ? missingReferences(copy.desc, sources) : sources;
  if (has('json')) say(JSON.stringify({ ...status, references: { available: sources.length, missing: missing.length } }, null, 2));
  else {
    say(status.ok ? '✓ 发布文案机械检查通过；内容与发布口径仍须人工审阅' : '✗ 发布文案未通过');
    for (const e of status.errors) say('  · ' + e.message);
    for (const w of status.warnings) say('  ⚠ ' + w.message);
    if (missing.length) say(`  ⚠ 有 ${missing.length} 条已登记的来源未出现在简介；需要时运行 vh refs --append`);
    else if (sources.length) say(`✓ 简介已包含可收集的全部 ${sources.length} 条来源链接`);
    else say('  · 没有可收集的来源（claims.json、脚本「数字与来源」、materials 检索来源、research 均无 URL 或 DOI）');
  }
  if (!status.ok) process.exitCode = 1;
}

/* refs —— 把项目里已登记的来源，追加到发布文案简介末尾。
   只排版与去重，不判断证据是否支持断言，也不核证 URL；已有同一链接不重复添加。 */
async function cmdRefs() {
  const project = resolveProject(getArg('dir', ''));
  const { collectReferences } = await import('./lib/reference-sources.mjs');
  const { referenceBlock, missingReferences, isMachineUrl } = await import('./lib/publish-refs.mjs');
  const sources = collectReferences(project);
  if (!sources.length) die('没有可公开引用的来源：claims.json、脚本「数字与来源」、materials 检索来源、research 里都没有 URL 或 DOI；未生成任何链接');
  const file = path.join(project, '发布文案.md');
  if (!fs.existsSync(file)) {
    // 没有文案时只打印，供手工粘贴，不擅自新建整份文案
    say(referenceBlock(sources));
    say('\n（还没有 发布文案.md；以上可直接粘贴到简介底部）');
    return;
  }
  const md = fs.readFileSync(file, 'utf8');
  const copy = parsePublish(md);
  const missing = missingReferences(copy?.desc || '', sources);
  if (!missing.length) { say(`✓ 简介已包含全部 ${sources.length} 条来源链接，未重复添加`); return; }
  const block = referenceBlock(missing);
  for (const u of missing.map(m => m.url)) {
    if (isMachineUrl(u)) say('  ⚠ 这条来源是接口/数据文件，读者点开看不到文章：' + u + '\n    可给该条证据加 publicUrl / publicLabel 指向给人看的页面');
  }
  if (has('print')) { say(block); return; }
  if (!has('append')) {
    say(block);
    say(`\n将追加 ${missing.length} 条到简介末尾；执行 vh refs --append --dir <项目> 写入。`);
    return;
  }
  const { writeReferences } = await import('./lib/reference-write.mjs');
  const wrote = writeReferences(project, sources);
  if (!wrote.ok) die(wrote.reason === 'no-desc-section' ? '发布文案里没有「## 简介」小节；未写入' : '未能写入发布文案');
  say(wrote.added
    ? `✓ 已把 ${wrote.added} 条来源链接追加到简介末尾（只排版，未核证链接与断言）` + (wrote.dropped ? `；${wrote.dropped} 条因字数上限未放` : '')
    : '✓ 简介已含全部来源链接，未重复添加');
  if (wrote.added) say('  ⚠ 文案已改变，发布前请重新核对并关联当前稿');
}

async function cmdDeliveryTarget() {
  const project = resolveProject(getArg('dir', ''));
  const target = getArg('target', '');
  if (target) {
    const status = taskStatus(project);
    if (status.running || status.orphanRunning) die('任务仍在执行，不能中途切换交付目标');
    setDeliveryTarget(project, target);
  }
  say(`交付目标：${deliveryTarget(project)}（video 仅视频；publish-package 视频＋发布包）`);
}

/* =================================================================== */
async function cmdContentReview() {
  const project = resolveProject(getArg('dir', ''));
  const record = getArg('record', '');
  /* Async is scheduling, not a weaker gate: the detached run calls this same
   * command, and render/voice/pack still read the same passing record. */
  if (has('async')) {
    const { asyncReviewStart, asyncReviewCommand, asyncReviewStatus, contentReviewInputs } = await import('./lib/content-review.mjs');
    if (record || has('independent')) throw new Error('--async 单独使用；它自己启动独立审稿，不与 --record/--independent 混用');
    const live = asyncReviewStatus(project);
    if (live.alive) die('已有后台审稿在进行（pid ' + live.pid + '）；等它结束或先 vh stop');
    const signature = contentReviewInputs(project).signature;
    const { cli, args } = asyncReviewCommand(project, { full: has('full'), maxOutputTokens: getArg('max-output-tokens', '') || undefined });
    const logPath = path.join(project, 'out/.vh-content-review-async.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, 'a');
    /* The detached run owns its own production lock: ownership cannot be
     * handed to a process that outlives the launcher, and a child sharing a
     * released owner would be a stranger to the lock. So the launcher must not
     * hold the lock itself — the gate skips it for --async. */
    const env = { ...process.env, VH_ASYNC_REVIEW_PROJECT: project };
    /* Inherited capability names would make the child believe it is a delegate
     * of a lock that already shut down; it must start as its own owner. */
    delete env.VH_PRODUCTION_LOCK_TOKEN; delete env.VH_PRODUCTION_LOCK_PROJECT;
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: project, detached: true, stdio: ['ignore', fd, fd], env,
    });
    fs.closeSync(fd);
    child.unref();
    productionChildren.set(child.pid, { group: true });
    asyncReviewStart(project, { signature, pid: child.pid });
    say(`后台审稿已启动（pid ${child.pid}）。这是主动请求的可选审稿；仅项目显式要求审稿时才阻塞正式制作。`);
    say('查看进度：node vh.mjs content-review · 日志：out/.vh-content-review-async.log');
    return;
  }
  if (has('async-run')) {
    /* Detached child: it owns the lock, so it takes the ordinary independent
     * path and only records its own outcome on the way out. */
    const { asyncReviewFinish } = await import('./lib/content-review.mjs');
    const { runIndependentContentReview } = await import('./lib/agent.mjs');
    const output = getArg('max-output-tokens', '');
    let status;
    try {
      status = await runIndependentContentReview(project, { log: message => console.error(message),
        ...(output ? { maxOutputTokens: Number(output) } : {}), ...(has('full') ? { full: true } : {}) });
    } catch (error) {
      asyncReviewFinish(project, { state: 'failed', error: error.message });
      throw error;
    }
    asyncReviewFinish(project, { state: status.ok ? 'passed' : 'revise' });
    console.log(JSON.stringify(status, null, 2));
    if (!status.ok) process.exitCode = 1;
    return;
  }
  if (has('independent')) {
    if (record) throw new Error('--independent 不能与 --record 同用；独立审稿不接受作者自评');
    const { runIndependentContentReview } = await import('./lib/agent.mjs');
    const output = getArg('max-output-tokens', '');
    const status = await runIndependentContentReview(project, { log: message => console.error(message),
      ...(output ? { maxOutputTokens: Number(output) } : {}), ...(has('full') ? { full: true } : {}) });
    console.log(JSON.stringify(status, null, 2));
    if (!status.ok) process.exitCode = 1;
    return;
  }
  if (record) {
    const value = JSON.parse(fs.readFileSync(path.resolve(record), 'utf8'));
    const status = recordContentReview(project, value);
    console.log(JSON.stringify(status, null, 2));
    if (!status.ok) process.exitCode = 1;
    return;
  }
  const status = contentReviewStatus(project);
  const { asyncReviewStatus } = await import('./lib/content-review.mjs');
  const asyncJob = asyncReviewStatus(project);
  console.log(JSON.stringify({ ...status, async: asyncJob.state === 'idle' ? undefined : asyncJob, input: contentReviewInputs(project) }, null, 2));
  if (has('strict') && !status.ok) process.exitCode = 1;
}

const commands = {
  'author-check': cmdAuthorCheck,
  'visual-fast': cmdVisualFast,
  'script-pacing': cmdScriptPacing,
  'script-review': cmdScriptReview,
  'content-review': cmdContentReview,
  automation: cmdAutomation, workflow: cmdWorkflow, runner: cmdRunner, schedule: cmdSchedule, quality: cmdQuality,
  plan: cmdPlan, subtitles: cmdSubtitles,
  'voice-sample': cmdVoiceSample, 'review-status': cmdReviewStatus, performance: cmdPerformance,
  'publish-check': cmdPublishCheck, 'refs': cmdRefs, 'delivery-target': cmdDeliveryTarget,
  new: cmdNew, status: cmdStatus, build: cmdBuild, measure: cmdMeasure,
  render: cmdRender, voice: cmdVoice, stills: cmdStills, contact: cmdContact, go: cmdGo, preview: cmdPreview,
  enhance: cmdEnhance, jitter: cmdJitter, key: cmdKey, clarity: cmdClarity, provider: cmdProvider, duration: cmdDuration,
  clean: cmdClean, rm: cmdRm, pack: cmdPack, prune: cmdPrune, stop: cmdStop, ask: cmdAsk, depth: cmdDepth, trim: cmdTrim, 'review-init': cmdReviewInit, theme: cmdTheme, dist: cmdDist, layout: cmdLayout, density: cmdDensity, variety: cmdVariety, screen: cmdScreen, contrast: cmdContrast, claims: cmdClaims, cover: cmdCover, compare: cmdCompare, portrait: cmdPortrait, sizes: cmdSizes, cost: cmdCost, brief: cmdBrief, scene: cmdScene, asset: cmdAsset, pick: cmdPick, subtitle: cmdSubtitle, fit: cmdFit, alive: cmdAlive, verify: cmdVerify, reflect: cmdReflect, hook: cmdHook, arc: cmdArc, loop: cmdLoop, concrete: cmdConcrete, type: cmdType, tokens: cmdTokens, rhythm: cmdRhythm, motion: cmdMotion, transition: cmdTransition, doctor: cmdDoctor, lexicon: cmdLexicon, pacing: cmdPacing, score: cmdScore, snap: cmdSnap, undo: cmdUndo, diff: cmdDiff, 'publish-done': cmdPublishDone,
};
const helpUsage = {
  'author-check': 'author-check [--kind script|clarity] [--show] [--terms "…"] [--json]  复用当前版本的完整作者检查；失败/待核不变，不调用模型，不影响出片缓存',
  'visual-fast': 'visual-fast [--strict] [--json]       每场 1 个停稳帧秒级硬伤快检（越界/压字幕/裁切/重叠/白屏）；不替代人工审片',
  'script-pacing': 'script-pacing [--strict] [--json]     纯确定性口播与场长节奏体检（开场长句/超长单场/句级锚点风险）',
  'script-review': 'script-review [--model <p/m>] [--strict] [--json]  干净上下文单轮轻量文稿审校（听得懂/因果/口径/呼应；支持 VH_REVIEW_MODEL 分层）',
  'content-review': 'content-review [--strict] [--independent [--max-output-tokens N] [--full] | --async [--full] | --record <JSON>]  用户主动选用的可选模型审稿，非默认制作步骤；--async 后台跑，--full 忽略增量；--record 仅旧契约；不是人工发布通过',
  automation: 'automation [--enable|--disable] [--max-repairs 0..5]  配置无人值守制作（不调用模型）',
  workflow: 'workflow [--profile content-first|audited] [--json]  内容优先（默认）或主动审校；不启用模型审稿',
  runner: 'runner [--set opencode|local] [--model <p/m>] [--agent <名>] [--json]  选择写稿执行器；不启动任务',
  schedule: 'schedule [--add "选题"] [--remove id] [--limit 每天支数] [--interval 分钟]\n    [--build-on|--build-off] [--build-from HH:MM] [--build-to HH:MM]\n    [--publish-on|--publish-off] [--publish-from HH:MM] [--publish-to HH:MM]\n    [--discover] [--no-discover] [--discover-query "方向"] [--discover-count 1..10] [--json]\n    选题队列；生成与发布两个定时开关默认都关。不派发、不调用模型',
  quality: 'quality [--pre-render] [--profile strict|technical] [--json]  手动检查默认 strict；制作默认仅 technical',
  new: 'new <目录> [--delivery video|publish-package] [--visual hybrid-sdf|dom] 创建项目（默认允许按场混合；不启动模型任务）',
  status: 'status [目录]                        只读查看产物与过期关口',
  plan: 'plan [--srt] [--json]                 只读执行计划、复用原因、并发与磁盘预算',
  subtitles: 'subtitles [--dir <目录>]            仅导出当前 SRT，不启动 TTS 或重混视频',
  build: 'build [--estimate] [--audit] [--dir <目录>]  构建及必要技术检查；--audit 主动追加形式诊断',
  measure: 'measure [--voice <音色>] [--speed 1] [--tts-concurrency 1..8]   实测旁白并更新 timing.json',
  'voice-sample': `voice-sample [--list] [--lines 1,4] [--voice ${DEFAULT_NARRATION.voice}] [--speed ${DEFAULT_NARRATION.speed}]  脚本级发音小样（新项目采用所选默认；旧项目沿用原参数；未试听）`,
  'review-status': 'review-status [--json]               核对当前审阅声明、证据指纹与待核事实',
  performance: 'performance [--json]                 真实CLI/模型请求/子步骤耗时；报告不运行制作或模型',
  'review-init': 'review-init [--snapshot] [--force]    建人工清单或待审 JSON 快照；不批准审阅',
  cover: 'cover [--style editorial|frame] [--at 秒] [--brand 名称]  三比例封面及320px缩略图',
  render: 'render [--scenes 1,2] [--all] [--hq] [--jobs 1..32]  安全增量；并发受 CPU/内存约束',
  voice: 'voice [--srt]                        混流旁白，可选字幕',
  go: 'go [--srt] [--dry-run]                 build → measure → render → voice；dry-run 只读计划',
  'publish-check': 'publish-check [--json]               只读检查发布文案必填项与占位符；失败退出非零',
  refs: 'refs [--append] [--print]           把 claims.json 登记的来源追加到简介底部（只排版，不核证链接）',
  'delivery-target': 'delivery-target [--target video|publish-package]  查看/保存交付目标（不调用模型）',
  pack: 'pack [--reviewed|--draft] [--with-stills] [--video-only]  默认直接导出；--reviewed 要求当前发布审阅记录',
  'publish-done': 'publish-done [--draft] [--out <新目录>]  打包并清可再生缓存；保留源稿、素材与依据',
  prune: 'prune [--frames|--dedupe [--dry-run]|--all|--trash|--trash-all --yes]  清理缓存；--dedupe 用硬链接合并相同帧；默认保留素材、备份和依据',
  rm: 'rm <项目目录> [--purge --yes]       默认移入回收站；彻底删除须显式确认',
  ask: 'ask "指令" [--unattended] [--mode article|topic|edit|edit-visual|edit-script|edit-copy]\n  ask --resume [--dir <目录>]           恢复原任务，不自动重放结果未知的工具\n  ask "新要求" --new                    明确开始新一轮（将调用模型）',
  screen: 'screen [--frames] [--review] [--strict]  图文对应体检；--review 另跑版式/对比度/分布并写入画面体检报告',
  stills: 'stills [--at 3,8]                    截取场景静帧',
  contact: 'contact [--times 1..4] [--cols 2..6] [--scenes 2,3]  批量关键帧拼图；有限采样，不代替播放/试听',
  preview: 'preview [--port 8144] [--open]        启动本地工作台，默认不打开浏览器',
  duration: 'duration [--unlimited | --max <秒> [--target <秒>]] 默认不限时长；可由用户显式设置或取消上限',
};
function cmdHelp() {
  const subject = cmd === 'help' || cmd === '--help' || cmd === '-h' ? args[1] : cmd;
  if (subject && helpUsage[subject]) {
    console.log('用法：node vh.mjs ' + helpUsage[subject] + '\n通用选项：--dir <项目目录>');
    return;
  }
  if (subject && !commands[subject]) die('未知帮助主题：' + subject);
  console.log('视频 harness · 用法：node vh.mjs <命令> [选项]\n');
  console.log(Object.values(helpUsage).map(s => '  ' + s).join('\n'));
  console.log('\n其他命令：' + Object.keys(commands).filter(c => !helpUsage[c]).join(' '));
  console.log('\n帮助：node vh.mjs help [命令] 或 node vh.mjs <命令> --help；不会执行制作或调用模型。');
}
const fn = has('help') || args.includes('-h') || cmd === 'help' ? cmdHelp : commands[cmd];
if (!fn) { console.error('未知命令：' + cmd + '\n可用：' + Object.keys(commands).join(' ')); process.exit(1); }
const writesProject = new Set(['ask', 'build', 'measure', 'voice-sample', 'render', 'voice', 'go', 'quality', 'subtitles', 'stills', 'contact', 'pack',
  'enhance', 'theme', 'clean', 'prune', 'portrait', 'cover', 'brief', 'undo', 'snap', 'review-init', 'clarity', 'compare', 'screen',
  'density', 'fit', 'alive', 'jitter', 'pacing', 'score', 'claims', 'asset', 'scene', 'publish-done', 'rm']);
const helpOnly = fn === cmdHelp;
const configuredWrite = cmd === 'content-review' && (has('record') || has('independent') || has('async')) || cmd === 'automation' && ['enable', 'disable', 'max-repairs'].some(has) || cmd === 'workflow' && has('profile') || cmd === 'duration' && ['max', 'target', 'unlimited'].some(has) || cmd === 'delivery-target' && has('target');
const commandStart = performance.now();
try {
  const existingNew = cmd === 'new' && args.slice(1).find(value => !value.startsWith('--'));
  const locksExistingNew = existingNew && fs.existsSync(path.join(path.resolve(existingNew), 'PROJECT.json'));
  if (!helpOnly && !has('dry-run') && (writesProject.has(cmd) || configuredWrite || locksExistingNew)
    && !(cmd === 'content-review' && (has('async') || has('async-run')))   // the detached reviewer takes its own lock
    && !(cmd === 'scene' && !has('append')) && !(cmd === 'prune' && (has('trash') || has('trash-all') || has('all'))) && !(cmd === 'voice-sample' && has('list'))) {
    const target = cmd === 'rm' ? args.slice(1).find(value => !value.startsWith('--')) : locksExistingNew ? existingNew : getArg('dir', '');
    const project = resolveProject(target);
    productionLock = acquireProductionLock(project, { command: cmd });
    process.once('exit', code => {
      if (cmd !== 'rm' && fs.existsSync(path.join(project, 'PROJECT.json'))) recordPerformance(project, { kind: 'command', stage: cmd, elapsedMs: performance.now() - commandStart, ok: code === 0, exitCode: code, failureCode: performanceFailure });
    });
    process.env.VH_PRODUCTION_LOCK_TOKEN = productionLock.env.VH_PRODUCTION_LOCK_TOKEN;
    process.env.VH_PRODUCTION_LOCK_PROJECT = productionLock.env.VH_PRODUCTION_LOCK_PROJECT;
    process.once('exit', () => { try { productionLock?.release(); } catch {} });
    if (cmd !== 'ask') {
      let stopping = null;
      const stop = code => {
        if (stopping) return;
        performanceFailure = 'interrupted';
        productionStopping = true;
        let timer;
        const browsers = Promise.race([closeLaunchedBrowsers(), new Promise(resolve => { timer = setTimeout(resolve, 1500); })]).finally(() => clearTimeout(timer));
        stopping = Promise.all([stopRecordedChildren([...productionChildren].map(([pid, info]) => ({ pid, group: info.group })).concat(readProductionLock(project).children || [])), browsers])
          .then(([result]) => { if (!result.stopped) console.error('⚠ 制作子进程仍待退出，保留锁登记，禁止重复制作'); })
          .catch(error => console.error('⚠ 子进程回收未确认：' + error.message))
          .finally(() => process.exit(code));
      };
      process.once('SIGINT', () => stop(130)); process.once('SIGTERM', () => stop(143));
    }
  }
  await fn();
} catch (error) {
  console.error('✗ ' + error.message); process.exitCode = 1;
} finally {
  try { productionLock?.release(); } catch (error) {
    if (!(cmd === 'rm' && productionLock && !fs.existsSync(productionLock.project))) { console.error('⚠ 制作锁未能释放：' + error.message); process.exitCode = 1; }
  }
}
