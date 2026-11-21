import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';
import { startServer } from '../lib/server.mjs';
import { prepareExecution } from '../lib/execution-config.mjs';
import { CATALOGS } from '../lib/opencode-catalog.mjs';

test('Go 和 Zen 分别读官方目录、分组展示、显式保存；刷新失败保留各自目录', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-oc-catalog-'));
  const fetched = [];
  let offline = false;
  const model = (id, input, output = input) => ({ type: 'chat', id, cost: { text: { input: { price: input }, output: { price: output } } } });
  const server = startServer(null, 0, { root, home: root, publish: {}, modelCatalogFetch: async (url, options) => {
    assert.equal(options.headers, undefined);
    fetched.push(url);
    if (offline) return new Response('offline', { status: 503 });
    return Response.json({ data: url === CATALOGS['opencode-go']
      ? [model('go-free', 0), model('go-paid', 1), model('free-input-only', 0, 1)]
      : [model('big-pickle', 0), model('zen-paid', 1)] });
  } });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async suffix => (await fetch(`${base}/_api/providers${suffix}`)).json();
  assert.equal((await api('')).providers.find(p => p.name === 'opencode').models.length, 0);
  assert.deepEqual(fetched, []);

  const browser = await launchBrowser(chromium);
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${base}/settings`);
  const go = page.locator('[data-model="opencode-go"]'), zen = page.locator('[data-model="opencode"]');
  await go.locator('option[value="go-free"]').waitFor({ state: 'attached' });
  assert.deepEqual(fetched.sort(), Object.values(CATALOGS).sort());
  assert.match(await go.locator('optgroup').first().textContent(), /go-free（OpenCode Go 套餐 · 免费）/);
  assert.match(await zen.locator('optgroup').first().textContent(), /big-pickle（OpenCode Zen · 免费）/);
  assert.equal(await go.locator('option[value=big-pickle]').count(), 0);
  assert.doesNotMatch(await go.locator('option[value=free-input-only]').textContent(), /免费/);
  assert.equal(await go.inputValue(), '', '失效的既有模型不能静默换成第一项');
  await zen.selectOption('big-pickle');
  assert.notEqual((await api('')).current.provider, 'opencode');
  await page.locator('[data-use="opencode"]').click();
  await page.waitForFunction(() => document.querySelector('#msg').textContent.includes('big-pickle'));
  const runtime = prepareExecution(root, { home: root, env: { HOME: root } });
  assert.equal(runtime.snapshot.model, 'opencode/big-pickle');
  assert.equal(runtime.childEnv.VH_EXECUTION_API_KEY, undefined);

  offline = true;
  const cached = await api('?models=refresh');
  assert.ok(cached.catalogErrors.opencode);
  assert.ok(cached.catalogErrors['opencode-go']);
  assert.deepEqual(cached.providers.find(p => p.name === 'opencode').freeModels, ['big-pickle']);
  assert.equal(cached.current.model, 'big-pickle');
});
