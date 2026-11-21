/* lib/publish-refs.mjs 的专项自检：
 *   node test/publish-refs.test.mjs
 * 覆盖：来源类型过滤、去重、未取得原文的排除、摘要不越界、空表不编造。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { referenceSources, referenceBlock, missingReferences } from '../lib/publish-refs.mjs';
import { appendClaimReferences as appendReferences } from '../lib/reference-sources.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vh-refs-'));
function write(claims) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify({ schemaVersion: 1, claims }, null, 2));
  return dir;
}
const ev = (url, extra = {}) => ({ url, quote: '原文摘录一句。', type: '官方新闻稿', checkedAt: '2026-11-01', ...extra });

test('只收集外部事实来源，作者建议/计算/用户提供不进公开清单', () => {
  const dir = write([
    { id: 'C1', statement: 'a', kind: '官方年报', sourceType: 'external', evidence: [ev('https://example.com/a')] },
    { id: 'C2', statement: 'b', kind: '作者建议', sourceType: 'recommendation', evidence: [ev('https://example.com/b')] },
    { id: 'C3', statement: 'c', kind: '作者计算', sourceType: 'calculation', evidence: [ev('https://example.com/c')] },
    { id: 'C4', statement: 'd', kind: '用户提供', sourceType: 'user-provided', evidence: [ev('https://example.com/d')] },
  ]);
  const urls = referenceSources(dir).map(s => s.url);
  assert.deepEqual(urls, ['https://example.com/a']);
});

test('同一 URL 只出现一次，保留首次的标题', () => {
  const dir = write([
    { id: 'C1', statement: 'a', kind: '官方', sourceType: 'external', evidence: [ev('https://example.com/x', { type: '第一次' })] },
    { id: 'C2', statement: 'b', kind: '官方', sourceType: 'external', evidence: [ev('https://example.com/x', { type: '第二次' })] },
  ]);
  const sources = referenceSources(dir);
  assert.equal(sources.length, 1);
  assert.match(sources[0].label, /^第一次/);
});

test('来源明确未取得（403 / available:false）不放进公开清单', () => {
  const dir = write([
    { id: 'C1', statement: 'a', kind: '官方', sourceType: 'external', evidence: [ev('https://example.com/ok')] },
    { id: 'C2', statement: 'b', kind: '官方', sourceType: 'external', evidence: [ev('https://example.com/blocked', { httpStatus: 403 })] },
    { id: 'C3', statement: 'c', kind: '官方', sourceType: 'external', evidence: [ev('https://example.com/gone', { available: false })] },
    { id: 'C4', statement: 'd', kind: '官方', sourceType: 'external', evidence: [ev('https://example.com/unread', { quote: '本次抓取 403，未读到原文' })] },
  ]);
  assert.deepEqual(referenceSources(dir).map(s => s.url), ['https://example.com/ok']);
});

test('非 http(s) 链接被丢弃，不生成假来源', () => {
  const dir = write([
    { id: 'C1', statement: 'a', kind: '官方', sourceType: 'external', evidence: [ev('file:///etc/passwd')] },
    { id: 'C2', statement: 'b', kind: '官方', sourceType: 'external', evidence: [ev('not a url')] },
  ]);
  assert.deepEqual(referenceSources(dir), []);
});

test('claims.json 缺失或损坏时返回空数组，不抛错也不编造', () => {
  const empty = tmp();
  assert.deepEqual(referenceSources(empty), []);
  fs.writeFileSync(path.join(empty, 'claims.json'), '{oops');
  assert.deepEqual(referenceSources(empty), []);
});

test('没有任何可引用来源时，文本块为空字符串', () => {
  assert.equal(referenceBlock([]), '');
  assert.equal(referenceBlock(null), '');
});

test('文本块含标题与链接，条数受 max 限制', () => {
  const sources = Array.from({ length: 12 }, (_, i) => ({ url: `https://example.com/${i}`, label: `来源${i}`, note: '' }));
  const block = referenceBlock(sources, { max: 8 });
  assert.match(block, /^参考资料/);
  assert.equal((block.match(/https:\/\/example\.com\//g) || []).length, 8);
});

test('摘要截断到一行且不超过上限', () => {
  const dir = write([{
    id: 'C1', statement: 'a', kind: '官方', sourceType: 'external',
    evidence: [ev('https://example.com/long', { quote: '第一'.repeat(300) + '。后面不该出现' })],
  }]);
  const [s] = referenceSources(dir);
  assert.ok(s.note.length <= 71, '摘要过长：' + s.note.length);
  assert.ok(!s.note.includes('后面不该出现'));
});

test('missingReferences 指出简介里还没出现的链接', () => {
  const sources = [{ url: 'https://a.example.com' }, { url: 'https://b.example.com' }];
  const missing = missingReferences('简介里已经有 https://a.example.com', sources);
  assert.deepEqual(missing.map(s => s.url), ['https://b.example.com']);
  assert.equal(missingReferences('', sources).length, 2);
});

test('publicUrl 优先于核证用 url：API 地址不会被当成给读者看的链接', () => {
  const dir = write([{
    id: 'C1', statement: 'a', kind: '官方', sourceType: 'external',
    evidence: [ev('https://data.sec.gov/api/xbrl/x.json', { publicUrl: 'https://investor.example.com/q3', publicLabel: '某公司 2026 Q3 财报' })],
  }]);
  const [s] = referenceSources(dir);
  assert.equal(s.url, 'https://investor.example.com/q3');
  assert.equal(s.label, '某公司 2026 Q3 财报');
});

test('标签不会四条一模一样：缺 publicLabel 时带上域名', () => {
  const dir = write([
    { id: 'C1', statement: 'a', kind: '官方', sourceType: 'external', evidence: [ev('https://data.sec.gov/api/xbrl/a.json')] },
    { id: 'C2', statement: 'b', kind: '官方', sourceType: 'external', evidence: [ev('https://data.sec.gov/api/xbrl/b.json')] },
  ]);
  const labels = referenceSources(dir).map(s => s.label);
  assert.equal(new Set(labels).size, labels.length, '标签重复：' + labels.join(' / '));
  assert.ok(labels.every(l => /data\.sec\.gov/.test(l)));
});

test('机器接口 URL 会被标记出来，供调用方提示', () => {
  const dir = write([{ id: 'C1', statement: 'a', kind: '官方', sourceType: 'external', evidence: [ev('https://data.sec.gov/api/xbrl/a.json')] }]);
  const list = referenceSources(dir);
  assert.deepEqual(list.machineUrls, ['https://data.sec.gov/api/xbrl/a.json']);
  const human = write([{ id: 'C1', statement: 'a', kind: '官方', sourceType: 'external', evidence: [ev('https://example.com/report')] }]);
  assert.deepEqual(referenceSources(human).machineUrls, []);
});

test('appendReferences 只做加法：不改动已有简介文字，且可重复执行', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify({ claims: [
    { id: 'C1', statement: 'a', kind: '官方', sourceType: 'external', evidence: [ev('https://a.example.com/x', { publicLabel: '来源甲' })] },
    { id: 'C2', statement: 'b', kind: '官方', sourceType: 'external', evidence: [ev('https://b.example.com/y', { publicLabel: '来源乙' })] },
  ] }));
  const original = '# 发布文案\n\n## 标题\n\n某标题\n\n## 简介\n\n这是原有简介，必须一字不改。\n\n## 标签\n\n测试\n';
  fs.writeFileSync(path.join(dir, '发布文案.md'), original);

  const r1 = appendReferences(dir);
  assert.equal(r1.ok, true);
  assert.equal(r1.added, 2);
  const after = fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8');
  assert.match(after, /这是原有简介，必须一字不改。/);
  assert.match(after, /参考资料/);
  assert.equal((after.match(/https:\/\/a\.example\.com\/x/g) || []).length, 1);
  // 其它小节未被破坏
  assert.match(after, /## 标签\n\n测试/);

  const r2 = appendReferences(dir);
  assert.equal(r2.added, 0);
  assert.equal(r2.reason, 'already-present');
  const again = fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8');
  assert.equal((again.match(/参考资料/g) || []).length, (after.match(/参考资料/g) || []).length);
});

test('没有文案时不臆造整份文件', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify({ claims: [
    { id: 'C1', statement: 'a', kind: '官方', sourceType: 'external', evidence: [ev('https://a.example.com')] }] }));
  const r = appendReferences(dir);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing-copy');
  assert.equal(fs.existsSync(path.join(dir, '发布文案.md')), false);
});

test('缺 ## 简介 小节时不写入，避免把链接塞进别处', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify({ claims: [
    { id: 'C1', statement: 'a', kind: '官方', sourceType: 'external', evidence: [ev('https://a.example.com')] }] }));
  fs.writeFileSync(path.join(dir, '发布文案.md'), '# 发布文案\n\n## 标题\n\n某标题\n');
  const r = appendReferences(dir);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-desc-section');
  assert.equal(fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8').includes('https://a.example.com'), false);
});
