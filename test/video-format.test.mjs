import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { selectVideoFormat, selectedVideoFormat, videoFormatState, enforceVideoFormat, assertVideoFormat, videoFormatPrompt, videoMediaFormatError } from '../lib/video-format.mjs';
import { makeTools, runAgent } from '../lib/agent.mjs';
import { writeCheckpoint, readCheckpoint } from '../lib/checkpoint.mjs';
import { startServer } from '../lib/server.mjs';
import { snapshot } from '../lib/state.mjs';
import { beginTask, updateTask } from '../lib/task-status.mjs';
import { deliverableState } from '../lib/deliverable.mjs';
import { launchBrowser } from '../lib/browser.mjs';
import { durationLimit } from '../lib/duration-limit.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-format-')), dir = path.join(root, 'projects/work');
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const template = `<!doctype html><body><script>
const ORIENT = 'portrait';
const PRESET = {landscape:{W:1920,H:1080},portrait:{W:1080,H:1920}};
const P0 = PRESET[ORIENT]; const W = P0.W, H = P0.H;
window.W=W;window.H=H;const DURATION = 1;window.DURATION=DURATION;
const scenes = []; const SUBS = []; window.renderAt = () => {};
</script>`;
  for (const [name, text] of Object.entries({
    'PROJECT.json': JSON.stringify({ name: '保持项目元数据', installedFiles: { original: 'hash' } }),
    'engine.tpl.html': template, 'scene.html': template, '脚本.md': '## S1 · 第一场\n1. 原文不得变更。\n',
    '方案.md': '原方案', 'claims.json': '[]', 'scenes.src.js': 'root => ({render(){}})',
    'gen.mjs': "import fs from 'node:fs'; fs.writeFileSync('scene.html',fs.readFileSync('engine.tpl.html','utf8'));",
  })) fs.writeFileSync(path.join(dir, name), text);
  return { root, dir };
}
async function serve(t, root, dir) {
  const server = startServer(dir, 0, { root, home: path.join(root, 'home'), providerInfo: () => [] });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const url = 'http://127.0.0.1:' + server.address().port;
  return { url, api: (method = 'GET', body, rel = 'projects/work') => fetch(url + '/_api/format?p=' + encodeURIComponent(rel), {
    method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }) };
}

test('旧竖屏工程不静默改向；明确选择后持久化、备份并保持作者内容', t => {
  const { dir } = fixture(t), original = fs.readFileSync(path.join(dir, 'engine.tpl.html'), 'utf8');
  assert.equal(videoFormatState(dir).aspectRatio, '9:16'); assert.equal(videoFormatState(dir).locked, false);
  const script = fs.readFileSync(path.join(dir, '脚本.md'), 'utf8');
  selectVideoFormat(dir, '16:9');
  assert.deepEqual(selectedVideoFormat(dir), { aspectRatio: '16:9', orientation: 'landscape', width: 1920, height: 1080 });
  assert.equal(videoFormatState(dir).pendingBuild, true);
  assert.equal(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), script);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'PROJECT.json'))).installedFiles.original, 'hash');
  const backups = fs.readdirSync(path.join(dir, 'out/.vh-format-backups'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'out/.vh-format-backups', backups[0], 'engine.tpl.html'), 'utf8'), original);
  selectVideoFormat(dir, '16:9'); assert.equal(fs.readdirSync(path.join(dir, 'out/.vh-format-backups')).length, 1);
  assert.throws(() => selectVideoFormat(dir, '4:3'), /16:9 或 9:16/);
});
test('画幅校验可消费同一次强探针结果，空/错误尺寸仍 fail closed', t => {
  const { dir } = fixture(t); selectVideoFormat(dir, '16:9');
  const file = path.join(dir, 'out/video.mp4'); fs.writeFileSync(file, 'not real media');
  assert.equal(videoMediaFormatError(dir, file, { video: { width: 1920, height: 1080 } }), null);
  assert.match(videoMediaFormatError(dir, file, { video: { width: 1080, height: 1920 } }), /成片为/);
  assert.match(videoMediaFormatError(dir, file, null), /无法核验/);
  assert.match(videoMediaFormatError(dir, file, { video: null }), /无法核验/);
  // The ordinary API still probes bytes rather than accepting the fake file.
  assert.match(videoMediaFormatError(dir, file), /无法核验/);
});

test('画幅选定后：构建纠偏，未重建不能渲染或当成最新；工具不得改方向/解除选择', async t => {
  const { dir } = fixture(t); selectVideoFormat(dir, '16:9');
  assert.throws(() => assertVideoFormat(dir), /先运行 vh build/);
  assert.match((await snapshot(dir)).stale.scene, /画幅/);
  const tools = makeTools(dir, () => {}, { mode: 'article' });
  const wrong = fs.readFileSync(path.join(dir, 'engine.tpl.html'), 'utf8').replace("'landscape'", "'portrait'");
  assert.match(await tools.write_file.run({ path: 'engine.tpl.html', content: wrong }), /拒绝/);
  assert.match(await tools.write_file.run({ path: 'PROJECT.json', content: '{}' }), /拒绝/);
  fs.writeFileSync(path.join(dir, 'engine.tpl.html'), wrong);
  assert.equal(enforceVideoFormat(dir), true);
  assert.equal(enforceVideoFormat(dir), false);
  execFileSync(process.execPath, ['gen.mjs'], { cwd: dir });
  assert.doesNotThrow(() => assertVideoFormat(dir));
  assert.equal(videoFormatState(dir).pendingBuild, false);
});

test('画幅 API 保存并生成同方向预览，刷新仍保留选择，不触发模型', async t => {
  const { root, dir } = fixture(t), { api } = await serve(t, root, dir);
  assert.equal((await (await api()).json()).aspectRatio, '9:16');
  const r = await api('POST', { aspectRatio: '16:9' }); assert.equal(r.status, 200);
  const saved = await r.json(); assert.equal(saved.locked, true); assert.equal(saved.pendingBuild, false);
  assert.equal(saved.actualOrientation, 'landscape'); assert.equal(saved.taskRunning, false);
  assert.equal((await (await api()).json()).aspectRatio, '16:9');
  assert.equal(fs.existsSync(path.join(dir, 'out/.vh-task.json')), false);
  assert.equal((await api('POST', { aspectRatio: '3:4' })).status, 400);
  assert.equal((await api('POST', { aspectRatio: '9:16' }, 'projects/不存在')).status, 404);
  assert.equal(selectedVideoFormat(dir).aspectRatio, '16:9');
});

test('任务运行时拒绝改幅，不覆盖；停止后才能保存', async t => {
  const { root, dir } = fixture(t), { api } = await serve(t, root, dir);
  const task = beginTask(dir, '原任务', 'article'); updateTask(dir, task.id, { status: 'running', pid: process.pid });
  const original = fs.readFileSync(path.join(dir, 'engine.tpl.html'), 'utf8');
  assert.equal((await api('POST', { aspectRatio: '16:9' })).status, 409);
  assert.equal(fs.readFileSync(path.join(dir, 'engine.tpl.html'), 'utf8'), original);
  assert.equal(selectedVideoFormat(dir), null);
  assert.equal((await (await api()).json()).taskRunning, true);
  updateTask(dir, task.id, { status: 'cancelled', pid: null });
  assert.equal((await api('POST', { aspectRatio: '16:9' })).status, 200);
});

test('生成失败只保留选择并提示预览未更新，不伪称切换成功', async t => {
  const { root, dir } = fixture(t), { api } = await serve(t, root, dir);
  fs.writeFileSync(path.join(dir, 'gen.mjs'), 'process.exit(1)');
  const result = await (await api('POST', { aspectRatio: '16:9' })).json();
  assert.equal(result.ok, true); assert.equal(result.pendingBuild, true); assert.match(result.warning, /预览重建未成功/);
  assert.equal(result.actualOrientation, 'portrait'); assert.equal(result.aspectRatio, '16:9');
});

test('恢复旧检查点从项目读最新画幅，不改旧 system 或原文', async t => {
  const { dir } = fixture(t); selectVideoFormat(dir, '16:9');
  writeCheckpoint(dir, { schemaVersion: 1, taskId: 'format-resume', mode: 'edit', status: 'cancelled',
    messages: [{ role: 'system', content: '旧提示：画布是竖屏' }, { role: 'user', content: '保持用户原文' }], pending: [] });
  await runAgent(dir, '保持用户原文', { taskId: 'format-resume', mode: 'edit', resume: true,
    providers: [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture' }], request: async (_p, messages) => {
      assert.equal(messages[0].content, '旧提示：画布是竖屏');
      assert.match(messages.at(-1).content, /用户选定画幅.*16:9/);
      assert.match(messages.at(-1).content, /1920×1080/);
      return { choices: [{ message: { role: 'assistant', content: '尚需布局复查' } }] };
    } });
  assert.equal(readCheckpoint(dir, 'format-resume').messages[1].content, '保持用户原文');
  assert.match(videoFormatPrompt(dir), /不得自行改成另一方向/);
});

test('新建项目可选竖屏，未指定默认横屏；非法画幅在创建前拒绝', async t => {
  const { root, dir } = fixture(t), { url } = await serve(t, root, dir);
  for (const [name, aspectRatio, expected] of [['vertical', '9:16', '9:16'], ['default', undefined, '16:9']]) {
    const r = await fetch(url + '/_api/new', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, input: '', aspectRatio }) });
    const body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(selectedVideoFormat(path.join(root, 'projects', name)).aspectRatio, expected);
    assert.equal(durationLimit(path.join(root, 'projects', name)), null, '网页新项目与CLI一致，默认不限时长');
    assert.equal(body.started, false);
  }
  const r = await fetch(url + '/_api/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'invalid', aspectRatio: '4:3' }) });
  assert.equal(r.status, 400); assert.equal(fs.existsSync(path.join(root, 'projects/invalid')), false);
});

test('成片实际宽高与选择不符，时间戳再新也不能误验收', t => {
  const { dir } = fixture(t); selectVideoFormat(dir, '16:9'); execFileSync(process.execPath, ['gen.mjs'], { cwd: dir });
  const file = path.join(dir, 'out/video.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=size=1080x1920:rate=1', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', file]);
  assert.equal(r.status, 0);
  assert.match(videoMediaFormatError(dir, file), /成片为 1080×1920/);
  assert.equal(deliverableState(dir).stale, true); assert.match(deliverableState(dir).reason, /16:9/);
});

test('真实工作台选择、保存、刷新保持，运行中禁改，手机宽度可用', { timeout: 30000 }, async t => {
  const { root, dir } = fixture(t), { url } = await serve(t, root, dir);
  const browser = await launchBrowser(chromium, { headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url + '/?p=projects%2Fwork');
  await page.waitForFunction(() => !document.querySelector('#projectAspectRatio').disabled);
  assert.equal(await page.inputValue('#projectAspectRatio'), '9:16');
  page.on('dialog', dialog => dialog.accept());
  await page.selectOption('#projectAspectRatio', '16:9'); await page.click('#saveAspectRatio');
  await page.waitForFunction(() => document.querySelector('#formatSaved').textContent.includes('16:9'));
  await page.reload(); await page.waitForFunction(() => !document.querySelector('#projectAspectRatio').disabled);
  assert.equal(await page.inputValue('#projectAspectRatio'), '16:9');
  await page.waitForFunction(() => document.querySelector('#frame').style.width === '1920px' && document.querySelector('#frame').src.includes('/scene.html') && document.querySelector('#reloading').classList.contains('hidden'));
  await page.frames().find(frame => frame.url().includes('/scene.html')).waitForFunction(() => window.W === 1920);
  assert.equal(await page.evaluate(() => { try { return !!document.querySelector('#frame').contentWindow.document; } catch { return false; } }), false);
  const task = beginTask(dir, '执行中', 'article'); updateTask(dir, task.id, { status: 'running', pid: process.pid });
  await page.reload(); await page.waitForFunction(() => document.querySelector('#formatStatus').textContent.includes('任务运行中'));
  assert.equal(await page.isDisabled('#projectAspectRatio'), true);
  updateTask(dir, task.id, { status: 'cancelled', pid: null });
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
  await page.waitForFunction(() => !document.querySelector('#projectAspectRatio').disabled);
  const box = await page.locator('#projectAspectRatio').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 391);
  await page.goto(url); assert.equal(await page.inputValue('#newAspectRatio'), '16:9');
  await page.selectOption('#newAspectRatio', '9:16'); assert.equal(await page.inputValue('#newAspectRatio'), '9:16');
  assert.deepEqual(errors, []);
});
