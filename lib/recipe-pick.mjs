/* lib/recipe-pick.mjs —— 按内容自动选版式（vh pick）
 *
 * 为什么需要：配方库做出来了，但"这场该用哪个"仍是人的判断。
 * agent 拿到 5 个配方名，实际还是习惯用列表——工具没被用，等于没有。
 *
 * 这里做**可解释的规则匹配**：从旁白里找线索（数字/对比/步骤/界面/单一结论），
 * 给出首选 + 理由 + 置信度。不猜意图、不硬塞：证据不够就明说"没把握，你定"。
 *
 * 关键原则：**只建议，不自动改场景**。选版式是创作决定，工具给的是"看得懂的依据"。
 */
import fs from 'node:fs';
import path from 'node:path';

/* 线索 → 版式。每条都要能在旁白里找到**具体证据**，不是关键词命中就完事 */
const RULES = [
  {
    key: 'window-walkthrough',
    name: '窗口实拍感',
    score: (t) => {
      let s = 0;
      const hits = [];
      /* 只提"部署/配置"这类词不算——讲概念也会说到它。
         必须能指向**一个可看的界面或一段可看的输出**。 */
      if (/界面|页面|面板|列表页|详情页|终端|命令行|代码|日志|报错|截图|仓库|镜像里|文件树/.test(t)) { s += 3; hits.push('提到了可看的界面/输出'); }
      if (/点(击|一下)|输入|打开|运行|执行后|返回了|输出是|显示成/.test(t)) { s += 2; hits.push('有可演示的操作'); }
      /* 两条都命中才算"有界面可拍"，只有一条更像在打比方 */
      if (s < 5) s = Math.min(s, 2);
      return { s, hits };
    },
  },
  {
    key: 'compare-bars',
    name: '条形对比',
    score: (t) => {
      let s = 0;
      const hits = [];
      /* 单位表要含中文数量词：'两分钟''四十分钟' 是中文数字，先归一化再数 */
      const norm = t.replace(/零|一|二|两|三|四|五|六|七|八|九|十|百|千/g, (ch) => ({
        零: '0', 一: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10', 百: '100', 千: '1000',
      }[ch] || ch));
      const nums = (norm.match(/\d+(?:\.\d+)?\s*(?:%|倍|MB|KB|GB|秒|分钟|小时|分钟|元|个|条|核|万|天|周)/g) || [])
        .concat(t.match(/[两三四五六七八九十百千]\s*(?:分钟|小时|秒|天|周|年|倍|万|千)/g) || []);
      if (nums.length >= 2) { s += 3; hits.push(`有 ${nums.length} 个带单位的量`); }
      if (/(从|由).{0,14}(降|涨|变|到).{0,14}\d/.test(t)) { s += 3; hits.push('有前后变化'); }
      if (/比|对比|相比|而|却|只有|多达|少了|多了|快了|慢了/.test(t)) { s += 2; hits.push('有比较关系'); }
      if (nums.length) { s += 1; }
      return { s, hits };
    },
  },
  {
    key: 'process-steps',
    name: '三步流程',
    score: (t) => {
      let s = 0;
      const hits = [];
      if (/先.{0,16}再.{0,16}(最后|然后)/.test(t)) { s += 4; hits.push('明确说了先后顺序'); }
      else if (/(第一步|首先|一开始).{0,20}(第二步|接着|然后)/.test(t)) { s += 4; hits.push('分步叙述'); }
      if (/然后|接着|之后|最后|下一步|再/.test(t)) { s += 1; hits.push('有承接词'); }
      if (/流程|步骤|顺序|阶段|环节/.test(t)) { s += 2; hits.push('点明了流程'); }
      return { s, hits };
    },
  },
  {
    key: 'one-take',
    name: '一镜到底',
    score: (t) => {
      let s = 0;
      const hits = [];
      if (/同一个|同一层|这一屏|整体|全局|俯瞰|放大到|推近|拉远/.test(t)) { s += 2; hits.push('说的是同一主体的不同层次'); }
      if (/(左边|右边|上面|下面).{0,20}(左边|右边|上面|下面)/.test(t)) { s += 2; hits.push('画面里有分区'); }
      return { s, hits };
    },
  },
  {
    key: 'hero-statement',
    name: '大字断言',
    score: (t) => {
      let s = 0;
      const hits = [];
      if (/^(不是|真正的|其实|本质上|一句话|说到底|核心是)/.test(t.trim())) { s += 3; hits.push('是一句判断'); }
      if (/不是.{0,12}而是/.test(t)) { s += 3; hits.push('有"不是…而是"的对照'); }
      if (t.length <= 40 && !/\d/.test(t)) { s += 1; hits.push('短、没有数字'); }
      return { s, hits };
    },
  },
];

/* 读脚本，取每场旁白 */
function scenesOf(project) {
  const md = (() => { try { return fs.readFileSync(path.join(project, '脚本.md'), 'utf8'); } catch { return ''; } })();
  const out = [];
  let cur = null;
  for (const raw of md.split('\n')) {
    const h = raw.match(/^##\s*S(\d+)\s*[·•\-—]?\s*(.*)$/);
    if (h) { cur = { n: +h[1], title: (h[2] || '').trim(), lines: [] }; out.push(cur); continue; }
    if (/^##\s/.test(raw)) { cur = null; continue; }
    const lm = raw.match(/^\s*\d+[.、)]\s*(.+)$/);
    if (cur && lm) cur.lines.push(lm[1].trim());
  }
  return out.filter(s => s.lines.length);
}

export function pick(project) {
  const scenes = scenesOf(project);
  const out = [];
  for (const sc of scenes) {
    const text = sc.lines.join(' ');
    const scored = RULES.map(r => ({ key: r.key, name: r.name, ...r.score(text) }))
      .sort((a, b) => b.s - a.s);
    const best = scored[0], second = scored[1];
    const margin = best.s - second.s;
    out.push({
      n: sc.n, title: sc.title,
      key: best.s >= 3 ? best.key : null,
      name: best.s >= 3 ? best.name : null,
      confidence: best.s >= 6 && margin >= 2 ? 'high' : best.s >= 3 ? 'low' : 'none',
      why: best.hits.length ? best.hits.join('；') : '旁白里没有明显线索',
      alt: second.s >= 2 ? { name: second.name, why: second.hits.join('；') } : null,
      scores: scored.slice(0, 3).map(s => `${s.name}:${s.s}`),
    });
  }
  return { scenes: out };
}

export function report(res) {
  const lines = ['版式建议（按旁白线索匹配，不是猜意图）', ''];
  for (const s of res.scenes) {
    const mark = s.confidence === 'high' ? '✓' : s.confidence === 'low' ? '·' : '?';
    lines.push(`${mark} S${String(s.n).padStart(2)} ${s.title.slice(0, 22)}`);
    if (s.key) {
      lines.push(`     建议：${s.name}（${s.confidence === 'high' ? '把握较大' : '可考虑'}）`);
      lines.push(`     依据：${s.why}`);
      if (s.alt) lines.push(`     备选：${s.alt.name}（${s.alt.why}）`);
    } else {
      lines.push(`     建议：没有明显线索 —— 你定（旁白没提到数字/对比/步骤/界面）`);
    }
  }
  const high = res.scenes.filter(s => s.confidence === 'high').length;
  lines.push('');
  lines.push(`共 ${res.scenes.length} 场：${high} 场有明确线索，其余需要人判断。`);
  lines.push('这是建议表，不是自动改写 —— 选版式是创作决定。');
  return lines.join('\n');
}
