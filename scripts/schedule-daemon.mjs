#!/usr/bin/env node
/* 定时派发：到时间了就从队列里取一支还没开过工的选题，建工程，交给 vh ask 做完。
 *
 * 这一层刻意只做「什么时候派下一支」，别的都不管：
 *   - 队列里有什么、做了没做 → lib/schedule.mjs（状态从项目推导，不存副本）
 *   - 时间窗口与次数上限   → lib/timing-plan.mjs
 *   - 怎么做视频           → vh.mjs ask（内部再交给 opencode）
 *
 * 所以这里没有认领、没有结算、没有僵尸回收。那些原本只是为了维护
 * 一份「队列自己记的执行状态」，而那份副本正是所有卡死和重复劳动的来源。
 *
 * 用法：
 *   node scripts/schedule-daemon.mjs --once        跑一轮就退出（给 cron / launchd）
 *   node scripts/schedule-daemon.mjs               按 intervalMinutes 常驻
 *   node scripts/schedule-daemon.mjs --dry-run     只打印会做什么
 *   node scripts/schedule-daemon.mjs --discover    只找选题，不派发
 *   node scripts/schedule-daemon.mjs --daily       只处理工作台的定点制作，不做选题发现
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSchedule, firstUnstarted, attachProject, dispatchedToday, queuedProduction } from '../lib/schedule.mjs';
import { discoverTopics } from '../lib/discovery.mjs';
import { automaticDiscoveryReason } from '../lib/topic-memory.mjs';
import { readJob } from '../lib/discovery-job.mjs';
import { shouldBuild } from '../lib/timing-plan.mjs';
import { observeTaskCompletion } from '../lib/task-completion.mjs';
import { acquireQueueDispatch, dispatchDailyBuild, queueProductionBusy } from '../lib/daily-build.mjs';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VH = path.join(HARNESS, 'vh.mjs');
const args = process.argv.slice(2);
const has = name => args.includes('--' + name);
const arg = (name, fallback = '') => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const ROOT = has('daily') ? path.resolve(arg('root', HARNESS)) : HARNESS;

const log = message => console.log(`[${new Date().toLocaleString('zh-CN')}] ${message}`);

function run(argv, { timeout = 6 * 60 * 60 * 1000 } = {}) {
  const result = spawnSync(process.execPath, [VH, ...argv], { cwd: ROOT, encoding: 'utf8', timeout });
  return { code: result.status, out: (result.stdout || '') + (result.stderr || '') };
}

/* 判断一个项目现在什么状态。给 lib/schedule.mjs 的 inspect 用。
 * 只看两件事：任务记录的状态，以及产物齐不齐（取消时常见）。 */
function inspect(project) {
  const dir = path.join(ROOT, project);
  let task = null;
  try { task = JSON.parse(fs.readFileSync(path.join(dir, 'out/.vh-task.json'), 'utf8')); } catch { return null; }
  const delivery = observeTaskCompletion(dir, task);
  const delivered = !delivery.stale && delivery.kind !== 'response';
  return { status: task.status, delivered };
}

function dispatch(item) {
  const { name, mode, input: brief, aspectRatio, deliveryTarget } = queuedProduction(ROOT, item);
  const rel = path.join('projects', name);
  const projectDir = path.join(ROOT, rel);

  log(`建工程：${rel}`);
  const created = run(['new', rel, '--aspect', aspectRatio, '--delivery', deliveryTarget]);
  if (created.code !== 0) return { ok: false, error: '建工程失败：' + created.out.slice(-300) };

  const materials = path.join(projectDir, 'materials');
  fs.mkdirSync(materials, { recursive: true });
  /* 同一个简报文本既写进 materials/选题.md，也作为 ask 的输入。
   * 实验开关打开时两份都带原文摘录；默认关闭时与旧行为逐字一致。 */
  fs.writeFileSync(path.join(materials, mode === 'article' ? '原文.md' : '选题.md'), brief + '\n', 'utf8');

  /* 先记账再派发：即使这一轮被打断，"这一支已经开过工"也要留痕，
   * 否则下次会重复建一个同名项目再跑一遍。 */
  attachProject(ROOT, item.id, rel);

  log(`派发制作：${item.topic.slice(0, 60)}`);
  /* --unattended 不是可选项：无人值守就是这里的全部意义。
   * 不带它时自动修复读 PROJECT.json 的配置，而 CLI 新建的工程没有这一项，
   * 等于「一切顺利才自动」。 */
  const asked = run(['ask', '--input-file', path.join(projectDir, 'materials', mode === 'article' ? '原文.md' : '选题.md'), '--mode', mode, '--unattended', '--dir', rel]);
  if (asked.code !== 0) return { ok: false, project: rel, error: asked.out.slice(-400) };

  const view = inspect(rel);
  if (!view || view.status !== 'completed' || !view.delivered) {
    return { ok: false, project: rel, error: '任务未完成：' + (view?.status || '无任务记录') };
  }
  return { ok: true, project: rel };
}

/* 队列空了才找新选题。失败只记日志，不影响已有队列。 */
async function maybeDiscover(queue) {
  const config = queue.discoveryConfig || {};
  if (automaticDiscoveryReason(queue, Date.now(), readJob(ROOT))) return null;
  const untouched = queue.items.filter(item => !item.project).length;
  log(`队列只剩 ${untouched} 支没开工，开始找选题：${config.query || '默认方向'}`);
  const result = await discoverTopics(ROOT, { ...config, operation: 'questions', origin: 'automatic' });
  if (!result.ok) { log('⚠ 找选题失败：' + result.reason); return result; }
  log(`✓ 找到 ${result.results.length} 个候选，入队 ${result.added.length} 个：` + result.results.map(item => item.topic).join('；'));
  return result;
}

async function tick() {
  // dry-run 不搜索、不改状态；自动发现不依赖定时生成是否开启。
  if (!has('dry-run')) await maybeDiscover(readSchedule(ROOT));
  const queue = readSchedule(ROOT);

  /* 只有「定时生成」开着、在时段内、未到上限，才动手。默认关。 */
  const fence = shouldBuild(queue, Date.now(), { dispatchedToday: dispatchedToday(queue) });
  if (!fence.ok) {
    log(`本轮不生成（${fence.message}）`);
    return { dispatched: false, reason: fence.reason };
  }

  let item = firstUnstarted(queue);
  if (!item) {
    log('队列里没有没开过工的选题');
    return { dispatched: false, reason: 'empty' };
  }

  if (has('dry-run')) {
    log(`[dry-run] 会做：${item.topic} → projects/${queuedProduction(ROOT, item).name}`);
    return { dispatched: false, reason: 'dry-run', item };
  }

  let result, lock;
  try {
    lock = acquireQueueDispatch(ROOT);
    const latest = readSchedule(ROOT);
    const allowed = shouldBuild(latest, Date.now(), { dispatchedToday: dispatchedToday(latest), anyRunning: queueProductionBusy(ROOT, latest) });
    if (!allowed.ok) return { dispatched: false, reason: allowed.reason };
    item = allowed.item;
    result = dispatch(item);
  } catch (error) {
    if (error.code === 'PRODUCTION_LOCK_BUSY') return { dispatched: false, reason: 'busy' };
    result = { ok: false, error: error.message };
  } finally { lock?.release(); }
  log(result.ok ? `✓ 完成：${result.project}` : `✗ 未完成：${result.error}`);
  return { dispatched: true, item, result };
}

if (has('daily')) {
  const outcome = dispatchDailyBuild(ROOT, { dispatch, dryRun: has('dry-run'), isBusy: queue =>
    queueProductionBusy(ROOT, queue) });
  if (outcome.reason === 'dry-run') log(`[dry-run] 会做：${outcome.item.topic}`);
  else if (outcome.result) {
    log(outcome.result.ok ? `✓ 完成：${outcome.result.project}` : `✗ 未完成：${outcome.result.error}`);
    if (!outcome.result.ok) process.exitCode = 1;
  }
} else if (has('discover')) {
  const queue = readSchedule(ROOT);
  const result = await discoverTopics(ROOT, { ...(queue.discoveryConfig || {}), operation: 'questions' });
  console.log(result.ok
    ? `✓ 找到 ${result.results.length} 个候选（尚未入队，请在工作台选择）\n` + result.results.map(i => '  · ' + i.topic).join('\n')
    : `✗ 找选题失败：${result.reason}`);
  process.exitCode = result.ok ? 0 : 1;
} else if (has('once') || has('dry-run')) {
  await tick();
} else {
  const queue = readSchedule(ROOT);
  const minutes = Math.max(5, Number(arg('interval', queue.intervalMinutes)) || 30);
  log(`定时检查已启动：每 ${minutes} 分钟看一次（Ctrl+C 停止）`);
  await tick();
  setInterval(tick, minutes * 60 * 1000);
}
