import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { runAgent, makeTools } from '../lib/agent.mjs';
import { readEditFile, readScene } from '../lib/author-edits.mjs';
import { addChange, pendingChanges, verifyChange, restoreChanges, defineChange } from '../lib/change-contract.mjs';
import { nextPipelineWork } from '../lib/pipeline-work.mjs';
import { readCheckpoint, writeCheckpoint } from '../lib/checkpoint.mjs';
import { saveState, hashFile } from '../lib/state.mjs';
import { createArtifactRecord, currentArtifactInputs } from '../lib/artifact-status.mjs';
import { toolOutcome } from '../lib/tool-result.mjs';
import { skillDir } from '../lib/state.mjs';
import { beginTask, updateTask, finishTask } from '../lib/task-status.mjs';
import { selectVideoFormat } from '../lib/video-format.mjs';
import { inspectableHtml } from './helpers/inspectable-html.mjs';
import { voiceFixture } from './helpers/voice-fixture.mjs';

const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }];
const reply = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const call = (id, name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
const scene = text => `// @layout 窗口\nroot => { const text = '${text}'; return { render(t) { void text; } }; }`;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-pipeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); fs.mkdirSync(path.join(dir, 'out'));
  for (const [name, text] of Object.entries({
    'PROJECT.json': '{}', '方案.md': '方案', 'claims.json': '[]',
    '脚本.md': '## S1 · 第一场\n1. 张三介绍一个问题。\n\n## S2 · 第二场\n1. 用一个窗口比较。\n',
    'scenes.src.js': scene('张三') + '\n\n//---\n\n' + scene('比较窗口') + '\n',
    'engine.tpl.html': "const ORIENT = 'landscape';", 'scene.html': 'const DURATION = 2; const scenes = [];',
  })) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
function media(dir) {
  for (const [name, audio] of [['video.mp4', false], ['video-voice.mp4', true]]) {
    const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=size=64x36:rate=30:duration=2'];
    if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest');
    args.push('-c:v', 'libx264', '-preset', 'ultrafast'); if (audio) args.push('-c:a', 'aac');
    args.push(path.join(dir, 'out', name)); assert.equal(spawnSync('ffmpeg', args).status, 0);
  }
  const input = currentArtifactInputs(dir);
  saveState(dir, { genStamp: { scriptHash: input.sourceHashes['脚本.md'], scenesHash: input.sourceHashes['scenes.src.js'], sourceHashes: input.sourceHashes },
    render: { sceneHtmlHash: input.sceneHtmlHash, artifact: createArtifactRecord(dir, 'render') },
    voice: { artifact: createArtifactRecord(dir, 'voice') } });
}

test('命令前段失败不能被 tail 吞掉；工具按真实失败登记', async t => {
  const dir = fixture(t), tools = makeTools(dir, () => {}, { mode: 'article' });
  const result = await tools.run.run({ command: 'node -e "process.exit(7)" 2>&1 | tail -3' });
  assert.match(result, /^exit=7/); assert.equal(toolOutcome(result).ok, false);
});

test('三种受限编辑模式不能通过解释器或复合 shell 绕过文件范围', async t => {
  const dir = fixture(t), original = fs.readFileSync(path.join(dir, '脚本.md'), 'utf8');
  for (const mode of ['edit-copy', 'edit-script', 'edit-visual']) {
    const tools = makeTools(dir, () => {}, { mode });
    for (const command of [
      'python3 -c "from pathlib import Path; Path(\'脚本.md\').write_text(\'changed\')"',
      'node -e "require(\'fs\').writeFileSync(\'PROJECT.json\',\'{}\')"',
      'cat 脚本.md > claims.json', 'ls; python3 -c "print(1)"', 'ls $(python3 -c "print(1)")',
      "awk 'BEGIN {system(\"touch out/unsafe\")}'", "sed -i '' 's/张三/甲/g' 脚本.md",
    ]) assert.match(await tools.run.run({ command }), /拒绝/, mode + ':' + command);
    assert.match(await tools.run.run({ command: 'grep -n "张三" 脚本.md | head -3' }), /^exit=0/);
    assert.match(await tools.run.run({ command: "sed -n '1,3p' 脚本.md" }), /^exit=0/);
  }
  assert.equal(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(dir, 'out/unsafe')), false);
  assert.match(await makeTools(dir, () => {}, { mode: 'article' }).run.run({ command: 'python3 -m pip install --user not-a-real-package' }), /拒绝/);
});

test('受限模式不能把嵌套项目 status 当作只读执行，也不能沿 out 符号链接写脚本', async t => {
  const dir = fixture(t), tools = makeTools(dir, () => {}, { mode: 'edit-visual' });
  const before = fs.readFileSync(path.join(dir, '脚本.md'), 'utf8');
  fs.mkdirSync(path.join(dir, 'out/nested'));
  fs.writeFileSync(path.join(dir, 'out/nested/PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, 'out/nested/timeline.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(dir, '脚本.md'))},'unsafe');`);
  const result = await tools.run.run({ command: `node "${path.resolve('vh.mjs')}" status --dir out/nested` });
  assert.match(result, /拒绝/); assert.equal(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), before);
  fs.symlinkSync(path.join(dir, '脚本.md'), path.join(dir, 'out/script-link.md'));
  assert.match(await tools.write_file.run({ path: 'out/script-link.md', content: 'unsafe' }), /符号链接/);
  assert.equal(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), before);
});

test('已有场景修改：触顶后转小片段/单场，真实落盘；机械核验由执行器完成', async t => {
  const dir = fixture(t), taskId = 'small-repair'; let n = 0; const choices = [];
  const task = '把人名“张三”替换为“受访者”，其他内容保留';
  const result = await runAgent(dir, task, { taskId, mode: 'article', providers, stepBudget: 5,
    request: async (_p, messages, _tools, options) => {
      choices.push(options.toolChoice);
      if (++n === 1) return { choices: [{ message: { role: 'assistant', content: null, reasoning_content: '过长推理' }, finish_reason: 'length' }] };
      if (n === 2) {
        assert.equal(options.toolChoice, 'patch_text'); assert.match(messages.at(-1).content, /当前小任务/);
        return call('script-patch', 'patch_text', { path: '脚本.md', base_hash: readEditFile(dir, '脚本.md').base_hash, find: '张三', replace: '受访者' });
      }
      if (n === 3) return call('scene-read', 'read_scene', { scene: 1 });
      if (n === 4) { const s = readScene(dir, 1); return call('scene-repair', 'replace_scene', { scene: 1, base_hash: s.base_hash, content: s.content.replace('张三', '受访者') }); }
      const change = readCheckpoint(dir, taskId).changeContracts[0];
      return call('verified', 'verify_change', { instruction_id: change.id, forbidden_terms: '["张三"]', summary: '已逐项核对公开脚本与两场画面，指定姓名均已替换且保留其他内容。' });
    } });
  assert.equal(result.status, 'paused'); assert.equal(n, 4, '机械核验由执行器直接完成，不再多耗一次模型请求');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /张三/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8'), /张三/);
  assert.match(readScene(dir, 2).content, /比较窗口/);
  const cp = readCheckpoint(dir, taskId); assert.equal(pendingChanges(dir, cp.changeContracts).length, 0);
  assert.equal(cp.changeContracts[0].status, 'verified');
  assert.equal(fs.readdirSync(path.join(dir, 'out/.vh-edit-history')).length, 2);
});

test('有有效带音轨成片，但新要求未执行，模型说完成也不能 completed', async t => {
  const dir = fixture(t); media(dir);
  const result = await runAgent(dir, '把“张三”替换为“受访者”并交付视频', { taskId: 'unapplied', mode: 'article', providers,
    request: async () => reply('已全部完成'), stepBudget: 5 });
  assert.equal(result.status, 'paused'); assert.match(result.paused, /用户要求尚未完成核验/);
  assert.match(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /张三/);
});

test('脱敏检查覆盖所有公开作者文件，不能只改脚本就确认；后续改动使验收失效', t => {
  const dir = fixture(t), changes = [];
  const change = addChange(dir, changes, { text: '人物名字脱敏', id: 'redact' });
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 采访\n1. 受访者介绍一个问题。\n');
  assert.throws(() => verifyChange(dir, change, { forbidden_terms: ['张三'], summary: '核对公开脚本和场景，指定人名已经替换。' }), /scenes.src.js/);
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), scene('受访者'));
  verifyChange(dir, change, { forbidden_terms: ['张三'], summary: '核对公开脚本和全部场景，指定人名已经替换。' });
  assert.equal(pendingChanges(dir, changes).length, 0);
  fs.writeFileSync(path.join(dir, '发布文案.md'), '本期采访张三');
  assert.equal(pendingChanges(dir, changes).length, 1);
  assert.throws(() => verifyChange(dir, change, { forbidden_terms: [], summary: '再次核对所有公开文案，应当保持人物名字匿名。' }), /发布文案/);
});

test('旧插话迁移成待验收要求，材料中的同类句子不误当指令', t => {
  const dir = fixture(t), prefix = '【用户中途补充指令，优先级高于原计划】';
  const messages = [{ role: 'user', content: '这段访谈说：你改成这个方案。' }, { role: 'user', content: prefix + '政治内容和人物名字脱敏' }];
  const changes = restoreChanges(dir, undefined, messages, '原材料');
  assert.equal(changes.length, 1); assert.equal(changes[0].kind, 'redact');
  assert.equal(restoreChanges(dir, changes, messages, '原材料').length, 1);
});

test('宽泛脱敏先登记短清单，再定向小替换；登记本身不能完成要求', async t => {
  const dir = fixture(t), changes = [];
  const change = addChange(dir, changes, { id: 'broad', text: '人物名字脱敏，不要提政治内容' });
  assert.equal((await nextPipelineWork(dir, 'article', changes)).stage, 'define_change');
  const before = fs.readFileSync(path.join(dir, '脚本.md'), 'utf8');
  defineChange(change, ['张三', '政治']);
  const next = await nextPipelineWork(dir, 'article', changes);
  assert.equal(next.tool, 'patch_text'); assert.equal(next.path, '脚本.md');
  assert.equal(pendingChanges(dir, changes).length, 1);
  assert.equal(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), before);
});

test('精确替换不能只删原词冒充完成；用户后续改主意可取代旧要求', t => {
  const dir = fixture(t), changes = [];
  const first = addChange(dir, changes, { id: 'first', text: '把“张三”替换为“受访者”' });
  for (const name of ['脚本.md', 'scenes.src.js']) fs.writeFileSync(path.join(dir, name), fs.readFileSync(path.join(dir, name), 'utf8').replaceAll('张三', '匿名者'));
  assert.throws(() => verifyChange(dir, first, { forbidden_terms: ['张三'], summary: '已检查所有作者文件并移除了原姓名。' }), /指定替换结果/);
  const next = addChange(dir, changes, { id: 'second', text: '把“张三”替换为“匿名者”' });
  assert.equal(first.status, 'superseded');
  verifyChange(dir, next, { forbidden_terms: ['张三'], summary: '遵照新要求核对公开脚本和画面，匿名者已经出现，原姓名不再残留。' });
  assert.equal(pendingChanges(dir, changes).length, 0);
  addChange(dir, changes, { id: 'cancel', text: '不用脱敏了，保留原有内容' });
  assert.equal(pendingChanges(dir, changes).length, 0);
});

test('替换结果包含原词的合法改稿可以核验，不会反复改成更长的词', async t => {
  const dir = fixture(t), changes = [];
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 配色\n1. 窗口是蓝色。\n');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), scene('蓝色'));
  const change = addChange(dir, changes, { text: '把“蓝色”改为“深蓝色”', id: 'substring' });
  for (const name of ['脚本.md', 'scenes.src.js']) fs.writeFileSync(path.join(dir, name), fs.readFileSync(path.join(dir, name), 'utf8').replaceAll('蓝色', '深蓝色'));
  assert.equal((await nextPipelineWork(dir, 'article', changes)).tool, 'verify_change');
  verifyChange(dir, change, { summary: '已核对脚本和窗口文案，原来的蓝色都已改为指定的深蓝色。' });
  assert.equal(pendingChanges(dir, changes).length, 0);
});

test('请求过程中收到插话，旧批次尚未执行的写入被阻止，下一轮接收新要求', async t => {
  const dir = fixture(t); let n = 0;
  await runAgent(dir, '制作视频', { taskId: 'steer-fence', mode: 'article', providers, stepBudget: 2,
    request: async () => {
      if (++n === 1) {
        fs.writeFileSync(path.join(dir, 'out/.vh-steer.json'), JSON.stringify([{ id: 'during-request', taskId: 'steer-fence', message: '人物名字脱敏' }]));
        return call('old-write', 'write_file', { path: '发布文案.md', content: '张三采访' });
      }
      return call('read-new', 'read_edit_file', { path: '脚本.md' });
    } });
  assert.equal(fs.existsSync(path.join(dir, '发布文案.md')), false);
  const cp = readCheckpoint(dir, 'steer-fence'); assert.deepEqual(cp.consumedSteers, ['during-request']);
  assert.match(cp.messages.find(m => m.tool_call_id === 'old-write').content, /尚未接收的新指令/);
  assert.equal(cp.changeContracts[0].status, 'received');
});

test('最终回复生成期间收到插话，不能旧版 completed 后留下未处理指令', async t => {
  const dir = fixture(t); media(dir); let n = 0;
  const result = await runAgent(dir, '制作视频', { taskId: 'late-final-steer', mode: 'article', providers, stepBudget: 4,
    request: async () => {
      if (++n === 1) fs.writeFileSync(path.join(dir, 'out/.vh-steer.json'), JSON.stringify([{ id: 'late', taskId: 'late-final-steer', message: '把“张三”替换为“受访者”' }]));
      return reply('已全部完成');
    } });
  assert.equal(result.status, 'paused'); assert.ok(n > 1);
  const cp = readCheckpoint(dir, 'late-final-steer'); assert.deepEqual(cp.consumedSteers, ['late']);
  assert.equal(pendingChanges(dir, cp.changeContracts).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'out/.vh-steer.json'))), []);
});

test('定向阶段不能无限只读，阶段计数在检查点留存', async t => {
  const dir = fixture(t); let n = 0;
  const result = await runAgent(dir, '制作视频', { taskId: 'stage-loop', mode: 'article', providers, stepBudget: 40,
    request: async () => call('list-' + (++n), 'list_files', { path: '.' }) });
  assert.equal(result.status, 'paused');
  assert.ok(n <= 8, '确定性阶段偏离后应由执行器代跑并停在真实失败，而不是耗满12轮：' + n);
  assert.match(result.paused, /失败|规定动作|代跑|阶段/);
  let resumedRequests = 0;
  await runAgent(dir, '制作视频', { taskId: 'stage-loop', mode: 'article', providers, resume: true, stepBudget: 1,
    request: async () => { resumedRequests++; return call('read-again', 'list_files', { path: '.' }); } });
  assert.equal(resumedRequests, 1, '明确恢复会获得本次执行的小步骤机会，不应零请求永久暂停');
  assert.ok(readCheckpoint(dir, 'stage-loop').pipelineState.totalTurns > 4);
});

test('渲染或混流期间输入改变，不能给产物登记新输入的凭证', t => {
  const dir = fixture(t); media(dir);
  const expectedInputs = currentArtifactInputs(dir);
  fs.appendFileSync(path.join(dir, 'scene.html'), '\n// changed during render');
  assert.throws(() => createArtifactRecord(dir, 'render', { expectedInputs }), /阶段运行期间/);
  assert.throws(() => createArtifactRecord(dir, 'voice', { expectedInputs }), /阶段运行期间/);
});

test('真实CLI渲染在运行中被改输入时失败，旧凭证不被重新认证', async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'scene.html'), inspectableHtml('const DURATION = 2;const SUBS=[{s:.1,e:.9,t:"张三介绍一个问题。"},{s:1.1,e:1.9,t:"用一个窗口比较。"}]; const scenes = []; addScene(0,1,root=>({}));addScene(1,2,root=>({}));'));
  media(dir);
  const before = fs.readFileSync(path.join(dir, 'out/.vh-state.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'render.mjs'), "import fs from 'node:fs';fs.appendFileSync('scene.html','\\n// changed while rendering');");
  const result = await makeTools(dir, () => {}, { mode: 'article' }).run_stage.run({ stage: 'render' });
  assert.match(result, /^exit=1/); assert.match(result, /阶段运行期间/);
  assert.equal(fs.readFileSync(path.join(dir, 'out/.vh-state.json'), 'utf8'), before);
});

test('固定阶段执行的失败退出码与完整日志均保留，不依赖管道摘要', async t => {
  const dir = fixture(t); fs.writeFileSync(path.join(dir, 'gen.mjs'), 'console.error("fixture generator failed"); process.exit(7);');
  const result = await makeTools(dir, () => {}, { mode: 'article' }).run_stage.run({ stage: 'build' });
  assert.match(result, /^exit=7/); assert.equal(toolOutcome(result).ok, false);
  const logs = fs.readdirSync(path.join(dir, 'out/.vh-tool-logs')); assert.equal(logs.length, 1);
  assert.match(fs.readFileSync(path.join(dir, 'out/.vh-tool-logs', logs[0]), 'utf8'), /fixture generator failed/);
});

test('有效 timing 重复 measure 不执行 TTS、不删除渲染基线', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'timeline.mjs'), 'export const scriptGroups = () => []; export const validateTiming = () => ({subs:[],total:2});');
  fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify({ measurement: { voice: 'zf_001', speed: 1 } }));
  fs.writeFileSync(path.join(dir, 'gen.mjs'), 'throw Error("should not generate");');
  fs.writeFileSync(path.join(dir, 'voice-kokoro.py'), voiceFixture('raise RuntimeError("should not run TTS")'));
  saveState(dir, { lastMeasure: { scriptHash: hashFile(path.join(dir, '脚本.md')) }, render: { original: 'render-proof' }, voice: { original: 'voice-proof' } });
  const before = fs.readFileSync(path.join(dir, 'out/.vh-state.json'), 'utf8');
  const output = execFileSync(process.execPath, [path.resolve('vh.mjs'), 'measure', '--dir', dir], { encoding: 'utf8' });
  assert.match(output, /复用有效 timing.json/);
  assert.equal(fs.readFileSync(path.join(dir, 'out/.vh-state.json'), 'utf8'), before);
});

test('已修改且核验的需求，配合当前真实媒体凭证可以正常完成', async t => {
  const dir = fixture(t), changes = [];
  fs.writeFileSync(path.join(dir, '发布文案.md'), '## 标题\n测试采访\n## 简介\n介绍窗口比较。\n## 置顶评论\n欢迎讨论。\n## 标签\n窗口比较\n## 封面文案\n主：窗口比较\n');
  const change = addChange(dir, changes, { text: '把“张三”替换为“受访者”', id: 'done-change' });
  for (const name of ['脚本.md', 'scenes.src.js']) fs.writeFileSync(path.join(dir, name), fs.readFileSync(path.join(dir, name), 'utf8').replaceAll('张三', '受访者'));
  verifyChange(dir, change, { forbidden_terms: ['张三'], summary: '已核对公开脚本、全部场景和发布文案，指定人名没有残留。' });
  media(dir);
  writeCheckpoint(dir, { schemaVersion: 1, taskId: 'verified-full', mode: 'article', status: 'paused',
    changeContracts: changes, pending: [], messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '制作并脱敏' }] });
  const result = await runAgent(dir, '制作并脱敏', { taskId: 'verified-full', mode: 'article', resume: true, providers,
    request: async () => reply('已完成当前版本的带旁白视频，内容仍需审阅。') });
  assert.equal(result.status, 'completed'); assert.equal(result.deliverable.stale, false);
});

test('公开文件已无登记词时执行器直接核验，不因模型继续搜内部证据而耗尽12轮', async t => {
  const dir = fixture(t), changes = [];
  fs.writeFileSync(path.join(dir, '方案.md'), '内部证据：张三的访谈记录。');
  const change = addChange(dir, changes, { id: 'public-clean', text: '人物名字脱敏' });
  defineChange(change, ['张三']);
  for (const name of ['脚本.md', 'scenes.src.js']) fs.writeFileSync(path.join(dir, name),
    fs.readFileSync(path.join(dir, name), 'utf8').replaceAll('张三', '受访者'));
  const taskId = 'auto-verify';
  writeCheckpoint(dir, { schemaVersion: 1, taskId, mode: 'article', status: 'paused', pending: [],
    messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '人物名字脱敏' }],
    task: '人物名字脱敏', changeContracts: changes });
  let n = 0; const logs = [];
  const result = await runAgent(dir, '人物名字脱敏', { taskId, mode: 'article', providers, resume: true, stepBudget: 2,
    log: line => logs.push(line), request: async () => {
      n++;
      return call('internal-read-' + n, 'read_file', { path: '方案.md' });
    } });
  const checkpoint = readCheckpoint(dir, taskId);
  assert.equal(pendingChanges(dir, checkpoint.changeContracts).length, 0,
    '禁止词只在内部证据，公开文件已清；执行器应完成机械核验');
  assert.match(logs.join('\n'), /执行器直接完成机械核验/);
  assert.ok(n <= 1, '机械核验不应额外消耗模型请求：' + n);
  assert.equal(result.status, 'paused');
});

test('公开文件仍有登记词时不能自动核验，也不能把内部证据当已清', async t => {
  const dir = fixture(t), changes = [];
  const change = addChange(dir, changes, { id: 'public-dirty', text: '人物名字脱敏' });
  defineChange(change, ['张三']);
  assert.ok(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8').includes('张三'));
  const work = await nextPipelineWork(dir, 'article', changes);
  assert.equal(work.stage, 'author_edit'); assert.equal(work.auto, false);
  assert.throws(() => verifyChange(dir, structuredClone(change),
    { summary: '只在内部证据里搜索，公开脚本仍有原姓名，不能据此通过。' }), /脚本\.md/);
});

test('用户说保留重点、不放小游戏，会形成可追踪要求而不是丢失', t => {
  const dir = fixture(t), changes = [];
  const change = addChange(dir, changes, { id: 'trim', text: '保留重点 和精华 至于什么小游戏 没必要放进去' });
  assert.ok(change); assert.equal(change.kind, 'edit'); assert.equal(change.semantic, true);
  assert.equal(pendingChanges(dir, changes).length, 1);
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 采访\n1. 受访者介绍四要素框架。\n');
  verifyChange(dir, change, { summary: '已按用户要求删减小游戏段落，保留四要素与核心例子。' });
  assert.equal(pendingChanges(dir, changes).length, 0);
  assert.equal(change.review, 'needs-human', '语义取舍不能伪装成机器已证明');
});

test('脱敏编辑允许先读公开脚本，但不允许改内部证据；连续只读最终停在准确缺口', async t => {
  const dir = fixture(t), changes = [];
  fs.writeFileSync(path.join(dir, '方案.md'), '内部证据：张三。');
  const change = addChange(dir, changes, { id: 'dirty-script', text: '人物名字脱敏' });
  defineChange(change, ['张三']);
  const taskId = 'redact-scope';
  writeCheckpoint(dir, { schemaVersion: 1, taskId, mode: 'article', status: 'paused', pending: [],
    messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '人物名字脱敏' }],
    task: '人物名字脱敏', changeContracts: changes });
  let n = 0; const logs = [];
  const result = await runAgent(dir, '人物名字脱敏', { taskId, mode: 'article', resume: true, providers, stepBudget: 8,
    log: line => logs.push(line), request: async () => {
      n++;
      // 第一次读公开脚本是侦察；之后只翻内部证据，应被拒绝且不执行。
      return call('read-' + n, 'read_file', { path: n === 1 ? '脚本.md' : '方案.md' });
    } });
  assert.equal(result.status, 'paused');
  assert.match(result.paused, /没有执行规定动作|公开|内部证据/);
  assert.ok(n >= 3 && n <= 8, '不应无限只读：' + n);
  assert.match(logs.join('\n'), /内部证据/);
  assert.ok(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8').includes('张三'), '未修改前不能假报已核验');
  assert.equal(pendingChanges(dir, readCheckpoint(dir, taskId).changeContracts).length, 1);
});

test('缺脚本时阶段不为空：直接进入分批写脚本，而不是无限查资料', async t => {
  const dir = fixture(t);
  fs.rmSync(path.join(dir, '脚本.md'));
  fs.writeFileSync(path.join(dir, '方案.md'), '# 方案\n\n受众基线：未知。\n');
  fs.writeFileSync(path.join(dir, 'claims.json'), '[]');
  const work = await nextPipelineWork(dir, 'article', []);
  assert.equal(work.stage, 'draft_script'); assert.equal(work.tool, 'append_file');
  assert.match(work.note, /append_file/);
});

test('长脚本用 append_file 分批写入：超过单批上限拒绝，后续批次校验 base_hash', async t => {
  const dir = fixture(t);
  fs.rmSync(path.join(dir, '脚本.md'));
  const first = await makeTools(dir, () => {}, { mode: 'article' }).append_file.run({ path: '脚本.md', content: '## S1 · 一\n1. 第一句。\n' });
  const created = JSON.parse(first);
  assert.equal(created.created, true); assert.match(created.base_hash, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), '## S1 · 一\n1. 第一句。\n');
  const second = await makeTools(dir, () => {}, { mode: 'article' }).append_file.run({
    path: '脚本.md', base_hash: created.base_hash, content: '## S2 · 二\n1. 第二句。\n' });
  assert.match(second, /appended_chars/);
  assert.match(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /第二句/);
  const stale = JSON.parse(second);
  const refused = await makeTools(dir, () => {}, { mode: 'article' }).append_file.run({
    path: '脚本.md', base_hash: created.base_hash, content: '## S3 · 三\n1. 第三句。\n' });
  assert.match(refused, /写入失败/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /第三句/);
  const tooBig = await makeTools(dir, () => {}, { mode: 'article' }).append_file.run({
    path: '脚本.md', base_hash: stale.base_hash, content: 'x'.repeat(40000) });
  assert.match(tooBig, /超过单批上限/);
});

test('write_file 拒绝一次性写超长脚本，引导改用 append_file', async t => {
  const dir = fixture(t);
  const result = await makeTools(dir, () => {}, { mode: 'article' }).write_file.run({
    path: '脚本.md', content: '长'.repeat(13000) });
  assert.match(result, /append_file/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /长长长/);
});

test('公开范围的核验不会因之后补写内部证据而失效', t => {
  const dir = fixture(t), changes = [];
  const change = addChange(dir, changes, { id: 'public-scope', text: '人物名字脱敏' });
  defineChange(change, ['张三']);
  for (const name of ['脚本.md', 'scenes.src.js']) fs.writeFileSync(path.join(dir, name),
    fs.readFileSync(path.join(dir, name), 'utf8').replaceAll('张三', '受访者'));
  verifyChange(dir, change, { summary: '核对公开脚本和全部场景，指定人名没有残留。' });
  fs.writeFileSync(path.join(dir, 'claims.json'), '[{"statement":"内部证据仍保留张三，不对外发布。"}]');
  assert.equal(pendingChanges(dir, changes).length, 0);
  fs.appendFileSync(path.join(dir, '脚本.md'), '\n2. 张三再次出现。\n');
  assert.equal(pendingChanges(dir, changes).length, 1, '公开文件改动仍必须使核验失效');
});

test('没有用户修改任务时，工作阶段从实际状态推导；单点编辑不强迫整片制作', async t => {
  const dir = fixture(t);
  assert.equal((await nextPipelineWork(dir, 'edit-copy', [])).stage, 'publish');
  const work = await nextPipelineWork(dir, 'article', []);
  assert.equal(work.stage, 'build'); assert.equal(work.tool, 'run_stage');
});

test('十场已有项目：截断→小块脱敏→真实CLI阶段→带音轨媒体与凭证→完成（合成测试媒体）', { timeout: 120000 }, async t => {
  const dir = fixture(t), assets = path.join(skillDir(), 'assets');
  for (const name of ['gen.mjs', 'timeline.mjs', 'engine.tpl.html']) fs.copyFileSync(path.join(assets, name), path.join(dir, name));
  const blocks = Array.from({ length: 10 }, (_, i) => `// @layout 测试场${i + 1}\nroot => { const el = mk('div','','${i === 0 ? '张三' : '测试窗口'}'); root.appendChild(el); return {render(t){el.style.opacity = '1';}}; }`);
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), blocks.join('\n\n//---\n\n'));
  fs.writeFileSync(path.join(dir, '脚本.md'), '**主体**：测试窗口\n**产品类型**：读懂型\n**承诺**：看懂测试窗口的变化\n' + Array.from({ length: 10 }, (_, i) => `\n## S${i + 1} · 测试${i + 1}\n1. ${i === 0 ? '张三' : '受访者'}展示一个窗口。\n← 依赖：${i ? 'S' + i : '无'}\n`).join(''));
  selectVideoFormat(dir, '16:9');
  fs.writeFileSync(path.join(dir, 'make-timing.mjs'), `import fs from 'node:fs';import {scriptGroups,digest} from './timeline.mjs';
const groups=scriptGroups(fs.readFileSync('脚本.md','utf8')),lines=groups.flatMap(g=>g.lines);let i=0;
const subs=groups.flatMap(g=>g.lines.map(t=>({s:(i++)*2+.1,e:i*2-.1,t})));
fs.writeFileSync('timing.json',JSON.stringify({schemaVersion:1,textHash:digest(lines),groupsHash:digest(groups.map(g=>g.lines)),measurement:{voice:'zf_001',speed:1},subs,scenes:groups.map((_,i)=>[i*2,(i+1)*2]),dur:groups.length*2}));`);
  fs.writeFileSync(path.join(dir, 'render.mjs'), `import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const dur=fs.readFileSync('scene.html','utf8').match(/const DURATION = ([\\d.]+)/)[1];
const r=spawnSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=black:s=1920x1080:r=10','-t',dur,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','out/video.mp4'],{stdio:'inherit'});process.exit(r.status||0);`);
  fs.writeFileSync(path.join(dir, 'voice-kokoro.py'), voiceFixture(`import sys, subprocess, re, pathlib
if args.measure:
    sys.exit(subprocess.run(['node','make-timing.mjs']).returncode)
if args.srt:
    pathlib.Path('out/subtitles.srt').write_text('1\\n00:00:00,100 --> 00:00:01,900\\n受访者展示一个窗口。\\n')
    sys.exit(0)
dur=re.search(r'const DURATION = ([\\d.]+)',pathlib.Path('scene.html').read_text())[1]
sys.exit(subprocess.run(['ffmpeg','-v','error','-y','-i','out/video.mp4','-f','lavfi','-i','sine=frequency=440:duration='+dur,'-shortest','-c:v','copy','-c:a','aac','-movflags','+faststart','out/video-voice.mp4']).returncode)
`));
  const task = beginTask(dir, '把“张三”替换为“受访者”并交付带旁白的视频', 'article');
  updateTask(dir, task.id, { status: 'running', pid: process.pid }, task.attemptId);
  let n = 0; const stages = [];
  const result = await runAgent(dir, task.message, { taskId: task.id, attemptId: task.attemptId, mode: 'article', providers, stepBudget: 16,
    request: async () => {
      n++;
      if (n === 1) return { choices: [{ message: { role: 'assistant', content: null, reasoning_content: '已触顶的思考' }, finish_reason: 'length' }] };
      if (n === 2) return call('patch', 'patch_text', { path: '脚本.md', base_hash: readEditFile(dir, '脚本.md').base_hash, find: '张三', replace: '受访者' });
      if (n === 3) return call('read-scene', 'read_scene', { scene: 1 });
      if (n === 4) { const source = readScene(dir, 1); return call('replace', 'replace_scene', { scene: 1, base_hash: source.base_hash, content: source.content.replace('张三', '受访者') }); }
      if (n === 5) return call('verify', 'verify_change', { instruction_id: readCheckpoint(dir, task.id).changeContracts[0].id,
        forbidden_terms: '["张三"]', summary: '已检查公开脚本与十场画面代码，指定姓名全部替换，其他场次未重写。' });
      if (n <= 9) { const stage = ['build', 'measure', 'render', 'voice'][n - 6]; stages.push(stage); return call('stage-' + stage, 'run_stage', { stage }); }
      if (n === 10) return call('publish', 'write_file', { path: '发布文案.md', content: '## 标题\n测试窗口\n## 简介\n展示十场测试窗口。\n## 置顶评论\n合成媒体只验证链路。\n## 标签\n- 测试\n## 封面文案\n主：测试窗口\n## 发布前检查清单\n- [ ] 人工审阅\n' });
      return reply('当前版本的带音轨视频和字幕已生成，合成测试媒体仅用于验证链路。');
    } });
  finishTask(dir, task.id, result, task.attemptId);
  assert.equal(result.status, 'completed', JSON.stringify({ status: result.status, paused: result.paused, error: result.error,
    last: readCheckpoint(dir, task.id).messages.filter(m => m.role === 'tool').slice(-4).map(m => m.content) }));
  assert.deepEqual(stages, ['build', 'measure', 'render', 'voice']);
  // 机械核验与最终交付检查由执行器直接完成，不再要求模型额外调用两次工具/回复。
  assert.ok(n >= 10 && n <= 11, 'stages=' + JSON.stringify(stages) + ' requests=' + n);
  assert.ok(result.deliverable.publish.ok, '发布文案也必须通过检查才能完成全流程');
  assert.equal(readScene(dir, 10).total_scenes, 10);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /张三/);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'out/.vh-state.json')));
  assert.ok(state.render.artifact.media.sha256); assert.ok(state.voice.artifact.media.sha256);
  assert.ok(fs.existsSync(path.join(dir, 'out/subtitles.srt')));
  assert.equal(result.deliverable.stale, false);
});
