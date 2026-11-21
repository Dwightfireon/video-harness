/* No real OpenCode service, model, network, or user process is touched. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { interruptSession } from '../lib/opencode-interrupt.mjs';
import { createRunner } from '../lib/runners/opencode.mjs';
import { processExists, stopRecordedChildren } from '../lib/process-lifecycle.mjs';

function fixture(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-interrupt-'));
  const bin = path.join(root, 'opencode-fixture');
  fs.writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  const env = { ...process.env, VH_OPENCODE_BIN: bin, FIXTURE_ROOT: root };
  t.after(async () => {
    // Only PIDs explicitly created by these fixtures; never search or infer groups.
    const file = path.join(root, 'pids.json');
    if (fs.existsSync(file)) {
      const { leader } = JSON.parse(fs.readFileSync(file, 'utf8'));
      await stopRecordedChildren([{ pid: leader, group: true }]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, env };
}

test('interrupt waits for CLI response, uses this invocation env/cwd, and distinguishes idle from unknown', async t => {
  const f = fixture(t, `const fs = require('node:fs');
    fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
    console.log(JSON.stringify({ interrupted: false }));`);
  const result = await interruptSession('ses_test', { env: f.env, cwd: f.root });
  assert.deepEqual(result, { ok: true, confirmed: true, interrupted: false, reason: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'argv.json'), 'utf8')),
    ['api', 'post', '/api/session/ses_test/interrupt']);
});

test('exit zero with no acknowledgment is not proof of server-side cancellation', async t => {
  const f = fixture(t, 'process.exit(0);');
  assert.deepEqual(await interruptSession('ses_test', { env: f.env, cwd: f.root }),
    { ok: true, confirmed: false, interrupted: null, reason: 'unconfirmed-response' });
});

test('failed request and spawn errors are bounded, structured, and do not expose stderr secrets', async t => {
  const f = fixture(t, `console.error('fixture-private-credential'); process.exit(1);`);
  const failed = await interruptSession('ses_test', { env: f.env });
  assert.equal(failed.ok, false); assert.equal(failed.reason, 'request-failed');
  assert.equal(JSON.stringify(failed).includes('fixture-private-credential'), false);
  const missing = await interruptSession('ses_test', { env: { ...f.env, VH_OPENCODE_BIN: path.join(f.root, 'missing') } });
  assert.equal(missing.reason, 'spawn-failed');
  assert.equal((await interruptSession('../other', { env: f.env })).reason, 'invalid-session');
});

test('hung interrupt helper and its TERM-ignoring descendant are reaped before returning', { timeout: 10000 }, async t => {
  const f = fixture(t, `const fs = require('node:fs'); const {spawn} = require('node:child_process');
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {stdio:'ignore'});
    fs.writeFileSync(process.env.FIXTURE_ROOT+'/pids.json',JSON.stringify({leader:process.pid,child:child.pid}));
    setInterval(()=>{},1000);`);
  const started = Date.now();
  const result = await interruptSession('ses_test', { env: f.env, timeoutMs: 600, graceMs: 100, killWaitMs: 1500 });
  assert.equal(result.reason, 'timeout'); assert.equal(result.confirmed, false);
  assert.equal(result.helperStopped, true, JSON.stringify(result));
  const pids = JSON.parse(fs.readFileSync(path.join(f.root, 'pids.json'), 'utf8'));
  assert.equal(processExists(pids.leader), false);
  assert.equal(processExists(pids.child), false);
  assert.ok(Date.now() - started < 4000, 'control request must not hang indefinitely');
});

for (const service of ['shared', 'private']) {
  test(`${service} runner cancellation escalates and awaits only its own helper/group`, { timeout: 10000 }, async t => {
    const f = fixture(t, `const fs=require('node:fs');const args=process.argv.slice(2);
      if(args[0]==='api') {fs.writeFileSync('interrupted.json',JSON.stringify(args));console.log(JSON.stringify({interrupted:true}));process.exit(0);}
      process.on('SIGTERM',()=>{});
      fs.writeFileSync('pids.json',JSON.stringify({leader:process.pid}));
      console.log(JSON.stringify({type:'text',sessionID:'ses_fixture_stop',part:{text:'fixture ready'}}));
      setInterval(()=>{},1000);`);
    fs.writeFileSync(path.join(f.root, 'PROJECT.json'), '{}');
    const controller = new AbortController();
    const runner = createRunner(f.root, { model: 'fixture/model', service, childEnv: f.env });
    const result = await runner.run({ prompt: 'read-only fixture', signal: controller.signal,
      log: line => { if (line.includes('fixture ready')) controller.abort(); } });
    await runner.waitForCancellation();
    assert.equal(result.status, 'cancelled');
    const { leader } = JSON.parse(fs.readFileSync(path.join(f.root, 'pids.json'), 'utf8'));
    assert.equal(processExists(leader, { group: true }), false);
    assert.equal(fs.existsSync(path.join(f.root, 'interrupted.json')), service === 'shared', 'private sessions must never be interrupted through the shared service');
  });
}

test('unconfirmed shared cancellation is reported in the result, not silently marked as confirmed', { timeout: 10000 }, async t => {
  const f = fixture(t, `const args=process.argv.slice(2);
    if(args[0]==='api') process.exit(1);
    process.on('SIGTERM',()=>{});
    require('node:fs').writeFileSync('pids.json',JSON.stringify({leader:process.pid}));
    console.log(JSON.stringify({type:'text',sessionID:'ses_fixture_uncertain',part:{text:'fixture ready'}}));
    setInterval(()=>{},1000);`);
  fs.writeFileSync(path.join(f.root, 'PROJECT.json'), '{}');
  const controller = new AbortController();
  const runner = createRunner(f.root, { model: 'fixture/model', service: 'shared', childEnv: f.env });
  const result = await runner.run({ prompt: 'read-only fixture', signal: controller.signal,
    log: line => { if (line.includes('fixture ready')) controller.abort(); } });
  assert.equal(result.status, 'cancelled');
  assert.match(result.warns.join('\n'), /中断未确认.*本地进程回收不等于服务端会话已停止/);
});

test('pre-aborted shared runner has no session authority and reports uncertainty without interrupting another session', async t => {
  const f = fixture(t, `if(process.argv[2]==='api') require('node:fs').writeFileSync('wrong-interrupt','bad');setInterval(()=>{},1000);`);
  fs.writeFileSync(path.join(f.root, 'PROJECT.json'), '{}');
  const controller = new AbortController(); controller.abort();
  const result = await createRunner(f.root, { model: 'fixture/model', service: 'shared', childEnv: f.env })
    .run({ prompt: 'read-only fixture', signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.match(result.warns.join('\n'), /未取得会话 ID.*未确认/);
  assert.equal(fs.existsSync(path.join(f.root, 'wrong-interrupt')), false);
});
