/* lib/brief.mjs —— 要求清单（vh brief）
 *
 * 两次真实翻车都出在这里：
 *   ① 用户说「简单点，给链接和优惠码」→ agent 写成「价格 + 三条要点」（绕开指令）
 *   ② 我（助手）拿抓到的页面否定用户指令，把内容改回去（我也绕开指令）
 *
 * 根因：没有任何机制把「用户要求什么」写下来，也没在收尾时核对「做到了没有」。
 * 这个模块做三件事：
 *   1. 从一句指令里抽 must（必须做）/ mustNot（不许做）——只认明确句式，不猜
 *   2. 存到 out/.vh-brief.json（跨轮可查，页面可显示）
 *   3. 收尾时逐条自检：产物里有没有违反 mustNot / 漏掉 must
 */
import fs from 'node:fs';
import path from 'node:path';

const BRIEF = (p) => path.join(p, 'out', '.vh-brief.json');

/* 只看明确表达的句式，避免"猜意图" */
const RULES = [
  // 不许做
  { type: 'mustNot', re: /(不要|不用|别|无需|不必)(再)?(说|写|介绍|展开|提|加|放|包含)?\s*([^，。；\n]{2,18})/g, label: (m) => `不要${m[3] || m[4] || ''}` },
  { type: 'mustNot', re: /(简单点|简洁点|短一点|少说点|别太详细|不用那么详细)/g, label: () => '不要长篇细节' },
  // 必须做
  { type: 'must', re: /(只要|只需要|就给|只给|只写|只留)\s*([^，。；\n]{2,20})/g, label: (m) => `只给${m[2] || ''}` },
  { type: 'must', re: /(必须|一定要|务必)\s*([^，。；\n]{2,20})/g, label: (m) => `必须${m[2] || ''}` },
];

/* 从指令里抽要求：按"短句 + 明确句式"抽，不吞整句 */
export function parseBrief(text) {
  const must = [], mustNot = [], facts = [];
  const push = (arr, s) => { const t = String(s).trim(); if (t.length >= 2 && t.length <= 26 && !arr.includes(t)) arr.push(t); };
  // 先把文本切成短句（中文标点 + 空格）
  const clauses = String(text).replace(/https?:\/\/\S+/g, ' ').split(/[，。；;\n\s]+/).map(x => x.trim()).filter(Boolean);

  for (const c of clauses) {
    // 不许做：不要/不用/别 + 动作 + 对象（对象限 2–10 字）
    let m = c.match(/^(?:不要|不用|别|无需|不必)\s*(?:那么|太)?\s*(?:详细|具体)?\s*(?:介绍|说|写|展开|提|加|放)?\s*([\u4e00-\u9fff\w]{2,10})/);
    if (m) { push(mustNot, '不要' + m[1]); continue; }
    if (/^(简单点|简洁点|短一点|少说点|别太详细|不用那么详细)/.test(c)) { push(mustNot, '不要长篇细节'); continue; }
    // 只要/只需要/就给/只给/只写/只留 + 对象
    m = c.match(/^(?:只要|只需要|就给|只给|只写|只留|给个|给一个)\s*([\u4e00-\u9fff\w、和及与]{2,18})/);
    if (m && /链接/.test(c)) {
      // 「给个链接 以及优惠码」：把"以及/和/与"后面的对象并进来
      const extra = c.match(/(?:以及|和|与)\s*([\u4e00-\u9fff\w]{2,10})/);
      if (extra) { push(must, '只给链接和' + extra[1].replace(/就可以了?$/, '')); continue; }
    }
    if (m) { push(must, '只给' + m[1].replace(/就可以了?$/, '')); continue; }
    // 必须/一定要
    m = c.match(/^(?:必须|一定要|务必)\s*([\u4e00-\u9fff\w]{2,18})/);
    if (m) { push(must, '必须' + m[1]); continue; }
    // 事实认定：X 就是 Y / X 是 Y
    m = c.match(/^([\w\u4e00-\u9fff.-]{2,20}?)\s*(?:就是|是)\s*([\w\u4e00-\u9fff.-]{2,20})$/);
    if (m) { facts.push({ subject: m[1], is: m[2] }); continue; }
  }
  // 整句级兜底：处理"给个链接 以及优惠码"这种被空格切开的并列
  {
    const flat = String(text).replace(/\s+/g, '');
    const m = flat.match(/(?:只要|只需要|就给|只给|只写|只留|给个|给一个)([\u4e00-\u9fff\w、和及与]{2,24}?)(?:就可以了?|就行|即可|。|$)/);
    if (m) {
      const obj = m[1].replace(/就可以了?|就行|即可/g, '').trim();
      if (obj.length >= 2) push(must, '只给' + obj);
    }
  }

  // 事实认定（整句扫，不依赖切词）：X 就是 Y / X 是 Y
  for (const m of String(text).matchAll(/([A-Za-z0-9][\w.\-]{1,23})\s*(?:就是|是)\s*(优惠码|兑换码|邀请码|口令|折扣码|推广码)\s*([A-Za-z0-9]{2,20})?/g)) {
    const subject = m[1].trim();
    // Y 里如果以"优惠码"开头，取整段（如"优惠码S9JE6G"）
    const kindWord = m[2];
    const code = (m[3] || '').trim();
    const val = kindWord;                      // 概念本身（优惠码）
    if (!facts.some(f => f.subject === subject)) facts.push({ subject, is: val, code: code || subject });
  }

  const clean = (u) => u.replace(/[，。；）】」\]]+$/, '');
  const urls = [...new Set((String(text).match(/https?:\/\/\S+/g) || []).map(clean))];
  const bare = [...new Set((String(text).match(/\b[a-z0-9-]+\.(?:com|xyz|cn|io|ai|app|dev)(?:\/\S*)?/gi) || []).map(clean))];
  return { must, mustNot, facts, urls: [...urls, ...bare], raw: String(text).slice(0, 600), at: new Date().toISOString() };
}


/* 合并/撤销（vh brief --amend）：用户中途改主意时，旧要求必须能被撤掉。
 * 真实场景：先说"简单点，只要链接和优惠码"，后说"算了，加上价格" ——
 * 如果不撤旧的 must-not，agent 会被两条互相矛盾的指令夹住，只能猜。 */
export function amend(prev, text) {
  const next = parseBrief(text);
  const out = prev ? JSON.parse(JSON.stringify(prev)) : { must: [], mustNot: [], facts: [], urls: [], raw: '', at: '' };
  out.must = out.must || []; out.mustNot = out.mustNot || []; out.facts = out.facts || []; out.urls = out.urls || [];

  // 1) 撤销：出现"算了/不用了/改成/不要…了"时，撤掉与新指令冲突的旧要求
  const revoke = /(算了|不用了|不要了|取消|改成|改为|还是|反过来|不限制)/.test(text);
  const wantPrice = /(加上|带上|写出|写上|补充?).{0,6}(价格|多少钱|费用|费率)|价格.{0,4}(也|要|写上)/.test(text);
  if (wantPrice) {
    out.mustNot = out.mustNot.filter(m => !/价格|费用|费率|长篇细节/.test(m));
    out.must = out.must.filter(m => !/只给/.test(m));
    if (!out.must.some(m => /价格/.test(m))) out.must.push('写出价格');
  }
  if (revoke && !wantPrice) {
    // 只撤"与新指令同类"的：新指令说不许 X，就撤掉旧的"必须 X"
    for (const m of next.mustNot) {
      const key = m.replace(/^不要/, '').trim();
      if (key) out.must = out.must.filter(x => !x.includes(key));
    }
  }

  // 2) 合并（去重）
  const merge = (a, b) => [...new Set([...(a || []), ...(b || [])])];
  out.must = merge(out.must, next.must);
  out.mustNot = merge(out.mustNot, next.mustNot);
  out.urls = merge(out.urls, next.urls);
  for (const f of next.facts) if (!out.facts.some(x => x.subject === f.subject)) out.facts.push(f);
  out.raw = [out.raw, text].filter(Boolean).join('\n---\n').slice(-1200);
  out.at = new Date().toISOString();
  out.amended = (out.amended || 0) + 1;

  // 3) 冲突检测：同一条既是"必须"又是"不许"
  out.conflicts = [];
  for (const m of out.must) {
    for (const n of out.mustNot) {
      const a = m.replace(/^(只给|必须|包含)/, '').trim();
      const b = n.replace(/^不要/, '').trim();
      if (a && b && (a.includes(b) || b.includes(a))) out.conflicts.push(`${m}  ⟷  ${n}`);
    }
  }
  return out;
}

export function save(project, brief) {
  fs.mkdirSync(path.join(project, 'out'), { recursive: true });
  fs.writeFileSync(BRIEF(project), JSON.stringify(brief, null, 2), 'utf8');
  return BRIEF(project);
}

export function load(project) {
  try { return JSON.parse(fs.readFileSync(BRIEF(project), 'utf8')); } catch { return null; }
}

/* 自检：产物里有没有违反 mustNot / 漏掉 must（只查能查的） */
export function selfCheck(project, brief) {
  const warns = [];
  if (!brief) return warns;
  const script = (() => { try { return fs.readFileSync(path.join(project, '脚本.md'), 'utf8'); } catch { return ''; } })();

  // must：链接/优惠码这类"必须出现"的，检查脚本里有没有
  for (const u of brief.urls || []) {
    const key = String(u).replace(/^https?:\/\//, '').split('/')[0];
    if (key && !script.includes(key)) warns.push(`要求里的链接「${key}」没出现在脚本里`);
  }
  for (const f of brief.facts || []) {
    const v = String(f.is || '').trim();
    if (v.length >= 2 && !script.includes(v)) warns.push(`你指明「${f.subject} 就是 ${v}」，但脚本里没出现「${v}」`);
  }
  // mustNot：不该出现的内容（保守：只看价格/费率这类明确被排除的）
  const noDetail = (brief.mustNot || []).some(x => /长篇细节|不要展开/.test(x));
  // 允许"只给链接和优惠码"时不出现价格：如果 must 里有"只给…码"，检查是否多写了价格
  const onlySimple = (brief.must || []).some(x => /只给.*(码|链接)/.test(x));
  if (onlySimple) {
    const priceHits = (script.match(/[¥￥]\s*\d+|\d+\s*元/g) || []).length;
    if (priceHits > 0) warns.push(`你要求"只给链接和优惠码"，但脚本里出现了 ${priceHits} 处价格`);
  }
  return warns;
}

export function report(brief) {
  if (!brief) return '还没有要求清单（vh brief "<你的指令>"）';
  const lines = ['要求清单（来自你的指令）'];
  if (brief.must.length) brief.must.forEach(m => lines.push('  ✓ 必须：' + m));
  if (brief.mustNot.length) brief.mustNot.forEach(m => lines.push('  ✗ 不许：' + m));
  if (brief.facts.length) brief.facts.forEach(f => lines.push(`  = 事实：${f.subject} 就是 ${f.is}`));
  if (brief.urls.length) brief.urls.forEach(u => lines.push('  ↗ 链接：' + u));
  if (!brief.must.length && !brief.mustNot.length && !brief.facts.length) lines.push('  （没抽出明确要求——可以写得更具体，如"简单点，只要链接和优惠码"）');
  if (brief.conflicts && brief.conflicts.length) {
    lines.push('');
    lines.push('  ⚠ 要求互相冲突（必须先定一个）：');
    for (const c of brief.conflicts) lines.push('     ' + c);
  }
  lines.push('');
  lines.push('  规则：用户明确给的内容优先于抓取结果；说"简单"就不许加戏。');
  return lines.join('\n');
}
