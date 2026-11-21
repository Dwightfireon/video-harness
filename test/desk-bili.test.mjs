import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBiliClient, pickCookies, cookiesComplete, flattenPartitions, BiliError, FALLBACK_PARTITIONS,
  ensureDeviceCookies, checkPublishReady, resolveChunkSize } from '../desk/bili.mjs';
import { cookiesFromSetCookie, cookiesFromUrl, mergeLoginCookies, saveBiliCredential, readBiliCredential, clearBiliCredential, credentialPath } from '../desk/login.mjs';

/* 假 B 站：按真实协议的最小行为返回，并记录调用顺序与请求体。 */
function fakeBili({ chunkSize = 4, failSubmit = null, submitCode = 0 } = {}) {
  const calls = [];
  const fake = async (url, options = {}) => {
    const u = new URL(url);
    const method = (options.method || 'GET').toUpperCase();
    calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: options.body, headers: options.headers });
    const json = (value, headers = {}) => ({
      ok: true, status: 200, headers: { getSetCookie: () => headers.setCookie || [] },
      text: async () => JSON.stringify(value), json: async () => value,
    });
    if (u.pathname === '/x/web-interface/nav') {
      return json({ code: 0, data: { isLogin: true, mid: 42, uname: '测试账号', level_info: { current_level: 5 } } });
    }
    if (u.pathname === '/x/vupre/web/archive/pre') {
      return json({ code: 0, data: { typelist: [
        { id: 4, parent: 0, name: '游戏', children: [{ id: 17, parent: 4, name: '单机游戏', children: [] }] },
        { id: 188, parent: 0, name: '科技', children: [{ id: 95, parent: 188, name: '数码', children: [] }] },
      ] } });
    }
    if (u.pathname === '/preupload') {
      return json({ OK: 1, endpoint: '//upos-test.bilivideo.com', auth: 'auth-token', biz_id: 99,
        chunk_size: chunkSize, upos_uri: 'upos://ugcupos/abc123.mp4' });
    }
    if (u.pathname.endsWith('/ugcupos/abc123.mp4') && u.searchParams.has('uploads')) {
      return json({ upload_id: 'uid-1', chunk_size: chunkSize });
    }
    if (u.pathname.endsWith('/ugcupos/abc123.mp4') && method === 'PUT') {
      return json({});
    }
    if (u.pathname.endsWith('/ugcupos/abc123.mp4') && method === 'POST' && !u.searchParams.has('uploads')) {
      return json({ OK: 1, url: 'http://upos-test/ugcupos/abc123.mp4' });
    }
    if (u.pathname === '/x/vu/web/cover/up') {
      return json({ code: 0, data: { url: 'https://i0.hdslb.com/cover.jpg' } });
    }
    if (u.pathname === '/x/vu/web/add/v3') {
      if (failSubmit) return { ok: false, status: 400, headers: { getSetCookie: () => [] },
        text: async () => JSON.stringify(failSubmit), json: async () => failSubmit };
      return json({ code: submitCode, message: submitCode ? '投稿过快' : 'OK',
        data: submitCode ? null : { aid: 111, bvid: 'BV1xx411c7mD' } });
    }
    throw new Error('unexpected request: ' + method + ' ' + url);
  };
  return { fake, calls };
}

function tmpVideo(t, bytes = 10) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-bili-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

const COOKIES = { SESSDATA: 'sess', bili_jct: 'jct', DedeUserID: '42' };

test('上传视频：preupload → 建会话 → 逐块 PUT → 合并，分块数与参数正确', async t => {
  // 用最小块大小 256KB，600KB 文件切成 3 块（256 + 256 + 88），贴近真实分块行为。
  const chunk = 256 * 1024;
  const file = tmpVideo(t, chunk * 2 + 88);
  const { fake, calls } = fakeBili({ chunkSize: chunk });
  const progress = [];
  const api = createBiliClient({ cookies: COOKIES, fetch: fake, onProgress: p => progress.push(p) });
  const video = await api.uploadVideo(file);

  assert.equal(video.filename, 'abc123');
  assert.equal(video.bytes, chunk * 2 + 88);
  assert.equal(video.chunks, 3);
  const puts = calls.filter(c => c.method === 'PUT');
  assert.equal(puts.length, 3);
  assert.deepEqual(puts.map(c => Number(c.query.size)), [chunk, chunk, 88]);
  assert.deepEqual(puts.map(c => c.query.partNumber), ['1', '2', '3']);
  assert.equal(puts[0].headers['x-upos-auth'], 'auth-token');
  const preupload = calls.find(c => c.path === '/preupload');
  assert.equal(preupload.query.name, 'clip.mp4');
  assert.equal(preupload.query.size, String(chunk * 2 + 88));
  const final = calls.find(c => c.method === 'POST' && c.path.endsWith('abc123.mp4') && c.query.uploadId);
  assert.deepEqual(JSON.parse(final.body).parts.map(p => p.partNumber), [1, 2, 3]);
  assert.ok(progress.some(p => p.phase === 'uploaded'));
});

test('上传失败会带步骤和码，不吞掉原始响应', async t => {
  const file = tmpVideo(t, 4);
  const fake = async url => {
    if (new URL(url).pathname === '/preupload') {
      return { ok: false, status: 412, headers: { getSetCookie: () => [] },
        text: async () => JSON.stringify({ code: 601, message: '上传过快，请稍后再试' }), json: async () => ({ code: 601 }) };
    }
    throw new Error('unexpected');
  };
  const api = createBiliClient({ cookies: COOKIES, fetch: fake });
  await assert.rejects(() => api.uploadVideo(file), error => {
    assert.ok(error instanceof BiliError);
    assert.equal(error.code, 601);
    assert.equal(error.step, '申请上传线路');
    assert.match(error.message, /上传过快/);
    return true;
  });
});

test('buildPayload：标题/分区/标签的硬约束在校验里说清楚', () => {
  const api = createBiliClient({ cookies: COOKIES });
  const video = { filename: 'abc123' };
  assert.throws(() => api.buildPayload({ title: '', tid: 171, tags: ['a'], video }), /标题不能为空/);
  assert.throws(() => api.buildPayload({ title: 't', tid: 0, tags: ['a'], video }), /分区/);
  assert.throws(() => api.buildPayload({ title: 't', tid: 171, tags: [], video }), /至少填一个标签/);
  assert.throws(() => api.buildPayload({ title: 't', tid: 171, tags: Array.from({ length: 11 }, (_, i) => 'a' + i), video }), /超过 10 个/);
  assert.throws(() => api.buildPayload({ title: 'x'.repeat(81), tid: 171, tags: ['a'], video }), /80 字上限/);
  assert.throws(() => api.buildPayload({ title: 't', tid: 171, tags: ['a'], video, copyright: 2 }), /来源/);
  assert.throws(() => api.buildPayload({ title: 't', tid: 171, tags: ['a'], video: {} }), /视频文件名/);

  const payload = api.buildPayload({ title: '  我的标题  ', tid: 171, tags: '游戏, 杂谈', desc: '简介', video, cover: 'https://c/1.jpg' });
  assert.equal(payload.title, '我的标题');
  assert.equal(payload.tag, '游戏,杂谈');
  assert.equal(payload.tid, 171);
  assert.equal(payload.videos[0].filename, 'abc123');
  assert.equal(payload.videos[0].title, '我的标题');
  assert.equal(payload.cover, 'https://c/1.jpg');
  assert.equal(payload.copyright, 1);
});

test('submit：成功返回 BV 号；失败带 B 站 code/message', async t => {
  const { fake } = fakeBili();
  const ok = createBiliClient({ cookies: COOKIES, fetch: fake });
  const payload = ok.buildPayload({ title: 't', tid: 171, tags: ['a'], video: { filename: 'abc123' } });
  const result = await ok.submit(payload);
  assert.equal(result.bvid, 'BV1xx411c7mD');
  assert.equal(result.aid, 111);

  const { fake: bad } = fakeBili({ failSubmit: { code: 21070, message: '投稿过于频繁' } });
  const failing = createBiliClient({ cookies: COOKIES, fetch: bad });
  await assert.rejects(() => failing.submit(payload), error => {
    assert.equal(error.code, 21070);
    assert.match(error.message, /投稿被拒绝：投稿过于频繁/);
    return true;
  });

  const anonymous = createBiliClient({ cookies: {}, fetch: fake });
  await assert.rejects(() => anonymous.submit(payload), /缺少登录凭据/);
});

test('与 B 站接口约定：csrf 与时间戳进查询串，Cookie 头正确', async () => {
  const { fake, calls } = fakeBili();
  const api = createBiliClient({ cookies: COOKIES, fetch: fake });
  await api.submit(api.buildPayload({ title: 't', tid: 171, tags: ['a'], video: { filename: 'abc123' } }));
  const submit = calls.find(c => c.path === '/x/vu/web/add/v3');
  assert.equal(submit.query.csrf, 'jct');
  assert.match(String(submit.query.t), /^\d{13}$/);
  assert.match(submit.headers.cookie, /SESSDATA=sess/);
  assert.match(submit.headers.cookie, /bili_jct=jct/);
  assert.equal(submit.headers['content-type'], 'application/json');
});

test('whoami：未登录返回 false，不抛错', async () => {
  const fake = async () => ({ ok: true, status: 200, headers: { getSetCookie: () => [] },
    text: async () => JSON.stringify({ code: -101, message: '账号未登录', data: { isLogin: false } }),
    json: async () => ({ code: -101, data: { isLogin: false } }) });
  assert.equal((await createBiliClient({ cookies: {}, fetch: fake }).whoami()).loggedIn, false);
});

test('partitions：扁平化嵌套分区并保留父级名称', async () => {
  const { fake } = fakeBili();
  const result = await createBiliClient({ cookies: COOKIES, fetch: fake }).partitions();
  assert.equal(result.live, true);
  // 父分类（游戏/科技）不能作为 tid 提交，必须只收子级。
  assert.deepEqual(result.list.map(({ id, name, parent }) => ({ id, name, parent })), [
    { id: 17, name: '单机游戏', parent: '游戏' },
    { id: 95, name: '数码', parent: '科技' },
  ]);
  assert.equal(flattenPartitions({ list: [{ id: 1, name: 'A', child: [{ id: 2, name: 'B' }] }] }).length, 1);
  assert.ok(FALLBACK_PARTITIONS.every(item => item.id > 0 && item.name));
});

/* 真实接口用 children 字段（不是 sub/child）。
 * 真实事故：字段名不匹配，140 个分区被平铺成同一层，父分类「生活」「游戏」也进了列表，
 * 选中后提交会失败。 */
test('flattenPartitions：识别真实接口的 children 结构，剔除父分类', () => {  const real = {
    typelist: [
      { id: 160, parent: 0, name: '生活', children: [
        { id: 138, parent: 160, name: '搞笑', children: [] },
        { id: 21, parent: 160, name: '日常', children: [] },
      ] },
      { id: 4, parent: 0, name: '游戏', children: [
        { id: 17, parent: 4, name: '单机游戏' },
      ] },
      { id: 177, parent: 0, name: '纪录片' },
    ],
  };
  const list = flattenPartitions(real);
  assert.deepEqual(list.map(({ id, name, parent }) => ({ id, name, parent })), [
    { id: 138, name: '搞笑', parent: '生活' },
    { id: 21, name: '日常', parent: '生活' },
    { id: 17, name: '单机游戏', parent: '游戏' },
  ]);
  // 父分类不得出现
  assert.equal(list.some(item => ['生活', '游戏'].includes(item.name)), false);
});

/* 旧投稿列表中，AI 技术内容写在「计算机技术」的描述里；新版另有人工智能频道。
 * 所以分区必须保留 description，否则用户按 AI 搜不到任何东西。 */
test('flattenPartitions：保留 description，AI 类内容才能被搜到', () => {
  const real = { typelist: [{ id: 188, name: '科技', children: [
    { id: 231, parent: 188, name: '计算机技术', description: '软硬件开发/人工智能/大数据/深度学习/IT运维等' },
    { id: 230, parent: 188, name: '软件应用', description: '围绕各类系统软件、应用软件、网站的相关视频' },
  ] }] };
  const list = flattenPartitions(real);
  assert.equal(list.length, 2);
  const tech = list.find(item => item.id === 231);
  assert.equal(tech.name, '计算机技术');
  assert.equal(tech.parent, '科技');
  assert.match(tech.description, /人工智能/);

  // 模拟搜索：按名字搜 "人工智能" 搜不到，按描述才能命中。
  const byName = list.filter(i => i.name.includes('人工智能'));
  assert.equal(byName.length, 0);
  const byDescription = list.filter(i => (i.name + i.parent + i.description).includes('人工智能'));
  assert.equal(byDescription.length, 1);
  assert.equal(byDescription[0].id, 231);
});

test('flattenPartitions：没有可投稿分区时返回空，不把父分类冒充可选', () => {
  const list = flattenPartitions({ typelist: [{ id: 1, name: '空分类', children: [] }] });
  // 空顶级容器不可当作二级投稿分区。
  assert.deepEqual(list, []);
  assert.deepEqual(flattenPartitions({}), []);
  assert.deepEqual(flattenPartitions(null), []);
});

test('cookie 只保留必要项，缺项时登录视为不完整', () => {
  const picked = pickCookies([
    { name: 'SESSDATA', value: 's' }, { name: 'bili_jct', value: 'j' }, { name: 'buvid3', value: 'device' },
    { name: 'buvid_fp', value: 'fingerprint-should-be-dropped' }, { name: '', value: 'bad' },
  ]);
  // 设备标识必须留下：只带两个 cookie 时 preupload 会被风控拦成 HTML 403。
  assert.deepEqual(picked, { SESSDATA: 's', bili_jct: 'j', buvid3: 'device' });
  assert.equal(cookiesComplete(picked), true);
  assert.equal(cookiesComplete({ SESSDATA: 's' }), false);
  assert.deepEqual(cookiesFromSetCookie(['SESSDATA=abc%2Cdef; Path=/', 'bili_jct=xyz; Path=/', 'other=1']), { SESSDATA: 'abc,def', bili_jct: 'xyz' });
  assert.deepEqual(cookiesFromUrl('https://x/?DedeUserID=42&bili_jct=jj'), { DedeUserID: '42', bili_jct: 'jj' });
  // 两处都有时 Set-Cookie 优先；只有一处时也能拿到完整凭据。
  assert.deepEqual(mergeLoginCookies({ setCookie: ['SESSDATA=s1; Path=/'], url: 'https://x/?SESSDATA=old&bili_jct=j&buvid3=nope' }),
    { SESSDATA: 's1', bili_jct: 'j' });
  assert.deepEqual(mergeLoginCookies({ setCookie: [], url: 'https://x/?SESSDATA=s&bili_jct=j' }), { SESSDATA: 's', bili_jct: 'j' });
  assert.deepEqual(mergeLoginCookies({}), {});
});

test('凭据文件写在项目外、权限 600，退出登录真的删除', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const saved = saveBiliCredential({ SESSDATA: 's', bili_jct: 'j', buvid3: 'dev', buvid_fp: 'drop' }, { home, mid: 42, name: '测试' });
  assert.equal(saved, credentialPath(home));
  const info = fs.statSync(saved);
  assert.equal(info.mode & 0o777, 0o600);
  const text = fs.readFileSync(saved, 'utf8');
  assert.equal(text.includes('buvid_fp'), false);
  assert.equal(text.includes('"buvid3"'), true);
  const read = readBiliCredential(home);
  assert.deepEqual(read.cookies, { SESSDATA: 's', bili_jct: 'j', buvid3: 'dev' });
  assert.equal(read.mid, 42);
  assert.equal(clearBiliCredential(home), true);
  assert.equal(readBiliCredential(home), null);
  assert.throws(() => saveBiliCredential({ SESSDATA: 's' }, { home }), /不完整/);
});

/* 真实事故：preupload 被风控拦截时返回整页 HTML，直接把 text 拼进错误会显示一屏乱码。 */
test('服务端返回 HTML 拦截页时给出可读原因，不把乱码当消息', async t => {
  const file = tmpVideo(t, 4);
  const fake = async () => ({ ok: false, status: 403, headers: { getSetCookie: () => [] },
    text: async () => '<!DOCTYPE HTML><html><head><title>403</title></head><body>风控拦截</body></html>',
    json: async () => { throw new Error('not json'); } });
  const api = createBiliClient({ cookies: COOKIES, fetch: fake });
  await assert.rejects(() => api.uploadVideo(file), error => {
    assert.match(error.message, /HTTP 403/);
    assert.match(error.message, /拦截页/);
    assert.equal(error.message.includes('<!DOCTYPE'), false);
    assert.equal(error.message.includes('<html'), false);
    return true;
  });
});

test('createBiliClient 暴露 preupload，供体检在真实上传前验证线路', async t => {
  const { fake } = fakeBili({ chunkSize: 4 });
  const api = createBiliClient({ cookies: COOKIES, fetch: fake });
  assert.equal(typeof api.preupload, 'function');
  const bucket = await api.preupload({ name: 'probe.mp4', size: 1024 });
  assert.equal(bucket.endpoint, '//upos-test.bilivideo.com');
  assert.equal(bucket.auth, 'auth-token');
});

test('checkPublishReady：登录、分区、线路三项分别给结论，任一失败即不可投稿', async t => {
  const { fake } = fakeBili({ chunkSize: 4 });
  const ok = await checkPublishReady(createBiliClient({ cookies: COOKIES, fetch: fake }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.checks.map(c => c.name), ['登录状态', '创作中心接口', '上传线路']);
  assert.ok(ok.checks.every(c => c.ok));

  const blocked = async url => {
    const u = new URL(url);
    if (u.pathname === '/x/web-interface/nav') return { ok: true, status: 200, headers: { getSetCookie: () => [] },
      text: async () => JSON.stringify({ code: -101, data: { isLogin: false } }), json: async () => ({ code: -101, data: { isLogin: false } }) };
    return { ok: false, status: 403, headers: { getSetCookie: () => [] },
      text: async () => '<html>blocked</html>', json: async () => null };
  };
  const bad = await checkPublishReady(createBiliClient({ cookies: {}, fetch: blocked }));
  assert.equal(bad.ok, false);
  assert.equal(bad.checks.find(c => c.name === '登录状态').ok, false);
  assert.equal(bad.checks.find(c => c.name === '上传线路').ok, false);
});

test('resolveChunkSize：服务端给异常大或 0 时夹到安全范围，避免整块读进内存', () => {
  assert.equal(resolveChunkSize(4 * 1024 * 1024), 4 * 1024 * 1024);
  // 服务端返回 100MB：不能照抄，否则一次分配 100MB
  assert.equal(resolveChunkSize(100 * 1024 * 1024), 16 * 1024 * 1024);
  // 服务端返回 0 / undefined：回落到 4MB
  assert.equal(resolveChunkSize(0), 4 * 1024 * 1024);
  assert.equal(resolveChunkSize(undefined), 4 * 1024 * 1024);
  assert.equal(resolveChunkSize(NaN), 4 * 1024 * 1024);
  // 过小的值也抬到下限，避免产生成千上万个分块
  assert.equal(resolveChunkSize(1024), 256 * 1024);
  // 显式指定优先，但同样受夹取
  assert.equal(resolveChunkSize(4 * 1024 * 1024, 1024), 256 * 1024);
  assert.equal(resolveChunkSize(4 * 1024 * 1024, 999 * 1024 * 1024), 16 * 1024 * 1024);
});

test('上传时按夹取后的块大小切分，URL 参数与之一致', async t => {
  const file = tmpVideo(t, 40);
  // 服务端谎报 100MB 块大小
  const { fake, calls } = fakeBili({ chunkSize: 0 });
  const custom = async (url, options) => {
    const u = new URL(url);
    if (u.pathname === '/preupload') {
      const body = await fake(url, options);
      const value = await body.json();
      return { ...body, json: async () => ({ ...value, chunk_size: 100 * 1024 * 1024 }), text: async () => JSON.stringify({ ...value, chunk_size: 100 * 1024 * 1024 }) };
    }
    return fake(url, options);
  };
  const api = createBiliClient({ cookies: COOKIES, fetch: custom });
  const video = await api.uploadVideo(file);
  // 40 字节的文件用最小块 256KB，仍然只有一块
  assert.equal(video.chunks, 1);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(Number(calls.find(c => c.method === 'PUT').query.total), 40);
});

test('archives / findArchive：读出稿件列表并能按 BV 号定位', async () => {
  const calls = [];
  const fake = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    return { ok: true, status: 200, headers: { getSetCookie: () => [] },
      text: async () => JSON.stringify({ code: 0, data: { page: { count: 2 }, arc_audits: [
        { Archive: { aid: 1, bvid: 'BV1xx411c7mD', title: '新片', state: 0, state_desc: '开放浏览', ptime: 1700000000 } },
        { Archive: { aid: 2, bvid: 'BV1yy411c7mE', title: '旧片', state: -30, state_desc: '审核中', ptime: 1600000000 } },
      ] } }),
      json: async () => ({ code: 0 }) };
  };
  const api = createBiliClient({ cookies: COOKIES, fetch: fake });
  const result = await api.archives();
  assert.equal(calls[0], '/x/web/archives');
  assert.equal(result.total, 2);
  assert.deepEqual(result.list.map(i => i.bvid), ['BV1xx411c7mD', 'BV1yy411c7mE']);

  const found = await api.findArchive('BV1yy411c7mE');
  assert.equal(found.title, '旧片');
  assert.equal(found.stateDesc, '审核中');
  assert.equal(await api.findArchive('BV1zz411c7mF'), null);
});

test('archives：接口报错时抛 BiliError，不静默返回空列表', async () => {
  const fake = async () => ({ ok: true, status: 200, headers: { getSetCookie: () => [] },
    text: async () => JSON.stringify({ code: -101, message: '账号未登录' }), json: async () => ({ code: -101 }) });
  const api = createBiliClient({ cookies: {}, fetch: fake });
  await assert.rejects(() => api.archives(), error => {
    assert.ok(error instanceof BiliError);
    assert.match(error.message, /账号未登录/);
    return true;
  });
});

test('ensureDeviceCookies：缺 buvid3 时补齐，已有就不重复请求', async () => {
  let calls = 0;
  const fake = async () => { calls++; return { ok: true, json: async () => ({ code: 0, data: { b_3: 'dev3', b_4: 'dev4' } }) }; };
  const fresh = await ensureDeviceCookies({ SESSDATA: 's', bili_jct: 'j' }, { fetch: fake });
  assert.equal(fresh.buvid3, 'dev3');
  assert.equal(fresh.buvid4, 'dev4');
  assert.equal(calls, 1);

  const existing = { SESSDATA: 's', bili_jct: 'j', buvid3: 'mine' };
  const kept = await ensureDeviceCookies(existing, { fetch: fake });
  assert.equal(kept.buvid3, 'mine');
  assert.equal(calls, 1);

  const failing = await ensureDeviceCookies({ SESSDATA: 's', bili_jct: 'j' }, { fetch: async () => { throw new Error('offline'); } });
  assert.equal(failing.SESSDATA, 's');
});
