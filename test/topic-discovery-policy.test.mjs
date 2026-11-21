import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { automaticDiscoveryReason } from '../lib/topic-memory.mjs';

const now = Date.now();
const queue = () => ({ items: [], runs: [], discoveryConfig: { enabled: true }, discovery: [] });

test('自动发现：独立于生成发布开关，但必须显式启用', () => {
  const q = queue();
  q.build = { enabled: false }; q.publish = { enabled: false };
  assert.equal(automaticDiscoveryReason(q, now), null);
  q.discoveryConfig.enabled = false;
  assert.equal(automaticDiscoveryReason(q, now), 'disabled');
});

test('自动发现：队列够用、搜索正在跑、等待选择时不重复检索', () => {
  const q = queue();
  q.items.push({ id: 'q', topic: '待做' });
  assert.equal(automaticDiscoveryReason(q, now), 'queue-filled');
  q.items = [];
  assert.equal(automaticDiscoveryReason(q, now, { state: 'running' }), 'running');
  q.discoveryTopics = [{ id: 'c', topic: '待选', at: now, status: 'candidate' }];
  assert.equal(automaticDiscoveryReason(q, now), 'awaiting-selection');
  q.discoveryTopics[0].status = 'dismissed';
  q.discoveryTopics[0].feedback = { kind: 'not-interested' };
  assert.equal(automaticDiscoveryReason(q, now), null);
});

test('自动发现：成功和失败尝试都冷却，默认半小时、最少五分钟', () => {
  const q = queue();
  q.discoveryLastAttemptAt = now - 60000;
  assert.equal(automaticDiscoveryReason(q, now), 'cooldown');
  assert.equal(automaticDiscoveryReason(q, now + 30 * 60000), null);
  q.discoveryConfig.intervalMinutes = 1;
  assert.equal(automaticDiscoveryReason(q, now + 2 * 60000), 'cooldown');
  assert.equal(automaticDiscoveryReason(q, now + 5 * 60000), null);
});

test('调度器：dry-run 不发现，制作统一保留选题依据', () => {
  const source = fs.readFileSync(new URL('../scripts/schedule-daemon.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(!has\('dry-run'\)\) await maybeDiscover/);
  assert.match(source, /origin: 'automatic'/);
  /* 选题简报只算一次：写进 materials/选题.md 的与交给 ask 的必须是同一份，
   * 否则实验开关（原文摘录）会只影响一边，A/B 的变量就不干净了。 */
  assert.match(source, /const brief = topicBrief\(item/);
  assert.match(source, /'选题.md'\), brief \+ '\\n'/);
  assert.match(source, /run\(\['ask', brief/);
  /* 原文摘录默认关闭：只有显式开关才把 root 传进去。 */
  assert.match(source, /researchPackEnabled\(\) \? \{ root: ROOT \} : \{\}/);
});
