import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { runAgent, makeTools, nextAgentStep } from '../lib/agent.mjs';
import { readCheckpoint, writeCheckpoint } from '../lib/checkpoint.mjs';
import { beginTask, finishTask, taskStatus } from '../lib/task-status.mjs';
import { ProviderRequestError } from '../lib/provider-pool.mjs';

const providers = [{ name: 'opendesign', key: 'fixture', base: 'http://fixture.invalid' }];
const reply = (content = '完成', finish_reason = 'stop') => ({ choices: [{ message: { role: 'assistant', content }, finish_reason }] });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const tools = (...calls) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }] });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-interruption-'));
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function authors(dir) {
  for (const f of ['方案.md', 'claims.json']) fs.writeFileSync(path.join(dir, f), '{}');
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 一场\n1. 第一句。\n');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), 'root => ({ render(){} })');
}
const opts = { providers, mode: 'edit-visual', taskId: 'fixture', stepBudget: 20, stallSteps: 100 };

test('同一长材料的不同段落不会因为总读取次数触发暂停', async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'source.txt'), Array.from({ length: 120 }, (_, i) => 'L' + i).join('\n'));
  let n = 0;
  const result = await runAgent(dir, '读不同段落', { ...opts, request: async () => ++n <= 10
    ? tools(call('r' + n, 'read_file', { path: 'source.txt', start_line: (n - 1) * 10, max_lines: 10 })) : reply() });
  assert.equal(result.status, 'completed');
  const cp = readCheckpoint(dir, 'fixture');
  for (let i = 1; i <= 10; i++) assert.match(cp.messages.find(m => m.tool_call_id === 'r' + i).content, new RegExp('L' + ((i - 1) * 10)));
});

test('通过 run 分段读同一模板不按模板总次数误拦，路径别名也可用', async t => {
  const dir = fixture(t); let n = 0;
  fs.writeFileSync(path.join(dir, 'engine.tpl.html'), Array.from({ length: 100 }, (_, i) => 'L' + i).join('\n'));
  const result = await runAgent(dir, '核对不同片段', { ...opts, request: async () => ++n <= 9
    ? tools(call('r' + n, 'run', { command: `sed -n '${n},${n + 1}p' ./engine.tpl.html` })) : reply() });
  assert.equal(result.status, 'completed');
  assert.doesNotMatch(readCheckpoint(dir, 'fixture').messages.filter(m => m.role === 'tool').map(m => m.content).join('\n'), /没有执行读取/);
});

test('文件内容已变，即使长度和 mtime 相同也能重新读取', async t => {
  const dir = fixture(t); const f = path.join(dir, 'scenes.src.js'); let n = 0;
  fs.writeFileSync(f, 'v0\n'); const time = fs.statSync(f).mtime;
  const result = await runAgent(dir, '改稿后复核', { ...opts, request: async () => {
    if (++n > 9) return reply();
    fs.writeFileSync(f, 'v' + n + '\n'); fs.utimesSync(f, time, time);
    return tools(call('r' + n, 'read_file', { path: './scenes.src.js', max_lines: 1 }));
  } });
  assert.equal(result.status, 'completed');
  assert.match(readCheckpoint(dir, 'fixture').messages.find(m => m.tool_call_id === 'r9').content, /v9/);
});

test('作者产物推进后，模板搜索次数会重置', async t => {
  const dir = fixture(t); let n = 0;
  fs.writeFileSync(path.join(dir, 'engine.tpl.html'), 'function mk(){}');
  const result = await runAgent(dir, '分阶段实现', { ...opts, request: async () => {
    ++n;
    if (n === 7) return tools(call('w', 'write_file', { path: 'scenes.src.js', content: '// new scene' }));
    if (n === 9) return reply();
    return tools(call('r' + n, 'run', { command: `grep -n 'pattern${n}' engine.tpl.html` }));
  } });
  assert.equal(result.status, 'completed');
  assert.doesNotMatch(readCheckpoint(dir, 'fixture').messages.find(m => m.tool_call_id === 'r8').content, /没有执行读取/);
});

test('一个批次多个重复读取不耗尽多个纠偏轮次，仍有机会写文件', async t => {
  const dir = fixture(t); let n = 0;
  fs.writeFileSync(path.join(dir, 'source.txt'), 'hello');
  const result = await runAgent(dir, '读取后写入', { ...opts, request: async () => {
    if (++n === 1) return tools(...Array.from({ length: 12 }, (_, i) => call('r' + i, 'read_file', { path: 'source.txt' })));
    if (n === 2) return tools(call('w', 'write_file', { path: 'scenes.src.js', content: '// progress' }));
    return reply();
  } });
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8'), '// progress');
});

test('有效的新动作打断重复读取拦截连击；真正持续重复仍暂停', async t => {
  for (const interrupt of [true, false]) {
    const dir = fixture(t); let n = 0;
    fs.writeFileSync(path.join(dir, 'source.txt'), 'hello');
    const result = await runAgent(dir, '验证重复保护', { ...opts, request: async () => {
      ++n;
      if (interrupt && n === 8) return tools(call('list', 'list_files', { path: '.' }));
      if (interrupt && n === 10) return reply();
      return tools(call('r' + n, 'read_file', { path: 'source.txt' }));
    } });
    assert.equal(result.status, interrupt ? 'completed' : 'paused');
    if (!interrupt) { assert.match(result.paused, /连续 3 轮/); assert.equal(n, 9); }
  }
});

test('长文件尾部读取回退磁盘，不从不完整缓存返回空正文', async t => {
  const dir = fixture(t); let n = 0;
  fs.writeFileSync(path.join(dir, 'big.txt'), Array.from({ length: 1000 }, (_, i) => 'L' + i + ':中文'.repeat(40)).join('\n'));
  await runAgent(dir, '读尾部', { ...opts, request: async (_p, messages) => {
    if (++n === 1) return tools(call('head', 'read_file', { path: 'big.txt', max_lines: 2 }));
    if (n === 2) return tools(call('tail', 'read_file', { path: 'big.txt', start_line: 800, max_lines: 2 }));
    const result = messages.find(m => m.tool_call_id === 'tail').content;
    assert.match(result, /L800/); assert.match(result, /L801/);
    return reply();
  } });
});

test('只指定 start_line 也从该行开始，缓存与直接读取语义相同', async t => {
  const dir = fixture(t); let n = 0;
  fs.writeFileSync(path.join(dir, 'small.txt'), 'zero\none\ntwo\nthree');
  const direct = await makeTools(dir, () => {}).read_file.run({ path: 'small.txt', start_line: 2 });
  assert.match(direct, /two\nthree/); assert.doesNotMatch(direct, /zero/);
  await runAgent(dir, '读范围', { ...opts, request: async (_p, messages) => {
    if (++n === 1) return tools(call('a', 'read_file', { path: 'small.txt' }));
    if (n === 2) return tools(call('b', 'read_file', { path: 'small.txt', start_line: 2 }));
    assert.ok(messages.find(m => m.tool_call_id === 'b').content.endsWith(direct));
    return reply();
  } });
});

test('文字汇报后继续耗尽预算：无成片必须暂停且保留恢复入口', async t => {
  const dir = fixture(t); authors(dir); let n = 0;
  const job = beginTask(dir, '做视频', 'article');
  const result = await runAgent(dir, '做视频', { ...opts, mode: 'article', taskId: job.id, attemptId: job.attemptId, stepBudget: 3,
    request: async () => ++n === 1 ? reply('还需要制作成片') : tools(call('l' + n, 'list_files', { path: '.' })) });
  assert.equal(result.status, 'paused'); assert.equal(result.answer, '');
  assert.match(result.paused, /3 步上限/);
  assert.equal(readCheckpoint(dir, job.id).status, 'paused');
  finishTask(dir, job.id, result, job.attemptId);
  assert.equal(taskStatus(dir).canResume, true);
});

test('持续声称完成但缺作者文件或成片，不能写成 completed', async t => {
  for (const withAuthors of [true, false]) {
    const dir = fixture(t); if (withAuthors) authors(dir);
    const result = await runAgent(dir, '做视频', { ...opts, mode: 'article', request: async () => reply('完成') });
    assert.equal(result.status, 'paused'); assert.equal(result.answer, '');
    assert.match(result.paused, withAuthors ? /尚未交付/ : /尚缺/);
  }
});

test('文字汇报后接口失败，必须 failed，不能残留最终答案', async t => {
  const dir = fixture(t); authors(dir); let n = 0;
  const result = await runAgent(dir, '做视频', { ...opts, mode: 'article', request: async () => {
    if (++n === 1) return reply('还没成片');
    throw new ProviderRequestError('quota');
  } });
  assert.equal(result.status, 'failed'); assert.equal(result.answer, '');
});

test('文本或仅推理因输出上限截断都不算完成，连续截断后可恢复暂停', async t => {
  for (const content of ['不完整的汇报', null]) {
    const dir = fixture(t);
    const result = await runAgent(dir, '改画面', { ...opts, request: async () => reply(content, 'length') });
    assert.equal(result.status, 'paused'); assert.equal(result.answer, '');
    assert.match(result.paused, /输出上限/);
  }
});

test('恢复去重真正作用于发送与检查点，普通用户补充逐字保留', async t => {
  const dir = fixture(t);
  const a = '同一前缀'.repeat(100) + '要求A', b = '同一前缀'.repeat(100) + '要求B';
  writeCheckpoint(dir, { schemaVersion: 1, taskId: 'fixture', mode: 'edit-visual', status: 'paused', pending: [],
    messages: [{ role: 'system', content: '原系统' }, { role: 'user', content: '原文' },
      ...Array.from({ length: 4 }, () => ({ role: 'user', content: '【继续原任务】旧提示' }))] });
  await runAgent(dir, '原文', { ...opts, resume: true, instructions: [{ id: 'a', content: a }, { id: 'b', content: b }],
    request: async (_p, messages) => {
      assert.equal(messages.filter(m => m.role === 'user' && m.content.startsWith('【继续原任务】')).length, 1);
      assert.ok(messages.some(m => m.content === a)); assert.ok(messages.some(m => m.content === b));
      assert.equal(messages[0].content, '原系统');
      return reply();
    } });
  assert.equal(readCheckpoint(dir, 'fixture').messages.filter(m => m.content?.startsWith('【继续原任务】')).length, 1);
});

test('恢复时的下一关从文件推导，不受过期 PROGRESS.md 影响', async t => {
  const dir = fixture(t); authors(dir);
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 一\n1. 一句\n## S2 · 二\n1. 二句\n');
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), '全部未开始');
  const before = fs.readFileSync(path.join(dir, 'PROGRESS.md'), 'utf8');
  assert.match(nextAgentStep(dir, 'article'), /脚本有 2 场，scenes.src.js 有 1 块/);
  writeCheckpoint(dir, { schemaVersion: 1, taskId: 'fixture', mode: 'article', status: 'paused', pending: [],
    messages: [{ role: 'system', content: '原系统' }, { role: 'user', content: '原文' }] });
  await runAgent(dir, '原文', { ...opts, mode: 'article', resume: true, stepBudget: 1, request: async (_p, messages) => {
    assert.match(messages.map(m => m.content || '').join('\n'), /脚本有 2 场，scenes.src.js 有 1 块/);
    return tools(call('list', 'list_files', { path: '.' }));
  } });
  assert.equal(fs.readFileSync(path.join(dir, 'PROGRESS.md'), 'utf8'), before);
  assert.doesNotMatch(nextAgentStep(dir, 'edit-copy'), /写 scenes.src.js/);
});

test('失败、被拒或空跑的构建不能冒充产物推进', async t => {
  const dir = fixture(t); let n = 0;
  fs.writeFileSync(path.join(dir, 'vh.mjs'), 'console.log("✗ build failed"); process.exit(1);');
  const result = await runAgent(dir, '做视频', { ...opts, mode: 'article', stepBudget: 60, stallSteps: 3,
    request: async () => tools(call('b' + (++n), 'run', { command: `node vh.mjs build --attempt ${n}` })) });
  assert.equal(result.status, 'paused'); assert.ok(n < 60);
  // 阶段守卫会更早停在“该动笔却没动笔”，同样达到不烧预算的目的。
  assert.match(result.paused, /没有推进任何产出|没有执行规定动作/);
  const steps = readCheckpoint(dir, 'fixture').noProgressSteps;
  assert.ok(steps > 0 && steps <= n, '失败的构建不能清零无进展计数：' + steps + '/' + n);
});

test('重写内容相同的构建产物不算新推进', async t => {
  const dir = fixture(t); let n = 0;
  fs.writeFileSync(path.join(dir, 'vh.mjs'), 'import fs from "node:fs"; fs.writeFileSync("scene.html", "same");');
  const result = await runAgent(dir, '做视频', { ...opts, mode: 'article', stepBudget: 60, stallSteps: 3,
    request: async () => tools(call('b' + (++n), 'run', { command: `node vh.mjs build --attempt ${n}` })) });
  assert.equal(result.status, 'paused'); assert.ok(n < 60);
  const steps = readCheckpoint(dir, 'fixture').noProgressSteps;
  assert.ok(steps > 0 && steps <= n, '相同内容的重写不能被当成推进：' + steps + '/' + n);
});

test('CLI 总帮助和子命令帮助成功退出，不启动 ask 或创建项目', () => {
  for (const args of [['--help'], ['-h'], ['help', 'build'], ['build', '--help'], ['ask', '--help']]) {
    const out = execFileSync(process.execPath, [path.resolve('vh.mjs'), ...args], { encoding: 'utf8' });
    assert.match(out, /用法/); assert.doesNotMatch(out, /未知命令|交给 agent 循环/);
  }
});

test('网页抓取在响应头或正文挂住时都受总超时限制', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/body') { res.writeHead(200); res.write('partial'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const tool = makeTools(fixture(t), () => {}, { fetchTimeoutMs: 100 }).fetch_url;
  for (const endpoint of ['headers', 'body']) {
    const start = Date.now();
    const result = await tool.run({ url: `http://127.0.0.1:${server.address().port}/${endpoint}` });
    assert.match(result, /抓取超时/); assert.ok(Date.now() - start < 3000);
  }
});
