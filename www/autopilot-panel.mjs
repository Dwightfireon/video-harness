/* 全自动巡航面板（低耦合独立前端组件，零侵入原有首页逻辑）。
 * 挂载于创作空间顶部，直接与 /_api/autopilot 通信；复用全局液态玻璃 CSS 变量。
 */
import { requestJSON } from '/_vh/http.mjs';

const STYLE_ID = 'vh-autopilot-style';
const CSS = `
.vh-autopilot{margin:14px 28px 6px;max-width:1000px;border-radius:18px;padding:15px 18px;
  background:var(--lg-surface,var(--panel));border:1px solid var(--lg-border,var(--line));
  box-shadow:var(--lg-rim,none),var(--lg-shadow,none);position:relative;transition:border-color .28s ease}
.vh-autopilot.is-active{border-color:color-mix(in srgb,var(--ok) 48%,var(--lg-border,var(--line)))}
.vh-autopilot.is-paused{border-color:color-mix(in srgb,var(--warn) 48%,var(--lg-border,var(--line)))}
.vh-ap-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.vh-ap-title{display:flex;align-items:center;gap:9px;font-size:14.5px;font-weight:700;color:var(--ink)}
.vh-ap-dot{width:8px;height:8px;border-radius:50%;background:var(--ink3);flex:none;transition:background .25s ease,box-shadow .25s ease}
.vh-autopilot.is-active .vh-ap-dot{background:var(--ok);box-shadow:0 0 10px color-mix(in srgb,var(--ok) 75%,transparent);animation:pulse 1.5s infinite}
.vh-autopilot.is-paused .vh-ap-dot{background:var(--warn)}
.vh-ap-badge{font-size:11px;font-weight:500;padding:2px 9px;border-radius:999px;border:1px solid var(--lg-border,var(--line));
  background:var(--lg-surface-subtle,var(--panel2));color:var(--ink2)}
.vh-autopilot.is-active .vh-ap-badge{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 36%,transparent)}
.vh-ap-spacer{flex:1}
.vh-ap-status{margin:8px 0 0;font-size:12.5px;color:var(--ink2);line-height:1.55}
.vh-ap-status strong{color:var(--ink);font-weight:600}
.vh-ap-alert{margin:8px 0 0;padding:8px 12px;border-radius:11px;font-size:12px;line-height:1.55;
  background:var(--lg-runbar-warn-bg,rgba(234,182,118,.12));border:1px solid var(--lg-runbar-warn-border,rgba(234,182,118,.32));color:var(--ink)}
.vh-ap-alert-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:7px}
.vh-ap-alert-actions .btn{font-size:11.5px;padding:4px 10px}
.vh-ap-metrics{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:11.5px;color:var(--ink3)}
.vh-ap-metrics b{color:var(--ink2);font-weight:600}
.vh-ap-settings{margin-top:10px;border-top:1px solid var(--line);padding-top:10px}
.vh-ap-settings summary{cursor:pointer;font-size:12px;color:var(--ink2);user-select:none}
.vh-ap-grid{display:grid;grid-template-columns:minmax(220px,1.6fr) repeat(3,minmax(120px,1fr));gap:10px;margin-top:10px;align-items:end}
.vh-ap-field{display:flex;flex-direction:column;gap:5px;font-size:11.5px;color:var(--ink2)}
.vh-ap-field input,.vh-ap-field select{background:var(--lg-input-bg,var(--panel2));border:1px solid var(--line);
  border-radius:9px;padding:7px 10px;color:var(--ink);font:inherit;font-size:12.5px;width:100%}
.vh-ap-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px}
@media(max-width:760px){.vh-autopilot{margin:12px 14px 4px;padding:14px}.vh-ap-grid{grid-template-columns:1fr 1fr}}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const PHASE_LABELS = {
  idle: '待命',
  discovering: '自动选题与联网调查中',
  building: '自动制作视频中',
  retrying: '自动续跑等待中',
  cooldown: '生成间隔冷却中',
  paused: '已熔断暂停',
};

function formatCountdown(targetAt) {
  const sec = Math.max(0, Math.ceil((targetAt - Date.now()) / 1000));
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)}GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(0)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

function mount() {
  const anchor = document.querySelector('.creation-intro');
  if (!anchor || document.getElementById('vhAutopilotBar')) return;
  injectStyle();

  const box = document.createElement('section');
  box.id = 'vhAutopilotBar';
  box.className = 'vh-autopilot';
  box.setAttribute('aria-label', '全自动巡航');
  box.innerHTML = `
    <div class="vh-ap-top">
      <div class="vh-ap-title">
        <span class="vh-ap-dot" aria-hidden="true"></span>
        <span>全自动巡航</span>
        <span class="vh-ap-badge" id="apBadge">已关闭</span>
      </div>
      <span class="vh-ap-spacer"></span>
      <button type="button" class="btn primary" id="apToggleBtn">开启全自动巡航</button>
    </div>
    <p class="vh-ap-status" id="apStatus">开启后将按设定方向自动离线出题、联网核查线索入队、隔 5 分钟自动制作视频，并联动发布台隔 5 分钟自动投稿 B 站（不限量，遇限流或报错立刻熔断）。</p>
    <div class="vh-ap-alert hidden" id="apAlert" role="status">
      <div id="apAlertText"></div>
      <div class="vh-ap-alert-actions hidden" id="apAlertActions">
        <button type="button" class="btn" id="apReconcileSubmitted">已在 B 站发过（解除阻断）</button>
        <button type="button" class="btn" id="apReconcileNotSubmitted">B 站未收稿（解除阻断）</button>
      </div>
    </div>
    <div class="vh-ap-metrics" id="apMetrics"></div>
    <details class="vh-ap-settings" id="apSettings">
      <summary>巡航参数设置（方向 / 间隔 / 模式）</summary>
      <div class="vh-ap-grid">
        <label class="vh-ap-field">自动选题方向
          <input type="text" id="apQuery" maxlength="1000" placeholder="例如：AI、LLM、Agent、机器学习">
        </label>
        <label class="vh-ap-field">出题模式
          <select id="apMode">
            <option value="focused">离线出题 + 自动调查</option>
            <option value="explore">拓展探索 + 自动调查</option>
            <option value="recent">近期动态（轻联网）</option>
          </select>
        </label>
        <label class="vh-ap-field">生成间隔（分钟）
          <input type="number" id="apBuildGap" min="0" max="1440" value="5">
        </label>
        <label class="vh-ap-field">投稿间隔（分钟）
          <input type="number" id="apPubGap" min="1" max="1440" value="5">
        </label>
      </div>
      <div class="vh-ap-foot">
        <label class="vh-ap-field" style="flex-direction:row;align-items:center;gap:6px">每次补题数
          <input type="number" id="apCount" min="1" max="10" value="3" style="width:68px">
        </label>
        <label class="vh-ap-field" style="flex-direction:row;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="apAutoPartition" checked style="width:auto">投递前 AI 自动选区
        </label>
        <label class="vh-ap-field" style="flex-direction:row;align-items:center;gap:6px;cursor:pointer" title="自动投稿时默认勾选 B 站「内容含营销信息」创作者声明">
          <input type="checkbox" id="apAutoPromotion" checked style="width:auto">自动标「内容含营销信息」
        </label>
        <label class="vh-ap-field" style="flex-direction:row;align-items:center;gap:6px;cursor:pointer" title="仅清理渲染帧、分段与配音等可再生缓存；成片、字幕、文稿与素材完整保留">
          <input type="checkbox" id="apAutoPrune" checked style="width:auto">发布后自动清缓存
        </label>
        <button type="button" class="btn" id="apSaveBtn">保存设置</button>
        <a class="btn" href="/publish#publishSchedule">检查 B 站投稿状态 →</a>
        <span class="format-hint" id="apSaveMsg" role="status"></span>
      </div>
    </details>
  `;
  anchor.after(box);

  const $ = id => box.querySelector('#' + id);
  let latest = null;
  let busy = false;
  let reconciling = false;
  let actionAlert = '';
  let formSeeded = false;
  let pollTimer = null;

  function readFormConfig() {
    return {
      query: $('apQuery').value.trim(),
      mode: $('apMode').value,
      count: Number($('apCount').value) || 3,
      buildGapMinutes: Math.max(0, Number($('apBuildGap').value) || 0),
      publishIntervalSeconds: Math.max(60, Math.round((Number($('apPubGap').value) || 5) * 60)),
      autoPartition: $('apAutoPartition').checked,
      autoPromotion: $('apAutoPromotion').checked,
      autoPrune: $('apAutoPrune').checked,
    };
  }

  function render(data) {
    if (!data) return;
    latest = data;
    const active = Boolean(data.active);
    const paused = !active && Boolean(data.pausedReason);
    box.classList.toggle('is-active', active);
    box.classList.toggle('is-paused', paused);

    $('apBadge').textContent = active ? (PHASE_LABELS[data.phase] || '运行中') : paused ? '已熔断暂停' : '已关闭';
    const btn = $('apToggleBtn');
    btn.disabled = busy;
    btn.className = active ? 'btn danger' : 'btn primary';
    btn.textContent = busy
      ? (active ? '正在停止…' : '正在启动…')
      : (active ? '停止全自动巡航' : '开启全自动巡航');

    const cfg = data.config || {};
    if (!formSeeded) {
      $('apQuery').value = cfg.query || 'AI、LLM、Agent、机器学习';
      $('apMode').value = cfg.mode || 'focused';
      $('apCount').value = cfg.count || 3;
      $('apBuildGap').value = cfg.buildGapMinutes ?? 5;
      $('apPubGap').value = Math.max(1, Math.round((cfg.publishIntervalSeconds || 300) / 60));
      $('apAutoPartition').checked = cfg.autoPartition !== false;
      $('apAutoPromotion').checked = cfg.autoPromotion !== false;
      $('apAutoPrune').checked = cfg.autoPrune !== false;
      formSeeded = true;
    }

    const statusEl = $('apStatus');
    if (active) {
      if (data.phase === 'discovering') {
        statusEl.innerHTML = `正在按方向「<strong>${esc(cfg.query)}</strong>」自动出题并逐条联网核查线索，合格后自动入队并开工…`;
      } else if (data.phase === 'building') {
        statusEl.innerHTML = `正在自动制作：<strong>${esc(data.currentTopic || data.currentProject || '队列项目')}</strong>（成片后将等待 ${cfg.buildGapMinutes ?? 5} 分钟再制作下一支，并由发布台自动投稿）。`;
      } else if (data.phase === 'retrying') {
        if (!data.currentProject && data.nextDiscoveryRetryAt > Date.now()) {
          statusEl.innerHTML = `本轮自动补题暂未入队，将在 <strong>${formatCountdown(data.nextDiscoveryRetryAt)}</strong> 后自动换一批重找…`;
        } else {
          const waitText = data.nextRetryAt > Date.now() ? `将在 <strong>${formatCountdown(data.nextRetryAt)}</strong> 后` : '即将';
          statusEl.innerHTML = `<strong>${esc(data.currentTopic || data.currentProject || '当前项目')}</strong> 遇到临时异常，${waitText}从断点自动续跑…`;
        }
      } else if (data.phase === 'cooldown' && data.nextBuildAt > Date.now()) {
        statusEl.innerHTML = `上一支已交付，冷却倒计时 <strong>${formatCountdown(data.nextBuildAt)}</strong> 后自动制作下一支（发布台将按 ${Math.round((cfg.publishIntervalSeconds || 300) / 60)} 分钟间隔自动投稿）。`;
      } else {
        statusEl.textContent = '全自动巡航已开启，正在检查队列与投稿状态…';
      }
    } else if (paused) {
      statusEl.textContent = '巡航已安全停止，正在制作的项目不受影响；排查下方原因后可一键重启。';
    } else {
      statusEl.textContent = `待命：方向「${cfg.query || 'AI、LLM、Agent、机器学习'}」，生成间隔 ${cfg.buildGapMinutes ?? 5} 分钟，自动投稿间隔 ${Math.round((cfg.publishIntervalSeconds || 300) / 60)} 分钟，每天不限量（遇偶发报错自动续跑，连续失败或限流自动熔断）。`;
    }

    const pub = data.publish;
    const interrupted = Boolean(pub?.lastAttempt?.state === 'running' && !pub.attemptActive);
    const interruptedHint = interrupted
      ? `上次自动投稿${pub.lastAttempt.id ? `「${pub.lastAttempt.id}」` : ''}因服务中断未完整闭合记录；若你已手动投稿或核对过 B 站稿件管理，点击下方按钮即可解除阻断。`
      : '';
    const alertEl = $('apAlert');
    const alertTextEl = $('apAlertText');
    const alertActionsEl = $('apAlertActions');
    const notice = actionAlert || data.pausedReason || data.publishNotice || data.lastWarning || interruptedHint || '';
    if (notice) {
      alertTextEl.textContent = notice;
      alertEl.classList.remove('hidden');
    } else {
      alertTextEl.textContent = '';
      alertEl.classList.add('hidden');
    }
    if (interrupted) {
      alertActionsEl.classList.remove('hidden');
      $('apReconcileSubmitted').disabled = busy || reconciling;
      $('apReconcileNotSubmitted').disabled = busy || reconciling;
    } else {
      alertActionsEl.classList.add('hidden');
    }

    const partDesc = pub?.autoPartition !== false
      ? `AI 自动选区（兜底 ${pub?.partitionLabel || '已选分区'}）`
      : (pub?.partitionLabel || '已选分区');
    const promoDesc = pub?.autoPromotion ? ' · 含营销声明' : '';
    const pubText = !pub ? '投稿状态未读取'
      : pub.lastAttempt?.state === 'running' && pub.attemptActive ? `自动投稿上传中（${pub.lastAttempt.id || '当前作品'}）`
      : interrupted ? `自动投稿待核对（上次「${pub.lastAttempt.id || '作品'}」中断未闭合）`
      : pub.enabled ? `自动投稿开启（${Math.round((pub.intervalSeconds || 300) / 60)} 分钟/支 · ${partDesc}${promoDesc}）`
      : pub.pauseReason ? `自动投稿已暂停（${pub.pauseReason}）`
      : '自动投稿未开启（开启巡航时自动联动）';
    $('apMetrics').innerHTML =
      `<span>待做队列 <b>${data.pendingCount ?? '-'}</b></span>` +
      `<span>本轮自动补题 <b>${data.discovered || 0}</b></span>` +
      `<span>本轮自动成片 <b>${data.completed || 0}</b></span>` +
      (data.skipped ? `<span>异常跳过 <b>${data.skipped}</b></span>` : '') +
      (data.prunedCount ? `<span>发布后已清缓存 <b>${data.prunedCount} 支（释放 ${formatBytes(data.prunedBytes)}）</b></span>` : '') +
      `<span>${esc(pubText)}</span>`;
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  async function refresh() {
    clearTimeout(pollTimer);
    try {
      const res = await requestJSON('/_api/autopilot', { cache: 'no-store' });
      render(res.autopilot || res);
    } catch {}
    const delay = latest?.active ? 3000 : 12000;
    pollTimer = setTimeout(() => { if (!document.hidden) void refresh(); }, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh();
  });

  async function reconcilePublishAttempt(resolution) {
    if (busy || reconciling) return;
    const itemId = latest?.publish?.lastAttempt?.id || '上一支稿件';
    const promptText = resolution === 'submitted'
      ? `确认「${itemId}」已经手动投稿或已在 B 站收到稿件？\n\n确认后将该记录标记为已提交（不再重复自动投稿），并解除排程阻断。`
      : `确认 B 站「稿件管理」中没有收到「${itemId}」？\n\n确认后将解除上次中断留下的排程阻断（若本地项目仍在队列中，后续可正常自动投稿）。`;
    if (!confirm(promptText)) return;
    reconciling = true;
    actionAlert = '';
    render(latest || {});
    try {
      let revision = latest?.publish?.revision;
      if (!Number.isInteger(revision)) {
        const cur = await requestJSON('/_api/publish/schedule', { cache: 'no-store' });
        revision = cur?.revision;
      }
      await requestJSON('/_api/publish/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reconcile', revision, resolution, confirmed: true }),
      });
      const res = await requestJSON('/_api/autopilot', {
        method: latest?.active ? 'POST' : 'GET',
        ...(latest?.active
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'config', config: readFormConfig() }) }
          : { cache: 'no-store' }),
      });
      render(res.autopilot || res);
    } catch (error) {
      actionAlert = '解除投稿阻断失败：' + error.message;
      render(latest || {});
    } finally {
      reconciling = false;
      render(latest || {});
    }
  }

  $('apReconcileSubmitted').onclick = () => { void reconcilePublishAttempt('submitted'); };
  $('apReconcileNotSubmitted').onclick = () => { void reconcilePublishAttempt('not-submitted'); };

  $('apToggleBtn').onclick = async () => {
    if (busy || reconciling) return;
    const active = Boolean(latest?.active);
    busy = true;
    actionAlert = '';
    render(latest || {});
    try {
      const body = active
        ? { action: 'stop' }
        : { action: 'start', config: readFormConfig() };
      const res = await requestJSON('/_api/autopilot', {
        method: 'POST',
        timeoutMs: 60000,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      render(res.autopilot || res);
      $('apSaveMsg').textContent = '';
    } catch (error) {
      actionAlert = (active ? '停止巡航失败：' : '启动巡航失败：') + error.message;
    } finally {
      busy = false;
      render(latest || {});
    }
  };

  $('apSaveBtn').onclick = async () => {
    $('apSaveBtn').disabled = true;
    $('apSaveMsg').textContent = '保存中…';
    actionAlert = '';
    try {
      const res = await requestJSON('/_api/autopilot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'config', config: readFormConfig() }),
      });
      render(res.autopilot || res);
      $('apSaveMsg').textContent = latest?.active ? '已保存巡航参数并同步自动投稿设置。' : '已保存巡航参数。';
    } catch (error) {
      $('apSaveMsg').textContent = '保存失败：' + error.message;
    } finally {
      $('apSaveBtn').disabled = false;
    }
  };

  void refresh();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
