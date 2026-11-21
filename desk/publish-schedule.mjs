/* 每日发布规则：不读文件、不启动定时器、不认识上传客户端。
 * 时点按运行服务的本地时区解释；只处理当前分钟，不追补错过的时点。 */
export function normalizeTimes(times) {
  if (!Array.isArray(times) || !times.length || times.length > 24) throw new Error('请选择 1–24 个每日发布时间');
  for (const time of times) if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('发布时间必须为 HH:MM');
  return [...new Set(times)].sort();
}

export function normalizePending(ids) {
  if (!Array.isArray(ids) || ids.length > 1000) throw new Error('待发队列须为项目列表（最多 1000 个）');
  for (const id of ids) if (typeof id !== 'string' || !id.trim() || /[/\\\x00-\x1f]/.test(id) || ['.', '..'].includes(id.trim())) throw new Error('待发项目 id 不合法');
  return [...new Set(ids.map(id => id.trim()))];
}

export function normalizeScope(scope = { kind: 'selected' }) {
  if (!scope || !['selected', 'production-queue'].includes(scope.kind)) throw new Error('请选择指定项目或制作队列作为发布范围');
  return { kind: scope.kind };
}

export function normalizePublishTrigger(trigger = { kind: 'daily' }) {
  if (trigger?.kind === 'daily') return { kind: 'daily' };
  if (trigger?.kind === 'ready' && Number.isInteger(trigger.intervalSeconds) &&
      trigger.intervalSeconds >= 30 && trigger.intervalSeconds <= 86400) {
    return { kind: 'ready', intervalSeconds: trigger.intervalSeconds };
  }
  throw new Error('请选择有效的发布方式；最短投稿间隔须为 30–86400 秒');
}

const pad = n => String(n).padStart(2, '0');
export function localDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function slotAt(now) {
  const date = new Date(now);
  return { key: `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`, start: new Date(date).setSeconds(0, 0) };
}

export function dueSlot(plan, now) {
  if (!plan.enabled || plan.lastAttempt?.state === 'running') return null;
  const slot = slotAt(now);
  if (!plan.times.includes(slot.time) || slot.start < plan.activatedAt || slot.key <= (plan.lastSlot || '')) return null;
  return slot;
}

export function nextReadyAt(plan) {
  return plan.trigger?.kind === 'ready' && plan.lastSubmittedAt > 0
    ? plan.lastSubmittedAt + plan.trigger.intervalSeconds * 1000 : null;
}

export function duePublish(plan, now) {
  if (plan.trigger?.kind !== 'ready') return dueSlot(plan, now);
  if (!plan.enabled || plan.lastAttempt?.state === 'running' || now < plan.activatedAt ||
      now < (nextReadyAt(plan) ?? 0)) return null;
  return { key: 'ready' };
}

export function upcomingSlots(plan, now, days = 7) {
  const result = [], start = new Date(now);
  for (let day = 0; day < days; day++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day);
    const slots = [];
    for (const time of plan.times) {
      const [hour, minute] = time.split(':').map(Number);
      const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
      // 跳过夏令时中不存在的本地时刻，不滚到另一个时点。
      if (at.getHours() !== hour || at.getMinutes() !== minute || +at < now || +at < (plan.activatedAt || 0)) continue;
      const key = `${localDay(date)} ${time}`;
      if (key > (plan.lastSlot || '')) slots.push(time);
    }
    result.push({ day: localDay(date), weekday: ['日', '一', '二', '三', '四', '五', '六'][date.getDay()], times: slots });
  }
  return result;
}
