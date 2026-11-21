import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { readProductionLock } from '../lib/production-lock.mjs';
import { taskStatus } from '../lib/task-status.mjs';

const vh = path.resolve('vh.mjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test, timeout = 5000) { const end = Date.now() + timeout; while (!test()) { if (Date.now() > end) throw new Error('fixture readiness timed out'); await delay(20); } }
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-cli-lock-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'));
  for (const [name, content] of Object.entries({ 'PROJECT.json': '{}', '脚本.md': '## S1 · 一\n1. 一句话。', 'scenes.src.js': 'root=>({})',
    'engine.tpl.html': "const ORIENT = 'landscape';", 'scene.html': 'const DURATION = 1; const SUBS = [{"s":0,"e":1,"t":"一句话。"}]; addScene(0,1,()=>{});',
    'gen.mjs': 'import fs from "node:fs"; fs.writeFileSync("out/tool-pid",String(process.pid)); process.on("SIGTERM",()=>{});setInterval(()=>{},1000);' })) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
test('真实CLI共享锁：独立字幕/改设置不能与构建并写；父死子组活时仍不能接管，退出后可恢复', { timeout: 20000 }, async t => {
  const dir = fixture(t), parent = spawn(process.execPath, [vh, 'build', '--dir', dir], { stdio: 'ignore' });
  let tool;
  t.after(() => { try { parent.kill('SIGKILL'); } catch {} if (tool) { try { process.kill(-tool, 'SIGKILL'); } catch {} } });
  await waitFor(() => fs.existsSync(path.join(dir, 'out/tool-pid')));
  tool = Number(fs.readFileSync(path.join(dir, 'out/tool-pid')));
  for (const args of [['subtitles'], ['automation', '--enable']]) {
    const other = spawnSync(process.execPath, [vh, ...args, '--dir', dir], { encoding: 'utf8', timeout: 5000 });
    assert.equal(other.status, 1); assert.match(other.stderr, /Production lock unavailable/);
  }
  const remove = spawnSync(process.execPath, [vh, 'rm', dir], { encoding: 'utf8', timeout: 5000 });
  assert.equal(remove.status, 1); assert.match(remove.stderr, /Production lock unavailable/); assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(path.join(dir, 'out/subtitles.srt')), false);
  parent.kill('SIGKILL'); await once(parent, 'close');
  const held = readProductionLock(dir); assert.equal(held.busy, true); assert.equal(held.reason, 'child-alive');
  const orphan = spawnSync(process.execPath, [vh, 'subtitles', '--dir', dir], { encoding: 'utf8', timeout: 5000 });
  assert.equal(orphan.status, 1);
  process.kill(-tool, 'SIGKILL');
  await waitFor(() => !readProductionLock(dir).busy);
  const recovered = spawnSync(process.execPath, [vh, 'subtitles', '--dir', dir], { encoding: 'utf8', timeout: 5000 });
  assert.equal(recovered.status, 0, recovered.stderr); assert.equal(readProductionLock(dir).busy, false);
});
test('直接CLI取消：忽略TERM的生产工具被升级结束后才退出，未进入下游写入', { timeout: 10000 }, async t => {
  const dir = fixture(t), parent = spawn(process.execPath, [vh, 'build', '--dir', dir], { stdio: 'ignore' });
  let tool;
  t.after(() => { try { parent.kill('SIGKILL'); } catch {} if (tool) { try { process.kill(-tool, 'SIGKILL'); } catch {} } });
  await waitFor(() => fs.existsSync(path.join(dir, 'out/tool-pid')));
  tool = Number(fs.readFileSync(path.join(dir, 'out/tool-pid')));
  parent.kill('SIGTERM'); const [code] = await once(parent, 'close');
  assert.equal(code, 143); assert.equal(readProductionLock(dir).busy, false);
  assert.throws(() => process.kill(-tool, 0), error => error.code === 'ESRCH');
  const stateFile = path.join(dir, 'out/.vh-state.json');
  assert.equal(fs.existsSync(stateFile), false, '取消后不能登记成功构建基线');
});
test('真实ask信号取消：中断请求并回收忽略TERM的工具组，确认退出后才可恢复任务', { timeout: 15000 }, async t => {
  const dir = fixture(t), home = path.join(dir, 'home');
  const script = 'require("fs").writeFileSync("out/generic-tool-pid",String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
  const model = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'owned-tool', type: 'function',
        function: { name: 'run', arguments: JSON.stringify({ command: `node -e '${script}'` }) } }] }, finish_reason: 'tool_calls' }] }));
    });
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(path.join(home, '.config/opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/opencode/opencode.jsonc'), JSON.stringify({ provider: { opendesign: { options: { baseURL: 'http://127.0.0.1:' + model.address().port } } } }));
  const parent = spawn(process.execPath, [vh, 'ask', '测试工具取消', '--mode', 'edit', '--dir', dir], {
    detached: true, stdio: 'ignore', env: { ...process.env, HOME: home, OPEN_DESIGN_API_KEY: 'fixture-only' },
  });
  let tool;
  t.after(async () => {
    try { process.kill(-parent.pid, 'SIGKILL'); } catch {}
    if (tool) { try { process.kill(tool, 'SIGKILL'); } catch {} }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  });
  await waitFor(() => fs.existsSync(path.join(dir, 'out/generic-tool-pid')));
  tool = Number(fs.readFileSync(path.join(dir, 'out/generic-tool-pid')));
  parent.kill('SIGTERM'); const [code] = await once(parent, 'close');
  assert.equal(code, 143); assert.throws(() => process.kill(tool, 0), error => error.code === 'ESRCH');
  const status = taskStatus(dir);
  assert.equal(status.status, 'cancelled'); assert.equal(status.canResume, true); assert.equal(status.running, false);
  assert.equal(readProductionLock(dir).busy, false); assert.equal(fs.existsSync(path.join(dir, 'out/.vh-run.json')), false);
});
