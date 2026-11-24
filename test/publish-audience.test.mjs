/* 公开文案的观众视角守卫。
 *
 * 事故：简介里整段写着「未采用的两条来源……抓取时被 Cloudflare 质询 / 连接重置，
 * 没取得正文，因此未作为任何结论的依据」。这是制作记录，观众不需要看，
 * 也不该把取材失败与内部判断暴露到公开页面。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audienceIssues, audienceLeaks } from '../lib/publish-audience.mjs';
import { checkPublish, PUBLISH_TASK } from '../lib/publish.mjs';

const COPY = (desc, extra = {}) => '# 发布文案\n\n## 标题\n\n甲\n\n## 简介\n\n' + desc +
  '\n\n## 置顶评论\n\n欢迎交流。\n\n## 标签\n\nAI\n\n## 封面文案\n\n主：甲\n副：乙\n\n## 发布前检查清单\n- [ ] 人工核对\n';

test('真实事故句子：简介里的取材失败叙述被判为会公开的内部记录', () => {
  const leak = '未采用的两条来源：Counterpoint 的 800 VDC 标准化分析与亚洲经济相关报道，抓取时被 Cloudflare 质询 / 连接重置，没取得正文，因此未作为任何结论的依据。';
  const issues = audienceIssues({ desc: leak });
  assert.equal(issues.errors.length, 1);
  assert.equal(issues.errors[0].code, 'internal-process');
  assert.equal(issues.errors[0].field, 'desc');
  assert.match(issues.errors[0].message, /简介会原样公开/);
  assert.match(issues.errors[0].message, /不进入公开文案/);
});

test('正常简介、置顶评论与题材本身不误报', () => {
  const normal = '这一期讲 800 VDC 为什么成为 AI 数据中心的新供电标准，以及它对服务器电源、散热和机架设计的实际影响。看完能判断厂商宣传里的数字哪部分值得信。';
  assert.deepEqual(audienceIssues({ desc: normal }), { errors: [], warnings: [] });
  assert.deepEqual(audienceIssues({ desc: '本期讲解提示词工程里最常见的三个误区。' }).errors, []);
  assert.deepEqual(audienceIssues({ comment: '有问题评论区问，看到都会回。', main: '甲', cover: '主：甲' }), { errors: [], warnings: [] });
});

test('项目文件名、路径、工具名出现在任何公开字段都是错误', () => {
  for (const raw of ['详见 claims.json', '见 out/video-voice.mp4', '用 opencode 跑的', '按 research/资料.md 整理', '参考 脚本.md 的第四节']) {
    const issues = audienceIssues({ main: raw });
    assert.equal(issues.errors.length, 1, raw);
    assert.equal(issues.errors[0].code, 'internal-artifact', raw);
  }
});

test('短字段里的取材叙述只提示，不阻断发布', () => {
  const issues = audienceIssues({ main: '我抓取失败了，但这期讲 800 VDC' });
  assert.deepEqual(issues.errors, []);
  assert.equal(issues.warnings[0].code, 'internal-process');
});

test('可能只是题材词的说法只提示，避免挡住正常选题', () => {
  const issues = audienceIssues({ desc: '这一期拆解一个抓取工具的实现，以及提示词在里面的作用。' });
  assert.deepEqual(issues.errors, []);
  assert.equal(issues.warnings[0].code, 'possible-process');
});

test('只检查公开字段，不碰检查清单与内部小节', () => {
  const md = COPY('正文。').replace('- [ ] 人工核对', '- [ ] 人工核对：尚未核证，待人工审阅');
  const result = checkPublish(md);
  assert.equal(result.errors.some(item => item.code.startsWith('internal-')), false);
});

test('checkPublish 真的会把泄露算成错误，打包因此被挡住', () => {
  const md = COPY('未采用的两条来源：抓取时被 Cloudflare 质询，没取得正文，未作为任何结论的依据。');
  const result = checkPublish(md);
  assert.equal(result.ok, false);
  assert.equal(result.state, 'blocked');
  assert.ok(result.errors.some(item => item.code === 'internal-process'), JSON.stringify(result.errors));
});

test('生成提示词写明公开字段不能带制作过程，并给出正确去处', () => {
  for (const pattern of [/写给观众，不是写给项目/, /会原样公开/, /取材与检索过程/, /核证状态/, /本地文件与目录路径/, /不属于发布文案/]) {
    assert.match(PUBLISH_TASK, pattern);
  }
});

/* 投稿表单可以绕过 发布文案.md 直接手填，同一套判断必须也守住这条出口。 */
test('投稿表单的标题与简介同样挡住内部记录', async () => {
  const { validateForm } = await import('../desk/publish-contract.mjs');
  // 新版分区编号必须 ≥1000，否则会先报分区问题，掩盖我们要验证的文案问题。
  const base = { title: '甲', tags: 'AI', partitionTaxonomy: 'human-type2', humanType2: 1231, copyright: 1 };
  const leak = '未采用的两条来源：抓取时被 Cloudflare 质询，没取得正文，因此未作为任何结论的依据。';
  const blocked = validateForm({ ...base, desc: leak });
  assert.ok(blocked.some(text => /会原样公开/.test(text)), blocked.join(' / '));
  assert.deepEqual(validateForm({ ...base, desc: '这一期讲 800 VDC 对服务器电源的影响。' }), []);
  assert.ok(validateForm({ ...base, desc: '本视频由口播稿转成，带你看懂测试结论。' }).length > 0);
});

test('本机路径、隐私信息与制作幕后（「口播稿转成的视频」等）被严格拦截', () => {
  const localPath = ['', 'Users', 'demo', 'project', 'a.md'].join('/');
  const fileUrl = 'file://' + localPath;
  for (const raw of [
    '素材在 ' + localPath,
    '打开 ' + fileUrl + ' 查看',
    '预览地址 http://localhost:8144/',
    '使用 zh-CN-XiaoxiaoNeural 与 edge-tts 配音',
  ]) {
    const issues = audienceIssues({ desc: raw });
    assert.equal(issues.errors.length, 1, raw);
    assert.equal(issues.errors[0].code, 'internal-artifact', raw);
  }
  for (const raw of [
    '本期是由口播稿转成的视频，带你了解机器人仿真。',
    '本视频由工作台自动巡航流水线配音合成制作。',
    '脚本已在本机环境中完成增量渲染与字幕混流。',
  ]) {
    const issues = audienceIssues({ desc: raw });
    assert.equal(issues.errors.length, 1, raw);
    assert.equal(issues.errors[0].code, 'internal-process', raw);
    const checked = checkPublish(COPY(raw));
    assert.equal(checked.ok, false, raw);
  }
});
