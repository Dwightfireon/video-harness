import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withSceneMetadata } from '../lib/scene-metadata.mjs';
import { readVisualIntent, collectVisualIntents, visualIntentTag, visualIntentSummary } from '../lib/scene-visual.mjs';
import { writeSceneDraft, sceneDraftMatches, assembleSceneDrafts, previousSceneVisualIntent } from '../lib/scene-drafts.mjs';
import { pendingSceneWork } from '../lib/scene-work.mjs';
import { runVisualReview, reviewSummary } from '../lib/visual-review.mjs';
import { buildVisualDiagnostics } from '../lib/build-visual-diagnostics.mjs';
import { buildScenesSrc } from '../lib/scene-builder.mjs';
import { analyze as screenAnalyze } from '../lib/screen-check.mjs';
import { scan as typeScan } from '../lib/type-audit.mjs';
import { scan as tokenScan } from '../lib/token-audit.mjs';
import { scan as rhythmScan } from '../lib/rhythm.mjs';
import { check as assetCheck } from '../lib/assets.mjs';
import { makeTools } from '../lib/agent.mjs';
import { scan as motionScan, report as motionReport } from '../lib/motion.mjs';
import { readTransitionTags } from '../lib/transition.mjs';
import { normalizeGeneratedMetadata } from '../lib/generator-metadata.mjs';

const visual = { focus: '正在执行的请求', hierarchy: '请求突出，工具与背景退后',
  restraint: '不加粒子，保留右侧留白', rhythm: '请求到工具后停住，结果出现再留阅读时间' };
const body = 'root => { return { render(t) {} }; }';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-visual-intent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '方案.md'), '方案');
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 请求\n1. 请求进入模型。\n\n## S2 · 返回\n1. 工具把结果返回。\n');
  fs.writeFileSync(path.join(dir, 'claims.json'), '[]');
  return dir;
}

test('意图与场景共存，旧场景可用，重复保存幂等且不覆盖作者声明', () => {
  assert.equal(withSceneMetadata(body, {}), body);
  const saved = withSceneMetadata(body, { layout: '流程', visual });
  assert.match(saved, /^\/\/ @layout 流程\n\/\/ @visual /);
  assert.deepEqual(readVisualIntent(saved), { status: 'declared', intent: visual });
  assert.equal(withSceneMetadata(saved, { layout: '流程', visual }), saved);
  assert.throws(() => withSceneMetadata(saved, { visual: { ...visual, focus: '另一个焦点' } }), /不一致/);
  assert.throws(() => withSceneMetadata(body, { visual: { focus: '只有焦点' } }), /hierarchy/);
  assert.throws(() => withSceneMetadata(body, { visual: { ...visual, rhythm: '换行\n造场景' } }), /单行/);
  assert.throws(() => withSceneMetadata(body, { visual: { ...visual, extra: '未知' } }), /未知字段/);
  assert.throws(() => withSceneMetadata(visualIntentTag(visual) + '\n' + visualIntentTag(visual) + '\n' + body), /只能声明一个/);
  assert.throws(() => withSceneMetadata('// @visual {bad}\n' + body), /无效/);
  assert.throws(() => withSceneMetadata('// @visual ' + JSON.stringify({ ...visual, focus: '</script>' }) + '\n' + body), /不能含字面量/);
  assert.throws(() => withSceneMetadata('// @visual ' + JSON.stringify({ ...visual, focus: '<!-- <script>' }) + '\n' + body), /不能含字面量/);
  const escaped = visualIntentTag({ ...visual, focus: '</script>' });
  assert.ok(!escaped.includes('</script>'));
  assert.equal(readVisualIntent(escaped + '\n' + body).intent.focus, '</script>');
  assert.equal(readVisualIntent("root => { const s = '// @visual {}'; return {render(){}} }").status, 'missing');
});

test('分场意图经过受控草稿、下一场上下文、组装和审阅；声明从不等于通过', async t => {
  const dir = fixture(t);
  writeSceneDraft(dir, 1, body, { layout: '流程', visual });
  assert.equal(sceneDraftMatches(dir, 1, body, { layout: '流程', visual }), true);
  assert.deepEqual(previousSceneVisualIntent(dir, 2), visual);
  const work = pendingSceneWork(dir, 'article');
  assert.equal(work.scene, 2);
  assert.match(work.note, /上一场已保存的视觉意图/);
  assert.match(work.note, /正在执行的请求/);
  writeSceneDraft(dir, 2, body, { layout: '结果' });
  assembleSceneDrafts(dir);
  const result = collectVisualIntents(dir);
  assert.equal(result.status, 'unreviewed');
  assert.deepEqual(result.scenes.map(s => s.status), ['declared', 'missing']);
  const review = await runVisualReview(dir);
  assert.equal(review.visualIntent.status, 'unreviewed');
  assert.equal(review.ok, false, '未运行像素和视听检查不能通过');
  const summary = reviewSummary(review);
  assert.match(summary, /作者声明，未验证实际画面/);
  assert.match(summary, /正在执行的请求/);
  assert.match(summary, /旧项目不受阻断/);
  assert.match(summary, /声明不代表已审阅/);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'out/.vh-visual-review.json'), 'utf8'));
  assert.equal(persisted.visualIntent.scenes[0].intent.focus, visual.focus);
});

test('制作 Agent 的 write_scene 真实参数进入相同草稿与中断恢复匹配', async t => {
  const dir = fixture(t);
  const tool = makeTools(dir, () => {}, { mode: 'article', automation: { enabled: true } }).write_scene;
  const args = { scene: 1, layout: '流程', content: body, visual_focus: visual.focus,
    visual_hierarchy: visual.hierarchy, visual_restraint: visual.restraint, visual_rhythm: visual.rhythm };
  const invalid = await tool.run({ ...args, visual_rhythm: undefined });
  assert.match(invalid, /^写入失败：/);
  assert.match(await tool.run(args), /已保存 S1/);
  assert.equal(sceneDraftMatches(dir, 1, body, { layout: '流程', visual }), true);
  assert.deepEqual(previousSceneVisualIntent(dir, 2), visual);
});

test('上场草稿被外部篡改时不作为新场创作依据', t => {
  const dir = fixture(t);
  writeSceneDraft(dir, 1, body, { layout: '流程', visual });
  const file = path.join(dir, 'out/.vh-scene-drafts/S1.js');
  fs.appendFileSync(file, '\n// 外部变更');
  assert.equal(previousSceneVisualIntent(dir, 2), null);
});

test('视觉声明里的示例不会伪造成画面对象、CSS 样式或缺失素材', t => {
  const dir = fixture(t), file = path.join(dir, 'scenes.src.js');
  const scene = "// @layout 流程\nroot => { const a = mk('div','','标题'); type(a, 'h1'); return {render(){}}; }";
  fs.writeFileSync(file, scene);
  const run = () => ({ screen: screenAnalyze(dir).scenes, type: typeScan(dir).findings,
    token: tokenScan(dir).findings, rhythm: rhythmScan(dir).findings, assets: assetCheck(dir).refs });
  const before = run();
  const tricky = { ...visual, focus: '01 先展示 assets/example.png', hierarchy: '使用 #aabbcc 和 font-size: 999px',
    restraint: '不使用 padding:17px 与 shotEl(root)', rhythm: '不出现 @transition wipe' };
  fs.writeFileSync(file, withSceneMetadata(scene, { visual: tricky }));
  assert.deepEqual(run(), before);
});

test('视觉意图、代码字符串和场内注释不是转场指令；旧的独立标签仍生效', t => {
  const dir = fixture(t), source = path.join(dir, 'scenes.src.js'), html = path.join(dir, 'scene.html');
  const tricky = { ...visual, rhythm: '不出现 @transition wipe 或 @transition-dur 9' };
  const first = withSceneMetadata("root => { const sample = `\n// @transition push\n`; return {render(){}}; }", { visual: tricky });
  const second = '// @transition cut\r\n// @transition-dur 0.7\r\nroot => { // @transition wipe\nreturn {render(){}}; }';
  fs.writeFileSync(source, first + '\n//---\n' + second);
  assert.deepEqual(readTransitionTags(dir), [{ kind: null, dur: null }, { kind: 'cut', dur: 0.7 }]);
  fs.writeFileSync(html, 'const scenes = [];\naddScene(0,2,root=>({}));\naddScene(2,4,root=>({}));\nwindow.DURATION = DURATION;');
  assert.equal(normalizeGeneratedMetadata(dir), true);
  assert.match(fs.readFileSync(html, 'utf8'), /window\.__vhTrans = \[{"k":"fade","d":null},{"k":"cut","d":0\.7}\]/);
  assert.equal(normalizeGeneratedMetadata(dir), false);
});

test('静态建议独立于安全门，检查失败/未执行显式报告而非吞掉', () => {
  const empty = () => ({ findings: [] });
  const result = buildVisualDiagnostics('.', {
    type: () => { throw new Error('模拟失败'); }, tokens: empty,
    rhythm: () => ({ findings: [], note: '没有场景' }),
    motion: () => ({ findings: [{ msg: '疑点' }] }),
    transition: () => ({ findings: [], kinds: ['fade'] }),
    variety: () => ({ findings: [], scenes: [] }),
  });
  assert.deepEqual(result.map(x => x.status), ['failed', 'clear', 'unavailable', 'findings', 'clear', 'clear']);
  assert.match(result[0].line, /执行失败.*不是通过/);
  assert.match(result[2].line, /未能据此审阅/);
  assert.match(result[4].line, /不以数量判审美/);
  const unknown = buildVisualDiagnostics('.', { type: () => ({ ok: false, findings: [] }) });
  assert.equal(unknown[0].status, 'failed');
  assert.match(unknown[0].line, /检查未完成/);
});

test('字幕锚点无法静态展开时标未解析，不误说几乎没有动作', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), "root => { const at = window.VH_FILM.sceneCue(root, '第三句'); return {render(t){enter(el,t,at,{})}}; }");
  fs.writeFileSync(path.join(dir, 'scene.html'), 'addScene(0, 20, root => ({}));');
  const result = motionScan(dir);
  assert.equal(result.scenes[0].coverage, 'cue-unresolved');
  assert.equal(result.findings.some(f => f.kind === 'sparse'), false);
  assert.match(motionReport(result), /未解析/);
  assert.match(motionReport(result), /字幕锚点/);
});

test('长片摘要不把全部意图塞进模型上下文，完整记录不丢失', () => {
  const scenes = Array.from({ length: 25 }, (_, i) => ({ scene: i + 1, status: 'declared', intent: visual }));
  const text = visualIntentSummary({ scenes });
  assert.match(text, /S20/);
  assert.doesNotMatch(text, /S21/);
  assert.match(text, /其余 5 场见 out\/\.vh-visual-review\.json/);
  assert.equal(scenes.length, 25);
});

test('确定性构建器不为相邻变化伪造数字，也不会调用未实现的窗口配方', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 第一段\n1. 没有任何数字的结论。\n\n## S2 · 第二段\n1. 另一句没有数字的结论。\n\n## S3 · 操作\n1. 打开终端界面并运行命令。\n');
  const result = buildScenesSrc(dir);
  assert.equal(result.report.ok, true);
  assert.deepEqual(result.report.scenes.map(s => s.layout), ['hero-statement', 'hero-statement', 'hero-statement']);
  assert.doesNotThrow(() => result.text.split(/^\/\/---\s*$/m).forEach(block => new Function('return (' + block.trim() + ')')));
});
