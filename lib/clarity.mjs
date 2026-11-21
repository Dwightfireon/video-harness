/* lib/clarity.mjs —— 解释质量评估器（references/clarity.md 的机器可查部分）
 *
 * 能查的（硬性）：
 *   1. 术语首现未定义：脚本里第一次出现的关键词/英文标识符/引号词，必须当场解释，或在「## 术语」表登记
 *   2. 依赖倒挂/缺失：每场的「← 依赖：…」只能指向更早的场；开场场必须写「无」
 *   3. 开场依赖未闭合：前 3 句里出现的术语，必须已定义（因为还没有任何台阶可站）
 *   4. 术语表定义必须含「它是什么」的动作词，不能是另一个未解释抽象词
 * 只能提示的（待审，不算通过也不算失败）：
 *   5. 因果缺中段：出现因为/所以/导致/才能…但没有机制类词（通过/步骤/过程/把…变成/先…再…）
 *   6. 关键结论附近没有可见的“依据 → 变化/判断规则 → 结论”桥（待登记，不猜语义）
 *   7. 抽象空转：整句只有抽象名词（能力/体系/机制/流程/价值/生态），没有具体对象、数字、例子
 *   8. 内部术语表不等于口播解释；强类比需要逐项对应与边界（只提示，不自动判语义）
 * 输出：审查-解释.md（含每场「隐性知识追问」清单）
 */
import fs from 'node:fs';
import path from 'node:path';
import { authorEvidenceStatus, evidenceComparisonMarkdown } from './author-evidence.mjs';

/* ---------- 读取 ---------- */
function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

/* 受众基线：从 方案.md 抓「已经知道 / 不知道」两段（先剥标题，标记必须带冒号，空行/标题即结束） */
function audienceBaseline(方案, { legacy = false } = {}) {
  const known = [], unknown = [];
  let mode = null, columns = null;
  const clean = line => line.replace(/\*\*|__/g, '').trim();
  const kind = text => /^(?:观众|读者)?(?:已经知道|已知)$/.test(clean(text)) ? 'known'
    : new RegExp('^(?:观众|读者)?(?:不知道|尚未知道|不清楚|还不知道)' + (legacy ? '$' : '(?:\\s*[/／、]\\s*容易误解)?$')).test(clean(text)) ? 'unknown' : null;
  const push = (line) => {
    // 去掉行首标记与引用符号，按顿号/逗号/分号切项
    const items = line.replace(/^[-*>\s]+/, '').split(/[、，,；;]/).map(s => s.trim())
      .map(s => s.replace(/^[`「『"]+|[`」』"]+$/g, '').trim())
      .filter(s => s.length >= 2 && (legacy ? s.length <= 40 : true));
    (mode === 'known' ? known : unknown).push(...items);
  };
  for (const raw of 方案.split('\n')) {
    const line = clean(raw);
    if (line.startsWith('|')) {
      const cells = line.replace(/^\||\|$/g, '').split('|').map(clean);
      if (cells.some(cell => kind(cell))) { columns = cells.map(kind); mode = null; continue; }
      if (columns && !cells.every(cell => /^:?-+:?$/.test(cell))) {
        cells.forEach((cell, i) => { if (columns[i]) { mode = columns[i]; push(cell); } });
      }
      mode = null;
      continue;
    }
    columns = null;
    if (!line) { mode = null; continue; }                       // 空行结束当前段
    if (/^#{1,6}\s/.test(line)) { mode = null; continue; }       // 标题结束当前段
    if (/^(#|\|)/.test(line)) continue;
    if (/^(已经知道|已知|观众已经知道|读者已经知道)\s*[：:]/.test(line)) {
      mode = 'known';
      push(line.replace(/^[^：:]*[：:]/, ''));
      continue;
    }
    if ((legacy ? /^(?:观众|读者)?(不知道|尚未知道|不清楚|还不知道)\s*[：:]/ : /^(?:观众|读者)?(不知道|尚未知道|不清楚|还不知道)(?:\s*[/／、]\s*容易误解)?\s*[：:]/).test(line)) {
      mode = 'unknown';
      push(line.replace(/^[^：:]*[：:]/, ''));
      continue;
    }
    if (mode) push(line);
  }
  return { known: [...new Set(known)], unknown: [...new Set(unknown)] };
}

/* 脚本：## Sm · 标题 + 编号行；以及可选的 ## 术语 / ## 概念台阶 / ## 数字与来源 */
function parseScript(md) {
  const scenes = [];
  const terms = {};           // 术语 -> 定义
  let cur = null, section = null;
  for (const raw of md.split('\n')) {
    const h = raw.match(/^##\s+(.*)$/);
    if (h) {
      const title = h[1].trim();
      const sm = title.match(/^S(\d+)\s*[·•\-—]?\s*(.*)$/);
      if (sm) { cur = { n: +sm[1], title: sm[2], lines: [], deps: null }; scenes.push(cur); section = 'scene'; continue; }
      section = /术语/.test(title) ? 'terms' : /台阶/.test(title) ? 'ladder' : 'other';
      cur = null; continue;
    }
    if (cur && section === 'scene') {
      const dep = raw.match(/^←\s*依赖\s*[：:]\s*(.+)$/);
      if (dep) { cur.deps = dep[1].trim(); continue; }
      const lm = raw.match(/^\s*(\d+)[.、)]\s*(.+)$/);
      if (lm) cur.lines.push(lm[2].trim());
      continue;
    }
    if (section === 'terms' && raw.trim()) {
      const tm = raw.match(/^\s*[-*|]?\s*([^：:|]+?)\s*[：:|]\s*(.+)$/);
      if (tm) terms[tm[1].trim()] = tm[2].trim();
    }
  }
  return { scenes, terms };
}

/* ---------- 术语提取 ---------- */
// 只挡「对任何受众都属常识、解释反而啰嗦」的词（协议：不要无意义地重复常识）；其余交给 方案.md 的受众基线白名单
const STOP = new Set(['AI', 'IT', 'OK']);
function extractTerms(text, drop) {
  const found = new Map();          // term -> 首个出现的行号
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    const cands = [];
    for (const m of l.matchAll(/[A-Za-z][A-Za-z0-9_.+#/-]{1,}/g)) cands.push(m[0]);
    // 引号内容要区分「概念」与「台词/例子」：
    //   台词/例子通常带语气词、标点、口语（「行，我看看」「哦，好吧」），不当作术语
    //   概念才是短名词性短语（「下次一定」「边界两件套」）
    for (const m of l.matchAll(/[「『"“]([^」』"”]{2,20})[」』"”]/g)) {
      const q = m[1];
      if (/[，。！？、；：]/.test(q)) continue;            // 含标点 → 台词，不是术语
      if (/^[那这他她我你](是|要|说|看)/.test(q)) continue;
      if (/^(行|哦|好|嗯|对|就是|可以|没事)/.test(q) && q.length <= 4) continue;  // 口语应答
      if (q.length > 10 && /[他她我你我们]/.test(q)) continue;   // 完整句子（带主语）→ 例子
      if (/(会不会|能不能|要不要|不接|不回|不行|谢谢)/.test(q) && q.length > 6) continue;   // 口语规则句/抱怨句
      if (/^(别|不|没事|行|哦|嗯)/.test(q) && q.length <= 6) continue;                       // 短口语（「别冲突」）
      cands.push(q);
    }
    for (const c of cands) {
      const t = c.trim();
      if (!t || t.length < 2) continue;
      if (STOP.has(t)) continue;
      if (drop.some(d => d && (t === d || t.includes(d) || d.includes(t)))) continue;
      if (!found.has(t)) found.set(t, i + 1);
    }
  });
  return found;
}

/* 判断「术语首次出现处」是否当场解释了它（术语锚定，不能用整行有冒号就算过） */
const DEF_VERB = /(是|指的是|意思是|即|叫做|称为|也就是|所谓)/;
function hasDefinition(lines, idx, term, { legacy = false } = {}) {
  const line = lines[idx] || '';
  const next = lines[idx + 1] || '';
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 1) 术语后紧跟括号注释：Artifact（一次运行留下的文件）
  if (new RegExp(esc + '\\s*[（(][^）)]{2,}[）)]').test(line)) return true;
  // 2) 术语前有括号解释再给术语：（跑完一次留下的文件）Artifact
  if (new RegExp('[（(][^）)]{4,}[）)]\\s*' + esc).test(line)) return true;
  // 3) 同一小句里对术语下定义：X 是… / X 指的是… / X：…… / X —— ……
  const clauses = line.split(/[，,。；;]/);
  const ci = clauses.findIndex(c => c.includes(term));
  if (ci >= 0) {
    const c = clauses[ci];
    if (legacy ? DEF_VERB.test(c) : new RegExp(esc + '[」』”"]?\\s*(?:是(?!否|不是)|指的是|意思是|即|叫做|称为|也就是)\\s*\\S').test(c)) return true;
    if (new RegExp(esc + '\\s*(——|：|:|=|＝)\\s*\\S').test(c)) return true;
    // 4) 「X，也就是 Y」：下一小句在解释
    const nx = (clauses[ci + 1] || '').trim();
    if (/^(也就是|即|指的是|意思是|包括|换成)/.test(nx)) return true;
  }
  // 5) 下一句整句在解释该术语
  if (legacy ? next.includes(term) && DEF_VERB.test(next) : new RegExp(esc + '[」』”"]?\\s*(?:是(?!否|不是)|指的是|意思是|即|叫做|称为|也就是)\\s*\\S').test(next)) return true;
  // 6) 引号短语紧跟同位语/用途说明，也算当场解释：
  //    「下次一定」的期票 / 用「婚礼你到底想邀谁」当标尺 / 作为例子
  const after = (line.split(term)[1] || '').slice(0, 24);
  if ((legacy ? /^[」』”"）)]?\s*(的|是指|指的是|当|作为|用来|就是)/ : /^[」』”"）)]?\s*(是指|指的是|就是)/).test(after)) return true;
  if (new RegExp(esc + '[^。；]{0,16}(当|作为|用来)[^。；]{0,10}(标尺|例子|比喻|方式|方法|标准)').test(line)) return true;
  return false;
}

/* ---------- 抽象/因果启发式 ---------- */
const ABSTRACT = /(能力|体系|机制|流程|价值|生态|范式|框架|方法|思路|策略|理念|模式|维度|层面|赋能|闭环|抓手)/g;
const CONCRETE = /(\d|[一二三四五六七八九十]+[个项条步秒天]|例如|比如|举个例子|字段|文件|按钮|命令行|截图|表格|目录|节点|如图|如下|姓名|金额|时间)/;
const CAUSAL = /(因为|所以|因此|导致|才能|就会|于是|从而)/;
const MECHANISM = /(通过|步骤|过程|先把|然后|再|第一步|每一步|把.{0,12}(变成|拆成|分成|写成)|中间|一开始|接着)/;
// 只识别需要观众据此作判断或采取行动的句子。不是给每句结论贴标签，
// 更不以“所以”一词代替完整推导。
const CLAIM = /(优先|建议|应该|该(?:选|用|做)|选择|适合|更对题|更值得|不要(?:选|用)|推荐|领先|优于|胜过|更强|更高(?:分|效|准确))/;
const BRIDGE = /(把.{0,16}(变成|拆成|分成|写成)|先.{0,18}(再|然后)|(?:导致|使得|从而|因此|所以|这样).{0,16}(能|会|让|使)|如果.{0,24}(就|再|才)|当.{0,24}时|解决.{0,20}(问题|痛点)|意味着|换句话说|也就是说)/;

function unknownTerm(value) {
  const quoted = value.match(/[「“"]([^」”"]{2,20})[」”"]/);
  if (quoted) return quoted[1];
  return value.replace(/^(?:不知道|尚未知道|不清楚|还不知道)/, '')
    .replace(/(?:是什么意思|是什么|的意思)[。.]?$/, '').replace(/[「」"“”]/g, '').trim();
}

function keyClaims(flat, context, { legacy = false } = {}) {
  const claims = [];
  flat.forEach((line, index) => {
    if (!CLAIM.test(line) && (legacy || !/(证明|意味着|说明了|不等于|不能说明|没(?:有)?证明|不是.{0,18}(?:份额|判决|永久|成品)|结论.{0,12}(?:失效|成立|属性))/.test(line))) return;
    const scene = sceneOfLine(context, index + 1)?.n || null;
    // 只用相邻口播寻找桥；不能让五场之前的事实自动为现在的建议背书。
    const nearby = flat.slice(Math.max(0, index - 2), index + 1).join(' ');
    claims.push({ scene, line, index, hasNearbyBridge: BRIDGE.test(nearby) });
  });
  return claims;
}

export function analyze(project, options = {}) {
  const script = readIf(path.join(project, '脚本.md'));
  const plan = readIf(path.join(project, '方案.md'));
  const { known, unknown } = audienceBaseline(plan, options);
  const { scenes, terms } = parseScript(script);
  const flat = scenes.flatMap(s => s.lines);
  const context = scriptLines(script);          // 带场号的行
  const out = { fail: [], warn: [], pending: [], terms, known, unknown, scenes, keyClaims: [] };

  if (!script) { out.fail.push('没有 脚本.md'); return out; }
  if (!known.length && !unknown.length) out.warn.push('方案.md 未检出受众基线；没有基线不代表观众已经知道所有术语');

  /* 1) 明确声明「不知道」的项：必须在脚本里出现过定义（它们是本片的必须解释项） */
  for (const u of unknown) {
    const key = options.legacy ? u.replace(/[「」"“”]/g, '').trim() : unknownTerm(u);
    if (!key || key.length < 2) continue;
    const appears = flat.some(l => l.includes(key));
    if (!options.legacy && !appears) out.pending.push(`[受众前提待核] ${u}：未按字面定位；须语义核对是否涉及及是否补齐，不能视为已知或已解释。`);
    const defined = terms[key] || Object.keys(terms).some(k => k.includes(key) || key.includes(k)) ||
      flat.some((l, i) => l.includes(key) && hasDefinition(flat, i, key, options));
    if (appears && !defined) {
      out.fail.push(`受众基线里列为「不知道」的「${key}」出现在脚本里，但没有定义（写进 ## 术语 表，或在首次出现处当场解释）`);
    }
  }

  /* 表只供作者与工具阅读，不能当成观众已经听到了；可能用常用说法解释，留人工判定。 */
  for (const term of Object.keys(terms)) {
    if (known.includes(term)) continue;
    const i = flat.findIndex(l => l.includes(term));
    if (i >= 0 && !hasDefinition(flat, i, term, options)) {
      const sc = sceneOfLine(context, i + 1);
      out.pending.push(`[口播解释待核] 第 ${sc ? sc.n + ' 场' : i + 1} 首次说到「${term}」；内部术语表已登记，但首现及下一句未检出解释。核对观众能否仅听旁白理解，不靠表格放行。`);
    }
  }

  /* 2) 术语首现未定义 */
  const drop = [...known, ...Object.keys(terms)];
  const firstAt = extractTerms(flat.join('\n'), drop);
  const flatLines = flat.join('\n').split('\n');
  for (const [term, ln] of firstAt) {
    const i = ln - 1;
    if (terms[term]) continue;
    if (hasDefinition(flatLines, i, term, options)) continue;
    const sc = sceneOfLine(context, ln);
    out.fail.push(`术语「${term}」在第 ${sc ? sc.n + ' 场' : ln + ' 行'}首次出现，但没有解释它是什么（写进 ## 术语 表或当场一句话说清）`);
  }

  /* 3) 依赖闭合：只能指向更早的场；开场必须是「无」 */
  scenes.forEach((s, i) => {
    if (s.deps == null) { out.fail.push(`第 ${s.n} 场缺「← 依赖：…」行（写不出依赖就说明这场要么跳步、要么不该有）`); return; }
    const refs = [...s.deps.matchAll(/S(\d+)/g)].map(m => +m[1]);
    if (i === 0 && (!/^无(?:[（(][^）)]*[）)])?[。.]?$/.test(s.deps) || refs.length)) out.fail.push(`第 ${s.n} 场是开场，依赖必须写「无」（现在写的是「${s.deps}」）`);
    for (const r of refs) {
      if (!scenes.some(scene => scene.n === r)) out.fail.push(`第 ${s.n} 场依赖不存在的 S${r}，不能据此确认链条闭合`);
      else if (r >= s.n) out.fail.push(`第 ${s.n} 场的依赖指向第 ${r} 场（后面/自己）—— 依赖倒挂，必须先立后依`);
    }
    if (!refs.length && !/无/.test(s.deps)) out.warn.push(`第 ${s.n} 场的依赖没写场号（「${s.deps}」）—— 无法核对是否成立`);
  });

  /* 4) 开场前 3 句：术语必须已定义（没有台阶可站） */
  const head3 = flat.slice(0, 3);
  const headText = head3.join('\n');
  const headTerms = extractTerms(headText, drop);
  for (const [t] of headTerms) {
    if (terms[t]) continue;
    const idx = headText.split('\n').findIndex(l => l.includes(t));
    if (idx >= 0 && !hasDefinition(headText.split('\n'), idx, t, options)) {
      out.fail.push(`开场前 3 句里出现未定义的「${t}」—— 观众此时还没有任何台阶可站`);
    }
  }

  /* 5) 待审：因果缺中段 / 抽象空转 */
  flat.forEach((l, i) => {
    const sc = sceneOfLine(context, i + 1);
    if (/(同一[个种]?结构|结构[上是]*相同|本质[上是]*一样|本质[上是]*相同|没有区别|完全等[同价])/.test(l)) {
      const excerpt = flat.slice(Math.max(0, i - 1), i + 2).join(' / ');
      out.pending.push(`[类比跨步待核] 第 ${sc ? sc.n + ' 场' : i + 1}：「${excerpt}」—— 两边各是什么，具体哪一步对应，差别在哪？相似不等于同一机制；也可能是在否定或引用，须读上下文。`);
    }
    if (CAUSAL.test(l) && !MECHANISM.test(l) && l.length > 12) {
      out.pending.push(`[因果缺中段] 第 ${sc ? sc.n + ' 场' : i + 1} 句：「${l.slice(0, 40)}…」—— 说了因果但没交代中间发生了什么`);
    }
    const abs = (l.match(ABSTRACT) || []).length;
    if (abs >= 2 && !CONCRETE.test(l)) {
      out.pending.push(`[抽象空转] 第 ${sc ? sc.n + ' 场' : i + 1} 句：「${l.slice(0, 40)}…」—— 抽象名词堆叠但没有具体对象/数字/例子`);
    }
  });
  out.keyClaims = keyClaims(flat, context, options);
  for (const claim of out.keyClaims) {
    if (claim.hasNearbyBridge) continue;
    out.pending.push(`[结论链待核] 第 ${claim.scene ? claim.scene + ' 场' : claim.index + 1} 句：「${claim.line.slice(0, 52)}…」—— 这是会影响比较、推荐或行动的判断，但附近口播未检出“依据 → 中间变化/判断规则 → 结论”。补出其中缺的一步，或在内容审稿中用编号旁白逐项登记。`);
  }
  out.evidence = authorEvidenceStatus(project, { plan, script });
  out.pending.push(...out.evidence.integrityIssues.map(issue => '[原文锚完整性待核] ' + issue), ...out.evidence.pending);
  return out;
}

function scriptLines(script) {
  // 返回 [{line, scene}]：把每句旁白对应到它的场
  const out = [];
  let cur = null;
  for (const raw of script.split('\n')) {
    const h = raw.match(/^##\s*S(\d+)/);
    if (h) { cur = +h[1]; continue; }
    const lm = raw.match(/^\s*(\d+)[.、)]\s*(.+)$/);
    if (lm && cur) out.push({ line: lm[2].trim(), scene: cur });
  }
  return out;
}
function sceneOfLine(context, n) {
  const item = context[n - 1];
  return item ? { n: item.scene } : null;
}

/* ---------- 报告 ---------- */
export function writeReport(project, res) {
  const tacitQuestions = [
    '要理解/执行这句话，我还必须已经知道什么？',
    '这里有没有默认前提（工具、环境、前置状态）？观众是否具备？',
    '有没有行业惯例或经验判断被省掉了？（观察到什么 → 为什么注意它 → 如何判断 → 采取什么行动 → 如何从结果获得反馈）',
    '边界在哪：什么时候不适用？有没有反例？',
    '同一句话里混了事实/推断/假设/建议吗？有没有标出来？',
  ];
  const sections = [];
  sections.push('# 解释质量审查（vh clarity）\n');
  sections.push(`生成时间：${new Date().toLocaleString('zh-CN')}\n`);
  sections.push('机器只查「依赖闭合」里可判定的部分；机制对不对、隐性知识补齐没有，必须人工过。术语表和依赖行是内部记录，不证明观众听懂。\n');
  sections.push('先只读编号旁白，不看标题、画面或术语表：每个关键判断的依据和中间变化是否真的说出口？若接不上，先补讲述或删掉站不住的关联，再做画面。\n');
  if (res.evidence) sections.push(evidenceComparisonMarkdown(res.evidence));
  sections.push(`\n## 硬性未通过（${res.fail.length}）\n`);
  sections.push(res.fail.length ? res.fail.map(s => '- ' + s).join('\n') : '- 无\n');
  sections.push(`\n## 提示（${res.warn.length}）\n`);
  sections.push(res.warn.length ? res.warn.map(s => '- ' + s).join('\n') : '- 无\n');
  sections.push(`\n## 待人工判定（${res.pending.length}）\n`);
  sections.push(res.pending.length ? res.pending.map(s => '- ' + s).join('\n') : '- 无\n');
  sections.push(`\n## 关键结论链（${res.keyClaims?.length || 0}）\n`);
  sections.push(res.keyClaims?.length
    ? res.keyClaims.map(item => `- 第 ${item.scene || '?'} 场：${item.line}${item.hasNearbyBridge ? '（附近检出桥接线索；仍须人工核对）' : '（未检出附近桥接线索，须补讲或登记）'}`).join('\n')
    : '- 未检出需要登记的比较、推荐或行动结论\n');
  sections.push('\n## 术语（已登记）\n');
  const tk = Object.keys(res.terms);
  sections.push(tk.length ? tk.map(k => `- ${k}：${res.terms[k]}`).join('\n') : '- （无）\n');
  sections.push('\n## 受众基线\n');
  sections.push(`- 已经知道：${res.known.join('、') || '（方案.md 未写）'}`);
  sections.push(`- 不知道：${res.unknown.join('、') || '（方案.md 未写）'}\n`);
  sections.push('\n## 逐场「隐性知识追问」（每场都要有人回答，不许空白）\n');
  for (const s of res.scenes) {
    sections.push(`### 第 ${s.n} 场 · ${s.title}`);
    sections.push(`依赖：${s.deps || '（缺）'}`);
    for (const q of tacitQuestions) sections.push(`- [ ] ${q}`);
    sections.push('');
  }
  const p = path.join(project, '审查-解释.md');
  fs.writeFileSync(p, sections.join('\n'));
  return p;
}
