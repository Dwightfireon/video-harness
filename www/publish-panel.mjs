/* 发布页：把 desk/ 的投稿流程接到工作台里，不需要再单开 Electron 窗口。
 *
 * 分工：
 *   - 这个文件只做界面与调用顺序
 *   - 校验、上传、提交全在 desk/service.mjs 与 desk/publish.mjs（同一套，已测过）
 *   - 后端入口 lib/publish-api.mjs，走本地 HTTP
 *   - 分区协议常量（taxonomy 名、兼容 tid）由后端随清单下发，前端不复制
 *
 * 不可逆动作的保护不在这里减弱：提交要弹确认框，批量要显式确认，
 * 失败不自动重试，结果未知时提示先查稿件管理。
 *
 * 交互原则：
 *   - 提交按钮贴在底部操作栏，不随内容滚走
 *   - 先说「还差什么」，再让人填；缺项高亮对应输入框
 *   - 默认展示人能读的摘要，原始 JSON 收进折叠区
 */
import { attachPublishSchedule } from './publish-schedule-panel.mjs';
import { attachPublishPromotion } from './publish-promotion-panel.mjs';
let schedulePanel;
let promotionPanel;
const $p = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const P = {
  overview: null, projects: [], partitions: [], catalog: null,
  current: null, draft: null, plan: null, refs: null,
  selected: [], coverWanted: true,
  projectsLoaded: false, projectsError: '', overviewError: '',
  qrTimer: null, notice: '', noticeKind: '', busy: false, planError: '',
};

const fmtBytes = n => !Number.isFinite(n) || n <= 0 ? '—' : n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';
const fmtSec = s => !Number.isFinite(s) ? '' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');

async function call(path, options = {}) {
  const response = await fetch('/_api/publish' + path, {
    // GET 读取失败必须结束加载；不对耗时上传施加这个读取超时。
    signal: !options.method || options.method === 'GET' ? AbortSignal.timeout(20000) : undefined,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || '请求失败'), data, { status: response.status });
  return data;
}

function setNotice(text, kind = '') {
  P.notice = text; P.noticeKind = kind;
  const box = $p('#pubNotice');
  if (!box) return;
  box.textContent = text;
  box.className = (text ? '' : 'hidden') + (kind ? ' ' + kind : '');
}

/* ---------- 账号 ---------- */
function paintAccount() {
  const a = P.overview?.account;
  const btn = $p('#pubAccount');
  if (!btn) return;
  if (P.overviewError) {
    btn.textContent = '账号读取失败，请刷新'; btn.title = P.overviewError;
    btn.className = 'pub-account warn'; return;
  }
  btn.title = '';
  if (!a?.loggedIn) {
    btn.textContent = a?.expired ? '登录已过期，点此重登' : '未登录，点此扫码';
    btn.className = 'pub-account warn';
  } else {
    const warn = P.overview?.ready && !P.overview.ready.ok ? ' · 投稿受限' : '';
    btn.textContent = '已登录：' + (a.name || 'B 站账号') + (a.level ? '（LV' + a.level + '）' : '') + warn;
    btn.className = 'pub-account' + (warn ? ' warn' : ' ok');
  }
}

/* ---------- 项目 ---------- */
function paintProjects() {
  const box = $p('#pubProjects');
  if (!box) return;
  box.innerHTML = '';
  const count = $p('#pubCount');
  if (count) count.textContent = P.projectsLoaded ? P.projects.length + ' 个' : '状态未知';
  const status = $p('#pubProjectsStatus');
  if (status) {
    status.textContent = P.projectsError ? '读取项目失败：' + P.projectsError + (P.projectsLoaded ? '（以下为上次读取的列表）' : '，请点击刷新重试。')
      : P.projectsLoaded ? '状态由服务端计算，每 15 秒刷新。' : '正在读取项目…';
    status.classList.toggle('bad', Boolean(P.projectsError));
  }
  if (!P.projects.length) {
    if (P.projectsLoaded && !P.projectsError) box.innerHTML = '<p class="pub-hint">projects/ 里还没有项目。</p>';
    return;
  }
  for (const item of P.projects) {
    const row = document.createElement('div');
    row.className = 'pub-row' + (P.current === item.id ? ' on' : '');

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'pub-pick';
    check.title = '加入显式选定队列，保存后生效；发布资格由服务端检查';
    check.setAttribute('aria-label', `选择 ${item.id}`);
    check.checked = P.selected.includes(item.id);
    check.onchange = () => {
      P.selected = check.checked ? [...P.selected.filter(id => id !== item.id), item.id] : P.selected.filter(id => id !== item.id);
      schedulePanel?.selectionChanged();
    };

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'pub-item';
    main.onclick = () => loadDraft(item.id);
    const bits = [
      item.hasCopy ? '有文案' : '无文案',
      item.hasVideo ? '有视频 ' + fmtBytes(item.video?.bytes) : '无视频',
      item.cover ? '有封面' : '无封面',
    ];
    main.innerHTML =
      `<span class="t">${esc(item.title || item.id)}</span>` +
      `<span class="m">${esc(bits.join(' · '))}</span>` +
      (item.error ? `<span class="m bad">${esc(item.error)}</span>` : '');
    const publication = item.publication;
    const status = document.createElement('span'); status.className = 'm pub-status';
    status.dataset.state = publication?.state || 'unknown';
    status.textContent = publication ? [publication.label, publication.reason].filter(Boolean).join(' · ') : '发布状态未返回';
    main.append(status);
    if (item.task) {
      const task = document.createElement('span'); task.className = 'm pub-status';
      const labels = { running: '进程运行中', taskRunning: '任务执行中', productionBusy: '制作占用中', orphanRunning: '有遗留运行记录' };
      const flags = Object.keys(labels).filter(key => item.task[key]).map(key => labels[key]);
      task.textContent = `制作任务：${item.task.status || '状态未返回'}` + (flags.length ? ` · ${flags.join(' / ')}` : '');
      main.append(task);
    }

    row.append(check, main);
    box.appendChild(row);
  }
  paintSelection();
}

/* ---------- 草稿 ---------- */
let draftCache = new Map();
let draftRevision = 0, formRevision = 0, planRequest = 0, refsRequest = 0, planTimer;
let partitionsReady = Promise.resolve();
const formEdits = new Map();
let formSaving = false, desiredPartition;
const editKey = id => 'vh.publish.edit.' + encodeURIComponent(draftCache.get(id)?.editorKey || id);
function localForm(input) {
  const selected = P.catalog?.human || Number(input.humanType2) > 0 ? Number(input.humanType2) : Number(input.tid);
  return { title: String(input.title || '').trim(), desc: String(input.desc || '').trim(),
    tags: (Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(/[\s,，、]+/)).filter(Boolean).join(' '),
    cover: input.cover !== false, promotion: { enabled: input.promotion?.enabled === true, brandName: input.promotion?.brandName || '',
      industryId: input.promotion?.industryId || null, showTypes: input.promotion?.showTypes || [] },
    partition: selected ? { partitionTaxonomy: input.partitionTaxonomy, tid: Number(input.tid), humanType2: Number(input.humanType2) || 0 } : null };
}
const formKey = value => JSON.stringify(value);
function persistEdit(id) {
  const entry = formEdits.get(id);
  try {
    if (entry && formKey(entry.form) !== formKey(entry.baseline)) sessionStorage.setItem(editKey(id), JSON.stringify(entry));
    else sessionStorage.removeItem(editKey(id));
  } catch { /* 切换时仍保留内存草稿；离开页面仍有未保存提醒。 */ }
}
function rememberEdit() {
  if (!P.current || !P.draft || !formEdits.has(P.current)) return;
  const entry = formEdits.get(P.current);
  entry.form = localForm(readForm());
  if (!P.catalog && desiredPartition) entry.form.partition = desiredPartition;
  persistEdit(P.current); paintFormStatus();
}
function paintFormStatus() {
  const entry = formEdits.get(P.current), dirty = entry && formKey(entry.form) !== formKey(entry.baseline);
  const conflict = entry && P.draft && entry.revision !== (P.draft.savedForm?.revision || 0);
  $p('#pubSaveForm').disabled = !P.draft || formSaving || P.busy;
  $p('#pubRestoreForm').disabled = !P.draft || formSaving || P.busy;
  $p('#pubSaveForm').textContent = formSaving ? '正在保存…' : '保存作品投稿资料';
  $p('#pubFormStatus').textContent = !P.draft ? '先选择作品。'
    : conflict ? '服务器已有其他版本；本页编辑已保留，保存前请先读取并核对已保存资料。'
      : dirty ? '有尚未保存的修改；已暂存本页，切换作品不会丢失，自动发布仍用上次保存的资料。'
        : P.draft.savedForm ? '已保存至本机 · ' + new Date(P.draft.savedForm.savedAt).toLocaleString('zh-CN')
          : '当前来自项目原始文案，尚未保存独立投稿资料。';
}
function applyDesiredPartition() {
  if (desiredPartition === undefined || !P.catalog) return;
  const select = $p('#pubPartition');
  if (!desiredPartition) { select.value = ''; return; }
  const value = String(P.catalog.human ? desiredPartition.humanType2 : desiredPartition.tid);
  if (desiredPartition.partitionTaxonomy === P.catalog.taxonomy && [...select.options].some(option => option.value === value)) select.value = value;
  else { select.value = ''; $p('#pubPartitionHint').textContent = '保存的分区不在当前账号列表中，请重新选择；不会自动转换编号。'; }
}
async function saveForm() {
  if (!P.current || !P.draft || formSaving || P.busy) return;
  rememberEdit();
  const id = P.current, entry = formEdits.get(id), input = readForm();
  const submitted = localForm(input);
  formSaving = true; paintFormStatus();
  try {
    const result = await call('/form', { method: 'POST', body: { id, revision: entry.revision, form: input } });
    const saved = result.savedForm;
    if (!saved?.fields || !Number.isInteger(saved.revision)) throw new Error('保存回执无效，请检查工作台版本');
    const target = formEdits.get(id);
    target.baseline = localForm({ ...saved.fields, ...saved.partition }); target.revision = saved.revision; target.inheritPartition = false;
    const apply = item => { if (item) Object.assign(item, { savedForm: saved, title: saved.fields.title, desc: saved.fields.desc,
      tags: saved.fields.tags, coverWanted: saved.fields.cover, promotion: saved.fields.promotion }); };
    apply(draftCache.get(id)); apply(P.projects.find(item => item.id === id)); if (P.current === id) apply(P.draft);
    persistEdit(id);
    if (P.current === id) setNotice('作品投稿资料已保存，商业声明也已保存；未发布、未启用排程。' +
      (formKey(target.form) !== formKey(submitted) ? ' 保存期间新增的修改仍未保存。' : ''), 'ok');
  } catch (error) {
    if (P.current === id) setNotice('投稿资料保存失败：' + error.message + '。本页编辑保留，自动发布仍用原有资料。', 'bad');
  } finally { formSaving = false; paintFormStatus(); }
}
async function restoreForm() {
  if (!P.current || !P.draft || formSaving || P.busy) return;
  const entry = formEdits.get(P.current);
  if (entry && formKey(entry.form) !== formKey(entry.baseline) && !confirm('读取已保存资料会替换本作品当前尚未保存的编辑，确认继续？')) return;
  const id = P.current, revision = formRevision;
  try {
    const data = await call('/projects');
    if (id !== P.current || revision !== formRevision) { setNotice('读取期间编辑已变化，未覆盖当前表单。'); return; }
    const item = data.projects?.find(item => item.id === id);
    if (!item || item.error) throw new Error(item?.error || '项目资料不可用');
    formEdits.delete(id); try { sessionStorage.removeItem(editKey(id)); } catch {}
    draftCache.set(id, item); P.draft = item; invalidatePlan(); paintForm(); plan({ silent: true });
    setNotice('已载入服务器当前保存的资料；没有独立保存时使用项目原文案。');
  } catch (error) { setNotice('读取失败：' + error.message + '，未覆盖当前编辑。', 'bad'); }
}
function invalidatePlan() {
  clearTimeout(planTimer);
  formRevision++;
  planRequest++;
  P.plan = null;
  P.planError = '';
}
function onFormEdit() {
  rememberEdit();
  invalidatePlan();
  paintSummary(); paintReadiness(); paintDescCount();
  // Uses the existing local-only plan endpoint, not a model or a submission.
  planTimer = setTimeout(() => plan({ silent: true }), 500);
}

async function loadDraft(id) {
  if (P.busy) { setNotice('正在核对或投稿，请等本次处理结束后再切换作品。'); return; }
  rememberEdit();
  const revision = ++draftRevision;
  invalidatePlan();
  P.current = id;
  P.draft = null;
  P.refs = null;
  desiredPartition = undefined;
  paintForm();
  paintProjects();
  setNotice('正在读取「' + id + '」…');
  try {
    if (!draftCache.has(id)) {
      const data = await call('/projects');
      if (revision !== draftRevision) return;
      draftCache = new Map((data.projects || []).map(item => [item.id, item]));
      if (data.projects) P.projects = data.projects;
    }
    P.draft = draftCache.get(id) || null;
    P.refs = null;
    paintForm();
    loadReferences(id);
    setNotice('');
    // 选中项目后自动试运行一次：用户不必先点一下才知道缺什么。
    plan({ silent: true });
  } catch (error) {
    if (revision !== draftRevision) return;
    setNotice('读取失败：' + error.message, 'bad');
  }
  paintProjects();
}

function paintForm() {
  const item = P.draft;
  if (!P.current || !item) {
    promotionPanel?.setProject(null);
    for (const id of ['#pubTitle', '#pubTags', '#pubDesc']) $p(id).value = '';
    const badge = $p('#pubReadyBadge');
    if (badge) { badge.textContent = P.current ? '读取中…' : ''; badge.className = 'pill'; }
    paintCoverField();
    paintSummary(); paintReadiness();
    paintFormStatus();
    return;
  }
  if (!formEdits.has(P.current)) {
    const inherited = readForm();
    const partition = item.savedForm ? item.savedForm.partition : { partitionTaxonomy: inherited.partitionTaxonomy, tid: inherited.tid, humanType2: inherited.humanType2 };
    const initial = localForm({ title: item.title, tags: item.tags, desc: item.desc, cover: item.coverWanted, promotion: item.promotion, ...partition });
    let cached;
    try { cached = JSON.parse(sessionStorage.getItem(editKey(P.current)) || 'null'); } catch {}
    const valid = cached?.form && cached?.baseline && Number.isInteger(cached.revision) && typeof cached.form.title === 'string' && typeof cached.form.tags === 'string' && typeof cached.form.desc === 'string';
    formEdits.set(P.current, valid ? cached : { form: initial, baseline: structuredClone(initial), revision: item.savedForm?.revision || 0, inheritPartition: !item.savedForm });
  }
  const local = formEdits.get(P.current).form;
  $p('#pubTitle').value = local.title;
  $p('#pubTags').value = local.tags;
  $p('#pubDesc').value = local.desc;
  P.coverWanted = local.cover;
  promotionPanel?.setProject(P.current, local.promotion);
  desiredPartition = formEdits.get(P.current).inheritPartition ? undefined : local.partition; applyDesiredPartition();
  const badge = $p('#pubReadyBadge');
  if (badge) {
    badge.textContent = item.hasVideo ? '素材已载入，表单待检查' : '缺成片';
    badge.className = 'pill';
  }
  updateTitleCount();
  paintDescCount();
  paintCoverField();
  paintReadiness();
  paintFormStatus();
}

/* 封面：左边是缩略图 + 实际文件信息，右边一个勾选。旧版只有一个裸复选框
 * 撑满整行，看着像没加载完；现在先给出「有没有、是哪张」，再谈发不发。 */
function paintCoverField() {
  const box = $p('#pubCoverBox');
  if (!box) return;
  const item = P.draft;
  const usable = Boolean(item?.cover);
  const wanted = P.coverWanted !== false;
  box.className = 'pub-cover' + (!usable && wanted ? ' bad' : '') + (wanted ? '' : ' off');
  box.innerHTML = '';

  if (usable) {
    const thumb = document.createElement('img');
    thumb.className = 'pub-cover-thumb';
    // 缩略图走同源静态文件；加载失败时退回文字，不留破图。
    thumb.src = '/projects/' + encodeURIComponent(P.current) + '/out/cover/' + encodeURIComponent(item.cover.file);
    thumb.alt = '封面预览';
    thumb.loading = 'lazy';
    thumb.onerror = () => { thumb.remove(); };
    box.appendChild(thumb);
  }

  const meta = document.createElement('div');
  meta.className = 'pub-cover-meta';
  const name = document.createElement('strong');
  name.textContent = usable ? item.cover.file : wanted ? '没有可用封面' : '本次不上传封面';
  const detail = document.createElement('small');
  detail.textContent = !wanted ? '本次请求不会携带封面图片' : usable
    ? fmtBytes(item.cover.bytes) + ' · 16:9'
    : (item?.coverIssue?.reason || item?.cover?.reason || '还没有生成封面');
  meta.append(name, detail);
  box.appendChild(meta);

  const toggle = document.createElement('label');
  toggle.className = 'pub-cover-toggle';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.id = 'pubCover';
  check.checked = wanted;
  check.disabled = P.busy;
  check.onchange = () => { P.coverWanted = check.checked; onFormEdit(); paintCoverField(); };
  const text = document.createElement('span');
  text.textContent = '投稿时上传封面';
  toggle.append(check, text);
  box.appendChild(toggle);
}

/* 链接来自项目里已经写下的东西（claims.json 或 脚本.md 的「数字与来源」）。
 * 这里只做展示与追加：判断哪条该留、链接通不通，是人的事。 */
async function loadReferences(id) {
  const revision = ++refsRequest, draft = draftRevision;
  const box = $p('#pubRefsBody');
  if (box) box.classList.add('hidden');
  const count = $p('#pubRefsCount');
  const note = $p('#pubRefsNote');
  if (count) count.textContent = '（读取中）';
  if (note) note.textContent = '';
  try {
    const refs = await call('/references', { method: 'POST', body: { id } });
    if (P.current !== id || draft !== draftRevision || revision !== refsRequest) return;
    P.refs = refs;
    const missing = Array.isArray(refs.missing) ? refs.missing.length : 0;
    if (count) count.textContent = P.refs.sources.length ? '（' + P.refs.sources.length + ' 条）' : '（无）';
    if (note) note.textContent = P.refs.sources.length
      ? (missing ? `有 ${missing} 条来源还没进简介，可用下方「追加到简介」补上；未核证链接可达性。`
        : '简介已含全部来源链接；未核证链接可达性。')
      : '项目里没有登记来源，无法生成参考链接。';
    paintReferences();
  } catch (error) {
    if (P.current !== id || draft !== draftRevision || revision !== refsRequest) return;
    P.refs = null;
    if (count) count.textContent = '（读取失败）';
    if (note) note.textContent = error.message;
  }
}

function paintReferences() {
  const list = $p('#pubRefsList');
  if (!list || !P.refs) return;
  list.innerHTML = '';
  P.refs.sources.forEach((item, index) => {
    const row = document.createElement('label');
    row.className = 'pub-ref-item';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = true;
    check.dataset.index = String(index);
    const text = document.createElement('span');
    text.innerHTML = `<span class="ref-label">${esc(item.label || item.url)}</span><br>` +
      `<span class="ref-url">${esc(item.url)}</span>`;
    row.append(check, text);
    list.appendChild(row);
  });
}

function selectedReferences() {
  if (!P.refs?.sources) return [];
  const boxes = [...document.querySelectorAll('#pubRefsList input[type=checkbox]')];
  return boxes.filter(box => box.checked)
    .map(box => P.refs.sources[Number(box.dataset.index)])
    .filter(Boolean);
}

async function appendReferences() {
  const picked = selectedReferences();
  if (!picked.length) { setNotice('先勾选要追加的参考链接。', 'bad'); return; }
  /* 合并规则只在后端实现一次：前端把「勾了哪些 + 当前简介」发过去，
   * 拿回已经裁到字数上限的成品。前端不复制 2000 字上限那套逻辑。 */
  const id = P.current, revision = draftRevision, desc = $p('#pubDesc').value;
  try {
    const result = await call('/references', {
      method: 'POST',
      body: { id, desc, urls: picked.map(item => item.url) },
    });
    if (id !== P.current || revision !== draftRevision) return;
    if ($p('#pubDesc').value !== desc) { setNotice('简介已修改，未覆盖当前内容。请再次追加参考链接。'); return; }
    if (!result.merged) { setNotice(result.note || '没有可追加的内容。', 'bad'); return; }
    $p('#pubDesc').value = result.merged;
    onFormEdit();
    setNotice(`已追加 ${result.added} 条到简介` +
      (result.roomDropped ? `（${result.roomDropped} 条因超出 2000 字未放，可删短简介后再追加）` : '') +
      (result.capDropped ? `（另有 ${result.capDropped} 条超过每次 10 条的排版上限，分次追加即可）` : '') + '。', 'ok');
  } catch (error) { if (id === P.current && revision === draftRevision) setNotice('追加失败：' + error.message, 'bad'); }
}

/* ---------- 就绪状态（底部操作栏那一行） ---------- */
function currentProblems() {
  const problems = [...(P.plan?.problems || [])];
  if (!P.draft) problems.push('正在读取项目');
  else if (!P.plan) problems.push(P.planError || '正在检查投稿信息');
  const title = $p('#pubTitle').value.trim();
  const tags = $p('#pubTags').value.trim();
  const partition = $p('#pubPartition').value;
  if (!title) problems.push('标题不能为空');
  if (!tags) problems.push('至少填一个标签');
  if (!partition) problems.push('请选择投稿分区');
  if (!P.overview?.account?.loggedIn) problems.push('还没有登录');
  else if (P.overview?.ready && !P.overview.ready.ok) problems.push('投稿体检未通过');
  if (promotionPanel?.read().enabled && P.plan && P.plan.promotionSupported !== true) problems.push('后端尚不支持商业声明，请在无制作或投稿运行时安全重启工作台');
  else if (promotionPanel?.read().enabled && P.plan && P.plan.promotionProtocolVersion !== 2) problems.push('后端尚未接入营销内容标注，请在空闲时安全重启工作台后重新检查');
  if (P.draft?.publication?.state === 'submitted') problems.push('当前成片已有投稿记录，不会重复提交');
  /* 同一个缺项会被两处各算一次（前端必填判断 + 后端 validate）。
   * 人看到的是一件事，去重时按语义归并，不按字符串——两边措辞不同。 */
  const seen = new Set();
  return problems.filter(text => {
    const key = /分区/.test(text) ? 'partition'
      : /标题/.test(text) ? 'title'
        : /标签/.test(text) ? 'tags'
          : /登录/.test(text) ? 'login'
            : /体检/.test(text) ? 'ready'
              : text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function paintReadiness() {
  const line = $p('#pubReady');
  const submit = $p('#pubSubmit');
  const problems = currentProblems();
  if (line) {
    if (!P.current) { line.textContent = '选择一支作品，准备投稿。'; line.className = ''; }
    else if (!P.draft) { line.textContent = '正在载入作品…'; line.className = ''; }
    else if (!P.plan && !P.planError) { line.textContent = '正在检查当前投稿信息…'; line.className = ''; }
    else if (problems.length) { line.textContent = '请处理：' + problems.join('；'); line.className = 'blocked'; }
    else { line.textContent = '当前表单可提交；尚未投稿，不代表平台审核通过'; line.className = 'ready'; }
  }
  // 缺项高亮：不弹错误框，直接标在输入框上。
  const mark = (id, missing) => {
    const field = $p(id);
    if (field) field.classList.toggle('needs', Boolean(missing));
  };
  mark('#fieldTitle', P.current && !$p('#pubTitle').value.trim());
  mark('#fieldTags', P.current && !$p('#pubTags').value.trim());
  mark('#fieldPartition', P.current && !$p('#pubPartition').value);
  if (submit) submit.disabled = P.busy || !P.current || problems.length > 0;
  const badge = $p('#pubReadyBadge');
  if (badge && P.draft) { badge.textContent = !P.plan ? '表单待检查' : problems.length ? '表单待处理' : '当前表单可提交'; badge.className = 'pill' + (problems.length ? '' : ' ok'); }
  updateTitleCount();
}

function paintDescCount() {
  const box = $p('#pubDescCount');
  const area = $p('#pubDesc');
  if (!box || !area) return;
  const n = area.value.trim().length;
  const limit = P.refs?.limit || 2000;
  box.textContent = n + ' / ' + limit;
  box.style.color = n > limit ? 'var(--bad)' : '';
}

function updateTitleCount() {
  const input = $p('#pubTitle');
  const label = $p('#pubTitleCount');
  if (!input || !label) return;
  const n = input.value.trim().length;
  label.textContent = n + ' / 80';
  label.style.color = n > 80 ? 'var(--bad)' : '';
}

/* ---------- 摘要（人读的） ---------- */
function paintSummary() {
  const box = $p('#pubSummary');
  const issues = $p('#pubIssues');
  const json = $p('#pubJson');
  if (!box) return;
  const item = P.draft;
  const plan = P.plan;
  if (!P.current) { box.innerHTML = '<p class="pub-hint">先在左边选一个项目。</p>'; if (issues) issues.innerHTML = ''; return; }

  const partitionText = $p('#pubPartition').selectedOptions?.[0]?.textContent || '未选择';
  const video = item?.video ? `${item.video.file} · ${fmtBytes(item.video.bytes)}` + (item.video.duration ? ' · ' + fmtSec(item.video.duration) : '') : '无';
  const cover = P.coverWanted === false ? '本次不上传封面' : item?.cover ? `${item.cover.file} · ${fmtBytes(item.cover.bytes)}` : '无';
  const tagCount = ($p('#pubTags').value.trim().split(/[\s,，、]+/).filter(Boolean)).length;

  box.innerHTML =
    '<dl class="pub-summary">' +
    `<dt>标题</dt><dd>${esc($p('#pubTitle').value.trim() || '（空）')}</dd>` +
    `<dt>分区</dt><dd>${esc(partitionText)}</dd>` +
    `<dt>标签</dt><dd>${tagCount ? tagCount + ' 个：' + esc($p('#pubTags').value.trim()) : '（空）'}</dd>` +
    `<dt>商业声明</dt><dd>${esc(promotionPanel?.describe() || '未勾选商业推广')}</dd>` +
    `<dt>成片</dt><dd class="${item?.video ? 'ok' : 'bad'}">${esc(video)}</dd>` +
    `<dt>封面</dt><dd class="${P.coverWanted === false || item?.cover ? 'ok' : 'bad'}">${esc(cover)}</dd>` +
    '</dl>';

  if (issues) {
    issues.innerHTML = '';
    // 顶部只留结论：缺项已经高亮在输入框上、底部栏也写着「还差什么」。
    const blocking = (plan?.problems || []).filter(text => !/分区|标题|标签/.test(text));
    for (const problem of blocking) {
      issues.insertAdjacentHTML('beforeend', `<div class="pub-block bad">✗ ${esc(problem)}</div>`);
    }
    /* 提醒分两级：
     *   硬问题（成片过期、封面不可用）单独红/黄块，并直接给出下一步按钮/命令；
     *   审阅与文案版本的说明并成一行灰字——它们每次都在，单独占三行会淹掉真正要说的事。 */
    const hard = [], soft = [];
    let coverAction = null;
    for (const warn of plan?.warnings || []) {
      const code = String(warn.code || '');
      if (P.coverWanted === false && ['no-cover', 'cover-issue'].includes(code)) continue;
      const text = String(warn.text || '').replace(/ENOENT[^；]*?open\s+'?[^'\n]+'?/g, '（文件不存在）');
      if (['video-stale', 'no-video', 'no-cover', 'cover-issue'].includes(code)) {
        hard.push(text);
        if (code === 'no-cover' || code === 'cover-issue') coverAction = text;
      } else soft.push(text);
    }
    for (const text of [...new Set(hard)]) {
      issues.insertAdjacentHTML('beforeend', `<div class="pub-block warn">⚠ ${esc(text)}</div>`);
    }
    // 封面问题最常见且多半只需重生成：给一条可直接复制的命令，而不是让人自己猜。
    if (coverAction) {
      issues.insertAdjacentHTML('beforeend',
        '<div class="pub-block note">封面可在终端运行 <code>node vh.mjs cover --dir projects/</code>' +
        esc(P.current || '') + ' 重新生成；只想先发布可以先取消勾选上传封面（投稿仍可成功）。</div>');
    }
    if (soft.length) {
      const summary = /review|审阅/.test(soft.join('')) ? '程序未核对人工审阅与出处；发布前请自己确认画面、听感和片中数字。' : '';
      issues.insertAdjacentHTML('beforeend', `<div class="pub-block note">ℹ ${esc(summary || soft[0])}</div>`);
    }
  }
  if (json) json.textContent = plan?.payload ? JSON.stringify(plan.payload, null, 2) : '暂无当前表单的检查结果。';
}

/* ---------- 分区 ---------- */
function partitionFields(selected, catalog = {}) {
  /* 分区模式与兼容 tid 由后端给；两个表单各自提供所选编号。 */
  return { partitionTaxonomy: catalog.taxonomy,
    humanType2: catalog.human ? selected : 0, tid: catalog.human ? catalog.compatTid : selected };
}
function paintPartitions() {
  const select = $p('#pubPartition');
  if (!select) return;
  const keep = select.value;
  select.innerHTML = '<option value="">— 请选择分区 —</option>';
  const groups = new Map();
  for (const item of P.partitions) {
    const parent = item.parent || '其他';
    if (!groups.has(parent)) {
      const group = document.createElement('optgroup');
      group.label = parent;
      groups.set(parent, group);
      select.appendChild(group);
    }
    const option = document.createElement('option');
    option.value = String(item.id);
    option.textContent = item.name + '（' + item.id + '）';
    if (item.description) option.title = item.description;
    groups.get(parent).appendChild(option);
  }
  const last = String(localStorage.getItem('vh.publish.partition') || '');
  const hint = $p('#pubPartitionHint');
  if (last && [...select.options].some(o => o.value === last)) {
    if (keep && [...select.options].some(o => o.value === keep)) select.value = keep;
    else {
      select.value = last;
      if (hint) hint.textContent = '沿用上次：' + (select.selectedOptions[0]?.textContent || '');
    }
  } else if (keep) select.value = keep;
  if (hint && !hint.textContent) {
    hint.textContent = P.catalog?.human ? '当前账号：新版分区' : '当前账号：旧版分区';
  }
  applyDesiredPartition();
  const entry = formEdits.get(P.current);
  if (entry?.inheritPartition) {
    const partition = localForm(readForm()).partition;
    entry.form.partition = partition; entry.baseline.partition = structuredClone(partition); persistEdit(P.current);
  }
}

function paintSelection() { schedulePanel?.paintSelection(); }

/* ---------- 试运行 ---------- */
async function plan({ silent = false } = {}) {
  if (!P.current || !P.draft) return;
  clearTimeout(planTimer);
  const revision = formRevision, request = ++planRequest, id = P.current;
  // 投稿校验依赖分区目录/上次选项。仅等待这条读取，不阻塞排程或来源；
  // 等待期间切项目或改表单时，原请求仍须作废，不能补发一次旧校验。
  await partitionsReady;
  if (id !== P.current || revision !== formRevision || request !== planRequest) return;
  const input = readForm();
  try {
    const result = await call('/plan', { method: 'POST', body: input });
    if (input.id !== P.current || revision !== formRevision || request !== planRequest) return;
    P.plan = result; P.planError = '';
    if (input.problems.length) P.plan.problems = [...new Set([...(P.plan.problems || []), ...input.problems])];
    paintSummary();
    paintReadiness();
    if (!silent) setNotice(P.plan.problems?.length ? '请先补全或修改提示的投稿信息。' : '投稿信息检查通过，尚未上传或投稿。', P.plan.problems?.length ? 'bad' : 'ok');
  } catch (error) {
    if (input.id !== P.current || revision !== formRevision || request !== planRequest) return;
    P.plan = null; P.planError = '检查失败，请重试：' + error.message;
    paintSummary(); paintReadiness();
    if (!silent) setNotice('试运行失败：' + error.message, 'bad');
  }
}

function readForm() {
  const catalog = P.catalog || {};
  const selected = Number($p('#pubPartition').value) || 0;
  const problems = [];
  if (!P.current) problems.push('没有选中项目');
  if (!selected) problems.push('请选择投稿分区');
  return {
    id: P.current,
    expectedAccountKey: P.overview?.accountKey,
    title: $p('#pubTitle').value.trim(),
    tags: $p('#pubTags').value.trim(),
    desc: $p('#pubDesc').value.trim(),
    ...partitionFields(selected, catalog),
    copyright: 1, noReprint: false, cover: P.coverWanted !== false,
    promotion: promotionPanel?.read(),
    problems,
  };
}

/* ---------- 提交 ---------- */
function paintBusy() {
  for (const node of document.querySelectorAll('#pubFormCard input, #pubFormCard textarea, #pubFormCard select, #pubPlanBtn, #pubAccount, #pubReload, #pubRefsAppend')) node.disabled = P.busy;
  paintReadiness(); paintFormStatus();
}
let progressToken = null;
function beginProgress(input, progressId) {
  const token = {}; progressToken = token;
  const box = $p('#pubUpload'), bar = $p('#pubUploadBar'), stage = $p('#pubUploadStage'), info = $p('#pubUploadInfo');
  box.hidden = false; bar.removeAttribute('value'); stage.textContent = '核对投稿资料'; info.textContent = '等待服务端进度；尚未确认平台收稿。';
  let reading = false;
  const refresh = async () => {
    if (reading || progressToken !== token) return;
    reading = true;
    try {
      const data = await call('/progress?id=' + encodeURIComponent(input.id) + '&progressId=' + encodeURIComponent(progressId));
      if (progressToken !== token) return;
      if (!data.available) { info.textContent = '暂未取得本次进度，不代表失败或未投稿；请等待提交回执。'; return; }
      stage.textContent = data.stage;
      if (Number.isFinite(data.total) && data.total > 0 && Number.isFinite(data.bytes)) {
        const percent = Math.max(0, Math.min(100, data.bytes / data.total * 100)); bar.value = percent;
        info.textContent = `视频已传 ${Math.floor(percent)}% · ${fmtBytes(data.bytes)} / ${fmtBytes(data.total)} · 已用 ${Math.floor(data.elapsedMs / 1000)} 秒（上传完成不等于已发布）`;
      } else { bar.removeAttribute('value'); info.textContent = `已用 ${Math.floor(data.elapsedMs / 1000)} 秒 · 当前阶段尚无可测百分比`; }
    } catch { if (progressToken === token) info.textContent = '进度连接暂不可用；不代表投稿失败，请等待提交回执，勿重复提交。'; }
    finally { reading = false; }
  };
  const timer = setInterval(refresh, 1000); void refresh();
  return result => {
    clearInterval(timer); if (progressToken !== token) return;
    progressToken = null;
    stage.textContent = result?.ok ? '平台已收稿' : result?.outcome === 'unknown' ? '投稿结果未知，需人工核对' : '本次处理已结束';
    info.textContent = result?.ok ? (result.declarationVerification?.message || '仍需到稿件管理查看审核与公开状态。') : result?.message || '请查看上方的处理提示。';
  };
}
async function submitOne() {
  if (P.busy) return;
  if (!P.overview?.account?.loggedIn) { openLogin(); return; }
  const input = readForm();
  const problems = currentProblems();
  if (problems.length) { setNotice('还不能提交：' + problems.join('；'), 'bad'); return; }
  P.busy = true; paintBusy();

  /* 提交前的本地防护：冷却中、同一支发过、上次结果未知。
   * 检查在弹确认框之前——先让人知道"现在不该点"，再谈提交什么。
   * duplicate / unknown 一律阻断：普通确认不能越过保护，也不在这里
   * 承诺"再点一次就能发"（那会产生重复稿件）。 */
  let finishProgress;
  try {
    const gate = await call('/preflight', { method: 'POST', body: { id: input.id } });
    if (!gate.ok) {
      setNotice((gate.message || '提交保护未通过') +
        (gate.reason === 'unknown' || gate.reason === 'submitting'
          ? '\n请先到 B 站稿件管理核对是否已有稿件；本工具不会自动重发。' : ''), 'bad');
      return;
    }
    const where = $p('#pubPartition').selectedOptions[0]?.textContent || '未选';
    if (!confirm(`确认投稿？\n\n作品：${input.id}\n账号：${P.overview?.account?.name || '当前账号'}\n标题：${input.title}\n分区：${where}\n标签：${input.tags}\n封面：${input.cover ? '上传当前封面' : '不上传'}\n商业声明：${promotionPanel.describe(input.promotion)}\n\n本次使用当前表单，不会自动保存资料或启用排程。提交后需去 B 站稿件管理里删改。`)) return;
    const btn = $p('#pubSubmit');
    btn.textContent = '提交中…';
    setNotice('正在上传视频，先不要关页面…');

    const progressId = crypto.randomUUID(); finishProgress = beginProgress(input, progressId);
    let result;
    try { result = await call('/submit', { method: 'POST', body: { ...input, progressId, confirmed: true } }); }
    catch (error) { throw Object.assign(error, { outcome: error.outcome || 'unknown' }); }
    finishProgress(result); finishProgress = null;
    if (!result?.ok) {
      setNotice(describeFailure(result), 'bad');
      return;
    }
    const bvid = result.bvid || '';
    const check = result.declarationVerification;
    const declarationConfirmed = check?.state === 'confirmed' && check.expectedId === 3 && check.actualId === 3;
    const declarationNotice = input.promotion?.enabled ? '\n' + (declarationConfirmed
      ? '平台资料已确认「内容含营销信息」；不代表观众端已显示或审核通过。'
      : check?.message || '营销声明尚未确认。稿件已收下，请到创作中心人工核对，不要重发。') : '';
    const noticeKind = input.promotion?.enabled && !declarationConfirmed ? 'bad' : 'ok';
    setNotice('平台已收稿' + (bvid ? '：' + bvid : '') + declarationNotice + '\n请到「稿件管理」确认审核与公开状态。', noticeKind);
    if (bvid) {
      call('/verify', { method: 'POST', body: { bvid } })
        .then(found => { if (found.found) setNotice(`✓ 已在稿件管理确认：${found.stateDesc || '已创建'} · ${found.title || ''}` + declarationNotice, noticeKind); })
        .catch(() => {});
    }
    invalidatePlan(); await refreshProjects(); plan({ silent: true });
  } catch (error) {
    finishProgress?.(error);
    setNotice(error.outcome ? describeFailure(error) : '提交保护检查失败：' + error.message + '。未上传，请稍后重试。', 'bad');
  } finally {
    P.busy = false;
    $p('#pubSubmit').textContent = '提交投稿';
    paintBusy();
  }
}

/* 把后端给的失败翻译成"现在该做什么"，而不是复述原始错误。
 * 失败分三类，处置完全不同：
 *   没发出去 → 可以改完再试
 *   要等     → 给一个具体时间
 *   结果未知 → 先去查，不要重试 */
function describeFailure(payload) {
  const message = payload?.message || payload?.error || '未知错误';
  const kind = payload?.kind;
  if (kind === 'rate') {
    const wait = Math.round((payload.waitMs || 600000) / 60000);
    return `B 站要求放慢提交频率（${message}）\n\n没有稿件被创建。保守等待约 ${wait} 分钟后可以再点提交；期间不要在批量里换别的视频接着发，风控是按账号算的。`;
  }
  if (kind === 'risk') return `账号被风控拦截。\n\n${message}\n\n先到 B 站创作中心确认账号状态与登录态，不建议反复重试。`;
  if (kind === 'auth') return `登录态无效或已过期。\n\n${message}\n\n点右上角重新扫码登录后再提交。`;
  if (kind === 'unknown' || payload?.outcome === 'unknown') {
    return `结果未知：${message}\n\n请求可能已经送达。先去 B 站「稿件管理」人工核对；不会自动解除阻断或重发，等待也不代表可以重试。`;
  }
  if (kind === 'duplicate') return message;
  return `未提交成功：${message}${payload?.advice ? '\n\n' + payload.advice : ''}`;
}

/* ---------- 登录 ---------- */
async function openLogin() {
  const modal = $p('#pubLogin');
  if (!modal) return;
  modal.classList.remove('hidden');
  await refreshQr();
}

async function refreshQr() {
  $p('#pubQrStatus').textContent = '正在获取二维码…';
  clearInterval(P.qrTimer);
  try {
    const data = await call('/qr', { method: 'POST' });
    $p('#pubQrImg').src = data.image;
    $p('#pubQrStatus').textContent = '用手机 B 站 App 扫码';
    P.qrTimer = setInterval(async () => {
      try {
        const result = await call('/login', { method: 'POST' });
        if (result.state === 'waiting') return;
        if (result.state === 'scanned') { $p('#pubQrStatus').textContent = '已扫码，请在手机上确认'; return; }
        if (result.state === 'expired') { $p('#pubQrStatus').textContent = '二维码已过期，点「换一张」'; clearInterval(P.qrTimer); return; }
        if (result.state === 'ok') {
          clearInterval(P.qrTimer);
          $p('#pubQrStatus').textContent = '登录成功';
          $p('#pubLogin').classList.add('hidden');
          await boot();
        }
      } catch (error) { clearInterval(P.qrTimer); $p('#pubQrStatus').textContent = '登录失败：' + error.message; }
    }, 2000);
  } catch (error) { $p('#pubQrStatus').textContent = '获取二维码失败：' + error.message; }
}

/* ---------- 启动 ---------- */
export async function initPublishPage() {
  promotionPanel = attachPublishPromotion({ request: call, onEdit: onFormEdit, isBusy: () => P.busy });
  $p('#pubSaveForm').onclick = saveForm;
  $p('#pubRestoreForm').onclick = restoreForm;
  schedulePanel = attachPublishSchedule({
    request: call, getSelection: () => P.selected,
    getProjects: () => P.projects,
    setSelection: ids => { P.selected = ids; paintProjects(); },
    loggedIn: () => Boolean(P.overview?.account?.loggedIn), notice: setNotice,
  });
  $p('#pubReload').onclick = () => boot();
  $p('#pubAccount').onclick = () => openLogin();
  $p('#pubQrRefresh').onclick = () => refreshQr();
  $p('#pubQrClose').onclick = () => { $p('#pubLogin').classList.add('hidden'); clearInterval(P.qrTimer); };
  $p('#pubLogout').onclick = async () => { await call('/logout', { method: 'POST' }); await boot(); };
  $p('#pubPlanBtn').onclick = () => plan();
  $p('#pubSubmit').onclick = () => submitOne();

  $p('#pubRefsToggle').onclick = () => {
    $p('#pubRefsBody').classList.toggle('hidden');
  };  $p('#pubRefsAppend').onclick = () => appendReferences();

  $p('#pubPartition').onchange = event => {
    const entry = formEdits.get(P.current); if (entry) entry.inheritPartition = false;
    desiredPartition = localForm(readForm()).partition;
    rememberEdit();
    try { localStorage.setItem('vh.publish.partition', event.target.value); } catch { /* Private mode must not disable form validation. */ }
    const hint = $p('#pubPartitionHint');
    if (hint) hint.textContent = event.target.selectedOptions[0]?.textContent || '';
    invalidatePlan(); paintSummary(); paintReadiness();
    plan({ silent: true });
  };

  paintDescCount();
  for (const id of ['#pubTitle', '#pubTags', '#pubDesc']) $p(id).addEventListener('input', onFormEdit);

  // 快捷键：Cmd/Ctrl+Enter 提交，省得去够按钮。
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (!$p('#pubSubmit').disabled) submitOne();
    }
  });
  // 状态轮询只刷新项目元数据，不重载投稿输入、排程时间或已勾选队列。
  const projectTimer = setInterval(() => { if (!document.hidden) refreshProjects(); }, 15000);
  window.addEventListener('pagehide', () => clearInterval(projectTimer), { once: true });
  window.addEventListener('beforeunload', event => {
    if (P.busy || [...formEdits.values()].some(entry => formKey(entry.form) !== formKey(entry.baseline))) { event.preventDefault(); event.returnValue = ''; }
  });
  await boot();
}

let projectsRequest = 0, projectsReading = false;
async function refreshProjects({ selectFirst = false } = {}) {
  if (projectsReading) return;
  const version = ++projectsRequest;
  projectsReading = true;
  try {
    const data = await call('/projects');
    if (version !== projectsRequest) return;
    if (!Array.isArray(data.projects)) throw new Error('项目列表响应无效');
    P.projects = data.projects; P.projectsLoaded = true; P.projectsError = '';
    draftCache = new Map(P.projects.map(item => [item.id, item]));
    if (!P.current && selectFirst && P.projects.length) await loadDraft(P.projects[0].id);
    else if (P.current && draftCache.has(P.current)) {
      const next = draftCache.get(P.current), old = P.draft;
      P.draft = next;
      // 新成片/状态变化需要重查，但保留正在编辑的标题、标签、简介与分区。
      if (JSON.stringify([old?.video, old?.cover, old?.publication]) !== JSON.stringify([next.video, next.cover, next.publication])) {
        invalidatePlan(); plan({ silent: true });
      }
    }
    paintSummary(); paintReadiness(); paintFormStatus();
  } catch (error) {
    if (version === projectsRequest) P.projectsError = error.message;
  } finally {
    if (version === projectsRequest) { projectsReading = false; paintProjects(); }
  }
}

async function boot() {
  // 四条读取独立启动；账号/分区/项目失败不能让排程卡在初始化。
  partitionsReady = (async () => {
    try {
      const partitions = await call('/partitions');
      P.partitions = partitions.list || []; P.catalog = partitions;
      $p('#pubPartitionHint').textContent = '';
      paintPartitions();
      schedulePanel.setPartitions(P.partitions.map(item => ({
        ...partitionFields(Number(item.id), partitions), label: `${item.name}（${item.id}）`,
      })));
    } catch (error) {
      schedulePanel.setPartitions(null);
      $p('#pubPartitionHint').textContent = '分区读取失败，请刷新：' + error.message;
    }
    paintReadiness(); paintSummary();
  })();
  await Promise.allSettled([
    schedulePanel.refresh(),
    refreshProjects({ selectFirst: true }),
    (async () => {
      try { P.overview = await call('/overview'); P.overviewError = ''; }
      catch (error) { P.overviewError = error.message; P.overview = null; }
      paintAccount(); paintReadiness();
    })(),
    partitionsReady,
  ]);
}
