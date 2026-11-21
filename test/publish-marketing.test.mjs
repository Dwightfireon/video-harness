import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBiliClient } from '../desk/bili.mjs';
import { buildPayload, normalizeForm } from '../desk/publish-contract.mjs';
import { runPublish } from '../desk/publish.mjs';

const INPUT = { title: '网站介绍', desc: '网站使用方法', tags: ['网站'], tid: 231, cover: false, promotion: { enabled: true } };
const BV = 'BV1234567890';
const response = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });

test('营销声明使用当前官方 creation_statement 格式，与 porder 分开；规范化和选填不影响标注', () => {
  const input = { ...INPUT, video: { filename: 'fake' } };
  for (const promotion of [{ enabled: true }, { enabled: true, brandName: '网站', industryId: 9, showTypes: [11] }]) {
    const raw = { ...input, promotion };
    const a = buildPayload(raw), b = buildPayload({ ...normalizeForm(raw), video: raw.video });
    assert.deepEqual(a.creation_statement, { id: 3 });
    assert.deepEqual(b.creation_statement, { id: 3 });
    assert.equal(a.neutral_mark, undefined, '不能把选项来源字段当提交声明');
  }
  assert.equal(buildPayload({ ...input, promotion: { enabled: false, brandName: '以前的网站' } }).creation_statement, undefined);
  assert.equal(buildPayload({ ...input, promotion: undefined }).creation_statement, undefined);
});

test('完整线协议：POST 带 creation_statement，随后只 GET 对应稿件并核对平台保存值', async () => {
  const calls = [];
  const api = createBiliClient({ cookies: { SESSDATA: 'fake', bili_jct: 'fake' }, fetch: async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body).creation_statement, { id: 3 });
      return response({ code: 0, data: { aid: 1, bvid: BV } });
    }
    assert.equal(new URL(url).pathname, '/x/vupre/web/archive/view');
    assert.equal(new URL(url).searchParams.get('bvid'), BV);
    // 无 porder、旧 neutral_mark 为空仍可确认；只认新创作者声明。
    return response({ code: 0, data: { archive: { aid: 1, bvid: BV, porder: null, neutral_mark: '', creation_statement: { id: 3, content: '内容含营销信息' } } } });
  } });
  const result = await runPublish({ input: INPUT, draft: { video: { path: '/fake/video' } }, prepareCover: () => {},
    api: { ...api, uploadVideo: async () => ({ filename: 'fake-upload' }) } });
  assert.equal(result.outcome, 'submitted'); assert.equal(result.declarationVerification.state, 'confirmed');
  assert.match(result.declarationVerification.message, /不代表观众端已显示/);
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
});

test('回读兼容旧版 creation_statement_id，校验编号防串稿，绝不拿 porder/neutral_mark 充当新标注', async () => {
  const cases = [
    [{ creation_statement_id: 3 }, 3],
    [{ creation_statement: { id: -1 } }, -1],
    [{ creation_statement: { id: 1 } }, 1],
    [{ creation_statement: null, creation_statement_id: 3 }, null],
    [{ creation_statement: { id: '' } }, null],
    [{ creation_statement: { id: false } }, null],
    [{ porder: { flow_id: 1 }, neutral_mark: '内容含营销信息' }, null],
  ];
  for (const [fields, expected] of cases) {
    const api = createBiliClient({ fetch: async (_url, options) => {
      assert.equal(options.method, 'GET'); return response({ code: 0, data: { archive: { bvid: BV, aid: 1, ...fields } } });
    } });
    assert.equal((await api.archiveDetail({ bvid: BV })).creationStatementId, expected);
    assert.equal((await api.archiveDetail({ aid: 1 })).creationStatementId, expected);
    await assert.rejects(api.archiveDetail({ aid: 2 }), /对应稿件/);
  }
  const api = createBiliClient({ fetch: async () => response({ code: 0, data: { archive: { bvid: 'BV0000000000', aid: 2, creation_statement: { id: 3 } } } }) });
  await assert.rejects(api.archiveDetail({ bvid: BV }), /对应稿件/);
  await assert.rejects(api.archiveDetail({}), /有效稿件编号/);
});

test('收稿成功但声明不符、缺失、超时或客户端不支持：保留收稿结果，明确提示，不重发不编辑', async () => {
  for (const [archiveDetail, expected] of [
    [async () => ({ creationStatementId: -1 }), 'mismatch'],
    [async () => ({ creationStatementId: 1 }), 'mismatch'],
    [async () => ({ creationStatementId: null }), 'unverified'],
    [async () => { throw Error('timeout'); }, 'unverified'],
    [undefined, 'unverified'],
  ]) {
    let submits = 0, reads = 0;
    const result = await runPublish({ input: INPUT, draft: { video: { path: '/fake/video' } }, prepareCover: () => {},
      api: { uploadVideo: async () => ({ filename: 'fake' }), buildPayload,
        submit: async () => { submits++; return { aid: 1, bvid: BV }; },
        ...(archiveDetail ? { archiveDetail: async id => { reads++; return archiveDetail(id); } } : {}) } });
    assert.equal(result.ok, true); assert.equal(result.outcome, 'submitted'); assert.equal(result.result.bvid, BV);
    assert.equal(result.declarationVerification.state, expected); assert.match(result.warnings.join(''), /不要重发/);
    assert.equal(submits, 1); assert.equal(reads, archiveDetail ? 1 : 0);
  }
});

test('未勾选不发声明也不回读；平台拒绝时不查声明、不去掉声明重发', async () => {
  let submits = 0, reads = 0;
  const api = { uploadVideo: async () => ({ filename: 'fake' }), buildPayload,
    submit: async () => { submits++; return { aid: 1, bvid: BV }; },
    archiveDetail: async () => { reads++; return { creationStatementId: 3 }; } };
  const params = { draft: { video: { path: '/fake/video' } }, prepareCover: () => {}, api };
  const result = await runPublish({ ...params, input: { ...INPUT, promotion: { enabled: false } } });
  assert.equal(result.declarationVerification, null); assert.equal(reads, 0);
  api.submit = async payload => { submits++; assert.deepEqual(payload.creation_statement, { id: 3 }); throw Object.assign(Error('拒绝'), { outcome: 'rejected' }); };
  await assert.rejects(runPublish({ ...params, input: INPUT }), error => error.outcome === 'rejected');
  assert.equal(submits, 2); assert.equal(reads, 0);
});
