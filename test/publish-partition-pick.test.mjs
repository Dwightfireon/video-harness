import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPartitionPrompt,
  parsePartitionRecommendation,
  recommendPartition,
  resolveAutoPublishPartition,
  readScriptExcerpt,
} from '../lib/publish-partition-pick.mjs';
import { createPublishApi } from '../lib/publish-api.mjs';

const HUMAN_CATALOG = {
  taxonomy: 'human-type2',
  human: true,
  compatTid: 21,
  live: true,
  list: [
    { id: 1011, name: '人工智能', parent: '', description: 'AI / 大模型 / Agent' },
    { id: 1010, name: '知识', parent: '', description: '科普、商业、课程与方法论' },
    { id: 1012, name: '科技数码', parent: '', description: '手机电脑硬件与软件产品' },
    { id: 1029, name: 'vlog', parent: '', description: '日常生活记录' },
  ],
};

const LEGACY_CATALOG = {
  taxonomy: 'legacy-tid',
  human: false,
  compatTid: 21,
  live: true,
  list: [
    { id: 231, name: '计算机技术', parent: '科技', description: '人工智能/开发/编程' },
    { id: 230, name: '软件应用', parent: '科技', description: '软件操作与工具测评' },
    { id: 207, name: '财经商业', parent: '知识', description: '财经/商业/职场/定价' },
    { id: 201, name: '科学科普', parent: '知识', description: '自然科学科普' },
  ],
};

test('buildPartitionPrompt 携带分区清单、视频信息及防全选 AI 约束', () => {
  const messages = buildPartitionPrompt({
    title: '为什么大厂都在砍掉低效周报？',
    tags: ['职场', '效率', 'ChatGPT'],
    desc: '分析组织沟通成本与管理模式变化',
    scriptExcerpt: '## S1 · 开场\n1. 很多人以为问题出在工具，其实出在汇报结构。',
    catalog: LEGACY_CATALOG,
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /万物皆 AI/);
  assert.match(messages[1].content, /id=207 \| 知识 · 财经商业/);
  assert.match(messages[1].content, /为什么大厂都在砍掉低效周报/);
  assert.match(messages[1].content, /脚本节选/);
});

test('parsePartitionRecommendation 严格校验新版与旧版编号并去重备选', () => {
  const humanRes = parsePartitionRecommendation(
    '```json\n{"primaryId": 1010, "reason": "核心是商业成本分析，更适合知识分区", "alternatives": [{"id": 1010, "reason": "重复应忽略"}, {"id": 1011, "reason": "涉及 AI 工具背景"}, {"id": 9999, "reason": "不存在应忽略"}]}\n```',
    HUMAN_CATALOG,
  );
  assert.equal(humanRes.primary.id, 1010);
  assert.deepEqual(humanRes.primary.partition, { partitionTaxonomy: 'human-type2', tid: 21, humanType2: 1010 });
  assert.equal(humanRes.alternatives.length, 1);
  assert.equal(humanRes.alternatives[0].id, 1011);

  const legacyRes = parsePartitionRecommendation(
    '{"primaryId": 207, "reason": "商业与定价分析", "alternatives": [{"id": 230, "reason": "含工具使用"}]}',
    LEGACY_CATALOG,
  );
  assert.equal(legacyRes.primary.id, 207);
  assert.deepEqual(legacyRes.primary.partition, { partitionTaxonomy: 'legacy-tid', tid: 207, humanType2: 0 });
  assert.equal(legacyRes.alternatives[0].id, 230);
});

test('parsePartitionRecommendation 拒绝清单外编号或非法 JSON', () => {
  assert.throws(() => parsePartitionRecommendation('{"primaryId": 8888, "reason": "编造"}', HUMAN_CATALOG), /不在当前账号可用列表/);
  assert.throws(() => parsePartitionRecommendation('这不是 JSON', HUMAN_CATALOG), /合法 JSON/);
});

test('recommendPartition 支持注入 chat 并返回模型信息', async () => {
  const result = await recommendPartition({
    title: '普通人如何用好表格自动汇总账单',
    tags: '表格 效率 工具',
    desc: '演示三步整理家庭月度账单',
    catalog: LEGACY_CATALOG,
    chat: async () => ({
      text: JSON.stringify({ primaryId: 230, reason: '核心为软件实操教程', alternatives: [{ id: 207, reason: '涉及个人记账' }] }),
      provider: 'opendesign',
      model: 'deepseek-v4.1-flash',
    }),
  });
  assert.equal(result.primary.id, 230);
  assert.equal(result.primary.name, '软件应用');
  assert.equal(result.model, 'deepseek-v4.1-flash');
  assert.equal(result.provider, 'opendesign');

  const fromReasoning = await recommendPartition({
    title: '普通人如何用好表格自动汇总账单',
    tags: '表格 效率 工具',
    desc: '演示三步整理家庭月度账单',
    catalog: LEGACY_CATALOG,
    chat: async () => ({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: null,
          reasoning_content: '分析完毕：{"primaryId": 230, "reason": "软件实操教程", "alternatives": [{"id": 207, "reason": "个人财务"}]}',
        },
      }],
    }),
  });
  assert.equal(fromReasoning.primary.id, 230);
});

test('resolveAutoPublishPartition 优先使用作品已保存分区，其次 AI 推荐，最后兜底排程分区', async () => {
  const defaultPartition = { partitionTaxonomy: 'human-type2', tid: 21, humanType2: 1011 };
  const savedPartition = { partitionTaxonomy: 'human-type2', tid: 21, humanType2: 1010 };

  let recommendCalls = 0;
  const fromSaved = await resolveAutoPublishPartition({
    draft: { savedForm: { partition: savedPartition } },
    defaultPartition,
    catalog: HUMAN_CATALOG,
    recommend: async () => { recommendCalls++; return null; },
  });
  assert.deepEqual(fromSaved, savedPartition);
  assert.equal(recommendCalls, 0);

  let resolvedAi = null;
  const fromAi = await resolveAutoPublishPartition({
    draft: { savedForm: null },
    defaultPartition,
    catalog: HUMAN_CATALOG,
    recommend: async () => ({ primary: { label: '科技数码（1012）', reason: '硬件评测', partition: { partitionTaxonomy: 'human-type2', tid: 21, humanType2: 1012 } } }),
    onResolved: info => { resolvedAi = info; },
  });
  assert.deepEqual(fromAi, { partitionTaxonomy: 'human-type2', tid: 21, humanType2: 1012 });
  assert.equal(resolvedAi.source, 'ai');
  assert.equal(resolvedAi.label, '科技数码（1012）');

  let resolvedFallback = null;
  const fromFallback = await resolveAutoPublishPartition({
    draft: { savedForm: null },
    defaultPartition,
    catalog: HUMAN_CATALOG,
    recommend: async () => { throw new Error('临时网络波动'); },
    onResolved: info => { resolvedFallback = info; },
  });
  assert.deepEqual(fromFallback, defaultPartition);
  assert.equal(resolvedFallback.source, 'fallback');
  assert.match(resolvedFallback.error, /临时网络波动/);
});

test('publish-api 暴露 recommendPartition 并读取脚本节选传给推荐器', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-part-pick-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(dir, 'projects', 'demo'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'projects', 'demo', 'PROJECT.json'), '{"deliveryTarget":"publish-package"}');
  fs.writeFileSync(path.join(dir, 'projects', 'demo', '脚本.md'), '## S1 · 开场\n1. 这期讲云厂商为什么突然涨价。\n← 依赖：无\n## 术语\n略\n');
  fs.writeFileSync(path.join(dir, 'projects', 'demo', '发布文案.md'), '# 发布文案\n\n## 标题\n\n云服务涨价真相\n\n## 简介\n\n分析算力成本。\n\n## 标签\n\n商业\n云计算\n');

  assert.match(readScriptExcerpt(path.join(dir, 'projects', 'demo')), /云厂商为什么突然涨价/);

  let seen;
  const api = createPublishApi({
    root: dir,
    home,
    recommendPartitionImpl: async args => {
      seen = args;
      return {
        primary: { id: 207, name: '财经商业', parent: '知识', label: '知识 · 财经商业（207）', reason: '核心为商业定价分析', partition: { partitionTaxonomy: 'legacy-tid', tid: 207, humanType2: 0 } },
        alternatives: [],
        taxonomy: args.catalog.taxonomy,
        human: args.catalog.human,
        live: args.catalog.live,
        model: 'test-model',
      };
    },
  });

  const rec = await api.recommendPartition({ id: 'demo' });
  assert.equal(rec.primary.id, 207);
  assert.equal(seen.title, '云服务涨价真相');
  assert.match(seen.scriptExcerpt, /云厂商为什么突然涨价/);
});
