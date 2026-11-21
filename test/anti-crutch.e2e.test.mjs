/* 反拐杖验收：用"会犯真实错误的模型"跑完整链路。
 *
 * 现有端到端测试用的是完全听话的脚本化模型（第1步读、第2步写、第3步跑 build…），
 * 它只证明"理想路径能通"，证明不了"真实模型犯错时不需要人插手"。
 * 这里刻意让模型犯历史上真实出现过的每种错，验证执行器自己兜住：
 *
 *   ① 改完脚本立刻宣称"完成"         → 不能算完成，必须继续出片
 *   ② 只写 发布文案.md 就想收工        → 不能满足"改片子"的指令
 *   ③ 把 shell 命令塞进 run_stage      → 自我纠正，不累计偏离
 *   ④ 反复读文件十几轮才动手           → 不能被轮次上限判死
 *   ⑤ 真的跑完 build/measure/render/voice → 才算完成
 *
 * 判据只有一条：**要么真正交付，要么停下并给出可操作的下一步**；
 * 不允许"看起来完成但片子没变"。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAgent } from '../lib/agent.mjs';
import { readEditFile } from '../lib/author-edits.mjs';
import { saveState } from '../lib/state.mjs';

const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }];
const toolCall = (id, name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
const reply = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

/* 一个"已成片"的项目：脚本、场景、时间轴、带音轨成片与凭证都齐。
 * render.mjs / voice-kokoro.py 用合成媒体替身，只验证链路不消耗真实资源。 */
function film(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-anticrutch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  for (const [name, content] of Object.entries({
    'PROJECT.json': JSON.stringify({ deliveryTarget: 'video', durationLimit: { maxSeconds: 900, targetSeconds: 60 } }),
    '方案.md': '# 方案\n\n| 场 | 内容 |\n|---|---|\n| S1 | 开场 |\n',
    '脚本.md': '**主体**：测试窗口\n## S1 · 开场\n1. 这是第一句。\n← 依赖：无\n',
    'claims.json': '[]',
    'scenes.src.js': '// @layout 标题\nroot => { const el = mk("div","","测试窗口"); root.appendChild(el); return {render(){}}; }\n',
    'engine.tpl.html': "const ORIENT = 'landscape';",
    'scene.html': 'const scenes = []; addScene(0, 30, () => {}); const DURATION = 30;',
    'timing.json': JSON.stringify({ dur: 30, subs: [] }),
    '发布文案.md': '## 标题\n测试\n## 简介\n介绍。\n## 置顶评论\n欢迎。\n## 封面文案\n主：测试\n',
    // 合成替身：不启动真实浏览器/ffmpeg
    'gen.mjs': "import fs from 'node:fs';if(!fs.existsSync('脚本.md'))process.exit(9);process.exit(0);",
    'render.mjs': "import fs from 'node:fs';fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/video.mp4', 'stub-video-'+Date.now());process.exit(0);",
    'voice-kokoro.py': "import pathlib\npathlib.Path('out').mkdir(exist_ok=True)\npathlib.Path('out/video-voice.mp4').write_text('stub-voice')\npathlib.Path('out/subtitles.srt').write_text('1\\n00:00:00,100 --> 00:00:01,900\\n测试\\n')\n",
  })) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test('反拐杖①：改完脚本就说"完成"，执行器必须自己继续出片', async t => {
  const dir = film(t);
  let requests = 0, ranStages = [];
  const result = await runAgent(dir, '在片尾加一段广告', {
    mode: 'article', taskId: 'lazy-done', providers, stepBudget: 14,
    instruction: '在片尾加一段广告，介绍 example.com',
    request: async () => {
      requests++;
      if (requests === 1) {
        const cur = readEditFile(dir, '脚本.md');
        return toolCall('w1', 'patch_text', { path: '脚本.md', base_hash: cur.base_hash,
          find: '1. 这是第一句。', replace: '1. 这是第一句。\n\n## S2 · 广告\n1. 介绍一下 example.com。' });
      }
      // 事故行为：写完就自称完成，一次都不跑阶段
      return reply('已完成修改。');
    },
  });
  const script = fs.readFileSync(path.join(dir, '脚本.md'), 'utf8');
  assert.match(script, /example\.com/, '脚本必须真的被改');
  /* 核心断言：不能以"已完成"收工。要么真的出了片，要么停在待出片并说清下一步。
   * 旧实现在这里直接 completed，而成片毫无变化。 */
  if (result.status === 'completed') {
    assert.ok(fs.readFileSync(path.join(dir, 'out/video-voice.mp4'), 'utf8').includes('stub-voice'),
      '若声称完成，成片必须是这一版');
  } else {
    assert.equal(result.status, 'paused', '应当是暂停而不是失败：' + result.status);
    assert.match(result.paused || '', /尚未交付|成片|重新生成|measure|render/,
      '暂停原因要能照着做：' + (result.paused || ''));
  }
});

test('反拐杖②：只写发布文案不能满足"改片子"，也不能因此标记完成', async t => {
  const dir = film(t);
  let requests = 0;
  const result = await runAgent(dir, '在片尾加广告', {
    mode: 'article', taskId: 'copy-only', providers, stepBudget: 6,
    instruction: '在片尾加一段广告，介绍 example.com',
    request: async () => {
      requests++;
      return toolCall('pub' + requests, 'write_file', { path: '发布文案.md', content: '# 发布文案\n\n## 标题\n改过的标题\n' });
    },
  });
  assert.ok(requests >= 2, '只写发布文案不能一次收工：' + requests);
  assert.notEqual(result.status, 'completed', '片子没改，不能算完成');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /example\.com/,
    '前提：这一轮确实没改脚本');
});

test('反拐杖③：把 shell 命令塞进 run_stage 会自我纠正，不被判偏离', async t => {
  const dir = film(t);
  let requests = 0, sawCorrection = false;
  const result = await runAgent(dir, '在片尾加广告', {
    mode: 'article', taskId: 'misuse', providers, stepBudget: 14,
    instruction: '在片尾加一段广告',
    request: async (_p, messages) => {
      requests++;
      sawCorrection ||= messages.some(m => m.role === 'tool' && /run_stage 的 stage 只接受/.test(m.content || ''));
      if (requests <= 3) return toolCall('bad' + requests, 'run_stage', { stage: 'grep -n x scenes.src.js' });
      const cur = readEditFile(dir, '脚本.md');
      return toolCall('w' + requests, 'patch_text', { path: '脚本.md', base_hash: cur.base_hash,
        find: '1. 这是第一句。', replace: '1. 这是第一句。\n\n## S2 · 广告\n1. 片尾广告。' });
    },
  });
  assert.ok(sawCorrection, '必须给出可照做的用法纠正');
  assert.doesNotMatch(result.paused || '', /没有执行阶段.*规定动作/,
    '用错工具不能被记成空转：' + (result.paused || ''));
  assert.match(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /片尾广告/,
    '纠正后应真的动上手');
});

test('反拐杖④：读十几轮再动手不能被轮次上限判死', async t => {
  const dir = film(t);
  let requests = 0;
  // 造一个更长的脚本，让"读不同片段"是真实的定位过程
  fs.writeFileSync(path.join(dir, '脚本.md'),
    '**主体**：测试窗口\n## S1 · 开场\n1. 这是第一句。\n' +
    Array.from({ length: 60 }, (_, i) => `补充说明第 ${i + 1} 行，用于让脚本足够长。`).join('\n') + '\n← 依赖：无\n');
  const result = await runAgent(dir, '在片尾加广告', {
    mode: 'article', taskId: 'slow-reader', providers, stepBudget: 24,
    instruction: '在片尾加一段广告',
    request: async (_p, _messages, tools) => {
      requests++;
      const names = (tools || []).map(t => t.function?.name);
      const canRead = names.includes('read_file');
      // 前 14 轮读**不同区间**（真实模型的定位过程）；工具被收窄就转去写
      if (canRead && requests <= 14) return toolCall('r' + requests, 'read_file', { path: '脚本.md', start_line: requests, max_lines: 6 });
      const cur = readEditFile(dir, '脚本.md');
      return toolCall('w' + requests, 'patch_text', { path: '脚本.md', base_hash: cur.base_hash,
        find: '1. 这是第一句。', replace: '1. 这是第一句。\n\n## S2 · 广告\n1. 片尾广告。' });
    },
  });
  assert.doesNotMatch(result.paused || '', /连续 ?12 ?轮未完成/,
    '准备期不该被固定轮次判死：' + (result.paused || ''));
  assert.match(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /片尾广告/,
    '读够了必须能真的写进去');
});

test('反拐杖⑤：真跑完阶段并交付时，才允许 completed', async t => {
  const dir = film(t);
  const stages = [];
  let requests = 0;
  const result = await runAgent(dir, '在片尾加广告', {
    mode: 'article', taskId: 'full-path', providers, stepBudget: 20,
    instruction: '在片尾加一段广告',
    request: async () => {
      requests++;
      if (requests === 1) {
        const cur = readEditFile(dir, '脚本.md');
        return toolCall('w1', 'patch_text', { path: '脚本.md', base_hash: cur.base_hash,
          find: '1. 这是第一句。', replace: '1. 这是第一句。\n\n## S2 · 广告\n1. 片尾广告。' });
      }
      if (requests <= 5) {
        const stage = ['build', 'measure', 'render', 'voice'][requests - 2];
        if (stage) { stages.push(stage); return toolCall('s' + requests, 'run_stage', { stage }); }
      }
      return reply('已改完并出片。');
    },
  });
  if (result.status === 'completed') {
    assert.ok(stages.length >= 3, '声称完成前必须真的跑过制作阶段，实际：' + JSON.stringify(stages));
  } else {
    // 合成替身可能让阶段校验不通过；此时必须给出可操作原因，不能静默完成
    assert.equal(result.status, 'paused');
    assert.ok((result.paused || '').length > 10, '暂停必须说明原因');
  }
});
