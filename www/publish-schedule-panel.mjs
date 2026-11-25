/* 每日排程 UI。发布资格、时点及队列状态均由后端计算；浏览器只轮询展示。 */
const $ = id => document.getElementById(id);
export function attachPublishSchedule({ request, getSelection, setSelection, getProjects = () => [], loggedIn, notice }) {
  let state, revision, saving = false, reading = false, dirty = false, requestVersion = 0, editVersion = 0;
  let readError = '', actionError = '';
  let partition = null, partitionOptions = new Map(), partitionCatalog = 'loading';
  let protocolCompatible = false, readySupported = false;
  const checkProtocol = data => {
    if (!Number.isInteger(data?.protocolVersion) || data.protocolVersion < 2) {
      protocolCompatible = false;
      readySupported = false;
      throw new Error('前后端版本不一致：后端过旧，请在无制作或投稿运行时重启工作台，再重新读取。网页不会自动重启或启用排程。');
    }
    protocolCompatible = true;
    readySupported = data.protocolVersion >= 3;
  };
  const times = () => [...$('pubScheduleTimes').querySelectorAll('input')].map(input => input.value);
  const scope = () => ({ kind: $('pubScheduleScope').value });
  const isReady = () => $('pubScheduleTrigger').value === 'ready';
  const markDirty = () => { dirty = true; editVersion++; paintControls(); };
  const errorText = error => error.status === 404
    ? '排程接口不可用：后端版本过旧。请在无制作或投稿运行时安全重启更新后的工作台，再重新读取。网页不会自动重启或启用排程。'
    : error.status === 409 ? '排程版本冲突：配置已被其他页面修改。请重新读取并核对后再保存或启用；本页编辑仍保留。'
      : error.message || '请求失败';

  function addTime(value = '20:00') {
    const row = document.createElement('div'); row.className = 'pub-time-row';
    const input = document.createElement('input'); input.type = 'time'; input.value = value;
    input.required = true; input.setAttribute('aria-label', '每日发布时间'); input.oninput = markDirty;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'pub-btn';
    remove.textContent = '移除'; remove.onclick = () => { row.remove(); markDirty(); };
    row.append(input, remove); $('pubScheduleTimes').append(row);
  }
  function restoreForm(data) {
    $('pubScheduleTimes').replaceChildren(); data.times.forEach(addTime);
    $('pubScheduleScope').value = data.scope?.kind || 'selected';
    $('pubScheduleTrigger').value = data.trigger?.kind || 'daily';
    $('pubScheduleInterval').value = data.trigger?.intervalSeconds ?? 180;
    partition = data.partition || null;
    paintPartitions();
    setSelection([...data.ids]);
  }
  const partitionKey = item => item ? `${item.partitionTaxonomy}:${item.humanType2 || item.tid}` : '';
  function paintPartitions() {
    const select = $('pubSchedulePartition'), key = partitionKey(partition);
    const unavailable = key && !partitionOptions.has(key);
    select.replaceChildren(new Option('— 请选择分区 —', ''));
    for (const [value, item] of partitionOptions) select.add(new Option(item.label, value));
    if (unavailable) select.add(new Option(`${partition.label || partition.tid}（已保存）`, key));
    select.value = key;
    select.disabled = !state || !protocolCompatible || (!partitionOptions.size && !key);
    $('pubSchedulePartitionHint').textContent = partitionCatalog === 'loaded' && unavailable
      ? '已保存分区不在当前目录中；重新启用前请选择分区。'
      : partitionCatalog === 'failed' ? '未能读取分区目录；可点页眉的「刷新」重试。' : '只用于定时发布，不影响单条投稿。';
  }
  function paintControls() {
    $('pubScheduleSave').disabled = saving || reading || !state || Boolean(readError) || !protocolCompatible;
    $('pubScheduleEnable').disabled = saving || reading || !state || Boolean(readError) || !protocolCompatible;
    $('pubSchedulePause').disabled = saving || reading || !state?.enabled || Boolean(readError) || !protocolCompatible;
    $('pubScheduleRetry').disabled = saving || reading;
    $('pubScheduleSave').textContent = saving ? '正在处理…' : '保存排程';
    $('pubScheduleDirty').textContent = dirty ? '有未保存的修改。保存只存配置并暂停，不会启用自动发布。' : '保存只存配置并暂停；启用需要另行确认。';
    $('pubSchedulePartition').disabled = !state || !protocolCompatible || (!partitionOptions.size && !partition);
    $('pubScheduleTrigger').disabled = !readySupported;
    $('pubScheduleDaily').hidden = isReady();
    $('pubScheduleReady').hidden = !isReady();
    $('pubScheduleTriggerHint').textContent = isReady()
      ? '首支就绪后开始投稿。没有就绪成片就等，不启动制作。'
      : '每天到点最多投一支，没有就跳过，错过不补。' +
        (state && protocolCompatible && !readySupported ? '「成片后自动投稿」需重启工作台服务后刷新。' : '');
    const automatic = scope().kind === 'production-queue';
    $('pubScheduleScopeHint').textContent = automatic
      ? '授权当前及今后制作队列中的项目。制作中会等待。'
      : '只发布显式勾选并保存的作品；后续项目需手动加入。未出片可先入队，等后端确认就绪。';
    $('pubScheduleQueue').hidden = automatic;
    $('pubScheduleQueueHeading').hidden = automatic;
  }
  function paintSelection() {
    const ids = getSelection();
    const list = $('pubScheduleQueue'); list.replaceChildren();
    const projects = new Map(getProjects().map(item => [item.id, item]));
    ids.forEach((id, index) => {
      const li = document.createElement('li');
      const label = document.createElement('span'); label.className = 'pub-queue-id'; label.textContent = id;
      const publication = projects.get(id)?.publication;
      const status = document.createElement('small'); status.className = 'pub-queue-status';
      status.textContent = publication ? [publication.label, publication.reason].filter(Boolean).join(' · ') : '状态尚未读取';
      const up = document.createElement('button'); up.type = 'button'; up.className = 'pub-btn';
      up.textContent = '上移'; up.disabled = index === 0; up.setAttribute('aria-label', `上移 ${id}`);
      up.onclick = () => { markDirty(); const next = [...getSelection()]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setSelection(next); };
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'pub-btn';
      remove.textContent = '移除'; remove.setAttribute('aria-label', `移除 ${id}`);
      remove.onclick = () => { markDirty(); setSelection(getSelection().filter(item => item !== id)); };
      li.append(label, status, up, remove); list.append(li);
    });
    paintControls();
  }
  function paintState() {
    paintControls();
    const box = $('pubScheduleStatus');
    if (readError) {
      box.textContent = '读取排程失败：' + readError + (state ? ' 以下为上次读取的状态，当前状态未确认。' : ' 当前启用状态和队列未知。');
      box.classList.add('bad');
    } else if (!state) {
      box.textContent = '正在读取排程…'; box.classList.remove('bad');
    } else {
      const last = state.lastAttempt;
      box.classList.remove('bad');
      const ready = state.trigger?.kind === 'ready';
      box.textContent = (ready
        ? (state.enabled ? `成片后自动投稿已开启 · 最短间隔 ${state.trigger.intervalSeconds} 秒。` : '成片后自动投稿已暂停。')
        : (state.enabled ? '每日发布已开启，只在排程时点由服务端尝试发布。' : '每日发布已暂停。')) +
        (last?.state === 'running'
          ? (state.attemptActive
            ? ' 投稿进行中，请等待本次处理结束。'
            : ` 上次投稿${last.id ? `（${last.id}）` : ''}未完整结束；请先核对 B 站稿件管理后，用下方按钮解除阻断。`)
          : '') +
        (state.accountMatches === false ? ' 账号已变化，请重新确认。' : '') +
        (last?.state === 'waiting' ? (ready ? ` 等待制作完成：${last.message || '项目制作中'}。`
          : ` 上次时点等待制作完成：${last.message || '项目正在制作或被制作锁占用'}；已跳过该时点，等下个排程时点。`) : '') +
        (last?.state === 'failed' ? ` 上次未完成：${last.message || last.outcome}，不会自动重试。` : '') +
        (last?.state === 'submitted' ? ` 最近已提交：${last.id}${last.bvid ? ' · ' + last.bvid : ''}。${last.message || ''}` : '') +
        (state.pauseReason ? ' ' + state.pauseReason : '') + (state.error ? ' ' + state.error : '');
    }
    const reconcileWrap = $('pubScheduleReconcile');
    if (reconcileWrap) {
      const showReconcile = Boolean(state && !readError && protocolCompatible && state.lastAttempt?.state === 'running' && !state.attemptActive);
      reconcileWrap.hidden = !showReconcile;
      if ($('pubScheduleReconcileSubmitted')) $('pubScheduleReconcileSubmitted').disabled = saving || reading || !showReconcile;
      if ($('pubScheduleReconcileNotSubmitted')) $('pubScheduleReconcileNotSubmitted').disabled = saving || reading || !showReconcile;
    }
    $('pubScheduleError').textContent = actionError;
    if (!state) {
      $('pubBatchCount').textContent = '状态未知';
      $('pubSchedulePending').textContent = '队列状态尚未读取。';
      return;
    }
    $('pubScheduleZone').textContent = `服务时区：${state.timezone}` +
      ` · 已保存范围：${state.scope?.kind === 'production-queue' ? '当前及今后制作队列' : '仅选定作品'}` +
      (state.partition ? ` · 已保存分区：${state.partition.label || state.partition.tid}` : ' · 未保存分区');
    const ready = state.trigger?.kind === 'ready';
    $('pubScheduleCalendarWrap').hidden = ready;
    $('pubScheduleNext').textContent = (ready
      ? !state.enabled ? '启用后，就绪作品可能立即开始投稿。'
        : state.nextReadyAt > Date.now()
          ? `下一支最早可投：${new Date(state.nextReadyAt).toLocaleString('zh-CN', { timeZone: state.timezone })}`
          : '已就绪且无其他投稿时自动提交。'
      : `${state.enabled ? '下次时点' : '启用后的下一时点预览'}：${state.nextSlot || '暂无'}`) + (readError ? '（上次读取）' : '');
    const pending = state.pending;
    $('pubBatchCount').textContent = pending ? `队列 ${pending.total} 支` : '状态未知';
    $('pubSchedulePending').textContent = pending
      ? `已保存队列：就绪 ${pending.ready} · 等待 ${pending.waiting} · 需处理 ${pending.needsAttention} · 已提交 ${pending.submitted}`
      : '后端未返回队列状态，请重新读取。';    const items = $('pubSchedulePendingItems'); items.replaceChildren();
    for (const item of pending?.items || []) {
      const li = document.createElement('li'); li.textContent = `${item.id}：${[item.label, item.reason].filter(Boolean).join(' · ')}`; items.append(li);
    }
    const calendar = $('pubScheduleCalendar'); calendar.replaceChildren();
    for (const day of state.calendar || []) {
      const cell = document.createElement('div'); cell.className = 'pub-calendar-day';
      const date = document.createElement('strong'); date.textContent = `${day.day.slice(5)} 周${day.weekday}`;
      const slots = document.createElement('span'); slots.textContent = day.times.join(' / ') || '—';
      cell.append(date, slots); calendar.append(cell);
    }
  }
  async function refresh({ rebase = false } = {}) {
    if (saving) return;
    const version = ++requestVersion, startEdit = editVersion;
    reading = true; paintControls();
    try {
      const data = await request('/schedule');
      if (version !== requestVersion) return;
      checkProtocol(data);
      if (!Array.isArray(data.times) || !Array.isArray(data.ids) || data.revision === undefined) throw new Error('排程响应无效，请检查服务版本后重试。');
      state = data; readError = '';
      if (rebase || revision === undefined || !dirty) revision = data.revision;
      if (!dirty && startEdit === editVersion) { restoreForm(data); dirty = false; }
      if (rebase) actionError = '';
    } catch (error) {
      if (version !== requestVersion) return;
      readError = errorText(error);
    } finally {
      if (version === requestVersion) { reading = false; paintState(); paintSelection(); }
    }
  }
  async function mutate(action) {
    if (saving || reading || !state || readError || !protocolCompatible) return;
    const selectedTimes = times(), ids = [...getSelection()];
    const interval = $('pubScheduleInterval').valueAsNumber;
    const trigger = isReady() ? { kind: 'ready', intervalSeconds: interval } : { kind: 'daily' };
    if (action !== 'pause' && isReady() && (!readySupported || !Number.isInteger(interval) || interval < 30 || interval > 86400)) {
      notice('请填写 30–86400 秒的最短投稿间隔。', 'bad'); return;
    }
    if (action !== 'pause' && !isReady() && (!selectedTimes.length || selectedTimes.some(time => !/^\d{2}:\d{2}$/.test(time)))) {
      notice('请至少设置一个有效的发布时间。', 'bad'); return;
    }
    if (action === 'enable') {
      if (!loggedIn()) { notice('请先登录账号，再启用自动发布。保存排程不需要登录。', 'bad'); return; }
      if (!partition?.tid || (partitionCatalog === 'loaded' && !partitionOptions.has(partitionKey(partition)))) {
        notice('请为排程选择有效分区，再启用自动发布。', 'bad'); return;
      }
      const authorization = scope().kind === 'production-queue'
        ? '授权当前及今后制作队列中的所有项目。'
        : `只授权显式选定的作品：${ids.join('、') || '空队列'}；后续新项目需手动加入并保存。`;
      const cadence = isReady()
        ? `成片后自动投稿。已有就绪作品可能立即开始投稿；上一支确认收稿后至少等 ${interval} 秒再投下一支。`
        : `每天：${[...new Set(selectedTimes)].sort().join('、')}（${state.timezone}）。每个时点最多发一支，没有就绪作品则跳过，不补发。`;
      if (!confirm(`确认启用自动发布？\n\n${cadence}\n分区：${partition.label || partition.tid}\n${authorization}\n\n投稿使用各项目保存的文案、商业声明与上述分区，不使用右侧尚未保存的修改。失败即暂停。`)) return;
    }
    const submittedVersion = editVersion, oldRevision = state.revision;
    const body = action === 'pause' ? { action, revision: state.revision }
      : { action, revision, ...(trigger.kind === 'daily' ? { times: selectedTimes } : {}),
          ...(readySupported ? { trigger } : {}), ids, scope: scope(), partition, ...(action === 'enable' ? { confirmed: true } : {}) };
    saving = true; reading = false; requestVersion++; actionError = ''; paintState();
    try {
      const result = await request('/schedule', { method: 'POST', body });
      checkProtocol(result); state = result; readError = '';
      if (action === 'pause') { if (revision === oldRevision) revision = state.revision; }
      else {
        revision = state.revision; dirty = editVersion !== submittedVersion;
        if (!dirty) restoreForm(state);
      }
      notice((action === 'pause' ? '已暂停。已经开始上传的投稿不会被撤销。'
        : action === 'enable' ? (trigger.kind === 'ready' ? '自动发布已启用。有就绪成片时可能立即开始投稿。' : '自动发布已启用。不会立即发布，从下一个排程时点开始。')
          : '排程已保存，自动发布保持暂停；需要另行启用。') + (dirty ? ' 你刚才新增的修改尚未保存。' : ''), 'ok');
    } catch (error) {
      actionError = `${action === 'pause' ? '暂停' : action === 'enable' ? '启用' : '保存'}失败：${errorText(error)}`;
      if (error.status === 404) readError = errorText(error);
      if (!protocolCompatible) readError = errorText(error);
      notice(actionError, 'bad');
    } finally { saving = false; paintState(); paintSelection(); }
  }
  $('pubScheduleScope').onchange = () => { markDirty(); paintSelection(); };
  $('pubScheduleTrigger').onchange = markDirty;
  $('pubScheduleInterval').oninput = markDirty;
  $('pubSchedulePartition').onchange = event => {
    partition = event.target.value ? partitionOptions.get(event.target.value) || partition : null;
    markDirty();
  };
  $('pubScheduleAdd').onclick = () => {
    if (times().length >= 24) { notice('每天最多设置 24 个时点。', 'bad'); return; }
    addTime('12:00'); markDirty();
  };
  async function reconcileInterrupted(resolution) {
    if (saving || reading || !state || readError || !protocolCompatible || state.lastAttempt?.state !== 'running' || state.attemptActive) return;
    const target = state.lastAttempt.id || '上一支作品';
    const msg = resolution === 'submitted'
      ? `确认「${target}」已经手动投稿或已在 B 站收到稿件？\n\n确认后将该记录标记为已提交（不再重复自动投稿），并解除排程阻断。`
      : `确认 B 站「稿件管理」中没有收到「${target}」？\n\n确认后将解除上次中断留下的排程阻断；自动发布保持暂停，核对队列后可重新启用。`;
    if (!confirm(msg)) return;
    const oldRevision = state.revision;
    saving = true; reading = false; requestVersion++; actionError = ''; paintState();
    try {
      const result = await request('/schedule', {
        method: 'POST',
        body: { action: 'reconcile', revision: state.revision, resolution, confirmed: true },
      });
      checkProtocol(result); state = result; readError = '';
      if (revision === oldRevision || !dirty) revision = state.revision;
      if (!dirty) restoreForm(state);
      notice('已解除上次未闭合的投稿记录；现在可修改排程或点击「确认并启用自动发布」。', 'ok');
    } catch (error) {
      actionError = '核对解除失败：' + errorText(error);
      notice(actionError, 'bad');
    } finally { saving = false; paintState(); paintSelection(); }
  }
  $('pubScheduleSave').onclick = () => mutate('save');
  $('pubScheduleEnable').onclick = () => mutate('enable');
  $('pubSchedulePause').onclick = () => mutate('pause');
  $('pubScheduleRetry').onclick = () => refresh({ rebase: true });
  if ($('pubScheduleReconcileSubmitted')) $('pubScheduleReconcileSubmitted').onclick = () => reconcileInterrupted('submitted');
  if ($('pubScheduleReconcileNotSubmitted')) $('pubScheduleReconcileNotSubmitted').onclick = () => reconcileInterrupted('not-submitted');
  const timer = setInterval(() => { if (!saving && !reading && !document.hidden) refresh(); }, 15000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  paintState();
  paintPartitions();
  return { refresh, paintSelection,
    setPartitions: items => {
      partitionCatalog = Array.isArray(items) ? 'loaded' : 'failed';
      partitionOptions = new Map((items || []).map(item => [partitionKey(item), item]));
      paintPartitions();
    },
    selectionChanged: () => { markDirty(); paintSelection(); } };
}
