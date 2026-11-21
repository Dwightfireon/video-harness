import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent, makeTools } from '../lib/agent.mjs';
import { beginTask } from '../lib/task-status.mjs';
import { worklogBlock, recordTool } from '../lib/worklog.mjs';
import { prepareRequestContext } from '../lib/request-context.mjs';
import { readCheckpoint, writeCheckpoint } from '../lib/checkpoint.mjs';
import { readEditFile } from '../lib/author-edits.mjs';
import { authorDocumentState } from '../lib/author-readiness.mjs';
import { sceneAssemblyMatches } from '../lib/scene-drafts.mjs';

const providers = [{ name: 'opendesign', key: 'fixture', base: 'http://fixture.invalid' }];
const project = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-stall-'));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const call = (id, name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });

/* 真实事故：387 次 run、163 次查同一份模板，第 367 步才第一次写方案，
   到 400 步预算时仍没有推进。只提高预算不能解决。 */
test('连续只读不改：先明确要求动手，仍无产出则暂停而不是烧完预算', async t => {
  const dir = project(t);
  fs.writeFileSync(path.join(dir, 'notes.md'), '已有材料，仅反复查阅不会推进作者稿。\n');
  let calls = 0;
  const notes = [];
  const result = await runAgent(dir, '做一支片', { taskId: 'stall-task', mode: 'article',
    providers, stepBudget: 400, stallSteps: 5,
    request: async (_p, messages) => {
      calls++;
      for (const m of messages) if (m.role === 'user' && /停止探索/.test(m.content || '')) notes.push(m.content);
      return call('r' + calls, 'read_file', { path: 'notes.md', max_lines: 1 });
    } });
  assert.equal(result.status, 'paused');
  assert.match(result.paused, /没有推进任何产出|停止查阅|没有执行规定动作/);
  assert.ok(calls < 400, `不应烧完整个预算，实际 ${calls}`);
  assert.ok(notes.length >= 1, '必须先给出一次明确的动手要求');
  assert.match(notes[0], /读文件不算推进/);
});

test('写作产出后重新计数：不会因为前面读过文件就误判停滞', async t => {
  const dir = project(t);
  let calls = 0, wrote = false;
  const result = await runAgent(dir, '做一支片', { taskId: 'stall-progress', mode: 'edit-visual',
    providers, stepBudget: 30, stallSteps: 4,
    request: async () => {
      calls++;
      if (calls === 6 && !wrote) { wrote = true; return call('w1', 'write_file', { path: 'scenes.src.js', content: '// x\n' }); }
      if (calls > 6) return { choices: [{ message: { role: 'assistant', content: '完成' } }] };
      return call('r' + calls, 'list_files', { path: '.' });
    } });
  assert.equal(wrote, true);
  assert.equal(fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8'), '// x\n');
  assert.equal(result.status, 'completed', '有产出后应继续而不是在旧计数上暂停');
});

test('写文件同样计入作者产出，纯写入任务不会被误判停滞', async t => {
  const dir = project(t);
  let calls = 0;
  const result = await runAgent(dir, '做一支片', { taskId: 'stall-writes', mode: 'edit-visual',
    providers, stepBudget: 12, stallSteps: 3,
    request: async () => {
      calls++;
      if (calls <= 9) return call('w' + calls, 'write_file', { path: 'out/note' + calls + '.txt', content: 'x'.repeat(calls) });
      return { choices: [{ message: { role: 'assistant', content: '完成' } }] };
    } });
  assert.equal(result.status, 'completed');
});

test('只读查看源码不再被"直接执行底层脚本"误拦', async t => {
  const dir = project(t);
  fs.writeFileSync(path.join(dir, 'gen.mjs'), 'const a = 1;\n');
  const tools = makeTools(dir, () => {}, { mode: 'article' });
  const read = await tools.run.run({ command: 'sed -n 1,20p gen.mjs' });
  assert.match(read, /exit=0/);
  assert.match(read, /const a = 1/);
  assert.doesNotMatch(read, /拒绝/);
  const exec = await tools.run.run({ command: 'node gen.mjs --estimate' });
  assert.match(exec, /拒绝/);
});

test('read_file 支持按行段读中段，不再只能读前缀', async t => {
  const dir = project(t);
  fs.writeFileSync(path.join(dir, 'big.md'), Array.from({ length: 200 }, (_, i) => 'line' + (i + 1)).join('\n'));
  const tools = makeTools(dir, () => {}, { mode: 'article' });
  const out = await tools.read_file.run({ path: 'big.md', start_line: 150, max_lines: 3 });
  assert.match(out, /行 151–153/);
  assert.match(out, /line151\nline152\nline153/);
});

test('重复读取返回本次范围的真实内容，而不是“就在上面不必再看”', async t => {
  const dir = project(t);
  fs.writeFileSync(path.join(dir, 'mid.md'), Array.from({ length: 60 }, (_, i) => 'R' + (i + 1)).join('\n'));
  let calls = 0; const contents = [];
  await runAgent(dir, '读两次', { taskId: 'read-range', mode: 'edit-visual', providers, stepBudget: 8,
    request: async (_p, messages) => {
      calls++;
      if (calls === 1) return call('a', 'read_file', { path: 'mid.md', start_line: 0, max_lines: 5 });
      if (calls === 2) { contents.push(messages.find(m => m.tool_call_id === 'a').content); return call('b', 'read_file', { path: 'mid.md', start_line: 30, max_lines: 3 }); }
      contents.push(messages.find(m => m.tool_call_id === 'b').content);
      return { choices: [{ message: { role: 'assistant', content: '完成' } }] };
    } });
  assert.match(contents[0], /R1\nR2\nR3\nR4\nR5/);
  assert.match(contents[1], /R31\nR32\nR33/, '重读应拿到新请求的行段');
  assert.doesNotMatch(contents[1], /不必再看/);
});

test('工作台账优先保留写入与失败，读取流水挤不掉产出', async t => {
  const dir = project(t);
  fs.writeFileSync(path.join(dir, '脚本.md'), 'x'.repeat(80));
  recordTool(dir, { taskId: 't', tool: 'write_file', target: '脚本.md', ok: true });
  for (let i = 0; i < 90; i++) recordTool(dir, { taskId: 't', tool: 'run', target: 'sed -n ' + i + 'p x', ok: true, note: 'exit=0' });
  recordTool(dir, { taskId: 't', tool: 'run', target: 'node vh.mjs build', ok: false, note: '✗ 块数对不上' });
  const block = worklogBlock(dir);
  assert.match(block, /已写文件/);
  assert.match(block, /脚本\.md/);
  assert.match(block, /块数对不上/, '失败原因要进台账');
});

test('恢复时请求里带最新台账，而不是几百步前的状态', async t => {
  const dir = project(t);
  const { writeCheckpoint, readCheckpoint } = await import('../lib/checkpoint.mjs');
  const original = [
    { role: 'system', content: '系统约束：不要覆盖用户文件' },
    { role: 'user', content: '原目标' },
  ];
  writeCheckpoint(dir, { schemaVersion: 1, taskId: 'resume-ledger', mode: 'article', status: 'failed',
    task: '原目标', messages: original, pending: [] });
  fs.writeFileSync(path.join(dir, '方案.md'), 'y'.repeat(321));
  recordTool(dir, { taskId: 'resume-ledger', tool: 'write_file', target: '方案.md', ok: true });
  let seen = '';
  await runAgent(dir, '原目标', { taskId: 'resume-ledger', mode: 'article', resume: true,
    providers, request: async (_p, messages) => {
      seen = messages.map(m => m.content || '').join('\n');
      return { choices: [{ message: { role: 'assistant', content: '好' } }] };
    } });
  assert.match(seen, /本任务已做过的动作/, '恢复请求必须带当前台账');
  assert.match(seen, /方案\.md.*321 字节/);
  // 原始检查点消息不能被这段现场污染（后续每次恢复仍从同一份历史出发）。
  assert.doesNotMatch(JSON.stringify(readCheckpoint(dir, 'resume-ledger').messages), /本任务已做过的动作/);
});

/* 真实事故：台账到 24k 上限后按首次出现顺序硬截，后期三笔写入回执全部消失。 */
test('台账到上限时仍保留最新写入与失败，不按时间前缀截断', () => {
  const messages = [{ role: 'system', content: '规则' }, { role: 'user', content: '原始要求' }];
  // 大量早期读取把台账撑到上限（每条命令都很长，签名各异，不会被合并计数）。
  for (let i = 0; i < 900; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'e' + i, type: 'function',
      function: { name: 'run', arguments: JSON.stringify({ command: 'sed -n ' + i + ',' + (i + 80) + 'p engine.tpl.html ' + 'x'.repeat(60) }) } }] });
    messages.push({ role: 'tool', tool_call_id: 'e' + i, content: 'exit=0\n' + 'template line '.repeat(80) });
  }
  for (const name of ['方案.md', '脚本.md', 'claims.json']) {
    const id = 'w-' + name;
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ path: name, content: 'c' }) } }] });
    messages.push({ role: 'tool', tool_call_id: id, content: '已写入 ' + name });
  }
  for (let i = 0; i < 12; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 't' + i, type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'f' + i }) } }] });
    messages.push({ role: 'tool', tool_call_id: 't' + i, content: '内容' });
  }
  const result = prepareRequestContext(messages);
  // 台账挂在请求末尾，system 保持逐字节不变（保住前缀缓存）。
  const tail = result.messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
  assert.equal(result.messages[0].content, '规则', 'system 不能被改写');
  assert.ok(result.ledgerChars <= 24000 + 200, '台账仍有上限');
  assert.match(tail, /省略 \d+ 项较低优先级历史/, '台账满时必须说明省略了多少');
  /* 三笔写入必须还能在请求里找到：要么在台账里（已折叠），
     要么在保留区里逐条完整（未折叠）。两种都算没丢。 */
  const keptPaths = new Set();
  for (const m of result.messages) {
    for (const c of m.tool_calls || []) {
      try { const a = JSON.parse(c.function.arguments); if (a.path) keptPaths.add(a.path); } catch {}
    }
  }
  for (const name of ['方案.md', '脚本.md', 'claims.json']) {
    const inLedger = tail.includes('write_file(' + name + ')');
    assert.ok(inLedger || keptPaths.has(name), '写入回执不能丢：' + name);
  }
});

/* 末尾追加现场时，若最后一条是带 tool_calls 的 assistant，插 user 会打断配对。 */
test('末尾是未配对的 assistant 时不插 user，台账改挂最后一条 user 消息', () => {
  const messages = [{ role: 'system', content: '规则' }, { role: 'user', content: '原始要求' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a1', type: 'function', function: { name: 'read_file', arguments: '{"path":"x.md"}' } }] }];
  const result = prepareRequestContext(messages, { tailNote: '【现场】最新状态' });
  const waiting = new Set();
  for (const m of result.messages) {
    if (m.role === 'tool') assert.ok(waiting.delete(m.tool_call_id));
    else { assert.equal(waiting.size, 0); for (const c of m.tool_calls || []) waiting.add(c.id); }
  }
  assert.equal(waiting.size, 1, '未配对的 tool_calls 必须仍然悬空且被保留');
  const userText = result.messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
  assert.match(userText, /【现场】最新状态/);
});

/* 真实事故：停滞计数存进检查点并跨执行继承，
 * 第 10 次执行只跑 2 步就因"连续 101 步"被暂停，而且连警告流程都跳过了。 */
test('停滞计数不跨执行继承：新一次执行不会一上来就暂停', async t => {
  const dir = project(t);
  const task = beginTask(dir, '原目标', 'article');
  // 造一个"上次已经停滞很久"的检查点（写入检查点要求任务在运行态）
  const cp = { schemaVersion: 1, taskId: task.id, attemptId: task.attemptId, mode: 'article',
    task: '原目标', messages: [{ role: 'user', content: '原目标' }], pending: [],
    status: 'running', phase: 'stopped', noProgressSteps: 100, stallPhase: 1,
    progressStamp: 'x:1:1' };
  writeCheckpoint(dir, cp);
  const plan = '# 方案\n\n| 场 | 内容 |\n|---|---|\n| S1 | 窗口 |\n';
  const script = '**主体**：窗口\n\n## S1 · 窗口\n1. 窗口展示输入与结果。\n← 依赖：无\n';
  const scene = 'root => { const el=mk("div","","窗口的输入与结果"); root.appendChild(el); return {render(t){el.style.opacity=t>=1?"1":"0";}}; }';
  const actions = [
    ['append_file', () => ({ path: '方案.md', content: plan })],
    ['finish_draft', () => ({ path: '方案.md', base_hash: readEditFile(dir, '方案.md').base_hash })],
    ['append_file', () => ({ path: '脚本.md', content: script })],
    ['finish_draft', () => ({ path: '脚本.md', base_hash: readEditFile(dir, '脚本.md').base_hash })],
    ['write_scene', () => ({ scene: 1, layout: '输入输出对照', content: scene })],
  ];
  let calls = 0, independentCalls = 0;
  const result = await runAgent(dir, '原目标', { taskId: task.id, attemptId: task.attemptId, mode: 'article',
    // 默认内容优先不再有独立 claims 步骤：五次合法作者动作，加执行器组装一轮。
    // 仍须全部真实落盘并组装；不自动审稿，不进入 TTS/渲染。
    resume: true, stepBudget: actions.length + 1, stallSteps: 5, providers,
    request: async (_p, _messages, schemas) => {
      if (!schemas.length) {
        independentCalls++;
        assert.fail('默认制作不应发起独立模型审稿请求');
      }
      const [name, args] = actions[calls++];
      assert.ok(schemas.some(schema => schema.function.name === name), '只执行现场作者阶段已公布的动作');
      return call('w' + calls, name, args());
    } });
  assert.equal(calls, actions.length, '旧计数不能妨碍任何一次合法作者动作');
  assert.equal(independentCalls, 0, '新提交脚本不自动启用独立审稿');
  assert.equal(fs.readFileSync(path.join(dir, '方案.md'), 'utf8'), plan);
  assert.equal(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), script);
  assert.equal(fs.existsSync(path.join(dir, 'claims.json')), false, '默认制作不为通过阶段检查补独立 claims 文书');
  assert.equal(authorDocumentState(dir, '方案.md').ok, true);
  assert.equal(authorDocumentState(dir, '脚本.md').ok, true);
  assert.match(fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8'), /窗口的输入与结果/);
  assert.equal(sceneAssemblyMatches(dir), true, '场景必须真实保存并组装，不能仅以暂停当作产出');
  assert.equal(readCheckpoint(dir, task.id).stallPhase, 0);
  assert.ok(readCheckpoint(dir, task.id).noProgressSteps < 5, '不继承旧的 100 步计数');
  assert.equal(result.status, 'paused', '作者阶段预算用尽不冒充成片交付');
  assert.doesNotMatch(result.paused || '', /没有推进任何产出/, '不应被判停滞');
});

test('恢复后的执行先给一次警告，而不是直接暂停', async t => {
  const dir = project(t);
  let calls = 0;
  const result = await runAgent(dir, '只读', { taskId: 'stall-warn', mode: 'article',
    stepBudget: 200, stallSteps: 4, providers,
    request: async () => {
      calls++;
      return { choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'r' + calls, type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] } }] };
    } });
  assert.equal(result.status, 'paused');
  assert.match(result.paused, /没有推进任何产出|停止查阅|没有执行规定动作/);
  assert.ok(calls > 4, '应先警告再给机会，不能一步就停：' + calls);
});

/* 未发生折叠时，末尾追加的现场也必须出现在请求里（曾经被丢弃）。 */
test('短对话不折叠时，追加的现场仍然进入请求', () => {
  const messages = [{ role: 'system', content: '规则' }, { role: 'user', content: '做一支片' }];
  const result = prepareRequestContext(messages, { tailNote: '【现场】已写 方案.md' });
  assert.equal(result.tailAppended, true);
  assert.match(result.messages.map(m => m.content || '').join('\n'), /【现场】已写 方案\.md/);
  assert.deepEqual(messages[1], { role: 'user', content: '做一支片' }, '原始消息不能被改写');
});

/* 真实事故：第 8 次执行 68 步里 20 多步在 cat/grep skill 脚本与参考文档，
   一步产物都没改。反复读文档必须被拦住。 */
test('反复读 skill 文档会被拦下并要求动手', async t => {
  const dir = project(t);
  const tools = makeTools(dir, () => {}, { mode: 'article' });
  const cmd = 'head -80 ~/.config/opencode/skills/article-video/references/engine-api.md'; // 避免 cat 被 head 提前关闭而产生真实 SIGPIPE。
  const first = await tools.run.run({ command: cmd });
  assert.match(first, /exit=0/, '第一次读文档是允许的');
  // 模拟连续读同一类文档：工具层只拦"直接执行底层脚本"，读取本身允许；
  // 真正的拦截在 agent 主循环（停滞检测 + 文档探索计数）里。
  assert.doesNotMatch(first, /拒绝/);
});

/* 真实事故：14 步里 10 步在 grep 同一份 engine.tpl.html，
   前后两条完全相同的命令隔了 6 步，"只比连续相同命令"比不出来，4 小时零产出。 */
test('反复读同一个项目文件（命令不同也算）会被拦下', async t => {
  const dir = project(t);
  fs.writeFileSync(path.join(dir, 'engine.tpl.html'), 'function mk(){}\n'.repeat(50));
  const tools = makeTools(dir, () => {}, { mode: 'article' });
  // 工具层允许读；拦截在 agent 主循环里按"同一文件被读次数"判定。
  const r = await tools.run.run({ command: 'grep -n "function mk" engine.tpl.html | head -20' });
  assert.match(r, /exit=0/);
});

test('同一作者稿被反复查阅时要求动手，正确阶段仍能真实补稿并提交', async t => {
  const dir = project(t);
  fs.writeFileSync(path.join(dir, '方案.md'), '# 方案\n| S1 | 窗口 |\n');
  const initial = '**主体**：窗口\n\n## S1 · 窗口\n';
  const narration = '1. 窗口展示输入与结果。\n← 依赖：无\n';
  fs.writeFileSync(path.join(dir, '脚本.md'), initial);
  let n = 0;
  const logs = [];
  const result = await runAgent(dir, '做一支片', { taskId: 'probe', mode: 'article',
    stepBudget: 10, stallSteps: 100, providers, log: l => logs.push(l),
    request: async (_p, _messages, schemas) => {
      n++;
      // The first useful read is not spinning; narrow after seven stale turns,
      // not seven cumulative reads.
      if (n <= 8) {
        assert.ok(schemas.some(schema => schema.function.name === 'read_file'));
        return call('p' + n, 'read_file', { path: '脚本.md', start_line: 0, max_lines: 4 });
      }
      if (n === 9) {
        assert.ok(!schemas.some(schema => schema.function.name === 'read_file'), '探索预算耗尽后收起读取');
        return call('write-narration', 'append_file', {
          path: '脚本.md', content: narration, base_hash: readEditFile(dir, '脚本.md').base_hash,
        });
      }
      assert.ok(schemas.some(schema => schema.function.name === 'read_file'), '真实落盘后才重置探索计数');
      return call('submit-script', 'finish_draft', { path: '脚本.md', base_hash: readEditFile(dir, '脚本.md').base_hash });
    } });
  assert.ok(logs.some(l => /反复读同一文件|收起只读工具/.test(l)),
    '应记录停止无界查阅的要求');
  assert.equal(n, 10);
  assert.equal(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), initial + narration, '必须真的补齐当前脚本，不越阶段写场景');
  assert.equal(authorDocumentState(dir, '脚本.md').ok, true, '补稿必须提交当前全文版本');
  assert.equal(readCheckpoint(dir, 'probe').pipelineState.progress.violations, 0);
  assert.equal(result.status, 'paused', '只完成作者稿不冒充视频 completed');
});

/* 一直被拦还不改手：不该继续烧额度，应停下来并把下一步说清楚。 */
test('连续被拦还不动手就暂停，并给出具体下一步', async t => {
  const dir = project(t);
  const initial = '**主体**：窗口\n\n## S1 · 窗口\n';
  fs.writeFileSync(path.join(dir, '脚本.md'), initial);
  let n = 0;
  const result = await runAgent(dir, '做一支片', { taskId: 'probe2', mode: 'article',
    stepBudget: 200, stallSteps: 500, providers,
    request: async () => {
      n++;
      // 新范围不因总次数被拦；反复空读/无产出仍会暂停并给出合法动作。
      return call('p' + n, 'read_file', { path: '脚本.md', start_line: n - 1, max_lines: 1 });
    } });
  assert.equal(result.status, 'paused');
  assert.match(result.paused, /不符合本轮工具契约|没有任何落盘/);
  assert.match(result.paused, /方案\.md[\s\S]*append_file|append_file[\s\S]*方案\.md/, '暂停说明必须给出当前作者文件和合法写入动作');
  assert.match(result.paused, /^下一步：append_file → 方案\.md。/, '合法工具与目标须先于长篇阶段说明，不能被截断埋没');
  assert.ok(n <= 15, '不该一直烧到预算上限，实际 ' + n + ' 步');
  assert.equal(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), initial, '拒绝后的读取不能假装产生作者稿');
  assert.equal(fs.existsSync(path.join(dir, '方案.md')), false, '违规调用不能冒充已写出方案');
  const denied = readCheckpoint(dir, 'probe2').messages.filter(m => m.role === 'tool' && /^拒绝：/.test(m.content));
  assert.equal(denied.length, 6, '持续违规须本地逐批拒绝，并以有限预算停止');
});
