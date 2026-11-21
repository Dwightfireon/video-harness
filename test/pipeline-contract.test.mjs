import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runAgent, makeTools } from '../lib/agent.mjs';
import { stageContract, newStageProgress, advanceStageProgress, STAGE_TOOLS } from '../lib/pipeline-contract.mjs';
import { readCheckpoint, writeCheckpoint } from '../lib/checkpoint.mjs';
import { pendingSceneWork } from '../lib/scene-work.mjs';
import { writeSceneDraft, sceneDraftStatus, sceneAssemblyMatches, sceneDraftRecovery } from '../lib/scene-drafts.mjs';
import { parseChunks, skillDir, parseSceneBodies, snapshot } from '../lib/state.mjs';
import { isDiscussionOnly, isPureContinuation, nextReadOnlyScope } from '../lib/change-contract.mjs';
import { createTaskContract } from '../lib/task-contract.mjs';
import { beginTask, readTask } from '../lib/task-status.mjs';
import { observeTaskCompletion } from '../lib/task-completion.mjs';
import { instructionKindFor } from '../lib/cli-instruction.mjs';

const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }];
const hash = text => createHash('sha256').update(text).digest('hex');
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (...calls) => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls } }] });
const body = n => `root => { const el=mk('div','','窗口${n}的具体结果'); root.appendChild(el); return {render(t){el.style.opacity=t>=1?'1':'0';}}; }`;
test('材料、只读范围、有限否定和纯出片指令不再共用模糊的新指令开关', () => {
  assert.equal(instructionKindFor({ mode: 'article', text: '# 文稿\n不要修改只是文稿引用。' }), 'material');
  assert.equal(instructionKindFor({ mode: 'topic', text: '先讨论，不要写入' }), 'request');
  assert.equal(isDiscussionOnly('先讨论，不要写入'), true);
  assert.equal(isDiscussionOnly('不要修改任何文件，只给建议'), true);
  assert.equal(isDiscussionOnly('不要执行先前计划的写入，改写另一个文件'), false);
  assert.equal(isDiscussionOnly('不要修改脚本，只改画面颜色'), false);
  assert.equal(isDiscussionOnly('只读审查当前草稿，不能编辑任何文件'), true);
  assert.equal(nextReadOnlyScope(true, '第二场是什么意思？'), true);
  assert.equal(nextReadOnlyScope(true, '现在可以修改第二场'), false);
  assert.equal(isPureContinuation('完成当前视频'), true);
  assert.equal(isPureContinuation('完成当前视频，片尾加一个广告'), false);
});

test('pasted article is source material, not a read-only instruction to the editor', t => {
  const dir = fixture(t);
  const article = '# 为什么项目越改 Bug 越多？\n\n'
    + '一开始，一句提示词就能生成看起来不错的项目。后来你想优化界面，于是让 AI 继续修改。\n\n'
    + '## 一、先分析问题\n\n正确的做法是先分析影响范围，再进行修改。\n\n'
    + '## 二、检查有没有显示异常\n\n让 AI 用浏览器打开页面，检查有没有显示异常。\n\n'
    + '## 三、不要修改无关内容\n\n如无必要，勿增复杂。不要修改与本次目标无关的代码。\n';
  const contract = createTaskContract(dir, { mode: 'article', message: article });
  assert.equal(contract.readOnly, false, '文章正文里的建议句不能把制作任务打成只读');
  assert.equal(contract.allowedAuthors.includes('脚本.md'), true);
  assert.ok(contract.changeTargets.includes('脚本.md'));

  // A short, deliberate read-only instruction still wins at the new-video entry.
  const short = createTaskContract(dir, { mode: 'article', message: '先讨论，不要写入' });
  assert.equal(short.readOnly, true);
  assert.deepEqual(short.allowedAuthors, []);

  // Edit/review flows keep the old strict reading: a read-only request there still means read-only.
  const edit = createTaskContract(dir, { mode: 'edit-script', message: '只读审查当前草稿，不能编辑任何文件' });
  assert.equal(edit.readOnly, true);
  assert.deepEqual(edit.allowedAuthors, []);

  // A long article pasted into the follow-up box also stays source material, not a read-only command.
  const resumed = createTaskContract(dir, { mode: 'article', message: article, previous: contract });
  assert.equal(resumed.readOnly, false);

  // Once the user explicitly asked for read-only, it persists until a positive edit instruction.
  const held = createTaskContract(dir, { mode: 'article', message: '这篇文章讲了什么？', previous: short });
  assert.equal(held.readOnly, true);
  const released = createTaskContract(dir, { mode: 'article', message: '现在可以开始制作视频', previous: short });
  assert.equal(released.readOnly, false);
});

test('article task is not completed as a read-only "response" (regression: pasted article ended immediately)', t => {
  const dir = fixture(t);
  const article = '# 为什么项目越改 Bug 越多？\n\n'
    + '一开始，一句提示词就能生成看起来不错的项目。后来你想优化界面，于是让 AI 继续修改。\n\n'
    + '## 一、先分析问题\n\n正确的做法是先分析影响范围，再进行修改。\n\n'
    + '## 二、检查有没有显示异常\n\n让 AI 用浏览器打开页面，检查有没有显示异常。\n\n'
    + '## 三、不要修改无关内容\n\n如无必要，勿增复杂。不要修改与本次目标无关的代码。\n';
  const task = beginTask(dir, article, 'article');
  assert.equal(task.contract.readOnly, false);
  const completion = observeTaskCompletion(dir, readTask(dir));
  assert.notEqual(completion.kind, 'response', '原文里的建议句不能把制作任务变成"只回答"');
  assert.equal(completion.stale, true, '还没改脚本/画面时，不能算制作完成');
});

function fixture(t, count = 7) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const starter = 'root => ({render(){}})';
  for (const [name, text] of Object.entries({
    'PROJECT.json': JSON.stringify({ deliveryTarget: 'video', installedFiles: { 'scenes.src.js': hash(starter) } }),
    '方案.md': '# 方案\n\n| 场 | 内容 |\n|---|---|\n' + Array.from({ length: count }, (_, i) => `| S${i + 1} | 窗口 |`).join('\n'),
    '脚本.md': '**主体**：窗口\n' + Array.from({ length: count }, (_, i) => `\n## S${i + 1} · 窗口${i + 1}\n1. 窗口展示第${i + 1}组输入与结果。\n← 依赖：无\n`).join(''),
    'claims.json': '[]', 'scenes.src.js': starter, 'notes.md': '侦察材料\n第二段\n第三段\n第四段\n第五段\n',
  })) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('改稿阶段不再宣传必然被拒的 run_stage，落盘后由执行器推进出片', () => {
  const names = [...new Set(Object.values(STAGE_TOOLS).flat())], schemas = names.map(name => ({ function: { name } }));
  // Reproduce the real incident: mode=edit, user asked for subtitle + ad changes.
  const work = { stage: 'author_edit', tool: 'patch_text', allowed: STAGE_TOOLS.author_edit, required: null };
  const contract = stageContract(work, { schemas, progress: newStageProgress() });
  assert.ok(contract.schemas.some(s => s.function.name === 'patch_text'));
  assert.ok(contract.schemas.some(s => s.function.name === 'replace_scene'));
  assert.equal(contract.schemas.some(s => s.function.name === 'run_stage'), false,
    '不能在只允许 author_edit 的阶段提供 run_stage：它只接受当前 stage，必然被拒');
});

test('同一份长场景分段定位多轮新范围不算空转，重复读已见内容才算', async t => {
  const dir = fixture(t, 2), seen = [];
  const { advanceStageProgress: advance } = await import('../lib/pipeline-contract.mjs');
  let progress = newStageProgress();
  // A real 900-line localization pass: many fresh ranges, no writes yet.
  for (let i = 0; i < 11; i++) progress = advance(progress, { read: true, fresh: true });
  assert.equal(progress.staleReads, 0);
  assert.ok(progress.idle > 12 || progress.idle === 11);
  for (let i = 0; i < 12; i++) progress = advance(progress, { read: true, fresh: false });
  assert.ok(progress.staleReads >= 12, '重复读同一内容才累计空转');
  assert.equal(seen.length, 0);
});

test('用户明确改片指令：先落盘作者文件，再自动出片，不靠模型自己跑阶段', async t => {
  const dir = fixture(t, 2);
  // A finished film: real scene code, so the next work is an edit, not scene authoring.
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), [1, 2].map(n => `// @layout 窗口\n${body(n)}`).join('\n\n//---\n\n') + '\n');
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ deliveryTarget: 'video' }));
  fs.writeFileSync(path.join(dir, '发布文案.md'), '## 标题\n旧标题\n');
  let wrote = false, sawStageCallInEditStage = false;
  const requests = [];
  await runAgent(dir, '字幕遮住画面了，改一下；片尾加广告', {
    taskId: 'edit-request-ad', mode: 'edit', providers, stepBudget: 12, automation: true,
    instruction: '字幕部分有些遮蔽到画面的文本内容了 这方面要适当修改 其次 我希望在视频最后加个广告 介绍 https://example.invalid/x 画面里给出链接 以及优惠码 ABC123 就行',
    request: async (_p, _m, schemas) => {
      requests.push(schemas.map(s => s.function.name));
      if (schemas.some(s => s.function.name === 'run_stage') && !wrote) sawStageCallInEditStage = true;
      if (!wrote) {
        wrote = true;
        const current = (await import('../lib/author-edits.mjs')).readEditFile(dir, '脚本.md');
        return response(toolCall('add-ad', 'patch_text', { path: '脚本.md', base_hash: current.base_hash,
          find: '1. 窗口展示第2组输入与结果。',
          replace: '1. 窗口展示第2组输入与结果。\n\n## S3 · 片尾\n1. 想自己去看看的话，链接在画面上。' }));
      }
      return response(toolCall('r' + requests.length, 'read_file', { path: '脚本.md' }));
    },
  });
  assert.equal(sawStageCallInEditStage, false, '改稿阶段不能提供 run_stage 后再拒绝它');
  assert.match(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /## S3 · 片尾/, '用户指令必须真的落到作者文件');
  assert.ok(requests.length > 1);
});

test('改片指令附上当前锚点与指纹，第一轮就能落笔而不是扫描整片', async t => {
  const dir = fixture(t, 2);
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), [1, 2].map(n => `// @layout 窗口\n${body(n)}`).join('\n\n//---\n\n') + '\n');
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ deliveryTarget: 'video' }));
  const { authorEditAnchors } = await import('../lib/agent.mjs');
  const anchors = authorEditAnchors(dir);
  const scriptHash = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(dir, '脚本.md'))).digest('hex');
  assert.match(anchors, new RegExp('脚本\\.md 当前版本】base_hash=' + scriptHash));
  assert.match(anchors, /最后一个场次起的内容/);
  assert.match(anchors, /文件末尾/);
  // A 900-line scene must not be pasted wholesale into the prompt.
  assert.ok(anchors.length < 9000, '锚点必须是有界节选，不能把整片塞进提示：' + anchors.length);
});

test('修复轮拿到的质量引文能直接定位到源码行，不需要整份扫描', async t => {
  const dir = fixture(t, 1);
  const { repairHints } = await import('../lib/agent.mjs');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), "root => {\n  const a = mk('div','','额度：09:00 满格');\n  const b = mk('div','','依据：OpenAI 帮助中心');\n  return {render(){}};\n}\n");
  const hints = repairHints(dir, '对比度 1.05:1「额度：09:00 满格」；对比度 1.54:1「依据：OpenAI 帮助中心」');
  assert.match(hints, /scenes\.src\.js:2/); assert.match(hints, /scenes\.src\.js:3/);
  assert.doesNotMatch(repairHints(dir, '对比度 1.05:1「不存在的文字」'), /scenes\.src\.js:\d+/);
});

test('同一契约决定工具列表、执行权限、场号、写入目标和确定性阶段参数', () => {
  const names = [...new Set(Object.values(STAGE_TOOLS).flat())], schemas = names.map(name => ({ function: { name } }));
  const contract = stageContract({ stage: 'draft_scenes', allowed: STAGE_TOOLS.draft_scenes }, {
    schemas, progress: { idle: 4, reads: 4, violations: 0 }, scene: { scene: 3 },
  });
  assert.deepEqual(contract.schemas.map(s => s.function.name), ['write_scene']);
  assert.match(contract.validate(toolCall('r', 'read_file', { path: '脚本.md' })), /不允许/);
  assert.match(contract.validate(toolCall('w', 'write_scene', { scene: 4, content: body(4) })), /当前任务是 S3/);
  assert.equal(contract.validate(toolCall('w', 'write_scene', { scene: 3, content: body(3) })), null);
  const write = stageContract({ stage: 'draft_script', allowed: STAGE_TOOLS.draft_script }, { schemas });
  assert.match(write.validate(toolCall('w', 'append_file', { path: 'claims.json', content: '[]' })), /只修改 脚本/);
  const build = stageContract({ stage: 'build', allowed: STAGE_TOOLS.build }, { schemas });
  assert.match(build.validate(toolCall('b', 'run_stage', { stage: 'voice' })), /当前只执行阶段 build/);
  assert.match(build.validate(toolCall('b', 'run_stage', { stage: 'grep x' })), /stage 只接受/);
});

test('只读、混合工具、拒绝和失败写入都使用落地后的同一进度口径', () => {
  let state = newStageProgress();
  state = advanceStageProgress(state, { read: true, fresh: true });
  state = advanceStageProgress(state, { read: true, fresh: true });
  state = advanceStageProgress(state, { violation: true });
  state = advanceStageProgress(state); // failed/no-op write
  // Non-progress turns that are not fresh reads also count as spinning:
  // a rejected-violation turn and a failed write both mean nothing advanced.
  assert.deepEqual(state, { idle: 4, reads: 2, staleReads: 2, violations: 1 });
  assert.deepEqual(advanceStageProgress(state, { changed: true }), newStageProgress());
  // Reading new ranges is a localization pass, not spinning.
  let scanning = newStageProgress();
  for (let i = 0; i < 20; i++) scanning = advanceStageProgress(scanning, { read: true, fresh: true });
  assert.equal(scanning.staleReads, 0);
  assert.equal(scanning.idle, 20);
  // Re-reading already-seen content is spinning.
  let spinning = newStageProgress();
  for (let i = 0; i < 3; i++) spinning = advanceStageProgress(spinning, { read: true, fresh: false });
  assert.equal(spinning.staleReads, 3);
});

test('新调研读取不因累计七次被剥夺fetch；重复空转才收窄工具', () => {
  const schemas = STAGE_TOOLS.draft_plan.map(name => ({ function: { name } }));
  const work = { stage: 'draft_plan', required: 'append_file', allowed: STAGE_TOOLS.draft_plan };
  const useful = stageContract(work, { schemas, progress: { idle: 20, reads: 20, staleReads: 0 } });
  assert.ok(useful.names.has('fetch_url'));
  assert.equal(useful.directed, undefined);
  const repeated = stageContract({ ...work, required: null }, { schemas, progress: { idle: 20, reads: 20, staleReads: 7 } });
  assert.equal(repeated.names.has('fetch_url'), false);
});

test('首次长文章＋混合侦察＋一次违规响应：同一次执行真实保存七场并由程序组装', async t => {
  const dir = fixture(t), choices = [], initial = fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8');
  // Use the actual installed generator/engine, not a no-op build substitute.
  for (const file of ['gen.mjs', 'timeline.mjs', 'engine.tpl.html']) {
    fs.copyFileSync(path.join(skillDir(), 'assets', file), path.join(dir, file));
  }
  let refusedOnce = false, requests = 0;
  const counts = new Map();
  const result = await runAgent(dir, '按文章制作视频', { taskId: 'seven-scenes', mode: 'article', providers,
    instruction: '原文里出现“不要修改”和“额度”只是题材，不是用户停止指令。'.repeat(60), instructionKind: 'material',
    stepBudget: 37, automation: true,
    request: async (_p, messages, schemas, options) => {
      requests++;
      const scene = pendingSceneWork(dir, 'article');
      assert.ok(scene, '本验收只到七场真实组装，不调用渲染/TTS');
      const n = (counts.get(scene.scene) || 0) + 1; counts.set(scene.scene, n);
      choices.push(options.toolChoice);
      if (options.toolChoice === 'write_scene') {
        assert.deepEqual(schemas.map(s => s.function.name), ['write_scene']);
        if (!refusedOnce) { refusedOnce = true; return response(toolCall('withheld-read', 'read_file', { path: 'notes.md' })); }
        return response(toolCall('write-' + scene.scene, 'write_scene', { scene: scene.scene, layout: '输入输出对照', content: body(scene.scene) }));
      }
      assert.ok(n <= 4, '混合读取不能重置四轮单场预算');
      const name = ['read_file', 'list_files', 'read_edit_file', 'read_scene'][n - 1];
      return response(toolCall('scout-' + requests, name, name === 'read_scene' ? { scene: 1 } :
        { path: name === 'list_files' ? '.' : name === 'read_edit_file' ? '脚本.md' : 'notes.md', max_lines: 1 }));
    } });
  assert.equal(result.status, 'paused'); // exact authoring budget; NOT false completed
  assert.equal(requests, 36);
  assert.equal(sceneDraftStatus(dir).present.length, 7);
  assert.equal(sceneAssemblyMatches(dir), true, '不是给出暂停原因就算验收，七场必须全部真实组装');
  const chunks = parseChunks(path.join(dir, 'scenes.src.js'));
  assert.equal(chunks.length, 7); assert.notEqual(fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8'), initial);
  chunks.forEach((chunk, i) => assert.match(chunk, new RegExp('窗口' + (i + 1) + '的具体结果')));
  const cp = readCheckpoint(dir, 'seven-scenes');
  assert.match(cp.messages.find(m => m.tool_call_id === 'withheld-read').content, /^拒绝：.*整批未执行/);
  assert.equal(cp.changeContracts.length, 0);
  assert.equal(cp.pipelineState.progress.violations, 0, '仅实际落盘清除违规预算');
  const built = await makeTools(dir, () => {}, { mode: 'article', automation: { enabled: true } }).run_stage.run({ stage: 'build' });
  assert.match(built, /^exit=0\n/, built);
  const html = fs.readFileSync(path.join(dir, 'scene.html'), 'utf8');
  assert.equal(parseSceneBodies(html).length, 7);
  for (let i = 1; i <= 7; i++) assert.match(html, new RegExp('窗口' + i + '的具体结果'));
  assert.equal((await snapshot(dir)).stale.scene, undefined, '真实生成产物登记为当前版，不以场数或占位 HTML 冒充');
});

test('模型返回隐藏读取或混入其他场次：整批无副作用，有限纠偏而不是读取照跑', async t => {
  const dir = fixture(t, 2), before = fs.readFileSync(path.join(dir, 'scenes.src.js'));
  let requests = 0;
  const result = await runAgent(dir, '制作', { taskId: 'wrong-batch', mode: 'article', providers, stepBudget: 15,
    request: async (_p, _messages, _schemas, options) => {
      requests++;
      if (!options.toolChoice) return response(toolCall('r' + requests, 'list_files', { path: '.' }));
      return response(toolCall('legitimate-' + requests, 'write_scene', { scene: 1, layout: '窗口', content: body(1) }),
        toolCall('wrong-' + requests, 'write_scene', { scene: 2, layout: '窗口', content: body(2) }));
    } });
  assert.equal(result.status, 'paused'); assert.equal(requests, 7);
  assert.match(result.paused, /不符合本轮工具契约/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'scenes.src.js')), before);
  assert.equal(sceneDraftStatus(dir), null);
  const cp = readCheckpoint(dir, 'wrong-batch');
  for (const m of cp.messages.filter(m => m.role === 'tool' && /^(?:legitimate|wrong)-/.test(m.tool_call_id))) assert.match(m.content, /^拒绝：/);
  let extraRequests = 0;
  await runAgent(dir, '制作', { taskId: 'wrong-batch', mode: 'article', providers, resume: true, stepBudget: 3,
    request: async () => { extraRequests++; return response(toolCall('r', 'read_file', { path: 'notes.md' })); } });
  // An explicit resume grants one new bounded protocol window (it must not exit
  // before a single request), but repeated contract violations still stop it.
  assert.ok(extraRequests >= 1 && extraRequests <= 3, '恢复应有一次有界机会，不能 0 请求秒退，也不能无限重试：' + extraRequests);
});

test('只读范围拦住模型强行写入、阶段执行和跨恢复写入；继续不解除原限制', async t => {
  const dir = fixture(t, 2), before = fs.readFileSync(path.join(dir, 'scenes.src.js'));
  await runAgent(dir, '做视频', { taskId: 'read-only', mode: 'article', providers, instruction: '先讨论，不要写入', stepBudget: 2,
    request: async (_p, _m, schemas, opts) => {
      assert.equal(opts.toolChoice, undefined);
      assert.ok(!schemas.some(s => s.function.name === 'write_scene'));
      return response(toolCall('w', 'write_scene', { scene: 1, content: body(1), layout: '窗口' }));
    } });
  await runAgent(dir, '做视频', { taskId: 'read-only', mode: 'article', providers, resume: true, instruction: '继续', stepBudget: 1,
    request: async (_p, _m, schemas) => {
      assert.ok(!schemas.some(s => s.function.name === 'run_stage'));
      return response(toolCall('stage', 'run_stage', { stage: 'build' }));
    } });
  assert.equal(readCheckpoint(dir, 'read-only').mutationDeferred, true);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'scenes.src.js')), before);
  assert.equal(sceneDraftStatus(dir), null);
  assert.equal(fs.existsSync(path.join(dir, 'out/.vh-tool-logs')), false);
});

test('脚本修订后自动归档/重开，只复用身份证据未变场次，然后补写缺场并组装', async t => {
  const dir = fixture(t, 2);
  writeSceneDraft(dir, 1, body(1), { layout: '窗口' });
  fs.appendFileSync(path.join(dir, '脚本.md'), '\n<!-- 用户添加备注 -->');
  assert.deepEqual(sceneDraftRecovery(dir).reusable, [1]);
  let requests = 0;
  await runAgent(dir, '制作', { taskId: 'recover-drafts', mode: 'article', providers, stepBudget: 3,
    request: async () => {
      requests++; assert.equal(pendingSceneWork(dir, 'article').scene, 2);
      return response(toolCall('s2', 'write_scene', { scene: 2, layout: '对照', content: body(2) }));
    } });
  assert.equal(requests, 1); assert.equal(sceneAssemblyMatches(dir), true);
  assert.equal(fs.readdirSync(path.join(dir, 'out/.vh-scene-drafts/history')).length, 1);
  assert.equal(sceneDraftStatus(dir).present.length, 2);
});

test('恢复旧检查点的未执行工具也按现场契约核对，不重放过期阶段的写入', async t => {
  const dir = fixture(t, 2), planned = toolCall('old', 'append_file', { path: 'claims.json', content: '破坏证据表' });
  const valid = toolCall('otherwise-valid', 'write_scene', { scene: 1, layout: '窗口', content: body(1) });
  writeCheckpoint(dir, { schemaVersion: 1, taskId: 'old-planned', mode: 'article', status: 'paused',
    messages: [{ role: 'user', content: '制作' }, { role: 'assistant', content: null, tool_calls: [valid, planned] }],
    pending: [{ call: valid, status: 'planned' }, { call: planned, status: 'planned' }] });
  await runAgent(dir, '制作', { taskId: 'old-planned', resume: true, mode: 'article', providers, stepBudget: 1,
    request: async () => response(toolCall('read', 'read_file', { path: 'notes.md' })) });
  assert.equal(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8'), '[]');
  assert.equal(sceneDraftStatus(dir), null, '恢复同样整批预检，前面的合法写也不能部分执行');
  assert.match(readCheckpoint(dir, 'old-planned').messages.find(m => m.tool_call_id === 'old').content, /^拒绝：/);
});

test('审阅范围跨恢复保留；普通追问不授权写入，明确制作授权才可解除', async t => {
  const dir = fixture(t, 2);
  await runAgent(dir, '检查字幕', { taskId: 'review-scope', mode: 'article', providers, instruction: '检查字幕', stepBudget: 1,
    request: async () => response(toolCall('read', 'read_file', { path: '脚本.md' })) });
  const cp = readCheckpoint(dir, 'review-scope'); assert.equal(cp.review.required, true);
  await runAgent(dir, '检查字幕', { taskId: 'review-scope', mode: 'article', providers, resume: true, instruction: '第二场是什么意思？', stepBudget: 1,
    request: async (_p, _m, schemas) => {
      assert.ok(!schemas.some(s => s.function.name === 'write_scene'));
      return response(toolCall('denied', 'write_scene', { scene: 1, layout: '窗口', content: body(1) }));
    } });
  assert.equal(sceneDraftStatus(dir), null);
  await runAgent(dir, '检查字幕', { taskId: 'review-scope', mode: 'article', providers, resume: true, instruction: '现在开始制作画面', stepBudget: 1,
    request: async (_p, _m, schemas) => {
      assert.ok(schemas.some(s => s.function.name === 'write_scene'));
      return response(toolCall('allowed', 'write_scene', { scene: 1, layout: '窗口', content: body(1) }));
    } });
  assert.deepEqual(sceneDraftStatus(dir).present, [1]);
});

test('自动组装开始前收到只读插话：保留草稿但不执行旧自动副作用', async t => {
  const dir = fixture(t, 2), original = fs.readFileSync(path.join(dir, 'scenes.src.js'));
  writeSceneDraft(dir, 1, body(1), { layout: '窗口' }); writeSceneDraft(dir, 2, body(2), { layout: '对照' });
  let steered = false;
  await runAgent(dir, '制作', { taskId: 'auto-steer', mode: 'article', providers, stepBudget: 2,
    log: line => {
      if (!steered && line.includes('制作阶段：draft_scenes')) {
        steered = true;
        fs.writeFileSync(path.join(dir, 'out/.vh-steer.json'), JSON.stringify([{ id: 'read-only-now', message: '先讨论，不要修改', taskId: 'auto-steer' }]));
      }
    }, request: async () => response(toolCall('read', 'read_scene', { scene: 1 })) });
  assert.equal(steered, true); assert.deepEqual(fs.readFileSync(path.join(dir, 'scenes.src.js')), original);
  assert.equal(sceneAssemblyMatches(dir), false);
  assert.deepEqual(readCheckpoint(dir, 'auto-steer').consumedSteers, ['read-only-now']);
});

test('首场生成期间被外部改稿：旧场景不能在新的脚本基线上落盘', async t => {
  const dir = fixture(t, 2);
  await runAgent(dir, '制作', { taskId: 'first-write-cas', mode: 'article', providers, stepBudget: 1,
    request: async () => {
      fs.appendFileSync(path.join(dir, '脚本.md'), '\n<!-- 外部刚改过 -->');
      return response(toolCall('old-scene', 'write_scene', { scene: 1, layout: '窗口', content: body(1) }));
    } });
  assert.equal(sceneDraftStatus(dir), null);
  assert.match(readCheckpoint(dir, 'first-write-cas').messages.find(m => m.tool_call_id === 'old-scene').content, /基线已改变/);
});
