/* panel.js —— 播放/预览页逻辑
 *
 * 核心机制：iframe 是 opaque sandbox，只通过受控消息驱动 renderAt(t)。
 * 不渲染 MP4 就能看：这是把「改→看」回路从分钟级降到秒级的关键。
 */
import { attachPagedInput } from './paged-input.mjs';
import { attachPreview } from './preview-controller.mjs';
import { projectProgress, stageLabel, reviewRequired } from './project-progress.mjs';
import { attachDraft } from './draft-input.mjs';
import { requestJSON } from './http.mjs';
import { visiblePolling } from './visible-polling.mjs';
import { attachProductionPanel } from './production-panel.mjs';
import { taskNotices } from './task-notices.mjs';
import { repairRecovery, resumeWithRecovery } from './repair-recovery.mjs';
import { recordChatSubmitFailure, clearChatSubmitFailure, subscribeChatSubmitFailure, renderChatSubmitFailure } from './chat-submit-errors.mjs';
import { playbackTime, playbackRate } from './playback-clock.mjs';const $ = s => document.querySelector(s);
const PROJ = new URLSearchParams(location.search).get('p') || '';
const BASE = PROJ ? '/' + PROJ : '';
const api = (u, opt) => fetch(u + (u.includes('?') ? '&' : '?') + 'p=' + encodeURIComponent(PROJ), opt);
const frame = $('#frame');
let STATE = null;          // /_api/state
let DUR = 0;               // DURATION
let SCENES = [];           // [{i,start,end,text}]
let SUBS = [];             // [{s,e,t}]
let t = 0, playing = false, speed = 1, lastTs = 0;
let rafId = null;
let overviewSig = '';
function displayState() {
  return STATE ? { ...STATE, workflow: STATE.workflow || productionPanel.getState().view?.workflow } : null;
}
function paintOverview() {
  const progress = projectProgress(displayState(), taskSnapshot || {}), signature = JSON.stringify(progress);
  if (signature === overviewSig) return;
  overviewSig = signature;
  $('#projectHeadline').textContent = progress.headline;
  const steps = $('#projectSteps'); steps.replaceChildren();
  for (const step of progress.steps) {
    const li = document.createElement('li'); li.dataset.state = step.state;
    const label = document.createElement('span'); label.textContent = step.label;
    const note = document.createElement('small'); note.textContent = step.note; li.append(label, note); steps.appendChild(li);
  }
  $('#projectNextDetail').textContent = progress.next?.detail || '';
  const next = $('#projectNext'); next.disabled = !progress.next;
  next.textContent = progress.next?.label || '下一步';
  next.onclick = () => document.querySelector(`#tabs button[data-tab="${progress.next.tab}"]`)?.click();
}

/* ---------- 顶部 chips 与标题 ---------- */
function chips(s) {
  const back = document.createElement('a'); back.href = '/'; back.title = '全部项目';
  back.style.cssText = 'color:inherit;text-decoration:none'; back.textContent = '←';
  $('#pname').replaceChildren(back, document.createTextNode(' ' + s.name));
  const c = $('#chips'); c.innerHTML = '';
  const entries = Object.entries(s.stale);
  if (!entries.length) addChip(c, 'ok', '视频产物最新');
  let n = 0;
  const staleLabels = { scene: '画面预览待更新', timing: '时间轴待实测', measure: '配音时长待实测', render: '画面成片待生成或更新',
    voice: '带声成片待生成或更新', duration: '片长需要调整', requirements: '修改要求待核验', stills: '分镜静帧待更新' };
  for (const [k, v] of entries) {
    addChip(c, k === 'timing' ? 'warn' : 'bad', staleLabels[k] || '制作检查待处理');
    c.lastElementChild.title = v;
    if (++n >= 3) break;
  }
  if (s.changedScenes && s.changedScenes.length) addChip(c, 'warn', `变化场：${s.changedScenes.join(',')}`);
  if (s.running) addChip(c, 'warn', '运行中：' + s.running.cmd);
  if (s.delivery?.publish.required && !s.delivery.publish.ok) addChip(c, 'warn', '发布文案待补齐 / 修复');
  if (s.depth) {
    const d = s.depth;
    addChip(c, d.ok ? 'ok' : 'warn',
      `深度 ${d.count} 场/${d.est}s${d.target ? '/' + d.target + 's' : ''}` + (d.ok ? '（达标）' : `（${d.hard.length} 项待补）`));
  }
}
function addChip(box, cls, text) {
  const el = document.createElement('span');
  el.className = 'chip ' + (cls || '');
  el.textContent = text; el.title = text;
  box.appendChild(el);
}

/* ---------- 项目比例：选择不等于保存，轮询不覆盖未保存的选择 ---------- */
let formatState = null, formatDirty = false, formatSaving = false, formatFetching = false;
let formatAvailable = false, formatRevision = 0;
let formatFetchError = '', formatSaveError = '', formatNotice = '';
const formatSelect = $('#projectAspectRatio'), formatSave = $('#saveAspectRatio');
const ratioLabel = ratio => ratio === '16:9' ? '16:9 横屏' : '9:16 竖屏';
function formatTaskRunning() {
  return !!(formatState?.taskRunning || taskSnapshot?.running || taskSnapshot?.orphanRunning || STATE?.running);
}
function paintFormat() {
  const running = formatTaskRunning();
  formatSelect.disabled = !formatAvailable || formatSaving || running;
  formatSave.disabled = formatSelect.disabled || !formatDirty || !formatSelect.value;
  formatSave.textContent = formatSaving ? '保存中…' : '保存比例';
  const saved = $('#formatSaved');
  if (formatState) {
    const dimensions = formatState.width > 0 && formatState.height > 0 ? `${formatState.width}×${formatState.height}` : '尺寸未知';
    saved.textContent = formatState.aspectRatio
      ? `已保存比例：${ratioLabel(formatState.aspectRatio)} · ${dimensions}`
      : `已保存比例：未设置标准比例（旧画布 ${dimensions}）`;
  } else saved.textContent = formatFetchError ? '已保存比例：暂时无法读取' : '已保存比例：读取中…';
  const messages = [];
  if (formatSaveError) messages.push(formatSaveError);
  if (formatFetchError) messages.push(formatFetchError);
  if (formatSaving) messages.push('正在保存比例，请稍候…');
  if (running) messages.push('任务运行中，暂不能修改比例；不会取消当前任务。');
  if (formatDirty) messages.push('当前选择尚未保存。');
  if (formatNotice) messages.push(formatNotice);
  if (formatState?.pendingBuild) messages.push(formatState.aspectRatio ? '⚠ 比例设置已保存，但预览尚未更新；请复查排版并手动重新生成画面、渲染整片。' : '⚠ 尚无可核验尺寸的预览；请先选择标准比例并构建画面。');
  const mismatch = formatState?.actualOrientation && formatState.actualOrientation !== formatState.orientation;
  if (mismatch) messages.push('⚠ 当前预览画布方向与已保存比例不一致，仍显示旧画布。');
  const status = $('#formatStatus');
  const text = messages.join(' ');
  if (status.textContent !== text) status.textContent = text;
  status.className = formatSaveError || formatFetchError ? 'error'
    : running || formatDirty || formatState?.pendingBuild || mismatch ? 'warn' : '';
}
async function readFormat(response) {
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`比例接口返回无效数据（HTTP ${response.status}）`); }
  if (!response.ok || result.error) throw new Error(result.error || `比例请求失败（HTTP ${response.status}）`);
  return validateFormat(result);
}
function validateFormat(result) {
  if (![null, '16:9', '9:16'].includes(result.aspectRatio) || typeof result.taskRunning !== 'boolean' || typeof result.pendingBuild !== 'boolean') {
    throw new Error('比例接口返回的数据不完整');
  }
  return result;
}
function applyFormat(result) {
  formatState = result; formatAvailable = true; formatFetchError = '';
  formatSelect.querySelector('option[value=""]').textContent = '旧画布：请选择标准比例';
  if (!formatDirty) formatSelect.value = result.aspectRatio || '';
  paintFormat();
}
async function refreshFormat() {
  if (formatFetching || formatSaving) return;
  formatFetching = true;
  const revision = formatRevision;
  try {
    const result = validateFormat(await requestJSON('/_api/format?p=' + encodeURIComponent(PROJ), { cache: 'no-store' }));
    if (revision === formatRevision) applyFormat(result);
  } catch (error) {
    if (revision === formatRevision) {
      formatAvailable = false; formatFetchError = '无法读取比例状态：' + error.message;
      paintFormat();
    }
  } finally { formatFetching = false; }
}
formatSelect.onchange = () => {
  formatDirty = formatSelect.value !== (formatState?.aspectRatio || '');
  formatSaveError = ''; formatNotice = ''; paintFormat();
};
formatSave.onclick = async () => {
  if (formatSave.disabled) return;
  const aspectRatio = formatSelect.value;
  if (!confirm(`将项目比例改为 ${ratioLabel(aspectRatio)}？\n修改后需要重新检查文字、图表和字幕排版，并重新渲染整片。已有成片不会自动更新，也不会自动启动或取消制作任务。`)) return;
  formatSaving = true; formatRevision++;
  formatSaveError = ''; formatNotice = ''; paintFormat();
  try {
    const result = await readFormat(await api('/_api/format', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ aspectRatio }),
    }));
    if (result.ok !== true || result.aspectRatio !== aspectRatio) throw new Error('服务器未确认所选比例已保存，请核对比例状态');
    formatDirty = false;
    formatNotice = '比例已保存；请复查排版并重新渲染整片。' + (result.warning ? ' ' + result.warning : '');
    applyFormat(result);
    if (!result.pendingBuild) loadFrame(t);
  } catch (error) {
    formatSaveError = '保存失败，未确认任何更改：' + error.message + '。选择已保留，没有自动重试。';
  } finally {
    formatSaving = false; paintFormat();
    formatPolling.refresh();
  }
};

/* ---------- iframe ---------- */
let stageSize = { w: 1920, h: 1080 };
const preview = attachPreview(frame, { ready(size) {
  if (size) stageSize = size;
  const { w: W, h: H } = stageSize;
  $('#frameWrap').style.aspectRatio = `${W} / ${H}`;
  $('#frameWrap').style.maxWidth = H > W ? `${60 * W / H}vh` : '';
  fitFrame();
  paintClock(); paintScript(t);
  $('#reloading').classList.add('hidden');
}, frameError(message) {
  const warning = $('#frameWarn');
  warning.classList.toggle('hidden', !message);
  warning.textContent = message ? `实时画面预览失败：${message}。如已有导出，可到「成片」查看，并核对版本。` : '';
  if (message && playing) {
    playing = false; $('#play').textContent = '▶'; audioEl?.pause();
  }
} });
function fitFrame() {
  const wrap = $('#frameWrap');
  if (!wrap || !wrap.clientWidth) return;
  const k = Math.min(wrap.clientWidth / stageSize.w, wrap.clientHeight / stageSize.h);
  frame.style.width = stageSize.w + 'px';
  frame.style.height = stageSize.h + 'px';
  frame.style.transform = `translate(-50%, -50%) scale(${k})`;
}
window.addEventListener('resize', fitFrame);
window.addEventListener('DOMContentLoaded', fitFrame);
/* 顶部显示当前 provider / 模型，并给出设置页入口。 */
async function showModelChip() {
  try {
    const s = await (await api('/_api/agent-ready')).json();
    if (s.execution) {
      $('#modelLink').textContent = '下次：' + s.execution.model;
      $('#modelLink').title = '执行器：' + s.execution.runner + '；模型来源：' + s.execution.modelSource + '；仅检查配置/程序，不代表连通或余额正常';
    } else if (s.current) $('#modelLink').textContent = '下次：' + s.current.provider + ' / ' + s.current.model;
  } catch {}
}
showModelChip();
function loadFrame(keepT = 0) {
  $('#reloading').classList.remove('hidden');
  playing = false; $('#play').textContent = '▶';
  if (audioEl) audioEl.pause();
  t = Math.max(0, keepT);
  preview.load(BASE + '/scene.html?v=' + Date.now(), t);
}

/* ---------- 播放循环 ---------- */
let audioEl = null;
let audioFailed = false, pendingSeek = null, audioPlayPending = false;
let audioDur = null;
/* 预览页把 scene.html（当前时间轴）和 out/narration.m4a（上一次配音）拼在一起播。
 * 两者不是同一版时，中段之后会静默声画不同步 —— 旧实现对此毫无提示。 */
function audioMatchesTimeline() {
  if (!Number.isFinite(audioDur) || !Number.isFinite(DUR) || !DUR) return true;
  return Math.abs(audioDur - DUR) <= 0.5;
}
function warnAudioMismatch() {
  const el = $('#audioWarn');
  if (!el) return;
  if (audioFailed || !Number.isFinite(audioDur) || audioMatchesTimeline()) { el.classList.add('hidden'); return; }
  el.textContent = `⚠ 预览旁白与当前时间轴不是同一版（旁白 ${audioDur.toFixed(1)}s / 画面 ${DUR.toFixed(1)}s），`
    + '中段之后会声画不同步。这是预览用的旧音轨；成片需按当前脚本重新渲染与配音。';
  el.classList.remove('hidden');
}
function ensureAudio() {
  if (audioEl || audioFailed) return audioEl;
  audioEl = new Audio(BASE + '/out/narration.m4a?v=' + Date.now());
  const a = audioEl;
  audioEl.preload = 'auto';
  audioEl.addEventListener('loadedmetadata', () => {
    audioDur = Number.isFinite(a.duration) ? a.duration : null;
    warnAudioMismatch();
    if (audioEl !== a || pendingSeek == null) return;
    a.currentTime = Math.min(pendingSeek, Math.max(0, a.duration)); pendingSeek = null;
  });
  audioEl.addEventListener('error', () => {
    if (audioEl !== a) return;
    audioFailed = true; audioEl = null; $('#mute').style.display = 'none';
  });
  return audioEl;
}
function syncAudio(tt, { seek = false } = {}) {
  const a = audioEl;
  if (!a) return;
  a.playbackRate = playbackRate(speed);
  if (seek) {
    pendingSeek = tt;
    if (Number.isFinite(a.duration)) {
      try { a.currentTime = Math.min(tt, Math.max(0, a.duration)); pendingSeek = null; } catch {}
    }
  }
  if (playing && !(Number.isFinite(a.duration) && tt >= a.duration)) {
    if (a.paused && !audioPlayPending) {
      audioPlayPending = true;
      a.play().catch(() => {
        if (audioEl !== a || !playing) return;
        playing = false; $('#play').textContent = '▶';
        $('#play').title = '音频未能播放，请点击重试；画面未继续抢跑';
      }).finally(() => { audioPlayPending = false; });
    }
  }
  else if (!a.paused) a.pause();
}
function tick(ts) {
  const dt = Math.max(0, (ts - lastTs) / 1000) * speed;
  lastTs = ts;
  if (playing) {
    t = playbackTime(t, dt, DUR, audioEl);
    preview.render(t);
    // 不能用 rAF 的时间反过来反复 seek 音频；媒体时钟就是画面时间。
    paintClock(); paintScript(t);
    if (t >= DUR) { playing = false; $('#play').textContent = '▶'; syncAudio(t); }
    scrubTo(t);
  }
  rafId = requestAnimationFrame(tick);
}
function scrubTo(tt) {
  const v = DUR ? tt / DUR * 1000 : 0;
  if (document.activeElement !== $('#scrub')) $('#scrub').value = v;
}
function paintClock() {
  $('#tclock').textContent = t.toFixed(2) + ' / ' + (DUR ? DUR.toFixed(2) : '--');
}

/* ---------- 场次章节 ---------- */
function renderChapters() {
  const box = $('#chapters'); box.innerHTML = '';
  for (const sc of SCENES) {
    const el = document.createElement('button');
    el.className = 'chapt'; el.dataset.i = sc.i;
    el.textContent = `S${sc.i}`;
    el.title = `${sc.start.toFixed(1)}s–${sc.end.toFixed(1)}s  ${sc.text.slice(0, 30)}`;
    el.onclick = () => seek(sc.start + 0.02);
    box.appendChild(el);
  }
}
function paintChapter(t) {
  const cur = SCENES.find(sc => t >= sc.start - 0.4 && t < sc.end + 0.4);
  document.querySelectorAll('.chapt').forEach(el => {
    el.classList.toggle('on', cur && +el.dataset.i === cur.i);
  });
}

/* ---------- 脚本对照 ---------- */
function buildScript() {
  // 把 SUBS 的句子按场次分桶（场次由 addScene 区间定）
  const box = $('#script'); box.innerHTML = '';
  const byScene = SCENES.map(sc => []);
  for (const sub of SUBS) {
    const sc = SCENES.find(sc => sub.s >= sc.start - 0.01 && sub.s < sc.end) || {};
    const idx = sc.i ? sc.i - 1 : byScene.length - 1;
    if (idx >= 0) byScene[idx].push(sub);
  }
  SCENES.forEach((sc, i) => {
    const sec = document.createElement('div'); sec.className = 'sec'; sec.id = 'sec' + sc.i;
    const h = document.createElement('h3');
    h.innerHTML = `<span>第 ${sc.i} 场</span><span class="t">${sc.start.toFixed(1)}–${sc.end.toFixed(1)}s · 多 ${(sc.end - sc.start).toFixed(1)}s</span>`;
    sec.appendChild(h);
    if (!byScene[i].length) sec.innerHTML += '<div class="hint">（该场没有旁白句）</div>';
    byScene[i].forEach(sub => {
      const row = document.createElement('div'); row.className = 'line'; row.dataset.s = sub.s; row.dataset.e = sub.e;
      row.innerHTML = `<span class="no">·</span><span class="tt">${esc(sub.t)}</span><span class="cell">${sub.s.toFixed(1)}s</span>`;
      row.onclick = () => seek(sub.s);
      sec.appendChild(row);
    });
    box.appendChild(sec);
  });
}
function paintScript(t) {
  const rows = document.querySelectorAll('#script .line');
  let hit = null;
  rows.forEach(r => {
    const on = t >= +r.dataset.s && t < +r.dataset.e;
    r.classList.toggle('now', on);
    if (on) hit = r;
  });
  if (hit) {
    const box = $('#script');
    const y = hit.offsetTop - box.clientHeight / 2 + hit.clientHeight / 2;
    if (Math.abs(box.scrollTop - y) > 60) box.scrollTo({ top: y, behavior: 'smooth' });
  }
  paintChapter(t);
}

/* ---------- 分镜 ---------- */
let stillsVersion = 0;
function buildBoard() {
  const box = $('#board');
  if (!SCENES.length) { box.innerHTML = '<div class="hint">没有场次。</div>'; return; }
  box.innerHTML = '<div class="hint">点静帧跳到该场中点。灰色 = 静帧没截（顶部「重截静帧」）。</div>';
  const grid = document.createElement('div'); grid.className = 'board-grid';
  const changed = new Set(STATE.changedScenes || []);
  for (const sc of SCENES) {
    const card = document.createElement('div'); card.className = 'card';
    const img = sc.stillReady
      ? `<img loading="lazy" src="${BASE}${sc.still}?v=${STATE.stillsCount}-${stillsVersion}" onerror="this.style.opacity=.15">`
      : `<div style="aspect-ratio:16/9;background:#222;display:flex;align-items:center;justify-content:center;color:#555">未截</div>`;
    card.innerHTML = img + `<div class="meta"><b>S${sc.i}</b>${(changed.has(String(sc.i)) || changed.has(sc.i)) ? '<span class="chg">变了</span> ' : ''}${sc.start.toFixed(1)}–${sc.end.toFixed(1)}s<br>${esc(sc.text.slice(0, 40))}</div>`;
    card.onclick = () => seek((sc.start + sc.end) / 2);
    grid.appendChild(card);
  }
  box.appendChild(grid);
}

/* ---------- 成片 ---------- */
function buildVideo() {
  const box = $('#video');
  if (!STATE.videos.length) { box.innerHTML = '<div class="hint">还没有成片。跑 <code>node vh.mjs go</code>。</div>'; return; }
  box.innerHTML = '';
  const list = [...STATE.videos].sort((a, b) => (b.file.includes('voice') ? 1 : 0) - (a.file.includes('voice') ? 1 : 0));
  for (const v of list) {
    const withVoice = v.file.includes('voice');
    const wrap = document.createElement('div'); wrap.className = 'vitem';
    wrap.innerHTML =
      `<div class="cap" style="font-size:13px;color:${withVoice ? 'var(--ok)' : 'var(--ink2)'}">` +
      (withVoice ? '🔊 带配音（推荐听这个）' : '🔇 无声（仅画面）') + `　·　${v.file}</div>` +
      `<video controls preload="metadata" src="${BASE}/out/${encodeURIComponent(v.file)}"></video>` +
      `<div class="cap">${(v.size / 1048576).toFixed(1)}MB · ${new Date(v.mtime).toLocaleString('zh-CN')} · ` +
      `<a href="${BASE}/out/${encodeURIComponent(v.file)}" download>下载</a>` +
      (withVoice ? '' : '　<span style="color:var(--ink3)">（这是渲染母版，配音在另一个文件里）</span>') + `</div>`;
    box.appendChild(wrap);
  }
}

/* ---------- 交互 ---------- */
function seek(tt) {
  t = Math.max(0, Math.min(DUR || tt, tt));
  preview.render(t);
  try { ensureAudio(); } catch {}
  syncAudio(t, { seek: true });
  paintClock(); paintScript(t); scrubTo(t);
}
$('#play').onclick = () => togglePlay();
function togglePlay() {
  if (!DUR) return;
  playing = !playing;
  $('#play').textContent = playing ? '⏸' : '▶';
  lastTs = performance.now();
  if (t >= DUR) { seek(0); }
  try { ensureAudio(); } catch {}
  syncAudio(t, { seek: true });
}
$('#mute').onclick = () => {
  const a = ensureAudio();
  if (!a) return;
  a.muted = !a.muted;
  $('#mute').textContent = a.muted ? '🔇' : '🔊';
};
$('#scrub').oninput = e => { seek(+e.target.value / 1000 * DUR); };
$('#speed').onchange = e => {
  speed = playbackRate(e.target.value); e.target.value = String(speed);
  syncAudio(t);
};
$('#reload').onclick = () => loadFrame(t);
$('#reStills').onclick = async e => {
  e.target.disabled = true; e.target.textContent = '截帧中…';
  $('#stillsStatus').textContent = '正在启动静帧命令…';
  let launchError = '';
  try { await requestJSON('/_api/stills?p=' + encodeURIComponent(PROJ), { method: 'POST' }); }
  catch (error) { launchError = error.message; $('#stillsStatus').textContent = '启动状态未确认：' + launchError; }
  // Even a timed-out POST may have started. Observe status rather than submit twice.
  void followStills(e.target, launchError);
};
async function followStills(button, launchError = '') {
  try {
    const status = await requestJSON('/_api/stills?p=' + encodeURIComponent(PROJ), { cache: 'no-store' });
    if (status.state === 'running') {
      $('#stillsStatus').textContent = '正在重截静帧…';
      setTimeout(() => void followStills(button, launchError), 1500); return;
    }
    button.disabled = false; button.textContent = '重截静帧';
    // A failed/timed-out POST could leave a previous completed entry visible.
    // Without a request identity, never present that older entry as this click's success.
    if (launchError && ['completed', 'failed'].includes(status.state)) {
      $('#stillsStatus').textContent = '本次提交未确认：' + launchError + '；后台最近一次静帧命令已结束，无法确认是否为本次。';
    } else if (status.state === 'completed') {
      $('#stillsStatus').textContent = '静帧生成完成；仍需逐张核对。';
      stillsVersion++; if (STATE) buildBoard();
    } else if (status.state === 'failed') $('#stillsStatus').textContent = '静帧失败：' + (status.message || '请查看制作状态');
    else $('#stillsStatus').textContent = launchError ? '未发现运行中的静帧命令。提交结果：' + launchError : '未发现运行中的静帧命令；可重新尝试。';
  } catch (error) {
    $('#stillsStatus').textContent = '无法确认静帧状态：' + error.message + '；正在重试，不会重复启动。';
    setTimeout(() => void followStills(button, launchError), 2000);
  }
}

document.addEventListener('keydown', e => {
  // ⚠ 输入类元素里绝不能抢键：曾经只放过 INPUT，导致聊天框（textarea）打不出空格
  const tag = e.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
  if (tag === 'INPUT' && e.target.type !== 'range') return;
  if (tag === 'VIDEO' || tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') seek(t - (e.shiftKey ? 5 : 1));
  else if (e.key === 'ArrowRight') seek(t + (e.shiftKey ? 5 : 1));
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const idx = SCENES.findIndex(sc => t >= sc.start - 0.4 && t < sc.end + 0.4);
    const next = SCENES[Math.max(0, (idx >= 0 ? idx : 0) + (e.key === 'ArrowDown' ? 1 : -1))];
    if (next) seek(next.start + 0.02);
  }
});


/* ---------- 发布（发布文案.md） ---------- */
let publishBusy = false, publishNotice = '', publishTargetDraft = null;
function publishControls(box) {
  const delivery = STATE?.delivery;
  if (!delivery) return;
  const running = !!(taskSnapshot?.running || taskSnapshot?.orphanRunning || STATE?.running);
  const summary = document.createElement('div');
  summary.id = 'publishStatus'; summary.className = 'publish-status'; summary.setAttribute('role', 'status');
  const video = delivery.video.state === 'checked' ? '机械检查通过' : delivery.video.state === 'missing' ? '尚未交付' : '需要更新';
  const pub = delivery.publish;
  const requiredReview = reviewRequired(displayState());
  const quality = productionPanel.getState().view?.quality;
  summary.textContent = `视频：${video}\n发布文案：${pub.ok ? '机械检查通过' : pub.state === 'missing' ? '尚未生成' : '待修复'}\n` +
    (pub.revision ? '文案版本：' + ({ current: '已关联当前稿', stale: '仍关联旧稿', edited: '有手动修改，待重新关联', untracked: '历史文案，尚未关联', missing: '尚未生成' }[pub.revision.state] || '未知') + '\n' : '') +
    `人工审阅${requiredReview ? '（必需）' : '（可选）'}：${delivery.review.state === 'recorded' ? '已登记（非程序质量保证）' : requiredReview ? '待完成' : '未验证，不阻塞普通交付'}\n` +
    (quality ? `质量范围：${quality.profileLabel || (quality.profile === 'technical' ? '技术检查' : '严格检查')}\n` : '') +
    (quality?.optionalChecks?.filter(check => !check.required && check.state === 'not-run').length
      ? '可选视觉检查：未运行，不标通过；不阻塞普通交付。\n' : '') +
    (delivery.target === 'video' ? '交付目标为仅视频；文案不阻塞视频交付。' :
      delivery.video.state !== 'checked' || !pub.ok ? '发布包尚未齐备。' : requiredReview ? '发布包机械检查通过；发布验收仍要求当前人工审阅记录。' : '视频与发布文案已就绪，可用 vh pack 导出；导出不代表人工审阅通过或发布授权。');
  box.appendChild(summary);
  if (delivery.video.reason) box.appendChild(block('视频状态说明', delivery.video.reason));
  if (pub.errors.length || pub.warnings.length) {
    const issues = block('发布检查', pub.errors.map(e => '✗ ' + e.message).concat(pub.warnings.map(w => '⚠ ' + w.message)).join('\n'));
    issues.id = 'publishIssues'; box.appendChild(issues);
  }
  const controls = document.createElement('div'); controls.className = 'publish-actions';
  const label = document.createElement('label'); label.textContent = '交付目标 ';
  const select = document.createElement('select'); select.id = 'deliveryTarget';
  for (const [value, text] of [['publish-package', '视频＋发布包'], ['video', '仅视频']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; select.appendChild(option);
  }
  select.value = publishTargetDraft || delivery.target; select.disabled = publishBusy || running;
  select.onchange = () => { publishTargetDraft = select.value; save.disabled = publishBusy || running || select.value === delivery.target; };
  label.appendChild(select);
  const save = document.createElement('button'); save.id = 'saveDeliveryTarget'; save.textContent = '保存目标';
  save.disabled = publishBusy || running || select.value === delivery.target;
  save.onclick = async () => {
    publishBusy = true; publishNotice = '正在保存目标…'; buildPublish();
    try {
      const response = await api('/_api/publish/target', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: publishTargetDraft }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '服务器未确认保存');
      STATE.delivery.target = result.target; STATE.delivery.publish = result.publish; publishTargetDraft = null;
      publishNotice = '交付目标已保存；没有启动模型或重做视频。';
    } catch (e) { publishNotice = '保存失败：' + e.message + '。未自动重试。'; }
    finally { publishBusy = false; buildPublish(); }
  };
  const generate = document.createElement('button'); generate.id = 'generatePublish';
  const resumeCopy = taskSnapshot?.canResume && taskSnapshot?.mode === 'edit-copy';
  generate.textContent = resumeCopy ? '继续文案任务（不重做视频）' : !STATE.publish ? '生成发布文案' : '修复 / 补齐文案';
  generate.disabled = publishBusy || running || !STATE.script?.length;
  generate.onclick = async () => {
    if (!confirm('使用当前配置的模型生成或修复发布文案，可能消耗模型额度。只修改发布文案，不重新渲染或配音；不会自动勾选人工审查。')) return;
    const confirmNew = !!(taskSnapshot?.canResume && taskSnapshot.mode !== 'edit-copy');
    if (confirmNew && !confirm('当前还有未完成的制作任务。单独生成文案会归档原任务并另开文案任务；原文件和检查点保留，但不会继续原视频制作。是否继续？')) return;
    publishBusy = true; publishNotice = '正在提交文案任务…'; buildPublish();
    try {
      const response = await api('/_api/publish/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmNew }) });
      const result = await response.json();
      if (!response.ok || !result.started) throw new Error(result.error || '文案任务未能启动');
      taskSnapshot = result.task; refreshTaskComposer(); paintFormat();
      publishNotice = '文案任务已提交，可在「修改」中查看进度。视频保持不变。';
    } catch (e) { publishNotice = '提交失败：' + e.message + '。已有文件保留，没有自动重试。'; }
    finally { publishBusy = false; buildPublish(); }
  };
  controls.append(label, save, generate); box.appendChild(controls);
  if (pub.revision && pub.revision.state !== 'current' && STATE.publish) {
    const confirmVersion = document.createElement('button'); confirmVersion.id = 'confirmPublishVersion';
    confirmVersion.textContent = '已核对文案，关联当前稿（不改内容）';
    confirmVersion.disabled = publishBusy || running || pub.errors.some(e => e.code !== 'stale');
    confirmVersion.onclick = async () => {
      if (!confirm('请确认已核对当前脚本与文案，尤其是网址、优惠码和推广口径。此操作只关联版本，不修改文案、不重做视频，也不代表已审阅成片。')) return;
      const revision = pub.revision;
      publishBusy = true; publishNotice = '正在关联版本…'; buildPublish();
      try {
        const response = await api('/_api/publish/confirm', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmed: true, sourceSignature: revision.sourceSignature, publishHash: revision.publishHash }) });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || '版本未关联');
        STATE.delivery.publish = result.publish; publishNotice = '文案已关联当前稿；原内容保留，仍须人工审阅成片。'; paintOverview();
      } catch (e) { publishNotice = '关联失败：' + e.message + '。未自动重试。'; }
      finally { publishBusy = false; buildPublish(); }
    };
    box.appendChild(confirmVersion);
  }
  const notice = document.createElement('div'); notice.id = 'publishNotice'; notice.className = 'hint'; notice.setAttribute('role', 'status');
  notice.textContent = running ? '任务运行中，暂不能另开文案任务或切换目标。' : publishNotice || '生成只使用已有脚本和明确提供的信息；缺少真实推广信息时不会编造。';
  box.appendChild(notice);
  if (taskSnapshot?.mode === 'edit-copy' && (taskSnapshot.error || taskSnapshot.canResume)) {
    box.appendChild(block('文案任务待继续', taskSnapshot.error?.message || taskSnapshot.resumeNotice));
  }
}
function copyBtn(text, label) {
  const b = document.createElement('button');
  b.textContent = label || '复制';
  b.style.cssText = 'font-size:11px;padding:3px 10px;margin-left:8px';
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(text || ''); b.textContent = '已复制 ✓'; }
    catch { b.textContent = '复制失败，请手动选择内容'; }
    setTimeout(() => b.textContent = label || '复制', 2000);
  };
  return b;
}
function block(title, text, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'pblock';
  const h = document.createElement('div');
  h.className = 'phead';
  h.innerHTML = '<span>' + title + '</span>';
  if (text) h.appendChild(copyBtn(text));
  const body = document.createElement('div');
  body.className = 'pbody' + (opts.mono ? ' mono' : '');
  body.textContent = text || '（还没写）';
  wrap.append(h, body);
  return wrap;
}
function buildPublish() {
  const box = $('#publish');
  const p = STATE && STATE.publish;
  box.innerHTML = '';
  publishControls(box);
  /* 「发布」标签在这一页只管发布文案（标题/简介/标签）。真正的投稿在 /publish：
   * 需要本机登录态与分块上传，不适合塞进这个面板，所以这里给一个明确入口，
   * 避免用户以为工作台里能直接发。 */
  const publishLink = document.createElement('a');
  publishLink.className = 'btnmini';
  publishLink.href = '/publish';
  publishLink.textContent = '去发布台投稿 →';
  publishLink.title = '选分区、核对预览、提交 B 站；批量发布也在那一页';
  const linkRow = document.createElement('div');
  linkRow.className = 'ptools';
  linkRow.style.marginBottom = '10px';
  linkRow.appendChild(publishLink);
  box.appendChild(linkRow);
  if (!p) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '还没有发布文案。可用上方按钮单独生成；保存后自动刷新，不需要重做视频。';
    box.appendChild(hint);
    return;
  }
  const tools = document.createElement('div');
  tools.className = 'ptools';
  const openBtn = document.createElement('a');
  openBtn.textContent = '打开 发布文案.md（源文件）';
  openBtn.href = BASE + '/发布文案.md';
  openBtn.target = '_blank';
  openBtn.className = 'btnmini';
  const allBtn = copyBtn([p.main && ('标题：' + p.main), p.alts && p.alts.length ? ('备选标题：' + p.alts.join(' / ')) : '',
    p.tags && p.tags.length ? ('标签：' + p.tags.join(' ')) : '',
    p.desc && ('简介：\n' + p.desc), p.comment && ('置顶评论：\n' + p.comment), p.cover && ('封面：\n' + p.cover)]
    .filter(Boolean).join('\n\n'), STATE.delivery?.publish.ok ? '复制全部' : '复制全部（草稿）');
  tools.append(openBtn, allBtn);
  box.appendChild(tools);
  box.appendChild(block('标题（主）', p.main));
  if (p.alts && p.alts.length) box.appendChild(block('备选标题', p.alts.join('\n')));
  if (p.tags && p.tags.length) box.appendChild(block('标签（B站/小红书，可整行粘贴）', p.tags.join(' ')));
  else box.appendChild(block('标签', ''));
  box.appendChild(block('简介', p.desc));
  if (p.comment) box.appendChild(block('置顶评论', p.comment));
  if (p.cover) box.appendChild(block('封面文案', p.cover));
  if (p.checklist) box.appendChild(block('发布前检查清单', p.checklist, { mono: true }));
  // 内容深度体检（来自 vh depth）
  const d = STATE && STATE.depth;
  if (d) {
    const txt = [`${d.count} 场 · 估算 ${d.est}s` + (d.target ? ` · 目标 ${d.target}s` : '') + (d.ok ? ' · ✓ 展开度达标' : '')]
      .concat(d.hard.map(h => '⚠ ' + h))
      .concat(d.thin.map(t => `第 ${t.n} 场「${t.title}」：\n  - ` + t.issues.join('\n  - ')))
      .join('\n');
    box.appendChild(block('内容深度体检（vh depth）', txt, { mono: true }));
  }
}

/* ---------- 指挥（聊天/生成入口） ---------- */
const MODES = {
  article: {
    hint: '粘贴文章、给 URL 或选本地文件，直接生成。默认自动推进、质检和有限修复，无需命令行启用；不自动发布。',
    ph: '粘贴文章正文，或填 URL。例：把这篇《为什么截断中文会坏字》做成 3 分钟讲解片，发 B 站，横屏。',
    quick: ['用我给的文章做一支 2–3 分钟讲解片', '这篇文章太长，先帮我缩到 90 秒的版本', '这篇是英文，做中文版'],
    btn: '生成 →',
  },
  topic: {
    hint: '给选题后直接调研、成文、出片，默认自动质检和有限修复。来源须可查，区分事实与推论；不自动发布。',
    ph: '例：讲讲「本地大模型为什么突然好用了」，面向没接触过的人，6 分钟，横屏。',
    quick: ['做个选题：为什么（某现象）今年突然流行起来', '面向零基础，讲清楚（某概念）到底是什么', '对比（A）和（B），说清该怎么选'],
    btn: '调研并生成 →',
  },
  edit: {
    hint: '输入改片要求，默认自动完成必要制作、质检和有限修复。只读审阅不改稿，单独改文案不重做视频。',
    ph: '例：第 2 场太慢，压到 6 秒；第 3 场的标题换成「不渲染的审片室」，然后重出。',
    quick: ['把开场改得更具体：先给一个真遇到的场景', '第 2 场的例子换成十进制，画面跟着改', '全片再打磨一版节奏：收口留 0.7–1.0s，然后重出'],
    btn: '开始修改 ↗',
  },
};
let curMode = 'article';
let taskSnapshot = null, newTaskIntent = false, lastModeTask = undefined, chatResumePending = false;
let chatResumeError = '', chatResumeErrorTask = null;
const productionPanel = attachProductionPanel($('#productionPanel'), { project: PROJ,
  onTask(task) { taskSnapshot = task; newTaskIntent = false; paintTaskNotices(task); refreshTaskComposer(); paintFormat(); },
});
/* 大文本输入：全文 > 4000 字时自动分页，textarea 只渲染当前页。
   否则每敲一个字都要重排全部内容（60k 字 / 4000 行实测每次按键 ~39ms）。 */
let chatDraft = null;
const chatInput = attachPagedInput($('#chatInput'), { pagerHost: $('#chatPagerHost'), onChange: () => chatDraft?.schedule() });
function refreshTaskComposer() {
  productionPanel.setTaskSnapshot(taskSnapshot);
  const done = taskSnapshot?.status === 'completed';
  const recovery = repairRecovery(taskSnapshot || {});
  const continuing = (!!taskSnapshot?.canResume || recovery.blocked) && !newTaskIntent && !done;
  /* 已完成任务：允许在现有项目上继续改（例如"片尾加一段广告"）。
   * 旧逻辑完成后按钮没有任何意义，用户输入指令点了没反应，像坏了一样。 */
  $('#chatSend').textContent = taskSnapshot?.running ? '补充指令 →'
    : continuing ? recovery.blocked ? recovery.label : '继续原任务 →'
      : done ? '开始修改 ↗' : MODES[curMode].btn;
  $('#chatInput').placeholder = taskSnapshot?.running ? '补充当前任务，下一步接收，不会重开任务。'
    : continuing ? recovery.blocked ? '预算已耗尽。追加修复须确认费用；现有输入会保留，不会自动提交。'
      : '可留空直接继续，也可补充要求。沿用原任务目标和模式，不新建项目。'
      : done ? '例如：在片尾加一段 15 秒广告；或把 S3 的数据换成最新一版。会沿用当前项目继续改。'
        : MODES[curMode].ph;
  document.querySelectorAll('#modes button').forEach(b => { b.disabled = !taskSnapshot || continuing || !!taskSnapshot.running; });
  $('#chatNew').disabled = !taskSnapshot || !!taskSnapshot.running || !!taskSnapshot.orphanRunning;
  const hint = $('#chatResumeHint');
  const showHint = continuing || done;
  hint.classList.toggle('hidden', !showHint);
  if (done) hint.textContent = '任务已完成。直接写要改什么，会在当前项目上接着改，不重做已完成的部分。';
  else if (continuing && recovery.blocked) hint.textContent = recovery.reason + recovery.detail;
  else if (continuing && taskSnapshot.staleStopNotice) hint.textContent = taskSnapshot.staleStopNotice +
    ' 现在可以直接写要改什么；会在现有成片上继续改，不重做已完成的部分。';
  else if (continuing) hint.textContent = (taskSnapshot.resumeKind === 'checkpoint' ? '从检查点继续。'
    : taskSnapshot.resumeKind === 'paused' ? ''
      : '旧任务按文件接续。') + taskSnapshot.resumeNotice + ' 原模式：' + taskSnapshot.mode + '。';
  const busy = chatResumePending || !!(taskSnapshot?.running || taskSnapshot?.cancelling || taskSnapshot?.orphanRunning || taskSnapshot?.productionBusy);
  $('#chatRetry').textContent = chatResumePending ? '继续请求中…' : recovery.label;
  $('#chatRetry').classList.toggle('hidden', !(taskSnapshot?.canRetry || recovery.blocked));
  $('#chatRetry').disabled = busy || recovery.blocked && !recovery.canExtend;
  $('#chatSend').disabled = chatResumePending || !!(taskSnapshot?.orphanRunning || taskSnapshot?.cancelling || taskSnapshot?.productionBusy && !taskSnapshot?.taskRunning)
    || continuing && recovery.blocked && !recovery.canExtend;
  /* 这次用哪个渠道：切换渠道只对"之后启动/继续"的任务生效，
     已在跑的中途不会换。不显示就会以为切换没起作用。 */
  const used = taskSnapshot?.provider;
  const el = $('#chatProvider');
  if (el) {
    let text = used ? '本次渠道：' + used : '';
    if (taskSnapshot?.channelMismatch) {
      text = '⚠ 上次用的是 ' + used + '；你已换成 ' + taskSnapshot.selectedProvider +
        '，点「继续原任务」后才会用新渠道。';
    }
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }
}
function setMode(m) {
  curMode = m;
  const cfg = MODES[m];
  document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('#modeHint').textContent = cfg.hint;
  $('#chatInput').placeholder = cfg.ph + '　（运行中也可以随时补充，下一步生效）';
  $('#chatSend').textContent = cfg.btn;
  const q = $('#chatQuick'); q.innerHTML = '';
  cfg.quick.forEach(t => {
    const b = document.createElement('button'); b.textContent = t;
    b.onclick = () => { chatInput.setValue(t); };
    q.appendChild(b);
  });
  refreshTaskComposer();
}
function initChat() {
  document.querySelectorAll('#modes button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  subscribeChatSubmitFailure(value => renderChatSubmitFailure($('#chatSubmitError'), value));
  const box = $('#chatSubmitError');
  if (box) {
    box.onclick = () => { clearChatSubmitFailure('dismiss'); };
    box.title = '点击关闭这条提示；不重试、不提交';
  }
  setMode('article');
  paintEditExamples();
  $('#chatSend').disabled = true;
  $('#chatSend').onclick = sendChat;
  $('#chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendChat();
  });
  $('#attach').addEventListener('change', uploadAttachments);
}

let attached = [];
async function uploadAttachments(e) {
  const files = [...e.target.files];
  if (!files.length) return;
  const label = $('#attachLabel');
  for (const f of files) {
    label.textContent = '上传中：' + f.name;
    try {
      const r = await api('/_api/upload', { method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(f.name) },
        body: await f.arrayBuffer() });
      const j = await r.json();
      if (j.ok) attached.push(j.path);
    } catch {}
  }
  label.textContent = attached.length ? ('已附加：' + attached.join('、')) : '或选择本地文件（.md/.txt/图片/素材）';
  label.classList.toggle('has', !!attached.length);
  e.target.value = '';
}

async function sendChat() {
  if ($('#chatSend').disabled) return;
  if (!newTaskIntent && repairRecovery(taskSnapshot || {}).blocked) return resumeChatTask();
  const v = chatInput.getValue().trim();
  if (!v && !attached.length && !(taskSnapshot?.canResume && !newTaskIntent)) return;
  const msg = (attached.length ? '[附加文件：' + attached.join('、') + ']\n' : '') + v;
  const sentAttachments = attached.slice();
  $('#chatSend').disabled = true;
  try {
    const response = await api('/_api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: msg, mode: curMode, intent: newTaskIntent ? 'new' : 'continue' }) });
    const j = await response.json();
    if (!response.ok || j.error) throw Object.assign(new Error(j.error || '任务未能提交'), { savedForResume: j.savedForResume, reason: j.reason });
    chatResumeError = '';
    if (chatInput.getValue().trim() === v) { chatInput.setValue(''); chatDraft?.clear(); }
    if (JSON.stringify(attached) === JSON.stringify(sentAttachments)) {
      attached = []; $('#attachLabel').textContent = '或选择本地文件（.md/.txt/图片/素材）';
      $('#attachLabel').classList.remove('has');
    }
    $('#chatError').classList.add('hidden');
    newTaskIntent = false;
    clearChatSubmitFailure();
    if (j.task) { taskSnapshot = j.task; paintTaskNotices(j.task); refreshTaskComposer(); paintFormat(); }
    if (j.delivered) {
      const log = $('#chatLog');
      log.textContent += '\n◆ 已送达当前会话（' + (j.delivery === 'steer' ? '下一步生效' : '本轮结束后生效') + '）——直接插进正在跑的那一轮，不是新任务\n';
      log.scrollTop = log.scrollHeight;
    } else if (j.queued) {
      const log = $('#chatLog');
      log.textContent += '\n◆ 已排队（' + (j.pending ? '当前 ' + j.pending + ' 条' : '下一步生效') + '）——Agent 下一步就会读到' +
        (j.note ? '\n  ' + j.note : '') + '\n';
      log.scrollTop = log.scrollHeight;
    }
    if (j.busy) $('#chatLog').textContent += '\n（上一条还在执行：' + (j.running || '') + '）';
  } catch (error) {
    const text = '提交失败：' + error.message + '\n输入已保留，没有自动重试。';
    $('#chatError').textContent = text;
    $('#chatError').classList.remove('hidden');
    recordChatSubmitFailure({ title: error.savedForResume ? '补充指令已保存，尚未送达' : '补充指令未送达',
      message: error.message + '\n输入已保留在下方，没有自动重试。' });
    if (error.savedForResume) {
      const log = $('#chatLog');
      log.textContent += '\n◆ 这条补充指令已保存到原任务；先点「停止」，再点「继续原任务」，下一次执行会收到。\n';
      log.scrollTop = log.scrollHeight;
    }
  } finally { $('#chatSend').disabled = false; }
}
$('#chatCancel').onclick = () => {
  api('/_api/chat/cancel', { method: 'POST' }).then(async response => {
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '取消请求未成功');
    $('#chatState').textContent = result.cancelling ? '正在取消，等待制作进程退出；请勿重复提交' : result.cancelled ? '已取消，登记进程已退出' : result.error || '没有可取消的任务';
  }).catch(error => {
    $('#chatError').textContent = '取消请求失败：' + error.message; $('#chatError').classList.remove('hidden');
    recordChatSubmitFailure({ title: '停止请求未成功', message: error.message });
  });
};
$('#chatNew').onclick = () => {
  if (!confirm('开始新一轮任务，仍在当前项目中。原任务历史会保留，已有文件不会自动删除。\n如果只是接着做，请取消并使用「继续原任务」。')) return;
  newTaskIntent = true; refreshTaskComposer();
  $('#modeHint').textContent = '新任务：请选择模式并输入新的要求。仍使用当前项目，不会新建项目目录。';
  $('#chatInput').focus();
};
async function resumeChatTask() {
  if (chatResumePending) return;
  chatResumeError = ''; chatResumeErrorTask = taskSnapshot?.taskId ?? taskSnapshot?.id;
  chatResumePending = true; refreshTaskComposer();
  try {
    // 未发送的补充要求随「继续」一并交给下一次执行；不能只留在输入框里被清空后才想起。
    const pendingInput = chatInput.getValue().trim();
    const result = await resumeWithRecovery({ getTask: () => taskSnapshot, confirmImpl: window.confirm.bind(window),
      request: async options => {
        const body = pendingInput
          ? { ...(options.body ? JSON.parse(options.body) : {}), instruction: pendingInput }
          : options.body;
        const response = await api('/_api/chat/resume', { ...options, ...(body ? {
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }), result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error || '原任务未能继续');
        return result;
      } });
    if (!result) return;
    newTaskIntent = false;
    if (pendingInput && chatInput.getValue().trim() === pendingInput) { chatInput.setValue(''); chatDraft?.clear(); }
    clearChatSubmitFailure();
    if (result.task) { taskSnapshot = result.task; refreshTaskComposer(); }
    paintTaskNotices(result.task || { status: 'starting' });
  } catch (error) {
    chatResumeError = error.message + '。输入已保留，没有自动重试。';
    recordChatSubmitFailure({ title: '继续任务未完成', message: error.message + '。输入已保留，没有自动重试。' });
  }
  finally { chatResumePending = false; refreshTaskComposer(); }
}
$('#chatRetry').onclick = () => { if (!$('#chatRetry').disabled) return resumeChatTask(); };
let chatTail = null, previousTaskStatus = null;
/* 最近几轮：让用户知道"它记得什么" */
function renderMemory() {
  api('/_api/chat/memory').then(r => r.json()).then(j => {
    const box = document.getElementById('chatMemory');
    if (!box) return;
    const mem = (j.memory || []).slice(-4).reverse();
    if (!mem.length) { box.innerHTML = '<span style="color:var(--ink3)">还没有历史（第一轮）</span>'; return; }
    box.innerHTML = mem.map(m =>
      `<div class="memrow"><span class="memu">你：${esc(String(m.user || '').slice(0, 60))}</span>` +
      `<span class="memr">→ ${esc(String(m.summary || '').slice(0, 70))}</span></div>`).join('');
  }).catch(() => {});
}

function paintTaskNotices(task) {
  const notices = taskNotices(task);
  if (chatResumeErrorTask !== (task?.taskId ?? task?.id)) chatResumeError = '';
  if (chatResumeError) notices.reason = chatResumeError;
  /* 任务被取消但产物已齐：明确告诉用户"不用继续"。
   * 否则界面只显示"任务已取消"，人会以为还得点一次继续。 */
  if (task?.delivered) {
    notices.reason = '这一版已经做完（成片与发布物料都在），不需要继续。要改就写要求；不改就直接去发布台。';
  }
  for (const [id, text] of [['chatError', notices.reason], ['chatStale', notices.deliverable]]) {
    const el = $('#' + id);
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }
  // 提交失败独立保存；轮询/任务状态变化不能把它在两秒内冲掉。
  renderChatSubmitFailure($('#chatSubmitError'));
  /* 运行期警告（例如中途断线后恢复）：单独一行，不和失败原因抢位置。 */
  const warn = $('#chatWarnings');
  if (warn) {
    const text = notices.warnings.length ? '⚠ ' + notices.warnings.join('\n⚠ ') : '';
    warn.textContent = text;
    warn.classList.toggle('hidden', !text);
  }
}

/* 改片历史：从任务日志提炼「你说过什么、它动了哪些文件」。
 * 只在任务状态变化时重取，不跟着每次轮询刷新——日志不变时重取是纯浪费。 */
let historySig = '';
async function refreshEditHistory(task) {
  const sig = [task?.taskId, task?.status, task?.attemptNumber, task?.steps].join('|');
  if (sig === historySig) return;
  historySig = sig;
  try {
    const data = await requestJSON('/_api/chat/history?p=' + encodeURIComponent(PROJ), { cache: 'no-store' });
    paintEditHistory(data.entries || [], data.archived || 0);
  } catch { /* 历史取不到不影响改片 */ }
}

function paintEditHistory(entries, archived) {
  const box = $('#editHistory');
  if (!box) return;
  box.innerHTML = '';
  if (!entries.length) {
    box.innerHTML = '<p class="edit-hint">还没有改过。第一次执行后会记在这里。</p>';
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'edit-history-item';
    const head = document.createElement('div');
    head.className = 'edit-history-head';
    head.innerHTML = `<span class="clock">${entry.clock ? String(entry.clock).replace(/[&<>"]/g, '') : ''}</span>` +
      `<span class="kind">${entry.kind === 'steer' ? '插话' : '你的要求'}</span>`;
    const body = document.createElement('div');
    body.className = 'edit-history-text';
    body.textContent = entry.text || '';
    row.append(head, body);
    if (entry.files?.length) {
      const files = document.createElement('div');
      files.className = 'edit-history-files';
      files.textContent = '动了：' + entry.files.join('、');
      row.appendChild(files);
    }
    box.appendChild(row);
  }
  if (archived) {
    box.insertAdjacentHTML('beforeend', `<p class="edit-hint">另有 ${archived} 次已归档的旧任务，不列在这里。</p>`);
  }
}

/* 示例：给出「具体到什么程度才算说清楚」的样板。
 * 大多数人第一次只会写「改好一点」，那样 agent 只能猜。 */
const EDIT_EXAMPLES = [
  '第 2 场太慢，压到 6 秒',
  '开场改得更具体，先给一个真实场景',
  '标题换成「不渲染的审片室」，封面文案跟着改',
  'S3 那个数字换成最新一版，并标出处',
];
function paintEditExamples() {
  const box = $('#editExamples');
  if (!box || box.dataset.done === '1') return;
  box.dataset.done = '1';
  for (const text of EDIT_EXAMPLES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'edit-example';
    button.textContent = text;
    button.onclick = () => { chatInput.setValue(text); $('#chatInput').focus(); };
    box.appendChild(button);
  }
}

function pollChat() {
  return requestJSON('/_api/chat?p=' + encodeURIComponent(PROJ), { cache: 'no-store', allowErrorField: true }).then(j => {
    taskSnapshot = j;
    if (j.execution?.runner === 'opencode') {
      $('#modelLink').textContent = '本轮：' + j.execution.model;
      $('#modelLink').title = '本轮执行器：opencode；模型来源：' + j.execution.modelSource + '；这是本轮配置快照，设置页修改只影响后续启动';
    }
    paintOverview();
    const publishTaskSig = JSON.stringify([j.taskId, j.status, j.mode, j.canResume, j.error, j.orphanRunning]);
    if (publishTaskSig !== lastPublishTaskSig) { lastPublishTaskSig = publishTaskSig; if (STATE) buildPublish(); }
    paintFormat();
    if (lastModeTask !== j.taskId && !newTaskIntent) {
      lastModeTask = j.taskId;
      setMode(MODES[j.mode] ? j.mode : j.mode?.startsWith('edit') ? 'edit' : 'article');
    }
    refreshTaskComposer();
    refreshEditHistory(j);
    const st = $('#chatState');
    const cancel = $('#chatCancel');
    const retry = $('#chatRetry');
    paintTaskNotices(j);
    if (j.running) {
      const mmss = ms => { const sec = Math.max(0, Math.round((Date.now() - ms) / 1000)); return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'); };
      const step = j.stageSince ? '本步 ' + mmss(j.stageSince) : '';
      st.textContent = (j.cancelling ? '正在取消，等待登记进程退出 ' : j.productionBusy && !j.taskRunning ? '命令行制作执行中 ' : j.status === 'starting' ? '制作进程启动中 ' : stageLabel(j.stage) + ' ')
        + '总用时 ' + mmss(j.since) + (step ? ' · ' + step : '') + (j.steps ? ` · 已调用工具 ${j.steps} 次` : '')
        + (j.stalled ? ' · ⚠ 90 秒无新动作' : (j.activeTool?.name ? ' · 后台工具仍在运行' : ''));
      st.className = 'busy';
      cancel.classList.toggle('hidden', !!(j.productionBusy && !j.taskRunning && !j.orphanRunning));
      cancel.disabled = !!j.cancelling;
      const lastEl = document.getElementById('chatLast');
      if (lastEl && j.last) lastEl.textContent = '最近动作：' + j.last;
    } else {
      cancel.classList.toggle('hidden', !j.orphanRunning);
      cancel.disabled = !!j.cancelling;
      const labels = { failed:'任务失败', interrupted:'任务中断', incomplete:'任务未完成', paused:'任务已暂停，可继续', cancelled:'任务已取消', completed: reviewRequired(displayState()) ? '任务已结束，等待必需审阅' : '任务已完成，可观看 / 导出', idle:'尚未提交任务' };
      st.textContent = labels[j.status] || '等待要求'; st.className = '';
      if (previousTaskStatus && previousTaskStatus !== j.status) { lastSceneM = 0; renderMemory(); }
    }
    previousTaskStatus = j.status;
    const log = $('#chatLog');
    if (j.tail != null && j.tail !== chatTail) {
      chatTail = j.tail;
      log.textContent = j.tail || '（Agent 启动中，通常 20–60 秒出第一行输出…）';
      log.scrollTop = log.scrollHeight;
    }
  }).catch(error => {
    $('#chatSend').disabled = true; $('#chatNew').disabled = true; $('#chatRetry').disabled = true;
    $('#chatError').textContent = error.message; $('#chatError').classList.remove('hidden');
    recordChatSubmitFailure({ title: '读取制作状态失败', message: error.message + '。这不是提交结果；请刷新后再试。' });
  });
}

/* tabs */
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('#side .tab').forEach(x => x.classList.toggle('on', x.id === b.dataset.tab));
});
initChat();
chatDraft = attachDraft({ key: 'vh:draft:chat:v1:' + encodeURIComponent(PROJ), input: chatInput,
  checkbox: $('#saveChatDraft'), status: $('#chatDraftStatus') });
renderMemory();
/* 支持 /?p=…&tab=publish 直达某个标签 */
const wantTab = new URLSearchParams(location.search).get('tab');
if (wantTab) {
  const b = [...document.querySelectorAll('#tabs button')].find(x => x.dataset.tab === wantTab);
  if (b) b.click();
}

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- 轮询状态（scene.html 变化 → 提示重载） ---------- */
let lastSceneM = 0;
let videoSig = '';
let pubSig = 'x', lastPublishTaskSig = '';
async function poll() {
  try {
    const s = await requestJSON('/_api/state?p=' + encodeURIComponent(PROJ), { cache: 'no-store' });
    if (!Array.isArray(s.scenes) || !Array.isArray(s.videos)) throw new Error('项目状态返回不完整');
    $('#stateConnection').textContent = '';
    const first = !STATE;
    const sceneDirty = first || s.sceneM !== lastSceneM;
    lastSceneM = s.sceneM;
    const scenesChanged = !STATE || JSON.stringify(s.scenes) !== JSON.stringify(SCENES) ||
                          JSON.stringify(s.subs) !== JSON.stringify(SUBS);
    const stillsChanged = !STATE || s.stillsCount !== STATE.stillsCount;
    const durChanged = !STATE || s.duration !== STATE.duration;
    STATE = s; DUR = s.duration; SCENES = s.scenes; SUBS = s.subs;
    paintFormat();
    chips(s);
    paintOverview();
    if (first || scenesChanged) { renderChapters(); buildScript(); buildBoard(); if (first) loadFrame(firstSeek()); }
    else if (stillsChanged) buildBoard();
    // ⚠ 成片列表只在「文件真的变了」时重建 —— 每 2s 无条件重建会把 <video> 拆掉重装，
    //   表现就是"点播放后过一会儿卡住"（播放位置被重置）。
    const psig = JSON.stringify([s.publish || null, s.delivery, s.running, productionPanel.getState().view?.quality, displayState()?.workflow]);
    if (first || psig !== pubSig) { pubSig = psig; buildPublish(); }
    const vsig = JSON.stringify(s.videos.map(v => [v.file, v.size, Math.round(v.mtime)]));
    if (first || vsig !== videoSig) {
      videoSig = vsig; buildVideo();
      // 重新出片后不能继续播放旧的缓存音轨。
      if (!first) {
        playing = false; $('#play').textContent = '▶';
        if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load(); }
        audioEl = null; audioFailed = false; audioPlayPending = false; pendingSeek = t;
        audioDur = null;
        $('#mute').style.display = '';
      }
    }
    // 时间轴变了也要重新判断旁白是否匹配（例如刚 measure 完、还没重新配音）。
    if (!first && durChanged) warnAudioMismatch();
    if (sceneDirty && !first) pulseReload();
  } catch (e) {
    $('#stateConnection').textContent = '项目状态读取失败：' + e.message + '。当前显示的是上次成功读取的结果，并非实时状态；正在重连，不会重新提交制作任务。';
  }
}
let reloadWake = false;
/* 首帧给一个有代表性的画面（第 1 场完成态附近），而不是 t=0 的空标题态 */
function firstSeek() {
  if (!SCENES.length) return 0;
  const s = SCENES[0];
  return Math.min(s.end - 0.3, s.start + Math.max(1.5, (s.end - s.start) * 0.35));
}
function pulseReload() {
  const b = $('#reload');
  b.style.color = 'var(--warn)';
  if (!reloadWake) { reloadWake = true; b.textContent = '画面已变 · 重载？'; }
  b.onclick = () => { reloadWake = false; b.style.color = ''; b.textContent = '重载画面 ↻'; loadFrame(t); };
}
function countStills(s) { return s.stillsCount; }

visiblePolling(pollChat, { intervalMs: 1500 });
visiblePolling(poll, { intervalMs: 2000 });
const formatPolling = visiblePolling(refreshFormat, { intervalMs: 5000 });
requestAnimationFrame(ts => { lastTs = ts; tick(ts); });
