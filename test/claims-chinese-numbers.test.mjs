import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, extractNumbers } from '../lib/claims.mjs';

/* 真实事故（2026-11-05）：解说脚本里有 6 处中文数量表述，`vh claims` 却报
 * 「0 个数字断言 · 0 处疑点」。检查看起来完美通过，实际什么都没核。
 * 根因是提取器只认阿拉伯数字。以下锁住两个方向：
 *   1) 中文数量要能提取并与阿拉伯写法对账；
 *   2) 不能把「一个 App」「这一期」这类量词用法当成数量（否则一次误报 18 条）。 */

const localClaim = assertion => ({
  id: 'C1', assertion, kind: '用户提供原文', scope: '仅限用户提供文章',
  sourceType: 'user-provided',
  evidence: [{ path: 'research/原文.md', sha256: 'x', locator: '全文', quote: assertion, type: '用户提供原文', checkedAt: '2026-11-05' }],
});

function fixture(t, script, claims) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-claims-zh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'research'), { recursive: true });
  fs.writeFileSync(path.join(dir, '脚本.md'), script);
  fs.writeFileSync(path.join(dir, 'research/原文.md'), '原文占位');
  fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify(claims));
  return dir;
}

test('中文数量会被提取，并与阿拉伯写法归一到同一个 key', () => {
  assert.deepEqual(extractNumbers('## S1\n1. 还有三个入口。').map(n => n.key), ['3']);
  assert.deepEqual(extractNumbers('## S1\n1. 还有 3 个入口。').map(n => n.key), ['3']);
  assert.deepEqual(extractNumbers('## S1\n1. 是三类。').map(n => n.key), ['3']);
  assert.deepEqual(extractNumbers('## S1\n1. 一共二十三家企业。').map(n => [n.value, n.key]), [['二十三', '23']]);
  assert.deepEqual(extractNumbers('## S1\n1. 一百零五个岗位。').map(n => [n.value, n.key]), [['一百零五', '105']]);
});

test('「七八类」「三到五个」这类概数和范围保留原形并可对账', () => {
  assert.deepEqual(extractNumbers('## S1\n1. 分散在七八类地方。').map(n => [n.raw, n.key]), [['七八类', '7-8']]);
  assert.deepEqual(extractNumbers('## S1\n1. 建议用三到五个渠道。').map(n => [n.raw, n.key]), [['三到五个', '3-5']]);
  assert.deepEqual(extractNumbers('## S1\n1. 建议用 3 到 5 个渠道。').map(n => n.key), ['3-5']);
});

test('量词用法不当成数量，避免大面积误报', () => {
  // 这些是固定表达或序数：数词不表示可核对的量。
  const idiomatic = [
    '1. 这一期讲清楚。',
    '1. 第一层是公开市场。',
    '1. 第二步，核对来源。',
    '1. 一模一样。',
    '1. 三思而后行。',
    '1. 2026 年百日千万招聘专项行动。',
  ];
  for (const line of idiomatic) {
    assert.deepEqual(extractNumbers('## S1\n' + line), [], `不该把「${line}」当成数量断言`);
  }
  // 同一句里真实存在的量仍要识别，不能被固定短语连带吞掉。
  assert.deepEqual(extractNumbers('## S1\n1. 一模一样的两份简历。').map(n => n.raw), ['两份']);
  // 「一个 App」里的「一个」是可核对的量（登记与否由作者决定）。
  assert.deepEqual(extractNumbers('## S1\n1. 打开一个 App。').map(n => n.key), ['1']);
});

test('中文数量没登记时真的会报 unclaimed，登记了则不报', t => {
  const script = '## S1 · 一\n1. 还有三个入口。\n2. 分散在七八类地方。\n';
  const partial = analyze(fixture(t, script, [localClaim('还有三个入口。')]));
  assert.ok(partial.numbers.some(n => n.key === '7-8'));
  assert.ok(partial.findings.some(f => f.kind === 'unclaimed' && /七八类/.test(f.msg)),
    JSON.stringify(partial.findings));
  assert.equal(partial.findings.some(f => f.kind === 'unclaimed' && /三个/.test(f.msg)), false);
});

test('阿拉伯写法与中文写法互相认可，不因拼写差异误报过期', t => {
  const dir = fixture(t, '## S1\n1. 建议用 3 到 5 个渠道，另有三类入口。', [localClaim('建议用三到五个渠道，另有三类入口。')]);
  const result = analyze(dir);
  assert.equal(result.findings.some(f => f.kind === 'unclaimed' || f.kind === 'stale-claim'), false,
    JSON.stringify(result.findings));
});
