/* 两个定时是两件事，必须分开配置：
 *
 *   生成（build）  什么时候开始做片子。默认关。
 *   发布（publish）什么时候把做好的片子发出去。默认关。
 *
 * 为什么分开：
 *   做片子要几分钟到几十分钟，还可能要重渲；发布只是一个点按钮的动作。
 *   把它们绑在一个开关上，用户想"每天 20 点发"就得连带同意"随时生成"，
 *   这不是他想表达的。反过来也一样。
 *
 * 这一层只做「现在该不该做」的判断，不启动任何东西、不调模型。
 * 时间窗口用本地时区，支持跨午夜（22:00–02:00）。
 */
import fs from 'node:fs';
import { schedulePath, writeSchedule } from './schedule.mjs';

export const DEFAULT_BUILD = Object.freeze({
  enabled: false,          // 默认不定时：用户点了才开始
  from: '09:00',
  to: '23:00',
  dailyLimit: 3,
  minGapMinutes: 120,      // 两次生成之间至少隔多久，防止一开窗就连续跑
});

export const DEFAULT_PUBLISH = Object.freeze({
  enabled: false,          // 默认不定时
  from: '20:00',
  to: '22:00',
  maxPerRun: 1,            // 每次触发最多发几支，风控按账号算，别贪多
});

/* "HH:MM" → 当天分钟数。非法值返回 null，不猜。 */
export function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/* 窗口判断。from > to 时视为跨午夜（例如 22:00–02:00）。 */
export function withinWindow(now, from, to) {
  const start = parseClock(from), end = parseClock(to);
  if (start == null || end == null) return false;
  const date = new Date(now);
  const current = date.getHours() * 60 + date.getMinutes();
  if (start === end) return true;                 // 同起止 = 全天
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;       // 跨午夜
}

function normalizeWindow(config, defaults) {
  return {
    enabled: config.enabled === true,
    from: parseClock(config.from) == null ? defaults.from : config.from,
    to: parseClock(config.to) == null ? defaults.to : config.to,
  };
}

export function buildPlan(raw = {}) {
  const base = normalizeWindow(raw, DEFAULT_BUILD);
  const limit = Number(raw.dailyLimit);
  const gap = Number(raw.minGapMinutes);
  return {
    ...base,
    ...(raw.mode === 'daily' ? { mode: 'daily' } : {}),
    dailyLimit: Number.isInteger(limit) && limit >= 1 && limit <= 20 ? limit : DEFAULT_BUILD.dailyLimit,
    minGapMinutes: Number.isInteger(gap) && gap >= 5 && gap <= 1440 ? gap : DEFAULT_BUILD.minGapMinutes,
  };
}

// 独立于发布排程的制作时点；错过不补，不因改时间在同一天重复开工。
export function dailyBuildSlot(build, now) {
  if (!build?.enabled || build.mode !== 'daily') return null;
  const date = new Date(now);
  if (date.getHours() * 60 + date.getMinutes() !== parseClock(build.from)) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function publishPlan(raw = {}) {
  const base = normalizeWindow(raw, DEFAULT_PUBLISH);
  const max = Number(raw.maxPerRun);
  return {
    ...base,
    maxPerRun: Number.isInteger(max) && max >= 1 && max <= 5 ? max : DEFAULT_PUBLISH.maxPerRun,
  };
}

/* 生成：窗口内 + 还有没开过工的选题 + 没到每日上限 + 距上次够久。
 *
 * 「有没有在做」不在这里判断——队列项不再保存执行状态，
 * 是否有任务在跑由项目本身回答。调用方用 inspect 注入。
 * dispatchedToday 同理由调用方传（它也只需要 dispatchedAt）。 */
export function shouldBuild(queue, now = Date.now(), { dispatchedToday = 0, anyRunning = false } = {}) {
  const plan = buildPlan(queue.build);
  if (!plan.enabled) return { ok: false, reason: 'disabled', message: '定时生成未开启' };
  if (plan.mode === 'daily') return { ok: false, reason: 'daily-mode', message: `每天定点制作（${plan.from}）由工作台服务负责` };
  if (!withinWindow(now, plan.from, plan.to)) {
    return { ok: false, reason: 'outside-window', message: `不在生成时段（${plan.from}–${plan.to}）` };
  }
  if (anyRunning) return { ok: false, reason: 'running', message: '已有一支在做' };
  if (dispatchedToday >= plan.dailyLimit) {
    return { ok: false, reason: 'daily-limit', message: `今日已派发 ${dispatchedToday} 支（上限 ${plan.dailyLimit}）` };
  }
  const lastDispatched = Math.max(0, ...queue.items.map(item => item.dispatchedAt || 0));
  if (lastDispatched && now - lastDispatched < plan.minGapMinutes * 60000) {
    const wait = Math.ceil((plan.minGapMinutes * 60000 - (now - lastDispatched)) / 60000);
    return { ok: false, reason: 'gap', message: `距上次派发不足 ${plan.minGapMinutes} 分钟，还需等约 ${wait} 分钟` };
  }

  const next = queue.items.find(item => !item.project);
  if (!next) return { ok: false, reason: 'empty', message: '队列里没有还没开工的选题' };
  return { ok: true, item: next, plan };
}

/* 发布：窗口内 + 有可发的成品 + 未超过本次上限 + 不在风控冷却。 */
export function shouldPublish(queue, ready, now = Date.now()) {
  const plan = publishPlan(queue.publish);
  if (!plan.enabled) return { ok: false, reason: 'disabled', message: '定时发布未开启' };
  if (!withinWindow(now, plan.from, plan.to)) {
    return { ok: false, reason: 'outside-window', message: `不在发布时段（${plan.from}–${plan.to}）` };
  }
  const day = new Date(now).toISOString().slice(0, 10);
  const publishedToday = queue.items.filter(item => item.publishedAt &&
    new Date(item.publishedAt).toISOString().slice(0, 10) === day).length;
  if (publishedToday >= plan.maxPerRun) {
    return { ok: false, reason: 'daily-limit', message: `今天已发 ${publishedToday} 支（上限 ${plan.maxPerRun}）` };
  }
  const next = ready.find(item => !item.publishedAt);
  if (!next) return { ok: false, reason: 'empty', message: '没有待发布的成品' };
  return { ok: true, item: next, plan };
}

/* 把两个开关写回 schedule.json。只动 build/publish 字段，队列内容不碰。 */
export function setPlans(root, { build, publish } = {}) {
  // 保留选题和历史字段；以原子写入替换，两个调度器不会读到半截配置。
  let data;
  try { data = JSON.parse(fs.readFileSync(schedulePath(root), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; data = { version: 2, items: [] }; }
  if (build?.mode !== undefined && !['daily', 'window'].includes(build.mode)) throw new Error('制作方式不合法');
  if (build?.mode === 'daily' && parseClock(build.from ?? data.build?.from) == null) throw new Error('请选择有效的每日制作时间');
  if (build) data.build = buildPlan({ ...(data.build || {}), ...build });
  else data.build = buildPlan(data.build);
  if (publish) data.publish = publishPlan({ ...(data.publish || {}), ...publish });
  else data.publish = publishPlan(data.publish);
  writeSchedule(root, data);
  return { build: data.build, publish: data.publish };
}

/* 给界面的一句话说明：不解释机制，只说「现在会发生什么」。 */
export function describePlans(queue, now = Date.now()) {
  const build = buildPlan(queue.build);
  const publish = publishPlan(queue.publish);
  const buildState = !build.enabled ? '关（你点「开始做」才做）'
    : build.mode === 'daily' ? `每天 ${build.from} 启动一支`
      : withinWindow(now, build.from, build.to) ? `开着，当前在时段内（${build.from}–${build.to}）` : `开着，等 ${build.from} 开始`;
  const publishState = !publish.enabled ? '关（你自己点「提交投稿」）'
    : withinWindow(now, publish.from, publish.to) ? `开着，当前在时段内（${publish.from}–${publish.to}）` : `开着，等 ${publish.from} 开始`;
  return {
    build: { ...build, state: buildState },
    publish: { ...publish, state: publishState },
  };
}
