import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTENT_PROFILES,
  resolveContentProfile,
  extractBriefMetadata,
  contentProfileGuidance,
  reviewProfileRules,
} from '../lib/content-profile.mjs';
import {
  configureContentProfile,
  readProjectContentProfile,
  resolveProjectContentProfile,
} from '../lib/project-profile.mjs';
import { composeTask } from '../lib/task-prompts.mjs';
import { topicBrief } from '../lib/schedule.mjs';

test('架构边界守卫：content-profile 保持零外部依赖，队列与提示词层不发生跨层耦合', () => {
  const pureSource = fs.readFileSync(new URL('../lib/content-profile.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(pureSource, /^\s*import\s/m, 'content-profile.mjs 必须是零 import 的纯函数叶子层');

  const scheduleSource = fs.readFileSync(new URL('../lib/schedule.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(scheduleSource, /discovery-prompts|discovery-evidence|project-profile|task-prompts/,
    '队列层不得跨层依赖发现提示词或项目目录配置');

  const taskPromptSource = fs.readFileSync(new URL('../lib/task-prompts.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(taskPromptSource, /node:fs|discovery-prompts|discovery-evidence|project-profile/,
    '任务提示词层只做纯参数拼装，不直接读磁盘或依赖选题发现层');
});

test('三档内容定位推断：显式指定 > 结构化元数据 > 文本特征，且实证实验题不被误判为观点片', () => {
  assert.deepEqual(CONTENT_PROFILES, ['auto', 'intel', 'science', 'opinion']);

  // 1. 显式指定最高优先级
  assert.equal(resolveContentProfile({ explicit: 'opinion', kind: 'news', text: '刚刚发布的最新财报' }), 'opinion');
  assert.equal(resolveContentProfile({ explicit: 'intel', kind: 'evergreen', text: '热力学第二定律' }), 'intel');

  // 2. 元数据信号
  assert.equal(resolveContentProfile({ kind: 'news', text: '普通标题' }), 'intel');
  assert.equal(resolveContentProfile({ discoveryMode: 'recent', text: '普通标题' }), 'intel');
  assert.equal(resolveContentProfile({ kind: 'opinion', text: '普通标题' }), 'opinion');
  assert.equal(resolveContentProfile({ discipline: 'philosophy', text: '决定论问题' }), 'opinion');

  // 3. 文本特征推断
  assert.equal(resolveContentProfile({ text: '苹果刚刚发布新款芯片，实测续航到底提升了多少？' }), 'intel');
  assert.equal(resolveContentProfile({ text: '为什么我不再建议独立开发者盲目追风口？聊聊产品取舍与个人体会' }), 'opinion');
  assert.equal(resolveContentProfile({ text: 'CRISPR 基因编辑为什么能精准切割 DNA？冷冻电镜下的构象变化与实验测量' }), 'science');
  assert.equal(resolveContentProfile({ text: '光纤通信里的全反射原理是怎么减少信号衰减的' }), 'science');
});

test('topicBrief 输出内容定位与核查时间戳，且被 extractBriefMetadata 与 composeTask 无损消费', () => {
  const checkedAt = Date.parse('2026-11-25T08:00:00Z');
  const now = Date.parse('2026-11-27T12:00:00Z'); // 超过 24h
  const item = {
    topic: '某地最新发布的算力补贴政策到底改了哪些申报门槛',
    coreQuestion: '新政策调整了哪些具体条款',
    sources: ['https://gov.example.test/policy'],
    research: {
      version: 1,
      kind: 'news',
      checkedAt,
      selectionReason: '官方原文列出了前后申报门槛对比。',
      caveats: [],
      sources: [{
        url: 'https://gov.example.test/policy',
        title: '政策通知',
        sourceType: 'primary',
        quote: '自2026年11月24日起，申报企业需提供实际算力调用凭证与结算单据。',
        supports: '说明申报门槛新增调用凭证要求。',
        publishedAt: '2026-11-24',
        eventDate: '2026-11-24',
        publicationQuote: '2026年11月24日',
        eventQuote: '自2026年11月24日起',
      }],
    },
  };
  const brief = topicBrief(item);
  assert.match(brief, /^内容定位：intel$/m);
  assert.match(brief, /^材料核查日期：2026-11-25（checkedAt=/m);

  const meta = extractBriefMetadata(brief);
  assert.equal(meta.explicitProfile, 'intel');
  assert.equal(meta.checkedDate, '2026-11-25');
  assert.equal(meta.checkedAt, checkedAt);

  // 超过 24 小时：触发写稿前二次核新指令
  const staleTask = composeTask({ project: '/tmp/demo', repo: '/tmp/repo', mode: 'topic', message: brief, now });
  assert.match(staleTask, /内容定位：intel/);
  assert.match(staleTask, /已超过 24 小时.*轻量联网检索/);
  assert.ok(staleTask.endsWith('用户的指令是：\n' + brief), '末尾分隔契约必须保持不变');

  // 24 小时内刚核查过：提示优先精读已有原文记录，不盲目重搜
  const freshTask = composeTask({
    project: '/tmp/demo',
    repo: '/tmp/repo',
    mode: 'topic',
    message: brief,
    now: checkedAt + 2 * 3600 * 1000,
  });
  assert.match(freshTask, /近 24 小时内刚核查过/);
});

test('contentProfileGuidance 与 reviewProfileRules 对三档各自输出差异化口径', () => {
  const opinionGuide = contentProfileGuidance('opinion');
  assert.match(opinionGuide, /客观事实前提.*主观判断/s);
  assert.match(opinionGuide, /稻草人/);

  const scienceGuide = contentProfileGuidance('science', { text: '植物光合作用的暗反应碳固定过程' });
  assert.match(scienceGuide, /不设热点时效焦虑/);
  assert.doesNotMatch(scienceGuide, /GPT-3\.5/, '纯自然科学选题不应硬塞早期大模型说教');

  const aiScienceGuide = contentProfileGuidance('science', { text: 'Transformer 注意力机制与 LLM 上下文衰减' });
  assert.match(aiScienceGuide, /2023–2024 年早期模型/);

  const opinionReview = reviewProfileRules('opinion', { date: '2026-11-27' });
  assert.match(opinionReview.scaleNote, /严禁用实证论文或随机对照实验模板苛求观点片/);
  assert.match(opinionReview.causalityRule, /稻草人/);
});

test('project-profile 薄适配层：缺省或设为 auto 时不污染历史 PROJECT.json', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-proj-profile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projectFile = path.join(dir, 'PROJECT.json');
  const initial = '{\n  "videoFormat": "16:9"\n}\n';
  fs.writeFileSync(projectFile, initial);

  assert.equal(readProjectContentProfile(dir), 'auto');
  assert.equal(configureContentProfile(dir, 'auto'), 'auto');
  assert.equal(fs.readFileSync(projectFile, 'utf8'), initial, 'auto 不得改写原本未设置 contentProfile 的旧项目文件');

  assert.equal(configureContentProfile(dir, 'opinion'), 'opinion');
  assert.equal(readProjectContentProfile(dir), 'opinion');
  assert.deepEqual(resolveProjectContentProfile(dir, { message: '最新发布的财报' }).profile, 'opinion');
  assert.deepEqual(resolveProjectContentProfile(dir, { explicit: 'intel', message: '最新发布的财报' }).profile, 'intel');

  // 切回 auto 时清理显式字段
  assert.equal(configureContentProfile(dir, 'auto'), 'auto');
  assert.equal(JSON.parse(fs.readFileSync(projectFile, 'utf8')).contentProfile, undefined);
});

test('直接粘贴隐性观点文章（无明显关键词）：写稿指令自动引导语义自判，且 方案.md 标记自动传递给下游审校', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-auto-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{"videoFormat":"16:9"}\n');
  const rawArticle = '远程办公正在悄悄改变初级工程师的成长路径：过去靠工位旁听学到的隐性经验正在消失。';

  // 1. 无上游锁定时，composeTask 输出全自动语义三选一指引并要求写入 方案.md
  const prompt = composeTask({ project: dir, repo: '/tmp/repo', mode: 'article', message: rawArticle });
  assert.match(prompt, /全自动语义识别/);
  assert.match(prompt, /方案\.md.*内容定位/s);

  // 2. 写稿模型通读全文后在 方案.md 写入了「- **内容定位**：opinion（行业评论）」
  fs.mkdirSync(path.join(dir, 'materials'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'materials', '原文.md'), rawArticle);
  fs.writeFileSync(path.join(dir, '方案.md'), '# 方案\n- **内容定位**：opinion（行业评论）\n\n已经知道：远程办公\n');

  // 3. 下游审校无需人工传参，直接从 方案.md 拿到语义级 opinion 定位
  const resolved = resolveProjectContentProfile(dir);
  assert.equal(resolved.profile, 'opinion');
  assert.equal(resolved.source, 'author-plan');
});
