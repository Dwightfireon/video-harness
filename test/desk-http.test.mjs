import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBiliClient, BiliError } from '../desk/bili.mjs';

const cookies = { SESSDATA: 'test', bili_jct: 'test' };
test('HTTP：响应头成功后读取 body 超时/失败仍转换为带阶段的网络错误', async () => {
  const api = createBiliClient({ cookies, timeout: 20, fetch: async (_url, { signal }) => ({
    ok: true, status: 200,
    text: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true })),
  }) });
  await assert.rejects(() => api.submit({}), error => {
    assert.ok(error instanceof BiliError);
    assert.equal(error.outcome, 'unknown');
    assert.equal(error.httpStatus, 200);
    assert.match(error.message, /超时/);
    return true;
  });
  const broken = createBiliClient({ cookies, fetch: async () => ({ ok: true, status: 200,
    text: async () => { throw new Error('body failed'); } }) });
  await assert.rejects(() => broken.partitions(), error => {
    assert.equal(error.step, '读取分区');
    assert.match(error.message, /body failed/);
    return true;
  });
});

test('HTTP：HTML/非 JSON/缺回执为结果未知，业务拒绝与 HTTP 状态保留', async () => {
  for (const item of [
    { status: 403, text: '<html>blocked</html>', outcome: 'unknown' },
    { status: 200, text: 'not json', outcome: 'unknown' },
    { status: 200, text: JSON.stringify({ code: 0, data: {} }), outcome: 'unknown' },
    { status: 400, text: JSON.stringify({ code: 21070, message: '投稿过于频繁' }), outcome: 'rejected', code: 21070 },
  ]) {
    let calls = 0;
    const api = createBiliClient({ cookies, fetch: async () => {
      calls++; return { ok: item.status === 200, status: item.status, text: async () => item.text };
    } });
    await assert.rejects(() => api.submit({}), error => {
      assert.equal(error.outcome, item.outcome);
      assert.equal(error.httpStatus, item.status);
      if (item.code) assert.equal(error.code, item.code);
      assert.equal(error.message.includes('<html>'), false);
      return true;
    });
    assert.equal(calls, 1, '投稿请求不得自动重试');
  }
});
