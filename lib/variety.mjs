/* lib/variety.mjs —— 版式多样性体检（vh variety）
 *
 * 来源：五支片子里有三支是「标题 + 若干行列表」占了 60% 以上场次。
 * 观众说"平"，但 layout / screen / pacing 全绿 —— 因为它们逐场看，不看全片节奏。
 *
 * 这个模块按场景代码的**结构特征**归类，再看分布：
 *   window（有窗口/代码行） · bars（有条形/进度） · steps（有步骤/箭头）
 *   grid（有卡片/网格） · list（有 3 行以上文本条目） · statement（只有大字）
 *
 * 三条机器能判的规则：
 *   1. 全片只用 1 种版式 → 警告（通篇一个模样）
 *   2. 相邻两场同版式 → 提示（切了镜但没换画面）
 *   3. 某一种版式占比 > 60% 且场次 ≥ 4 → 警告（观众会觉得"又来了"）
 *
 * 不判"应该用什么"——选版式是创作决定；它只负责把分布摊开给人看。
 */
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/* 单场特征 → 版式标签（按"最突出的结构"归类，可多标签但取主标签） */
export function classify(chunk) {
  /* ⚠ 必须先去掉注释再分类。
     真实 bug：S5 的注释里写了「属性 → 说明」，于是被当成"流程步骤"，
     而它其实是事件表 —— 注释里的字不该影响版式判定。 */
  const code = String(chunk)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // 块注释
    .replace(/^\s*\/\/.*$/gm, ' ')          // 行注释
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const has = (re) => re.test(code);
  // 文本条目数：所有"写字的地方"（line / codeLine / textContent / 带内容实参的 mk）
  // ⚠ 不能只看字符串字面量：组装出来的文案（'第' + n + '条'）也是字
  const textRows = (code.match(/codeLine\(|textContent\s*=|\bline\(/g) || []).length
    + (code.match(/\bmk\(\s*['"][a-z]+['"]\s*,\s*(?:['"][^'"]*['"]|'')\s*,\s*[^,)]+/g) || []).length;
  // 是否有多条并列（数组 / forEach / map 出多条）
  const multi = /\bforEach\(|\bmap\(|\[\s*\{[^\]]*\},\s*\{/.test(code);
  const tags = [];

  if (has(/shotEl|bgImg\s*\(/)) tags.push('shot');
  if (has(/chartEl|chartSvg|<svg/i)) tags.push('chart');
  if (has(/videoEl\s*\(|<video/i)) tags.push('video');
  if (has(/windowMock|codeLine|VH_UI\.windowMock/)) tags.push('window');
  // 条形：必须有"轨道 + 填充"的语义；只写 style.width 的（下划线动画）不算
  if (has(/\bbarW\b|\btrack\b|progressBar|fill\.style\.width|条形|进度条/)) tags.push('bars');
  if (has(/→|steps|箭头|forEach\(\(s,\s*i\)/)) tags.push('steps');
  if (has(/\.grid|gridTemplate|columns|grid-template/)) tags.push('grid');
  /* 手写的卡片（多个 rounded 容器 + 数字大字）也算一种独立版式，
     否则"S3 三个数"会被认成文本列表 —— 而它确实是三张卡片 */
  if (!tags.length && has(/border-radius:\s*20px/) && has(/flex-direction|box-sizing:border-box/)) tags.push('grid');
  if (has(/VH_UI\.oneTake|oneTake\(/)) tags.push('one-take');

  // 主标签：优先级 一镜到底 > 窗口 > 步骤 > 条形 > 网格 > 列表 > 大字
  /* 大字断言：只有一个 hero 级大字 + 一句副文（不再当"文本列表"）。
     判据看 type(...,'hero') 或 fs-hero —— 这是版式分类，不是"有没有文字"。 */
  if (has(/type\([^,]+,\s*'hero'\)|--fs-hero/)) tags.push('statement');
  /* 卡片网格：3 张以上同构卡片（border-radius:var(--radius) + 重复 append） */
  if (!tags.length && has(/border-radius:var\(--radius\)/) && has(/forEach\(|map\(/) && has(/border:1px solid var\(--line\)/)) tags.push('grid');

  /* 事件表：左侧竖线 + 属性名/值成对（不是流程箭头） */
  if (!tags.length && has(/border-left:3px solid/) && has(/pending|属性|事件/) === false && has(/baseline/)) tags.push('eventtable');
  /* 时间线：一条轴 + 节点（axis/dot/date）—— 独立版式 */
  if (!tags.length && has(/axisY|axis\.style|dot\.style|时间轴/)) tags.push('timeline');
  /* 双数字对比：两个超大数字并排（不是条形，是纯数字） */
  if (!tags.length && has(/fs-display|fs-h1/) && (code.match(/big|大字|数字/) || []).length >= 0
      && has(/items\.map|\[\[.*?\],\s*\[/)) tags.push('bignum');

  /* 示意图对比：自己画的两个并列图（方形 vs 圆角）—— 不是列表 */
  if (!tags.length && has(/drawHole|drawShape|示意|对比图/) && has(/split\(|canvas|createElementNS/)) tags.push('diagram');
  if (!tags.length && /drawHole\s*\(/.test(code) && (code.match(/drawHole\s*\(/g) || []).length >= 2) tags.push('diagram');

  const order = ['one-take', 'video', 'shot', 'chart', 'diagram', 'timeline', 'eventtable', 'window', 'steps', 'bars', 'bignum', 'grid', 'statement'];
  const main = order.find(t => tags.includes(t))
    || (textRows >= 3 || (multi && textRows >= 2) ? 'list' : 'statement');
  return { main, tags };
}

const NAME = {
  'one-take': '一镜到底',
  shot: '真实截图',
  statement: '大字断言',
  diagram: '示意图对比',
  timeline: '时间轴',
  eventtable: '事件表',
  bignum: '双数字对比',
  chart: '图表',
  video: '录屏',
  window: '窗口/代码',
  steps: '流程步骤',
  bars: '条形对比',
  grid: '卡片网格',
  list: '文本列表',
  statement: '大字断言',
  diagram: '示意图对比',
  timeline: '时间轴',
  eventtable: '事件表',
  bignum: '双数字对比',
};

export function analyze(project) {
  const src = read(path.join(project, 'scenes.src.js'));
  const script = read(path.join(project, '脚本.md'));
  if (!src) return { ok: true, scenes: [], findings: [], note: '没有 scenes.src.js' };

  const chunks = src.split(/^\/\/---\s*$/m).map(s => s.trim()).filter(Boolean);
  const titles = [...script.matchAll(/^##\s*S(\d+)\s*[·•\-—]?\s*(.*)$/gm)].map(m => m[2].trim());

  const scenes = chunks.map((c, i) => {
    const { main, tags } = classify(c);
    return { i: i + 1, title: titles[i] || '', main, name: NAME[main] || main, tags, lines: c.split('\n').length };
  });

  const findings = [];
  const n = scenes.length;
  if (n === 0) return { ok: true, scenes, findings, note: '没有场景' };

  // 1) 全片只有一种版式
  const kinds = [...new Set(scenes.map(s => s.main))];
  if (kinds.length === 1 && n >= 2) {
    findings.push({
      kind: 'monotone',
      msg: `全片 ${n} 场识别为同一种版式「${scenes[0].name}」`,
      fix: '核对连续性和内容变化；同一界面或主体可以持续使用，不为数量强行换版式。',
    });
  }

  // 2) 相邻同版式：把连续的合并成一段（5 条一样的提示等于没提示）
  const runs = [];
  for (let i = 1; i < n; i++) {
    if (scenes[i].main === scenes[i - 1].main) {
      const last = runs[runs.length - 1];
      if (last && last.end === scenes[i - 1].i) last.end = scenes[i].i;
      else runs.push({ start: scenes[i - 1].i, end: scenes[i].i, name: scenes[i].name });
    }
  }
  for (const r of runs) {
    const span = r.end - r.start + 1;
    findings.push({
      kind: 'adjacent',
      msg: span === 2
        ? `第 ${r.start}–${r.end} 场连着都是「${r.name}」—— 切了镜但画面结构没变`
        : `第 ${r.start}–${r.end} 场连着 ${span} 场识别为「${r.name}」`,
      fix: '看是否有内容推进和必要的强弱变化；连续同结构可以是有意保持参照。',
    });
  }

  // 3) 单一版式占比过高
  if (n >= 4) {
    const count = new Map();
    for (const s of scenes) count.set(s.main, (count.get(s.main) || 0) + 1);
    for (const [k, c] of count) {
      if (c / n > 0.6) {
        findings.push({
          kind: 'dominant',
          msg: `「${NAME[k] || k}」占了 ${c}/${n} 场（${Math.round(c / n * 100)}%）`,
          fix: '结合叙事核对是否单调；高占比本身不代表错误。',
        });
      }
    }
  }

  return { ok: findings.length === 0, scenes, findings };
}

export function report(res) {
  if (res.note) return res.note;
  const lines = ['版式分布（按场景代码的结构特征归类，不是按标题）', ''];
  lines.push('  场次  版式        标题');
  for (const s of res.scenes) {
    lines.push(`  S${String(s.i).padStart(2)}   ${s.name.padEnd(10)}  ${s.title.slice(0, 30)}`);
  }
  // 简易分布条
  const count = new Map();
  for (const s of res.scenes) count.set(s.main, (count.get(s.main) || 0) + 1);
  lines.push('');
  lines.push('  分布：' + [...count.entries()].map(([k, c]) => `${NAME[k] || k}×${c}`).join('　'));
  lines.push('');
  if (!res.findings.length) {
    lines.push('未触发分布提示；不代表节奏或审美通过。');
  } else {
    for (const f of res.findings) {
      lines.push(`⚠ ${f.msg}`);
      if (f.fix) lines.push(`   → ${f.fix}`);
    }
  }
  lines.push('');
  lines.push('说明：这是分布表，不是审美判定——某种版式用得多可能是对的（如整片都在讲一个界面）。');
  return lines.join('\n');
}
