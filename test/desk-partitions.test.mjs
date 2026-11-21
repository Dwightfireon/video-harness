import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { flattenPartitions, FALLBACK_PARTITIONS, offlinePartitions, searchPartitions,
  validatePartition, partitionAdvice, PARTITION_TAXONOMY } from '../desk/partitions.mjs';
import { createBiliClient, checkPublishReady } from '../desk/bili.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/desk-partitions-tech.json', import.meta.url)));
const live = list => ({ live: true, taxonomy: PARTITION_TAXONOMY, list });

test('分区：真实科技响应保留原名/编号/描述，只包含叶子节点', () => {
  const list = flattenPartitions(fixture);
  assert.deepEqual(list.map(p => p.id), [95, 230, 231, 232, 233]);
  assert.equal(list.find(p => p.id === 231).name, '计算机技术');
  assert.match(list.find(p => p.id === 231).description, /人工智能/);
  assert.ok(list.every(p => p.parent === '科技'));
  assert.equal(FALLBACK_PARTITIONS.find(p => p.id === 171).name, '电子竞技');
  assert.equal(FALLBACK_PARTITIONS.find(p => p.id === 207).name, '财经商业');
  assert.equal(FALLBACK_PARTITIONS.some(p => [188, 36, 4, 160].includes(p.id)), false);
});

test('分区：空父级、隐藏分区、重复项剔除，根容器和空叶子保持兼容', () => {
  const list = flattenPartitions({ typelist: [{ id: 0, name: '根', children: [
    { id: 188, parent: 0, name: '科技', children: [
      { id: 231, parent: 188, name: '计算机技术', children: [] },
      { id: 230, parent: 188, name: '软件应用', show: false },
      { id: 231, parent: 188, name: '重复' },
    ] }, { id: 4, parent: 0, name: '游戏', children: [] },
  ] }] });
  assert.deepEqual(list.map(p => p.id), [231]);
  assert.deepEqual(flattenPartitions({ typelist: [{ id: 177, parent: 0, name: '纪录片' }] }), []);
});

test('搜索：AI/Agent/人工智能/计算机科学都能找到技术分区，不重命名或代选', () => {
  const list = [...flattenPartitions(fixture), ...FALLBACK_PARTITIONS.filter(p => [259, 265].includes(p.id))];
  for (const query of ['AI', 'Agent', '人工智能', '计算机科学', '智能体', 'llm', '231', '科技 ai']) {
    assert.equal(searchPartitions(list, query)[0]?.id, 231, query);
  }
  assert.deepEqual(searchPartitions(list, 'AI').map(p => p.id), [231, 259, 265]);
  assert.deepEqual(searchPartitions(list, '找不到'), []);
  assert.equal(list[2].name, '计算机技术');
  assert.match(partitionAdvice(list[2]), /Agent/);
  assert.match(partitionAdvice(list.find(p => p.id === 259)), /不要只因用了 AI/);
});

test('分区校验：实时叶子可用，离线、父级、新频道编号与未知编号均阻断', () => {
  const catalog = live(flattenPartitions(fixture));
  assert.deepEqual(validatePartition('231', catalog), []);
  for (const id of [188, 999, 1011, 2096]) assert.ok(validatePartition(id, catalog).length, String(id));
  assert.match(validatePartition(231, offlinePartitions()).join(), /实时/);
  assert.ok(validatePartition(231, { ...catalog, taxonomy: 'tid_v2' }).length);
});

test('分区客户端：真实响应可解析，新版/空列表不得退回离线冒充 live', async () => {
  const client = data => createBiliClient({ fetch: async () => ({ ok: true, status: 200,
    text: async () => JSON.stringify({ code: 0, data }) }) });
  const result = await client(fixture).partitions();
  assert.equal(result.live, true);
  assert.equal(result.taxonomy, PARTITION_TAXONOMY);
  const revised = await client({ ...fixture, is_typeid_revision: 1 }).partitions();
  assert.equal(revised.live, false);
  assert.match(revised.reason, /新版/);
  assert.equal((await client({ typelist: [] }).partitions()).live, false);
  const ready = await checkPublishReady({ whoami: async () => ({ loggedIn: true }),
    partitions: async () => offlinePartitions(), preupload: async () => ({ endpoint: '//test' }) });
  assert.equal(ready.ok, false);
  assert.equal(ready.checks.find(p => p.name === '创作中心接口').ok, false);
});
