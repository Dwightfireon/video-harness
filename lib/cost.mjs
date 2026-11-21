/* lib/cost.mjs —— 成本与耗时统计（vh cost）
 *
 * 两部分：
 *  1. 从 out/.vh-chat.log 统计可核的：工具调用次数、修改文件、跑的 vh 命令、轮次。
 *  2. 从 out/.vh-state.json 的 usage 读**真实 token 与金额**。
 *     网关（amr-link / OpenDesign）确实回 usage，且带 cached_tokens，
 *     所以能算出"这次花了多少钱"和"缓存命中率"——不再靠猜。
 *
 * 单价按 OpenDesign 官方价目（USD / 1M tokens，2026-10-20 核对）：
 *   DeepSeek V4.1 Flash：输入 0.30 / 输出 1.20 / 缓存读 0.006
 * 缓存读价只有全价的 1/50，所以"缓存命中率"直接决定账单量级。
 */
import fs from 'node:fs';
import path from 'node:path';

/* USD / 1M tokens。模型不同价不同，这里按 DeepSeek V4.1 Flash（harness 默认）算。 */
export const PRICE = Object.freeze({ input: 0.30, output: 1.20, cacheRead: 0.006 });

const statePath = project => path.join(project, 'out', '.vh-state.json');

function readUsage(project) {
  try {
    const st = JSON.parse(fs.readFileSync(statePath(project), 'utf8'));
    const u = st?.usage;
    if (!u || !Number(u.requests)) return null;
    return {
      requests: Number(u.requests) || 0,
      prompt: Number(u.prompt) || 0,
      cached: Number(u.cached) || 0,
      uncached: Number(u.uncached) || 0,
      completion: Number(u.completion) || 0,
      reasoning: Number(u.reasoning) || 0,
      at: u.at || '',
    };
  } catch { return null; }
}

export function costOf(usage, price = PRICE) {
  if (!usage) return null;
  const usd =
    (usage.uncached / 1e6) * price.input +
    (usage.completion / 1e6) * price.output +
    (usage.cached / 1e6) * price.cacheRead;
  return { usd, hitRate: usage.prompt ? usage.cached / usage.prompt : 0 };
}

export function analyze(project) {
  const logPath = path.join(project, 'out', '.vh-chat.log');
  let text = '';
  const hasLog = fs.existsSync(logPath);
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { /* 没有日志也要能报 usage */ }

  const steps = (text.match(/^· /gm) || []).length;
  const writes = [...text.matchAll(/^· write_file \{"path":"([^"]+)"/gm)].map(m => m[1]);
  const vhRuns = [...text.matchAll(/vh\.mjs\s+([\w-]+)/g)].map(m => m[1]);
  const fetches = (text.match(/^· fetch_url/gm) || []).length;

  // 轮次：以 "══ 用户" 分隔
  const rounds = text ? text.split(/══ 用户\s/).slice(1).map((chunk, i) => {
    const title = chunk.split('\n')[0].replace(/[：:].*$/, '').trim().slice(0, 40);
    const st = (chunk.match(/^· /gm) || []).length;
    const w = [...chunk.matchAll(/^· write_file \{"path":"([^"]+)"/gm)].map(m => m[1]);
    return { i: i + 1, title, steps: st, writes: [...new Set(w)] };
  }) : [];

  const cmdCount = {};
  for (const c of vhRuns) cmdCount[c] = (cmdCount[c] || 0) + 1;

  const usage = readUsage(project);
  const cost = costOf(usage);

  // 没有运行记录：按原契约明确说明，不崩。
  if (!hasLog) return { ok: false, error: '还没有运行记录（out/.vh-chat.log 不存在）', usage, cost };

  return {
    ok: true, steps, fetches, rounds,
    writes: [...new Set(writes)],
    commands: cmdCount,
    bytes: Buffer.byteLength(text, 'utf8'),
    usage, cost,
  };
}

export function report(res) {
  if (!res.ok) return '成本统计：' + res.error;
  const lines = [`运行统计（来自 out/.vh-chat.log，${(res.bytes / 1024).toFixed(0)}KB）`];
  lines.push(`  工具调用 ${res.steps} 次 · 抓网页 ${res.fetches} 次 · 轮次 ${res.rounds.length}`);
  if (res.writes.length) lines.push(`  改过文件：${res.writes.join('、')}`);
  const cmds = Object.entries(res.commands).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (cmds.length) lines.push(`  跑的 vh 命令：${cmds.map(([k, v]) => `${k}×${v}`).join('　')}`);
  if (res.rounds.length) {
    lines.push('');
    lines.push('  每轮：');
    for (const r of res.rounds.slice(-6)) {
      lines.push(`   ${r.i}. ${r.title}　${r.steps} 步` + (r.writes.length ? `　改 ${r.writes.join('/')}` : ''));
    }
  }

  const u = res.usage;
  if (u) {
    lines.push('');
    lines.push('  模型用量（网关实报 usage，单价按 OpenDesign 官方价目）:');
    lines.push(`    请求 ${u.requests} 次 · 输入 ${(u.prompt / 1e6).toFixed(2)}M token`
      + `（其中缓存命中 ${(u.cached / 1e6).toFixed(2)}M，未命中 ${(u.uncached / 1e6).toFixed(2)}M）`);
    lines.push(`    输出 ${(u.completion / 1e6).toFixed(2)}M token（含推理 ${(u.reasoning / 1e6).toFixed(2)}M）`);
    if (res.cost) {
      lines.push(`    缓存命中率 ${(res.cost.hitRate * 100).toFixed(1)}%`
        + `　→　本次花费 $${res.cost.usd.toFixed(4)}`);
      if (res.cost.hitRate < 0.5) {
        lines.push('    ⚠ 缓存命中率偏低：全价输入是缓存价的 50 倍，'
          + '若每轮都在改写请求前部（system/摘要），账单会成倍上升。');
      }
    }
  } else {
    lines.push('');
    lines.push('  ⚠ 还没有 usage 记录（本次运行尚未落盘，或旧任务在加记账前跑完）。');
  }
  return lines.join('\n');
}
