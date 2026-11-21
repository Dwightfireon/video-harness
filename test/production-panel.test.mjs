import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachProductionPanel, productionView } from '../www/production-panel.mjs';

function fixture() {
  return { version: 1, readOnly: true,
    automation: { enabled: true, maxRepairs: 2, source: 'web-default', activePolicy: null },
    task: { id: 'task-1', attemptId: 'attempt-1', status: 'failed', running: false, cancelling: false,
      canResume: true, stage: 'measure', error: { message: '旁白超时 <img onerror=alert(1)>' }, pausedReason: null },
    repair: { used: 1, limit: 2, phase: 'stopped', lastIssue: '旁白超时' },
    quality: { state: 'unverified', phase: 'final', checkedAt: '2026-10-24T10:00:00Z', verifiedAt: null,
      checks: [{ id: 'media', label: '媒体', state: 'failed', issues: [{ message: '需要重新配音', hint: '删减脚本' }] }], note: '旧检查记录', reason: null } };
}

/* 小型 DOM 替身只测试状态流；布局、原生键盘行为与 XSS 另由真实浏览器覆盖。 */
class Element {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.dataset = {}; this.childNodes = []; this.attributes = {}; this._text = ''; }
  set textContent(value) { this._text = String(value); this.childNodes = []; }
  get textContent() { return this._text + this.childNodes.map(child => child.textContent).join(''); }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.childNodes = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
}
function harness(handler, options = {}) {
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {},
    createElement(tag) { return new Element(tag, doc); }, createTextNode(value) { const node = new Element('#text', doc); node.textContent = value; return node; } };
  const root = doc.createElement('details'), calls = [];
  const panel = attachProductionPanel(root, { project: 'projects/测试 & x', autoStart: false,
    ...options,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return handler(url, options); } });
  const all = node => [node, ...node.childNodes.flatMap(all)];
  const action = name => all(root).find(node => node.dataset.action === name);
  const field = name => all(root).find(node => node.dataset.field === name);
  return { root, calls, panel, action, field, doc };
}
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });

test('生产面板追加：默认无confirm不授权，取消、只读刷新与核验无费用POST', async () => {
  const view = fixture();
  view.task.repairRecovery = { blocked: true, canExtend: true, additionalRepairs: 1, used: 2, limit: 2, targetLimit: 3 };
  for (const options of [{}, { confirmImpl: () => false }]) {
    const h = harness(() => response(view), options);
    await h.panel.refresh();
    assert.match(h.action('resume').textContent, /追加1轮修复并继续/);
    await h.action('resume').onclick(); await h.action('verify').onclick(); await h.panel.refresh();
    assert.ok(h.calls.every(call => !call.options.method));
    assert.equal(h.panel.getState().view.task.repairRecovery.limit, 2); h.panel.dispose();
  }
});

test('生产视图缺恢复字段但历史预算耗尽时禁用普通继续，提示重启；快照身份不同亦不可追加', () => {
  const view = fixture(); view.automation.activePolicy = { enabled: true, maxRepairs: 2 }; view.repair.used = 2;
  assert.equal(productionView(view).canResume, false);
  assert.match(productionView(view).recovery.reason, /重启工作台/);
  view.task.repairRecovery = { blocked: true, canExtend: true, additionalRepairs: 1, used: 2, limit: 2, targetLimit: 3 };
  assert.equal(productionView(view).canResume, true);
  assert.equal(productionView(view, { snapshot: { taskId: 'task-1', attemptId: 'new-attempt' } }).canResume, false);
});

test('生产面板追加：旧服务忽略JSON不得显示成功，新服务回证后才接受', async () => {
  for (const actualLimit of [2, 3]) {
    const view = fixture();
    view.task.repairRecovery = { blocked: true, canExtend: true, additionalRepairs: 1, used: 2, limit: 2, targetLimit: 3 };
    const h = harness((url, options) => {
      if (!url.includes('/resume')) return response(view);
      assert.deepEqual(JSON.parse(options.body), { additionalRepairs: 1, taskId: 'task-1', attemptId: 'attempt-1' });
      return response({ task: { taskId: 'task-1', automationSummary: { repairLimit: actualLimit, repairUsed: 2 } } });
    }, { confirmImpl: () => true });
    await h.panel.refresh(); await h.action('resume').onclick();
    assert.match(h.root.textContent, actualLimit === 2 ? /未确认.*重启工作台/s : /继续请求已接收/);
    if (actualLimit === 2) assert.doesNotMatch(h.root.textContent, /继续请求已接收/);
    assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1); h.panel.dispose();
  }
});

test('自动制作展示：默认模式、实际模式、修复预算和历史回执分开显示', () => {
  const view = fixture(); view.automation.activePolicy = { enabled: false, maxRepairs: 0 };
  const model = productionView(view);
  assert.match(model.policy, /默认生效.*2 轮.*网页默认/);
  assert.match(model.activePolicy, /非自动制作.*0 轮/);
  assert.match(model.repair, /1 \/ 2 轮/);
  assert.match(model.quality, /旧回执/); assert.match(model.historical, /不代表当前文件有效/);
  assert.match(model.verified, /无记录.*不重新核验媒体/);
  assert.ok(model.issues.some(issue => issue.includes('旁白超时')));
});

test('自动制作展示：任务完成不自动升级质检，强核验通过与 stale 分开', () => {
  const view = fixture(); view.task.status = 'completed'; view.task.canResume = false;
  assert.equal(productionView(view).qualityState, 'unverified');
  view.quality.state = 'passed'; view.quality.verifiedAt = '2026-10-24T10:05:00Z';
  assert.equal(productionView(view).qualityState, 'passed');
  view.quality.state = 'stale'; assert.match(productionView(view).quality, /产物有变化/);
  view.quality.state = 'passed'; view.quality.phase = 'pre-render';
  assert.match(productionView(view).quality, /渲染前.*非最终验收/);
});

test('自动制作按钮：运行、取消、CLI busy、孤儿进程、断连均不错误继续', () => {
  const view = fixture(); assert.equal(productionView(view).canResume, true);
  view.task.running = true;
  assert.equal(productionView(view).canResume, false); assert.equal(productionView(view).canCancel, true);
  assert.equal(productionView(view).canVerify, false);
  view.task.cancelling = true;
  assert.equal(productionView(view).canCancel, false); assert.equal(productionView(view).canSave, false);
  view.task.running = view.task.cancelling = false;
  const cli = productionView(view, { snapshot: { running: true, productionBusy: true, taskRunning: false } });
  assert.equal(cli.showCancel, false); assert.equal(cli.canResume, false); assert.equal(cli.canSave, false);
  const orphan = productionView(view, { snapshot: { orphanRunning: true } });
  assert.equal(orphan.canCancel, true); assert.equal(orphan.canResume, false);
  assert.equal(productionView(view, { stale: true }).canResume, false);
  assert.equal(productionView(view, { cancelPending: true }).canResume, false);
  view.task.productionBusy = true; view.task.taskRunning = false;
  assert.equal(productionView(view).showCancel, false); assert.equal(productionView(view).canResume, false);
  assert.equal(productionView(view, { snapshot: { productionBusy: false } }).showCancel, false);
  view.task.orphanRunning = true;
  assert.equal(productionView(view).canCancel, true); assert.equal(productionView(view).canResume, false);
});

test('自动制作：初始化和刷新只读 GET；断连保留视图且禁止动作', async () => {
  let offline = false;
  const h = harness(() => { if (offline) throw new Error('网络断开'); return response(fixture()); });
  await h.panel.refresh(); const prior = h.panel.getState().view;
  assert.match(h.calls[0].url, /p=projects%2F/);
  offline = true; await h.panel.refresh();
  assert.equal(h.panel.getState().view, prior); assert.equal(h.panel.getState().stale, true);
  assert.match(h.root.textContent, /非实时.*只重试读取/);
  assert.equal(h.action('resume').disabled, true);
  assert.ok(h.calls.every(call => !call.options.method)); h.panel.dispose();
});

test('自动制作：409 保存失败保留选择；后续轮询不能覆盖未保存选择或错误', async () => {
  const h = harness(url => response(url.includes('/settings') ? { error: '当前任务运行中' } : fixture(), url.includes('/settings') ? 409 : 200));
  await h.panel.refresh();
  h.field('enabled').checked = false; h.field('enabled').onchange();
  h.field('maxRepairs').value = '5'; h.field('maxRepairs').onchange();
  await h.action('save').onclick(); await h.panel.refresh();
  assert.equal(h.field('enabled').checked, false); assert.equal(h.field('maxRepairs').value, '5');
  assert.equal(h.panel.getState().dirty, true);
  assert.match(h.root.textContent, /保存失败.*当前任务运行中.*选择已保留/);
  const writes = h.calls.filter(call => call.options.method === 'POST');
  assert.equal(writes.length, 1); assert.deepEqual(JSON.parse(writes[0].options.body), { enabled: false, maxRepairs: 5 });
  h.panel.dispose();
});

test('自动制作：保存成功只改变未来策略，不启动生成或继续', async () => {
  const saved = fixture(); saved.automation.enabled = false; saved.automation.maxRepairs = 0;
  const h = harness(url => response(url.includes('/settings') ? saved : fixture()));
  await h.panel.refresh(); h.field('enabled').checked = false; h.field('enabled').onchange();
  h.field('maxRepairs').value = '0'; h.field('maxRepairs').onchange(); await h.action('save').onclick();
  assert.equal(h.panel.getState().dirty, false); assert.match(h.root.textContent, /没有启动或继续制作/);
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].url.includes('/production/settings?'), true); h.panel.dispose();
});

test('自动制作：取消收到 cancelling 仍显示待退出，不宣称已取消，不重复 POST', async () => {
  const view = fixture(); view.task.running = true; view.task.status = 'running';
  const h = harness(url => response(url.includes('/cancel') ? { cancelling: true, cancelled: false } : view));
  await h.panel.refresh(); await h.action('cancel').onclick();
  assert.equal(h.action('cancel').disabled, true); assert.equal(h.action('resume').disabled, true);
  assert.match(h.root.textContent, /尚未确认停止/); assert.doesNotMatch(h.root.textContent, /服务器确认.*已退出/);
  await h.action('cancel').onclick(); assert.equal(h.calls.filter(call => call.url.includes('/cancel')).length, 1); h.panel.dispose();
});

test('自动制作：失败取消与继续不假报成功，错误不会被读取轮询清除', async () => {
  for (const action of ['cancel', 'resume']) {
    const view = fixture(); view.task.running = action === 'cancel';
    const h = harness(url => response(url.includes('/chat/') ? { error: '服务拒绝请求' } : view, url.includes('/chat/') ? 409 : 200));
    await h.panel.refresh(); await h.action(action).onclick(); await h.panel.refresh();
    assert.match(h.root.textContent, /请求失败.*服务拒绝请求.*没有自动重试/);
    assert.doesNotMatch(h.root.textContent, /请求已接收|服务器确认/);
    assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1); h.panel.dispose();
  }
});

test('自动制作：强核验仅显式 GET verify=1，不发任何制作请求', async () => {
  const h = harness(url => { const value = fixture(); if (url.includes('verify=1')) { value.quality.state = 'stale'; value.quality.reason = '媒体版本已变化'; } return response(value); });
  await h.panel.refresh(); await h.action('verify').onclick();
  assert.match(h.root.textContent, /只读复核已返回：回执已过期/);
  assert.ok(h.calls[1].url.endsWith('&verify=1')); assert.ok(h.calls.every(call => !call.options.method)); h.panel.dispose();
});

test('自动制作：继续请求按后端 started/task 合同接受，等待任务更新期间不重复派发', async () => {
  const view = fixture();
  const h = harness(url => response(url.includes('/resume') ? { started: true, resumed: true, task: { id: 'task-1', status: 'starting' } } : view));
  await h.panel.refresh(); await h.action('resume').onclick();
  assert.match(h.root.textContent, /继续请求已接收.*不代表制作或质检成功/);
  assert.equal(h.action('resume').disabled, true);
  await h.action('resume').onclick(); assert.equal(h.calls.filter(call => call.url.includes('/resume')).length, 1);
  view.task.running = true; view.task.status = 'running'; await h.panel.refresh();
  assert.equal(h.action('resume').disabled, true); assert.equal(h.action('cancel').disabled, false); h.panel.dispose();
});

test('自动制作：只读复核被 409 拒绝不冒充断连或成功，仍保留历史检查', async () => {
  const h = harness(url => response(url.includes('verify=1') ? { error: '制作尚未结束' } : fixture(), url.includes('verify=1') ? 409 : 200));
  await h.panel.refresh(); await h.action('verify').onclick();
  assert.equal(h.panel.getState().stale, false);
  assert.match(h.root.textContent, /只读复核未完成.*制作尚未结束.*未认定通过/);
  assert.doesNotMatch(h.root.textContent, /连接异常|只读复核已返回/); h.panel.dispose();
});

test('自动制作：保存前发出的慢读取不能覆盖保存响应', async () => {
  let finishRead;
  const saved = fixture(); saved.automation.maxRepairs = 4;
  let reads = 0;
  const h = harness(url => url.includes('/settings') ? response(saved) : ++reads === 1 ? response(fixture())
    : new Promise(resolve => { finishRead = () => resolve(response(fixture())); }));
  await h.panel.refresh();
  h.field('maxRepairs').value = '4'; h.field('maxRepairs').onchange();
  const slowRead = h.panel.refresh();
  await h.action('save').onclick(); finishRead(); await slowRead;
  assert.equal(h.panel.getState().view.automation.maxRepairs, 4);
  assert.equal(h.field('maxRepairs').value, '4'); assert.equal(h.panel.getState().dirty, false); h.panel.dispose();
});

test('自动制作：后台不轮询，坏数据不会覆盖上次成功视图', async () => {
  let malformed = false;
  const h = harness(() => response(malformed ? {} : fixture()));
  await h.panel.refresh(); h.doc.hidden = true; await h.panel.refresh(); assert.equal(h.calls.length, 1);
  h.doc.hidden = false; malformed = true; await h.panel.refresh();
  assert.equal(h.panel.getState().view.version, 1); assert.equal(h.panel.getState().stale, true); h.panel.dispose();
});
test('正常提示不是错误卡点；用户折叠后轮询不强行重新展开', async () => {
  const value = fixture(); value.task.error = null; value.repair.lastIssue = null; value.quality.reason = '上次通过尚未复核';
  assert.deepEqual(productionView(value).issues, []);
  assert.equal(productionView(value).qualityReason, '上次通过尚未复核');
  const h = harness(() => response(value));
  await h.panel.refresh(); assert.equal(h.root.open, true);
  h.root.open = false; await h.panel.refresh(); assert.equal(h.root.open, false); h.panel.dispose();
});
