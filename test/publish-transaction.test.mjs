import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createPublishService } from '../desk/service.mjs';
import { createPublishTransaction, publishAccountKey } from '../desk/publish-transaction.mjs';
import { createPublishApi } from '../lib/publish-api.mjs';
import { buildPayload } from '../desk/publish-contract.mjs';
import { PARTITION_TAXONOMY } from '../desk/partitions.mjs';
import { readJournal, recordAttempt, checkBeforePublish, videoFingerprint, legacyVideoFingerprint,
  DEFAULT_COOLDOWN_MS, JOURNAL_FILE } from '../lib/publish-guard.mjs';

const CRED = { mid: 123, name: 'fixture', cookies: { SESSDATA: 'test-session', bili_jct: 'test-csrf', DedeUserID: '123' } };
const INPUT = { id: 'a', title: '安全测试', tags: '测试', desc: '不能进入保护摘要的正文', tid: 231, copyright: 1, cover: false, confirmed: true };
const CATALOG = { live: true, taxonomy: PARTITION_TAXONOMY, list: [{ id: 231, name: '计算机技术' }] };

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-publish-txn-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'), home = path.join(base, 'home');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const files = {};
  for (const id of ['a', 'b']) { files[id] = path.join(base, id + '.mp4'); fs.writeFileSync(files[id], id.repeat(4096)); }
  const draft = id => ({ video: { path: files[id], file: id + '.mp4' }, fields: { title: INPUT.title, tags: INPUT.tags, desc: INPUT.desc }, blockers: [], warnings: [] });
  const store = credential => path.join(home, '.config/video-harness/publish-state', publishAccountKey(credential || CRED));
  function service({ credential = CRED, repo = root, api = {}, transaction = createPublishTransaction({ root: repo, home }) } = {}) {
    const calls = [];
    const client = {
      partitions: async () => { calls.push('partitions'); return CATALOG; },
      uploadVideo: async () => { calls.push('upload'); return { filename: 'fake-video', chunks: 1 }; },
      buildPayload,
      submit: async () => { calls.push('submit'); return { bvid: 'BV1234567890', aid: 1 }; }, ...api,
    };
    return { calls, client, service: createPublishService({ getDraft: async id => draft(id), getCredentials: () => credential,
      createClient: () => client, prepareCover: () => {}, cleanupCover: () => {}, transaction }) };
  }
  const credentialDir = path.join(home, '.config/video-harness');
  fs.mkdirSync(credentialDir, { recursive: true });
  fs.writeFileSync(path.join(credentialDir, 'bilibili.json'), JSON.stringify(CRED), { mode: 0o600 });
  const web = client => createPublishApi({ root, home, getDraft: async id => draft(id), createClient: () => client,
    fetchImpl: async () => { throw new Error('真实网络禁止'); } });
  return { base, root, home, files, draft, store, service, web };
}

test('共同入口：无事务依赖 fail closed，confirmed 不能替代保护', async t => {
  const f = fixture(t), { service, calls } = f.service({ transaction: null });
  assert.equal((await service.submit(INPUT)).reason, 'guard-missing');
  assert.deepEqual(calls, []);
});

test('营销声明：请求快照先持久化，回读不符仍记已收稿并阻止重发，历史记录不补签', async t => {
  const f = fixture(t);
  const x = f.service({ api: {
    submit: async payload => {
      assert.deepEqual(payload.creation_statement, { id: 3 });
      assert.deepEqual(readJournal(f.store()).entries[0].declaration, { requested: { id: 3 }, state: 'pending' });
      return { bvid: 'BV1234567890', aid: 1 };
    }, archiveDetail: async () => ({ creationStatementId: -1 }),
  } });
  const result = await x.service.submit({ ...INPUT, promotion: { enabled: true } });
  assert.equal(result.ok, true); assert.equal(result.declarationVerification.state, 'mismatch');
  const receipt = readJournal(f.store()).entries[0];
  assert.equal(receipt.outcome, 'submitted'); assert.equal(receipt.declaration.actualId, -1);
  assert.equal(receipt.declaration.state, 'mismatch');
  assert.equal((await x.service.submit(INPUT)).reason, 'duplicate');
  assert.ok(!JSON.stringify(receipt).includes(CRED.cookies.SESSDATA));
});

test('共同入口：成功前预写、成功后记账；换项目/标题/入口仍阻断重复', async t => {
  const f = fixture(t);
  assert.equal((await f.service().service.preflight('a')).ok, true);
  const first = f.service({ api: { submit: async () => {
    const entries = readJournal(f.store()).entries;
    assert.equal(entries.length, 1); assert.equal(entries[0].outcome, 'submitting');
    return { bvid: 'BV1234567890', aid: 1 };
  } } });
  assert.equal((await first.service.submit(INPUT)).ok, true);
  const receipt = readJournal(f.store()).entries[0];
  assert.equal(receipt.outcome, 'submitted'); assert.equal(receipt.fingerprint.length, 64);
  fs.copyFileSync(f.files.a, f.files.b);
  const second = f.service();
  const web = f.web(second.client);
  assert.equal((await web.submit({ ...INPUT, id: 'b', title: '另一个标题' })).reason, 'duplicate');
  assert.deepEqual(second.calls, []);
  const summary = await web.preflight('b');
  assert.equal(summary.reason, 'duplicate');
  const raw = JSON.stringify(readJournal(f.store()));
  assert.ok(!raw.includes(INPUT.desc));
  for (const secret of [CRED.cookies.SESSDATA, CRED.cookies.bili_jct]) assert.ok(!raw.includes(secret));
  assert.ok(!raw.includes('cookies'));
});

test('拒绝可安全重试，unknown 无论等待多久/confirmed 都不放行', async t => {
  const f = fixture(t);
  for (const outcome of ['rejected', 'unknown']) {
    const x = f.service({ api: { submit: async () => { throw Object.assign(new Error('fixture failure'), { outcome }); } } });
    const result = await x.service.submit(INPUT);
    assert.equal(result.outcome, outcome);
    assert.equal(readJournal(f.store()).entries.at(-1).outcome, outcome);
  }
  const x = f.service();
  assert.equal((await x.service.submit({ ...INPUT, id: 'b', confirmed: true })).reason, 'unknown');
  assert.equal(checkBeforePublish(f.store(), { project: 'b', now: Date.now() + 365 * 86400000 }).reason, 'unknown');
  assert.deepEqual(x.calls, []);
});

test('同账号不同项目/仓库/服务实例共用冷却，别的账号不受影响', async t => {
  const f = fixture(t), repo = path.join(f.base, 'other-repo'); fs.mkdirSync(repo);
  const x = f.service({ api: { uploadVideo: async () => { throw Object.assign(new Error('上传过快'), { httpStatus: 406 }); } } });
  assert.equal((await x.service.submit(INPUT)).outcome, 'not-submitted');
  assert.equal(readJournal(f.store()).entries[0].kind, 'rate');
  const y = f.service({ repo });
  assert.equal((await y.service.submit({ ...INPUT, id: 'b' })).reason, 'cooldown');
  assert.deepEqual(y.calls, []);
  assert.equal(checkBeforePublish(f.store(), { project: 'b', now: Date.now() + DEFAULT_COOLDOWN_MS + 100 }).ok, true);
  const z = f.service({ credential: { ...CRED, mid: 456 } });
  assert.equal((await z.service.submit({ ...INPUT, id: 'b' })).ok, true);
});

test('并发：两个入口只有一个上传，活进程锁不按年龄接管', async t => {
  const f = fixture(t);
  let release, began;
  const hold = new Promise(r => { release = r; });
  const ready = new Promise(r => { began = r; });
  const x = f.service({ api: { uploadVideo: async () => { began(); await hold; return { filename: 'f', chunks: 1 }; } } });
  const first = x.service.submit(INPUT); await ready;
  try {
    const ownerPath = path.join(f.store(), '.vh-production.lock/owner.json');
    const owner = JSON.parse(fs.readFileSync(ownerPath));
    owner.started = '2000-01-01T00:00:00.000Z'; fs.writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
    const y = f.service();
    const blocked = await f.web(y.client).submit({ ...INPUT, id: 'b' });
    assert.equal(blocked.reason, 'locked'); assert.deepEqual(y.calls, []);
  } finally { release(); }
  assert.equal((await first).ok, true);
});

test('损坏日志/结构错误不变成空记录，提交前持久化失败不上传', async t => {
  const f = fixture(t), store = f.store();
  fs.mkdirSync(path.join(store, 'out'), { recursive: true });
  const file = path.join(store, JOURNAL_FILE);
  for (const raw of ['{broken', '{"version":1,"entries":{}}', '{"version":1,"entries":[{}]}']) {
    fs.writeFileSync(file, raw);
    const x = f.service();
    assert.equal((await x.service.submit(INPUT)).reason, 'state');
    assert.deepEqual(x.calls, []); assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
  fs.unlinkSync(file);
  // A file where out/ must be: even when journal absence looks empty, prewrite fails.
  fs.rmdirSync(path.dirname(file)); fs.writeFileSync(path.dirname(file), 'blocked');
  const x = f.service(); assert.equal((await x.service.submit(INPUT)).ok, false); assert.deepEqual(x.calls, []);
});

test('结果记账失败不能冒充成功/未提交；残留 submitting 阻断重发', async t => {
  const f = fixture(t);
  let saved;
  const x = f.service({ api: { submit: async () => {
    const out = path.join(f.store(), 'out'); saved = out + '.saved';
    fs.renameSync(out, saved); fs.writeFileSync(out, 'simulate IO failure');
    return { bvid: 'BV1234567890', aid: 1 };
  } } });
  const result = await x.service.submit(INPUT);
  assert.equal(result.outcome, 'unknown'); assert.equal(result.reason, 'journal-write');
  fs.unlinkSync(path.join(f.store(), 'out')); fs.renameSync(saved, path.join(f.store(), 'out'));
  const y = f.service(); assert.equal((await y.service.submit(INPUT)).reason, 'unknown'); assert.deepEqual(y.calls, []);
});

test('批量每项都有 journal，批量/单条/桌面服务不能绕过 unknown 或 duplicate', async t => {
  const f = fixture(t), x = f.service(), web = f.web(x.client);
  const batch = await web.batchSubmit({ ids: ['a', 'b'], tid: 231, confirmed: true, intervalMs: 1500 });
  assert.equal(batch.ok, true); assert.equal(batch.submitted.length, 2);
  assert.deepEqual(readJournal(f.store()).entries.map(e => [e.project, e.outcome]), [['a', 'submitted'], ['b', 'submitted']]);
  assert.equal((await x.service.submit(INPUT)).reason, 'duplicate');
  const duplicate = await web.batchSubmit({ ids: ['a', 'b'], tid: 231, confirmed: true });
  assert.equal(duplicate.results.length, 1); assert.equal(duplicate.results[0].reason, 'duplicate');

  const g = fixture(t), unknown = g.service({ api: { submit: async () => { throw new Error('断网'); } } });
  const otherWeb = g.web(unknown.client);
  const failed = await otherWeb.batchSubmit({ ids: ['a', 'b'], tid: 231, confirmed: true });
  assert.equal(failed.results.length, 1); assert.equal(failed.results[0].outcome, 'unknown');
  const next = await otherWeb.batchSubmit({ ids: ['b'], tid: 231, confirmed: true });
  assert.equal(next.results[0].reason, 'unknown');
  assert.equal(readJournal(g.store()).entries.length, 1);
});

test('全量哈希区分相同首兆；保留旧回执的重复/未知保护', async t => {
  const f = fixture(t), head = Buffer.alloc(1 << 20, 1);
  fs.writeFileSync(f.files.a, Buffer.concat([head, Buffer.from('a')]));
  fs.writeFileSync(f.files.b, Buffer.concat([head, Buffer.from('b')]));
  assert.notEqual(videoFingerprint(f.files.a), videoFingerprint(f.files.b));
  assert.equal(legacyVideoFingerprint(f.files.a), legacyVideoFingerprint(f.files.b));
  recordAttempt(f.root, { project: 'old', outcome: 'submitted', fingerprint: legacyVideoFingerprint(f.files.a) });
  const x = f.service(); assert.equal((await x.service.submit(INPUT)).reason, 'duplicate'); assert.deepEqual(x.calls, []);
});

test('旧日志损坏、未知结果仍阻断；不覆盖原日志', async t => {
  const f = fixture(t);
  recordAttempt(f.root, { project: 'old-project', outcome: 'unknown' });
  const file = path.join(f.root, JOURNAL_FILE), before = fs.readFileSync(file, 'utf8');
  const x = f.service(); assert.equal((await x.service.submit({ ...INPUT, id: 'b' })).reason, 'unknown');
  assert.equal(fs.readFileSync(file, 'utf8'), before); assert.deepEqual(x.calls, []);
  fs.writeFileSync(file, 'corrupt');
  assert.equal((await x.service.submit(INPUT)).reason, 'state');
  assert.equal(fs.readFileSync(file, 'utf8'), 'corrupt');
});

test('BV verify 查到/没查到都不解锁 unknown，不修改回执', async t => {
  const f = fixture(t);
  recordAttempt(f.store(), { project: 'a', outcome: 'unknown' });
  const file = path.join(f.store(), JOURNAL_FILE), before = fs.readFileSync(file, 'utf8');
  for (const found of [false, true]) {
    const web = createPublishApi({ root: f.root, home: f.home, getDraft: async id => f.draft(id),
      fetchImpl: async () => new Response(JSON.stringify({ code: 0,
        data: { arc_audits: found ? [{ Archive: { bvid: 'BV1234567890', title: 'test' } }] : [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } }) });
    const result = await web.verify('BV1234567890');
    assert.equal(result.found, found); assert.match(result.note, /不解除/);
    assert.equal((await web.preflight('a')).reason, 'unknown');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('不完整锁 metadata fail closed 并说明需人工检查，不偷偷接管', async t => {
  const f = fixture(t), dir = path.join(f.store(), '.vh-production.lock');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'owner.json'), '{broken', { mode: 0o600 });
  const x = f.service(), result = await x.service.submit(INPUT);
  assert.equal(result.reason, 'locked'); assert.match(result.message, /人工检查/); assert.deepEqual(x.calls, []);
  assert.equal(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'), '{broken');
});

test('账号 key 优先 mid，测试账号 fallback 不含秘密且稳定', () => {
  assert.equal(publishAccountKey(CRED), publishAccountKey({ ...CRED, name: 'renamed', cookies: { SESSDATA: 'changed' } }));
  assert.equal(publishAccountKey({ cookies: { DedeUserID: '123' } }), publishAccountKey(CRED));
  assert.equal(publishAccountKey({ name: 'fixture', cookies: { SESSDATA: 'one' } }), publishAccountKey({ name: 'fixture', cookies: { SESSDATA: 'two' } }));
});

test('跨进程崩溃窗口：预写后/远端收稿后退出都不能自动重发', async t => {
  for (const mode of ['before-upload', 'after-remote-success']) {
    const f = fixture(t);
    const childCode = `
      import { createPublishService } from ${JSON.stringify(new URL('../desk/service.mjs', import.meta.url).href)};
      import { createPublishTransaction } from ${JSON.stringify(new URL('../desk/publish-transaction.mjs', import.meta.url).href)};
      import { buildPayload } from ${JSON.stringify(new URL('../desk/publish-contract.mjs', import.meta.url).href)};
      const cfg = JSON.parse(process.env.FIXTURE);
      const die = () => process.exit(0);
      const service = createPublishService({ getDraft: async () => cfg.draft, getCredentials: () => cfg.credential,
        transaction: createPublishTransaction(cfg), prepareCover: () => {}, cleanupCover: () => {},
        createClient: () => ({ partitions: async () => cfg.catalog, buildPayload,
          uploadVideo: async () => { if (cfg.mode === 'before-upload') die(); return { filename: 'fake', chunks: 1 }; },
          submit: async () => die() }) });
      await service.submit(cfg.input); process.exit(2);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { env: { ...process.env,
      FIXTURE: JSON.stringify({ root: f.root, home: f.home, credential: CRED, draft: f.draft('a'), catalog: CATALOG, input: INPUT, mode }) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', b => { stderr += b; });
    const [code] = await once(child, 'close'); assert.equal(code, 0, stderr);
    assert.equal(readJournal(f.store()).entries[0].outcome, 'submitting');
    const x = f.service();
    assert.equal((await x.service.submit({ ...INPUT, id: 'b' })).reason, 'unknown');
    assert.deepEqual(x.calls, []);
  }
});

test('真实跨进程互斥：子进程持锁时另一个入口零上传，退出后未知仍阻断', async t => {
  const f = fixture(t);
  const childCode = `
    import { createPublishTransaction } from ${JSON.stringify(new URL('../desk/publish-transaction.mjs', import.meta.url).href)};
    const cfg = JSON.parse(process.env.FIXTURE);
    process.on('message', () => {});
    await createPublishTransaction(cfg).execute(cfg.context, async () => {
      process.send('locked'); await new Promise(() => {});
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { env: { ...process.env,
    FIXTURE: JSON.stringify({ root: f.root, home: f.home, context: { credential: CRED, draft: f.draft('a'), input: INPUT } }) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const closed = once(child, 'close');
  try {
    await once(child, 'message');
    const x = f.service();
    assert.equal((await f.web(x.client).submit({ ...INPUT, id: 'b' })).reason, 'locked');
    assert.deepEqual(x.calls, []);
  } finally { child.kill('SIGTERM'); await closed; }
  const y = f.service(); assert.equal((await y.service.submit(INPUT)).reason, 'unknown'); assert.deepEqual(y.calls, []);
});
