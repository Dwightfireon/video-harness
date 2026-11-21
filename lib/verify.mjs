/* lib/verify.mjs —— 换算验算（vh verify）
 *
 * 为什么需要：`vh concrete` 只能查"有没有换算"，查不出"换算算错了"。
 * 而算错比不算更糟——观众信了你给的那个体感数字，其实是错的。
 *
 * 实测抓到：comet 里写「三千零六十次 —— 相当于一年半的航班」。
 *   3060 ÷ 每天 3 班 = 1020 天 ≈ 2.8 年，不是一年半。差了一倍。
 *
 * 这个模块做的是**算术核对**：
 *   从句子解析出「原量 → 换算量 → 换算依据（每天几班/每班多久）」，然后真的算一遍。
 * 目前能算的三类（覆盖真实用法）：
 *   ① 次数 + 每天 N 次 → 年数
 *   ② 小时 / 分钟 → 天
 *   ③ 米 / 英尺 / 公里 互换
 * 算不了的就明说"这条无法验算"，不假装通过。
 */
import fs from 'node:fs';
import path from 'node:path';

/* ---------- 中文数字 ---------- */
const ZH_D = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ZH_U = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };
export function zh2num(s) {
  let tot = 0, sc = 0, cur = 0;
  for (const ch of String(s)) {
    if (ZH_D[ch] !== undefined) cur = ZH_D[ch];
    else if (ZH_U[ch] !== undefined) {
      const un = ZH_U[ch];
      if (un >= 10000) { sc = (sc + cur) * un; tot += sc; sc = 0; cur = 0; }
      else { if (cur === 0) cur = 1; sc += cur * un; cur = 0; }
    }
  }
  return tot + sc + cur;
}

/* 从一段文字里取第一个数（阿拉伯或中文），返回 {v, rest} */
function takeNum(text) {
  const ar = String(text).match(/(\d+(?:\.\d+)?)/);
  const zh = String(text).match(/([零一二三四五六七八九十百千两]+[万亿]?[零一二三四五六七八九十百千两]*)/);
  if (!ar && !zh) return null;
  if (ar && (!zh || ar.index <= zh.index)) return { v: +ar[1], raw: ar[1], kind: 'ar', at: ar.index };
  return { v: zh2num(zh[1]), raw: zh[1], kind: 'zh', at: zh.index };
}

function takeAllNums(text) {
  const out = [];
  const t = String(text);
  /* 中文数字必须**包含"万/亿"**，否则"一万六千"会被切成"六千"
     （真实 bug：16000 次被解析成 6000，于是"14 年"被误判成算错）。 */
  const re = /(\d+(?:\.\d+)?|[零一二三四五六七八九十百千两]+[万亿]?[零一二三四五六七八九十百千两]*)/g;
  for (const m of t.matchAll(re)) {
    const raw = m[1];
    if (!raw) continue;
    const v = /^\d/.test(raw) ? +raw : zh2num(raw);
    if (Number.isFinite(v) && v > 0) out.push({ v, raw, at: m.index });
  }
  return out;
}

/* ---------- ① 次数 + 每天 N 班 → 年数 ---------- */
function checkPerDay(text, defaultPerDay) {
  /* 例：「三千零六十次 —— 相当于一年半的航班」「每天飞三班、飞不到三年」
     ⚠ 真实漏报：S9 只写了「三千零六十次 —— 相当于一年半的航班」，没写"每天几班"，
     于是没被验算 —— 而那句其实是错的（3060÷3÷365 = 2.8 年，不是一年半）。
     修法：没写频率时，用全片出现过的最高频（脚本里说过"每天飞三班"）作为默认。 */
  if (!/(次)/.test(text)) return null;
  const perDay = text.match(/每天\s*(?:飞|跑|开|用)\s*([零一二三四五六七八九十几\d]+)\s*(?:班|次|趟)/);
  let nPerDay;
  if (perDay) nPerDay = /^\d+$/.test(perDay[1]) ? +perDay[1] : zh2num(perDay[1]);
  else if (defaultPerDay) nPerDay = defaultPerDay;
  else return null;
  if (!nPerDay) return null;

  /* 原量：句中最靠前的"次数"，但要排除"每天飞三班"里的那个数字 */
  const perDayAt = perDay ? text.indexOf(perDay[0]) : text.search(/(相当于|也就是|等于)/);
  const before = text.slice(0, perDayAt);
  const nums = takeAllNums(before).filter(x => x.v >= 100);
  if (!nums.length) return null;
  const total = nums[nums.length - 1].v;    // 取最靠近"每天"的那个大数

  /* 结论：年 / 月 / 天 */
  const after = text.slice(perDayAt);
  const years = after.match(/([零一二三四五六七八九十百千两\d.]+)\s*年(半)?/);
  const days = after.match(/([零一二三四五六七八九十百千两\d.]+)\s*天/);
  const months = after.match(/([零一二三四五六七八九十百千两\d.]+)\s*个月/);

  const realYears = total / nPerDay / 365;
  const realDays = total / nPerDay;

  let claimed = null, unit = null;
  if (years) {
    let v = /^\d/.test(years[1]) ? +years[1] : zh2num(years[1]);
    if (years[2]) v += 0.5;
    claimed = v; unit = '年';
  } else if (months) {
    let v = /^\d/.test(months[1]) ? +months[1] : zh2num(months[1]);
    claimed = v / 12; unit = '个月';
  } else if (days) {
    let v = /^\d/.test(days[1]) ? +days[1] : zh2num(days[1]);
    claimed = v / 365; unit = '天';
  }
  if (claimed == null) return null;
  return {
    kind: 'per-day',
    total, perDay: nPerDay,
    real: realYears, claimed,
    unit,
    detail: `${total} 次 ÷ 每天 ${nPerDay} 次 = ${realDays.toFixed(0)} 天 ≈ ${realYears.toFixed(1)} 年`,
  };
}

/* ---------- ② 英尺 ↔ 米 ---------- */
function checkFeet(text) {
  /* ⚠ 中文数字必须从**最靠前的数字起点**开始匹配。
     真实 bug：「三万七千英尺」被切成了「七千英尺」→ 算成 2.1 公里（实际 11 公里）。
     修法：用 takeAllNums 取所有数字，取紧挨着"英尺"前的那一个**完整中文数**。 */
  const ftAll = takeAllNums(text);
  const ftIdx = text.search(/(?:英尺|ft)/);
  if (ftIdx < 0) return null;
  /* 找"英尺"之前、离它最近的那个数字，且它后面紧跟"英尺" */
  const cand = ftAll.filter(n => n.at < ftIdx && text.slice(n.at + n.raw.length, ftIdx).replace(/\s/g, '') === '');
  if (!cand.length) return null;
  const ftV = cand[cand.length - 1].v;
  const m = text.match(/([零一二三四五六七八九十百千两\d.]+)\s*公里/);
  if (!m) return null;
  let mV = /^\d/.test(m[1]) ? +m[1] : zh2num(m[1]);
  const realKm = ftV * 0.3048 / 1000;
  return {
    kind: 'feet', from: ftV, unitFrom: '英尺',
    real: realKm, claimed: mV, unit: '公里',
    detail: `${ftV} 英尺 × 0.3048 = ${(ftV * 0.3048).toFixed(0)} 米 ≈ ${realKm.toFixed(1)} 公里`,
  };
}

/* ---------- ③ 小时 → 天 ---------- */
function checkHoursToDays(text) {
  const h = text.match(/([零一二三四五六七八九十百千两\d.]+)\s*小时/);
  const d = text.match(/([零一二三四五六七八九十百千两\d.]+)\s*天/);
  if (!h || !d) return null;
  let hv = /^\d/.test(h[1]) ? +h[1] : zh2num(h[1]);
  let dv = /^\d/.test(d[1]) ? +d[1] : zh2num(d[1]);
  if (!hv || !dv) return null;
  return {
    kind: 'hours', from: hv, unitFrom: '小时',
    real: hv / 24, claimed: dv, unit: '天',
    detail: `${hv} 小时 ÷ 24 = ${(hv / 24).toFixed(1)} 天`,
  };
}

/* ---------- 主流程 ---------- */
export function analyze(project, opt = {}) {
  const md = (() => { try { return fs.readFileSync(path.join(project, '脚本.md'), 'utf8'); } catch { return ''; } })();
  if (!md) return { ok: true, checks: [], findings: [], note: '没有 脚本.md' };

  const scenes = [];
  let cur = null;
  for (const raw of md.split('\n')) {
    const h = raw.match(/^##\s*S(\d+)\s*[·•\-—]?\s*(.*)$/);
    if (h) { cur = { n: +h[1], lines: [] }; scenes.push(cur); continue; }
    if (/^##\s/.test(raw)) { cur = null; continue; }
    const lm = raw.match(/^\s*\d+[.、)]\s*(.+)$/);
    if (cur && lm) cur.lines.push(lm[1].trim());
  }

  /* 全片默认频率：脚本里说过的"每天飞 N 班"（用于没写频率的换算句） */
  const perDayM = md.match(/每天\s*(?:飞|跑|开|用)\s*([零一二三四五六七八九十几\d]+)\s*(?:班|次|趟)/);
  const defaultPerDay = perDayM ? (/^\d+$/.test(perDayM[1]) ? +perDayM[1] : zh2num(perDayM[1])) : null;

  const checks = [];
  for (const sc of scenes) {
    for (const l of sc.lines) {
      const r1 = checkPerDay(l, defaultPerDay);
      const r2 = checkFeet(l);
      const r3 = checkHoursToDays(l);
      for (const r of [r1, r2, r3]) if (r) checks.push({ scene: sc.n, line: l, ...r });
    }
  }

  const findings = [];
  for (const c of checks) {
    /* 容忍 25%（口播允许取整，但不能差一倍） */
    const off = c.real === 0 ? 1 : Math.abs(c.claimed - c.real) / Math.abs(c.real);
    c.off = Math.round(off * 100) / 100;
    c.ok = off <= 0.25;
    if (!c.ok) {
      findings.push({
        kind: 'miscalc',
        scene: c.scene,
        msg: `第 ${c.scene} 场的换算算错了：说「${c.claimed} ${c.unit}」，实际是 ${c.real.toFixed(1)} ${c.unit}（差 ${Math.round(off * 100)}%）`,
        fix: `验算：${c.detail}。改口播或改数字，以验算结果为准。`,
      });
    }
  }

  return {
    ok: findings.length === 0,
    checks, findings,
    verified: checks.length,
    passed: checks.filter(c => c.ok).length,
  };
}

export function report(res) {
  if (res.note) return res.note;
  const lines = ['换算验算（"相当于…"到底算对没有）', ''];
  if (!res.checks.length) {
    lines.push('  （没有可验算的换算，或换算类型还不在支持范围）');
    lines.push('');
    lines.push('  能验算的三类：次数÷每天N次→年数 / 英尺→公里 / 小时→天');
    lines.push('  其余换算（如"游泳池""埃菲尔铁塔"）无法机械验算，需要人核。');
    return lines.join('\n');
  }
  lines.push(`  可验算 ${res.verified} 条，通过 ${res.passed} 条`);
  lines.push('');
  lines.push('  场次  结论  说法            实际      算式');
  for (const c of res.checks) {
    const m = c.ok ? ' ✓ ' : ' ✗ ';
    const claim = `${c.claimed}${c.unit}`;
    const real = `${c.real.toFixed(1)}${c.unit}`;
    lines.push(`  S${String(c.scene).padStart(2)} ${m} ${claim.padEnd(12)} ${real.padEnd(9)} ${c.detail}`);
  }
  lines.push('');
  if (!res.findings.length) {
    lines.push('✓ 所有可验算的换算都对');
  } else {
    for (const f of res.findings) {
      lines.push(`⚠ ${f.msg}`);
      if (f.fix) lines.push(`   → ${f.fix}`);
    }
  }
  lines.push('');
  lines.push('口径：口播允许 25% 以内的取整误差；超过就是算错，不是"大约"。');
  return lines.join('\n');
}
