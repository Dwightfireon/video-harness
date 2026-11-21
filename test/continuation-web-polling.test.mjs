import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visiblePolling } from '../www/visible-polling.mjs';
import { endpoints, webFixture, wait } from './continuation-web-fixture.mjs';

const routes = [
  { name: 'panel', route: '/?p=projects/fixture', paths: endpoints.slice(0, 3) },
  { name: 'index', route: '/', paths: ['/_api/projects'] },
  { name: 'settings', route: '/_vh/settings.html', paths: ['/_api/projects'] },
];
const callsFor = (h, paths) => h.calls.filter(call => call.method === 'GET' && paths.includes(call.path));
async function until(check, timeout = 5000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) assert.fail('condition timed out'); await wait(10); }
}

test('共享调度：完成后等待、切换时在途不重叠、重复事件不添循环、错误可恢复、显式后台刷新与销毁', async () => {
  const doc = new EventTarget(); doc.hidden = true;
  const change = hidden => { doc.hidden = hidden; doc.dispatchEvent(new Event('visibilitychange')); };
  let count = 0, active = 0, maxActive = 0, release;
  const errors = [];
  const polling = visiblePolling(async () => {
    count++; active++; maxActive = Math.max(active, maxActive);
    try { await new Promise(resolve => { release = resolve; }); if (count === 1) throw new Error('read failed'); }
    finally { active--; }
  }, { doc, intervalMs: 30, onError: e => errors.push(e.message) });
  try {
    await wait(50); assert.equal(count, 0);
    change(false); change(true); await wait(50); assert.equal(count, 0, 'hide before queued automatic read starts');
    change(false); await until(() => count === 1);
    for (let i = 0; i < 8; i++) { change(true); change(false); }
    await wait(70); assert.equal(count, 1);
    release(); await until(() => count === 2);
    assert.deepEqual(errors, ['read failed']);
    for (let i = 0; i < 8; i++) change(false);
    release(); await wait(10); assert.equal(count, 2);
    change(true); await wait(60); assert.equal(count, 2);
    const explicit = polling.refresh(); await until(() => count === 3);
    assert.equal(polling.refresh(), explicit);
    release(); await explicit; await wait(60); assert.equal(count, 3);
    change(false); await until(() => count === 4);
    polling.dispose(); release(); await wait(70);
    assert.equal(count, 4); assert.equal(maxActive, 1);
  } finally { polling.dispose(); release?.(); }
});

for (const { name, route, paths } of routes) {
  test(`${name}真实HTTP：隐藏零轮询、恢复立即刷新、重复事件无新循环、断连恢复、不缓存成功`, { timeout: 30000 }, async () => {
    const h = await webFixture();
    try {
      const { page, errors } = await h.page(route, { hidden: true });
      await wait(5200); assert.equal(callsFor(h, paths).length, 0);
      const resume = Date.now();
      await page.evaluate(() => setControlledHidden(false));
      await until(() => paths.every(p => callsFor(h, [p]).some(call => call.start >= resume && call.end)));
      assert.ok(callsFor(h, paths).every(call => call.start - resume < 1000));
      for (const p of paths) assert.equal(callsFor(h, [p]).length, 1, 'one startup read, no duplicate load');
      await page.evaluate(() => { for (let i = 0; i < 20; i++) setControlledHidden(false); });
      await wait(300);
      for (const p of paths) assert.equal(callsFor(h, [p]).length, 1);
      await page.evaluate(() => setControlledHidden(true));
      for (const p of paths) h.controls.set(p, { fail: true });
      const failAt = Date.now(); await page.evaluate(() => setControlledHidden(false));
      await until(() => paths.every(p => callsFor(h, [p]).some(call => call.start >= failAt && call.status === 503)));
      if (name === 'panel') {
        await page.waitForFunction(() => document.querySelector('#stateConnection').textContent.includes('fixture unavailable') && document.querySelector('#chatError').textContent.includes('fixture unavailable') && document.querySelector('#formatStatus').textContent.includes('fixture unavailable'));
      } else if (name === 'index') {
        await page.waitForFunction(() => document.querySelector('#connectionStatus').textContent.includes('fixture unavailable'));
      }
      await page.evaluate(() => setControlledHidden(true));
      h.controls.clear();
      const freshAt = Date.now(); await page.evaluate(() => setControlledHidden(false));
      await until(() => paths.every(p => callsFor(h, [p]).some(call => call.start >= freshAt && call.status === 200)));
      if (name === 'panel') await page.waitForFunction(() => !document.querySelector('#stateConnection').textContent && document.querySelector('#chatError').classList.contains('hidden') && !document.querySelector('#formatStatus').textContent.includes('无法读取'));
      if (name === 'index') await page.waitForFunction(() => document.querySelector('#list').textContent.includes('fixture') && !document.querySelector('#connectionStatus').textContent);
      assert.deepEqual(errors, []);
    } finally { await h.close(); }
  });

  test(`${name}真实HTTP：慢请求与多轮visibility切换不重叠、不遗留多条定时循环`, { timeout: 30000 }, async () => {
    const h = await webFixture();
    try {
      for (const p of paths) h.controls.set(p, { delayMs: 2400 });
      const { page, errors } = await h.page(route);
      await until(() => paths.every(p => callsFor(h, [p]).length === 1));
      await page.evaluate(() => { for (let i = 0; i < 10; i++) { setControlledHidden(true); setControlledHidden(false); } });
      await wait(5400);
      // Initial request + one coalesced wake-up; next poll must wait its interval.
      for (const p of paths) assert.equal(callsFor(h, [p]).length, 2, p);
      await page.evaluate(() => setControlledHidden(true));
      await wait(5200);
      for (const p of paths) {
        const calls = callsFor(h, [p]); assert.equal(calls.length, 2, p + ': hidden stopped');
        assert.ok(calls[0].end <= calls[1].start, p + ': no overlap');
      }
      assert.deepEqual(errors, []);
    } finally { await h.close(); }
  });
}

test('真实HTTP：POST失败只提交一次；visibility恢复只读，不自动重试/改派任务或渠道', { timeout: 15000 }, async () => {
  const h = await webFixture();
  try {
    const { page, errors } = await h.page('/?p=projects/fixture&tab=chat');
    await page.waitForFunction(() => !document.querySelector('#chatSend').disabled);
    await page.locator('#chatInput').fill('只提交一次，失败保留输入');
    await page.locator('#chatSend').click();
    await page.waitForFunction(() => document.querySelector('#chatError').textContent.includes('没有自动重试'));
    assert.equal(await page.locator('#chatInput').inputValue(), '只提交一次，失败保留输入');
    const error = await page.evaluate(async () => {
      const { requestJSON } = await import('/_vh/http.mjs');
      try { await requestJSON('/_api/provider/select', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }); }
      catch (e) { return e.message; }
    });
    assert.match(error, /fixture unavailable/);
    await page.evaluate(() => { for (let i = 0; i < 10; i++) { setControlledHidden(true); setControlledHidden(false); } });
    await wait(2200);
    assert.deepEqual(h.calls.filter(call => call.method === 'POST').map(call => call.path), ['/_api/chat', '/_api/provider/select']);
    assert.deepEqual(errors, []);
  } finally { await h.close(); }
});

test('失败任务中的error字段仍是正常状态数据：保留真实原因和继续入口，不误判为断连', { timeout: 10000 }, async () => {
  const h = await webFixture();
  try {
    h.controls.set('/_api/chat', { value: { status: 'failed', taskId: 'fixture-task', mode: 'article', canResume: true,
      canRetry: true, error: { message: 'fixture task failure' }, tail: 'failed task log' } });
    const { page, errors } = await h.page('/?p=projects/fixture&tab=chat');
    await page.waitForFunction(() => document.querySelector('#chatState').textContent === '任务失败' && document.querySelector('#chatError').textContent.includes('fixture task failure'));
    assert.equal(await page.locator('#chatSend').isDisabled(), false);
    assert.equal(await page.locator('#chatRetry').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await h.close(); }
});

test('requestJSON：挂起GET到时终止，失败后显式重读，不缓存结论', { timeout: 15000 }, async () => {
  const h = await webFixture();
  try {
    const { page } = await h.page('/_vh/settings.html', { hidden: true });
    h.controls.set('/_api/projects', { delayMs: 1000 });
    const error = await page.evaluate(async () => {
      const { requestJSON } = await import('/_vh/http.mjs');
      try { await requestJSON('/_api/projects', { timeoutMs: 80 }); } catch (e) { return e.message; }
    });
    assert.match(error, /等待超时/);
    h.controls.clear();
    const count = await page.evaluate(async () => {
      const { requestJSON } = await import('/_vh/http.mjs');
      return (await requestJSON('/_api/projects', { timeoutMs: 1000 })).projects.length;
    });
    assert.equal(count, 1); assert.equal(callsFor(h, ['/_api/projects']).length, 2);
  } finally { await h.close(); }
});
