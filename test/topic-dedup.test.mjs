import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import {
  duplicateOf,
  hasConceptOverlap,
  findSourceOverlap,
  formatOlderHistoryEntry,
  sourceIdentity,
} from '../lib/topic-dedup.mjs';
import { discoveryPrompt } from '../lib/discovery-prompts.mjs';

test('架构边界守卫：topic-dedup 保持零外部依赖，不发生跨层耦合', () => {
  const source = fs.readFileSync(new URL('../lib/topic-dedup.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m, 'topic-dedup.mjs 必须是零 import 的纯函数叶子层');
});

test('概念与机制锚点去重：拦住换皮同题，不误杀同产品不同切口', () => {
  const known = [
    {
      id: 'long-horizon-1',
      topic: 'AI agent 连续干一百步就崩：卡住它的是上下文太长，还是每一步本身就不够可靠？',
      subject: '长时程 AI agent 的可靠性衰减',
      coreQuestion: '长时程 AI agent 在多步任务中为什么容易崩溃',
    },
    {
      id: 'voice-turn-1',
      topic: '跟 ChatGPT 语音聊天时插一句话，它是真停下还是装没听见？',
      subject: 'ChatGPT 实时语音对话的打断与回合切换',
      coreQuestion: '语音对话中用户中途插话时模型如何检测并切换回合',
    },
    {
      id: 'mpemba-1',
      topic: '同样一碗水，热的凭什么比冷的先结冰？',
      subject: '姆潘巴效应（Mpemba effect）的物理机制与实验可重复性',
      coreQuestion: '热水比冷水先结冰在什么条件下成立',
    },
  ];

  // 1. 真实漏网案例：换了完全不同的大白话标题，但底层都是「长时程 AI agent」失败机制 → 必须拦住
  const paraphrased = {
    topic: 'Agent 短活干得漂亮，长活怎么就跑偏了？',
    subject: 'AI agent 在长时程任务上的完成率与失败机制',
    coreQuestion: '为什么短任务稳定的 agent 一到多步长任务就频繁跑偏',
  };
  assert.equal(duplicateOf(paraphrased, known)?.id, 'long-horizon-1');

  // 2. 换英文专有机制名（Mpemba effect）或中文现象名（姆潘巴）→ 必须拦住
  const mpembaDup = {
    topic: '冰箱里放两杯水，为什么高温那杯反而更早冻住？',
    subject: 'Mpemba effect 冷却曲线反常',
    coreQuestion: '高温液体先结冰的物理机制',
  };
  assert.equal(duplicateOf(mpembaDup, known)?.id, 'mpemba-1');

  // 3. 正交切口（语音打断机制 vs 语音计费多少钱）及跨领域修饰词（长时程核聚变控制 vs 长时程 AI agent）→ 绝不误杀
  const voiceCost = {
    topic: '用语音跟 ChatGPT 聊十分钟，和打十分钟字，花的钱一样吗？',
    subject: 'ChatGPT 实时语音对话的输入输出计费与延迟',
    coreQuestion: '实时语音对话和文本对话的 token 计费成本差多少',
  };
  assert.equal(duplicateOf(voiceCost, known), undefined);
  assert.equal(hasConceptOverlap(voiceCost, known[1]), false);

  const fusionControl = {
    topic: 'AI 控制核聚变等离子体，换一台机器还灵吗',
    subject: '数据驱动等离子体控制在托卡马克等装置上的跨装置与长时程迁移',
    coreQuestion: '托卡马克聚变装置中的等离子体控制器跨装置迁移边界',
  };
  assert.equal(duplicateOf(fusionControl, known), undefined);
});

test('调查完成后同源重合检测：共用核心来源且概念重叠时提示，不误伤 updateOf 或无关单源', () => {
  const known = [
    {
      id: 'old-1',
      topic: 'AI agent 连续干一百步就崩',
      subject: '长时程 AI agent 的可靠性衰减',
      status: 'queued',
      sources: ['https://arxiv.org/abs/2601.12345?utm_source=x', 'https://blog.example.org/eval'],
    },
  ];
  assert.equal(sourceIdentity('https://arxiv.org/abs/2601.12345?utm_source=x#sec1'), 'https://arxiv.org/abs/2601.12345');

  // 共用全部核心论文且概念重叠 → 命中重合
  const hit = findSourceOverlap(
    ['https://arxiv.org/abs/2601.12345'],
    known,
    { target: { topic: 'Agent 短活稳、长活崩', subject: '长时程任务完成率' } },
  );
  assert.equal(hit?.previous.id, 'old-1');
  assert.equal(hit?.sharedUrls.length, 1);

  // 显式 updateOf 旧题 → 不误报重合
  assert.equal(
    findSourceOverlap(['https://arxiv.org/abs/2601.12345'], known, { updateOf: 'old-1', target: { subject: '长时程任务' } }),
    null,
  );

  // 仅共享 1 篇综合页但讨论完全无关的概念 → 不误报
  assert.equal(
    findSourceOverlap(['https://arxiv.org/abs/2601.12345'], known, { target: { topic: '开源协议变化', subject: '软件许可证法律边界' } }),
    null,
  );
});

test('早期历史压缩保留机制/对象锚点，且不冗余重复标题已有词', () => {
  assert.equal(
    formatOlderHistoryEntry({ topic: 'Agent 短活干得漂亮，长活怎么就跑偏了？', subject: '长时程 AI agent 的失败机制' }),
    'Agent 短活干得漂亮，长活怎么就跑偏了？〔长时程 AI agent 的失败机制〕',
  );
  assert.equal(
    formatOlderHistoryEntry({ topic: 'AI 筛简历对非名校是不是先天吃亏', subject: 'AI 筛简历' }),
    'AI 筛简历对非名校是不是先天吃亏',
  );

  const history = Array.from({ length: 45 }, (_, i) => ({
    id: `h-${i}`,
    topic: i === 0 ? 'Agent 短活干得漂亮，长活怎么就跑偏了？' : `历史题目 ${i}`,
    subject: i === 0 ? '长时程 AI agent 的失败机制' : `主题 ${i}`,
    status: 'queued',
  }));
  const prompt = discoveryPrompt({ query: 'AI agent', history });
  assert.match(prompt, /Agent 短活干得漂亮，长活怎么就跑偏了？〔长时程 AI agent 的失败机制〕/);
});
