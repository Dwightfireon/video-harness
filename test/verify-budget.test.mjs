import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeTools, toolSchema } from '../lib/agent.mjs';
import { stripProjectCaches } from '../lib/disk-hygiene.mjs';
import { beginResearchAttempt, finishResearchAttempt, researchAttempts,
  researchAttemptFile, verificationBudgetNote } from '../lib/research-attempts.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-verify-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function attempt(dir, assertion, ok, suffix = '/source') {
  const begun = beginResearchAttempt(dir, { assertion, url: 'https://example.com' + suffix });
  assert.equal(begun.blocked, false);
  finishResearchAttempt(dir, begun.ticket, { ok, failureCode: 'http-403' });
}

test('相同问题换来源连续失败两次后停止，新断言不受全项目次数限制', t => {
  const dir = fixture(t);
  attempt(dir, '某药物的试验人数是120名', false, '/a');
  attempt(dir, '某药物的试验人数是120名', false, '/b');
  assert.equal(beginResearchAttempt(dir, { assertion: '某药物的试验人数是120名', url: 'https://elsewhere.test/c' }).blocked, true);
  for (let i = 0; i < 12; i++) attempt(dir, '独立的新问题' + i, true, '/new-' + i);
  assert.equal(researchAttempts(dir).length, 14);
  assert.match(verificationBudgetNote(dir), /没有全项目次数上限/);
});

test('跨恢复保留每次真实结果，不从raw文件数或去重台账推测', t => {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, 'research/raw'), { recursive: true });
  for (let i = 0; i < 15; i++) fs.writeFileSync(path.join(dir, `research/raw/${i}.txt`), '来源');
  assert.equal(verificationBudgetNote(dir), '');
  attempt(dir, '收益率', false);
  attempt(dir, '收益率', false);
  const rows = researchAttempts(dir);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.outcome === 'unavailable' && row.failureCode === 'http-403'));
  assert.equal(beginResearchAttempt(dir, { url: 'https://example.com/source' }).blocked, true);
  assert.equal(fs.readFileSync(researchAttemptFile(dir), 'utf8').trim().split('\n').length, 4);
});

test('成功抓取只重置该问题的连续取原文失败，不证明事实通过', t => {
  const dir = fixture(t);
  attempt(dir, '问题A', false, '/a');
  attempt(dir, '问题A', true, '/b');
  attempt(dir, '问题A', false, '/c');
  const next = beginResearchAttempt(dir, { assertion: '问题A', url: 'https://example.com/d' });
  assert.equal(next.blocked, false);
  finishResearchAttempt(dir, next.ticket, { ok: false });
  assert.match(verificationBudgetNote(dir), /不证明来源支持断言/);
});

test('未落盘结果保留为unknown，两次在途/中断不无限恢复重发', t => {
  const dir = fixture(t);
  for (const suffix of ['/a', '/b']) {
    assert.equal(beginResearchAttempt(dir, { assertion: '问题A', url: 'https://example.com' + suffix }).blocked, false);
  }
  const next = beginResearchAttempt(dir, { assertion: '问题A', url: 'https://example.com/c' });
  assert.equal(next.blocked, true);
  assert.match(next.message, /0 次连续抓取失败、2 次结果未落盘/);
  assert.ok(researchAttempts(dir).every(row => row.outcome === 'started'));
});

test('并发完成顺序决定连续失败数，不按启动顺序误算', t => {
  const dir = fixture(t);
  const a = beginResearchAttempt(dir, { assertion: '问题A', url: 'https://example.com/a' });
  const b = beginResearchAttempt(dir, { assertion: '问题A', url: 'https://example.com/b' });
  finishResearchAttempt(dir, b.ticket, { ok: false });
  finishResearchAttempt(dir, a.ticket, { ok: true });
  assert.equal(verificationBudgetNote(dir), '');
});

test('记录损坏或符号链接时不重置次数、不覆盖记录', t => {
  const dir = fixture(t);
  attempt(dir, '问题A', false);
  const file = researchAttemptFile(dir);
  fs.appendFileSync(file, '{truncated');
  assert.throws(() => beginResearchAttempt(dir, { url: 'https://example.com/a' }));
  assert.match(verificationBudgetNote(dir), /不可读/);
  fs.unlinkSync(file);
  const sentinel = path.join(dir, 'sentinel'); fs.writeFileSync(sentinel, 'unchanged');
  fs.symlinkSync(sentinel, file);
  assert.throws(() => beginResearchAttempt(dir, { url: 'https://example.com/a' }));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
});

test('out目录符号链接不能把抓取记录写到项目外', t => {
  const dir = fixture(t), outside = fixture(t);
  fs.symlinkSync(outside, path.join(dir, 'out'));
  assert.throws(() => beginResearchAttempt(dir, { url: 'https://example.com/a' }), /普通目录/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('URL凭证、参数和断言正文不写入抓取计数日志', t => {
  const dir = fixture(t);
  const a = beginResearchAttempt(dir, { assertion: 'private-assertion', url: 'https://user:secret@example.com/source?token=private-key' });
  finishResearchAttempt(dir, a.ticket, { ok: false });
  assert.doesNotMatch(fs.readFileSync(researchAttemptFile(dir), 'utf8'), /secret|private|example\.com/);
});

test('清理可再生缓存不清掉抓取失败历史', t => {
  const dir = fixture(t);
  attempt(dir, '问题A', false);
  attempt(dir, '问题A', false);
  const bytes = fs.readFileSync(researchAttemptFile(dir));
  fs.mkdirSync(path.join(dir, 'out/frames'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out/frames/00000.jpg'), 'rebuildable cache');
  stripProjectCaches(dir, { keepSeg: false });
  assert.deepEqual(fs.readFileSync(researchAttemptFile(dir)), bytes);
  assert.equal(beginResearchAttempt(dir, { url: 'https://example.com/source' }).blocked, true);
});

test('真实工具拒绝第三次联网，重建工具后仍生效，只读不记账', async t => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; res.writeHead(404); res.end('missing'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const dir = fixture(t), url = `http://127.0.0.1:${server.address().port}/missing`;
  for (let i = 0; i < 2; i++) assert.match(await makeTools(dir, () => {}).fetch_url.run({ url, assertion: '问题A' }), /抓取失败/);
  assert.match(await makeTools(dir, () => {}).fetch_url.run({ url, assertion: '问题A' }), /未再次联网/);
  assert.equal(requests, 2);
  const readOnly = fixture(t);
  await makeTools(readOnly, () => {}, { readOnly: true }).fetch_url.run({ url });
  assert.equal(fs.existsSync(path.join(readOnly, 'out')), false);
  const schema = toolSchema(makeTools(dir, () => {})).find(row => row.function.name === 'fetch_url');
  assert.ok(schema.function.parameters.properties.assertion);
  assert.deepEqual(schema.function.parameters.required, ['url']);
});

test('只有脚本标签的长HTML不是取得正文，记录损坏时工具不联网', async t => {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.end('<script>' + 'x'.repeat(500) + '</script>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const dir = fixture(t), url = `http://127.0.0.1:${server.address().port}/empty`;
  assert.match(await makeTools(dir, () => {}).fetch_url.run({ url }), /正文过短/);
  assert.equal(researchAttempts(dir)[0].failureCode, 'short-body');
  fs.appendFileSync(researchAttemptFile(dir), '{broken');
  assert.match(await makeTools(dir, () => {}).fetch_url.run({ url }), /未联网/);
  assert.equal(requests, 1);
});
