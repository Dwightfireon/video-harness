import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BILIBILI_LIMITS, publishLimitIssues } from '../lib/publish-limits.mjs';
import { LIMITS, validateForm, buildPayload } from '../desk/publish-contract.mjs';
import { checkPublish, parsePublish, publishStatus, publishRevision, confirmPublishRevision, reviewStatus, PUBLISH_TASK } from '../lib/publish.mjs';

const form = { title: '手动标题', desc: '简介', tags: ['测试'], tid: 171, copyright: 1 };
const markdown = ({ title, desc, tags }) => `## 标题\n${title}\n\n## 简介\n${desc}\n\n## 置顶评论\n欢迎讨论。\n\n## 标签\n${tags.map(tag => '- ' + tag).join('\n')}\n\n## 封面文案\n主：测试\n副：边界\n\n## 发布前检查清单\n- [ ] 人工核对成片与发布口径\n`;

test('发布文案与 B 站表单共用限制，生成提示也明确这些上限', () => {
  assert.equal(LIMITS, BILIBILI_LIMITS);
  assert.ok(Object.isFrozen(LIMITS));
  assert.deepEqual(LIMITS, { title: 80, tags: 10, tag: 20, desc: 2000 });
  assert.match(PUBLISH_TASK, /主标题最多 80 字，简介最多 2000 字，标签最多 10 个、每个最多 20 字/);
});

for (const [name, changed, field, code] of [
  ['12 个标签', { tags: Array.from({ length: 12 }, (_, i) => `标签${i}`) }, 'tags', 'count'],
  ['超长标签', { tags: ['标'.repeat(21)] }, 'tags', 'length'],
  ['超长标题', { title: '题'.repeat(81) }, 'main', 'length'],
  ['超长简介', { desc: '介'.repeat(2001) }, 'desc', 'length'],
]) {
  test(`${name}：生成/交付检查与投稿表单均阻断，使用同一错误文案`, () => {
    const input = { ...form, ...changed }, md = markdown(input);
    const result = checkPublish(md), problems = validateForm(input);
    assert.equal(result.ok, false);
    assert.equal(result.state, 'blocked');
    assert.ok(result.errors.some(issue => issue.field === field && issue.code === code));
    assert.deepEqual(result.errors.map(issue => issue.message), problems);
    assert.equal(result.warnings.some(issue => issue.code === 'length'), false);
    assert.deepEqual(parsePublish(md).tags, input.tags, '不截断或删除标签');
    assert.equal(parsePublish(md).main, input.title, '不截断用户标题');
    assert.throws(() => buildPayload({ ...input, video: { filename: 'local-fixture' } }), /投稿参数不完整/);
  });
}

test('标题、简介、标签数量与单标签长度恰好到上限可通过；表单与 payload 保留原文', () => {
  const input = { ...form, title: '题'.repeat(80), desc: '介'.repeat(2000),
    tags: Array.from({ length: 10 }, (_, i) => '标'.repeat(19) + i) };
  const result = checkPublish(markdown(input));
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(validateForm(input), []);
  assert.deepEqual(publishLimitIssues(input), []);
  assert.equal(result.unchecked, 1, '机械通过不等于人工审阅');
  const payload = buildPayload({ ...input, video: { filename: 'local-fixture' } });
  assert.equal(payload.title, input.title);
  assert.equal(payload.desc, input.desc);
  assert.equal(payload.tag, input.tags.join(','));
});

test('长度沿用表单 UTF-16 语义，多行简介及分隔符标签也得到相同结果', () => {
  const input = { ...form, title: '😀'.repeat(40), desc: '介'.repeat(999) + '\n' + '介'.repeat(1000) };
  assert.equal(checkPublish(markdown(input)).ok, true);
  assert.deepEqual(validateForm(input), []);
  const overflow = { ...input, title: input.title + '题', desc: input.desc + '介' };
  assert.deepEqual(checkPublish(markdown(overflow)).errors.map(issue => issue.message), validateForm(overflow));
  const tags = Array.from({ length: 12 }, (_, i) => '标签' + i);
  for (const separator of ['、', '，', ',', ' ']) {
    const md = markdown({ ...form, tags: [tags.join(separator)] });
    assert.deepEqual(checkPublish(md).errors.map(issue => issue.message), validateForm({ ...form, tags: tags.join(separator) }));
    assert.equal(checkPublish(md).ok, false);
  }
});

test('项目状态与版本确认同样拦截超限，不写回文案或登记审阅', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-publish-limits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1\n1. 测试发布限制。\n');
  const md = markdown({ ...form, tags: Array.from({ length: 12 }, (_, i) => '标签' + i) });
  const file = path.join(dir, '发布文案.md');
  fs.writeFileSync(file, md);
  const status = publishStatus(dir);
  assert.equal(status.required, true);
  assert.equal(status.ok, false);
  assert.match(status.errors.map(issue => issue.message).join(), /标签 12 个，超过 10 个上限/);
  const revision = publishRevision(dir);
  assert.throws(() => confirmPublishRevision(dir, revision), /标签 12 个/);
  assert.equal(fs.existsSync(path.join(dir, 'out/.vh-publish-revision.json')), false);
  assert.equal(reviewStatus(dir).state, 'pending');
  assert.equal(fs.readFileSync(file, 'utf8'), md, '保留手动标题、所有标签和未勾选清单');
});
