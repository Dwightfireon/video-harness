/* lib/subtitle.mjs —— 字幕断行 + 正文让位（vh subtitle）
 *
 * 两个真实问题：
 *   ① 断行位置由浏览器随手决定：中文断在"的/了/和"前面、英文断在单词中间，
 *      观众读起来会卡。字幕要按语义断（标点优先，再无标点均分）。
 *   ② 字幕一变两行就往上长，压住正文最后一行（竖屏尤其明显）。
 *      正文的安全区必须按"这一场最长的那句字幕"算，不能按固定比例。
 *
 * 这个模块提供：
 *   · breakLine(text, maxChars, maxLines)：无损语义断行（行数目标不能删字）
 *   · worseCaseSubs(project)：每场"最长字幕"是几行 → 正文该让多少
 *   · fitPlan(project)：每场安全区底边（渲染前就能算，不用截图）
 */
import fs from 'node:fs';
import path from 'node:path';

/* 只替换已知有截字缺陷的字幕块，不覆盖作者主题、场景或其他 FX 修改。 */
export function repairSubtitleTemplate(project, fxBlock) {
  const file = path.join(project, 'engine.tpl.html');
  if (!fs.existsSync(file)) return { changed: false };
  const source = fs.readFileSync(file, 'utf8');
  const first = 'function subtitleBreaker(maxW) {';
  const last = 'window.VH_UI = Object.assign(window.VH_UI || {}, { subtitleBreaker });';
  const a = source.indexOf(first), b = source.indexOf(last, a);
  if (a < 0 || b < 0) return { changed: false };
  const old = source.slice(a, b + last.length);
  if (old.includes('patched.__lossless = true;')) return { changed: false };
  if (!old.includes('if (lines.length >= 2) break;') || !old.includes('return lines.slice(0, 2);')) {
    return { changed: false, note: '自定义字幕实现，未自动覆盖' };
  }
  const x = fxBlock.indexOf(first), y = fxBlock.indexOf(last, x);
  if (x < 0 || y < 0 || !fxBlock.slice(x, y).includes('patched.__lossless = true;')) throw new Error('无损字幕补丁不完整');
  const backup = file + '.bak-subtitles-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(file, source.slice(0, a) + fxBlock.slice(x, y + last.length) + source.slice(b + last.length));
  return { changed: true, backup };
}

/* 中文标点的断行优先级：句末 > 逗顿 > 连接词前 > 均分 */
const STRONG = /[。！？；]/;
const WEAK = /[，、：,;]/;
/* 不能出现在行首的字符（标点/"的"类结尾词） */
const NO_LINE_START = /^[，。、；：！？,.;:!?）】」』"'”’]/;

/* 视觉宽度：中文/全角算 1，ASCII 算 0.55（比按字符数断准得多） */
export function vwidth(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    n += (c >= 0x2e80 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef) ? 1 : 0.55;
  }
  return n;
}

/* 断行：maxW 是"视觉宽度"预算（不是字符数）
 * 规则（按优先级）：句末标点 → 逗顿标点 → 空格 → 均分；
 * 英文词不拆开（PostgreSQL 不会被切成 Postgre+SQL）；标点不落行首。 */
export function breakLine(text, maxW = 18, maxLines = 2) {
  if (!(maxW > 0) || !Number.isFinite(maxW)) throw new Error('字幕宽度必须为有限正数');
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return [];
  if (vwidth(s) <= maxW) return [s];

  /* 切成不可分单元：英文词/数字串 是一块；中文一字一块；空格一块 */
  const units = [];
  for (const m of s.matchAll(/[A-Za-z0-9][A-Za-z0-9.\-/%]*|\s+|./gu)) units.push(m[0]);

  const lines = [];
  let cur = '';
  const flush = (cutAt) => {
    let line = cur.slice(0, cutAt);
    let rest = cur.slice(cutAt);
    while (rest && NO_LINE_START.test(rest[0])) { line += rest[0]; rest = rest.slice(1); }
    lines.push(line.trim());
    cur = rest;
  };
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    // 单个单元就超预算（超长英文词）：只能硬切
    if (vwidth(u) > maxW) {
      if (cur.trim()) flush(cur.length);
      let restU = u;
      while (vwidth(restU) > maxW) {
        let k = 1;
        while (k < restU.length && vwidth(restU.slice(0, k + 1)) <= maxW) k++;
        lines.push(restU.slice(0, k));
        restU = restU.slice(k);
      }
      cur = restU;
      continue;
    }
    if (vwidth(cur + u) <= maxW) { cur += u; continue; }
    /* 放不下了：在**整行**里找最好的断点（不能只看末尾 6–8 字：
       真实事故——"…不在快，在于它把接口" 的逗号在倒数第 7 个字，窗口太窄所以没找到，
       结果硬切成 "FastAPI" / "的价值不在快，在于它把接口…"，读起来是断的）。 */
    let cut = cur.length;
    const pickLast = (re) => {
      for (let k = cur.length - 1; k >= 1; k--) if (re.test(cur[k])) return k + 1;
      return -1;
    };
    // 标点太靠前（切完剩不下几个字）也不好，至少留 1/3 行长
    const minCut = Math.max(2, Math.floor(cur.length / 3));
    let c1 = pickLast(STRONG); if (c1 >= minCut) cut = c1;
    if (cut === cur.length) { const c2 = pickLast(WEAK); if (c2 >= minCut) cut = c2; }
    if (cut === cur.length) {
      const sp = cur.lastIndexOf(' ');
      if (sp >= minCut) cut = sp + 1;
    }
    if (cut === cur.length && lines.length >= 0) {
      // 没有标点/空格：把即将加入的英文词整体挪到下一行；中文则硬切
      if (/^[A-Za-z0-9]/.test(u)) {
        const w = cur.match(/[A-Za-z0-9][A-Za-z0-9.\-/%]*$/);
        if (w) cut -= w[0].length;
      }
    }
    if (cut <= 0) cut = cur.length;
    flush(cut);
    cur += u;
  }
  if (cur.trim()) {
    lines.push(cur.trim());
  }
  // maxLines 是排版目标，不是删字许可。超目标必须完整返回，让检查器报告让位。
  return lines.filter(Boolean);
}

/* 从 scene.html 读 SUBS，算每场最长字幕是几行 */
export function sceneSubs(project, maxW = 18) {
  const html = (() => { try { return fs.readFileSync(path.join(project, 'scene.html'), 'utf8'); } catch { return ''; } })();
  const subs = [...html.matchAll(/"s":\s*([\d.]+),\s*"e":\s*([\d.]+),\s*"t":\s*"((?:[^"\\]|\\.)*)"/g)]
    .map(m => ({ s: +m[1], e: +m[2], t: JSON.parse(`"${m[3]}"`) }));
  const ranges = [...html.matchAll(/addScene\(\s*([\d.]+)\s*,\s*([\d.]+)/g)].map(m => [+m[1], +m[2]]);
  return { subs, ranges };
}

/* 每场：最长字幕的行数 + 字幕条往上顶了多少（正文要让位的像素） */
export function fitPlan(project, opt = {}) {
  const { subs, ranges } = sceneSubs(project, opt.maxW);
  const html = (() => { try { return fs.readFileSync(path.join(project, 'scene.html'), 'utf8'); } catch { return ''; } })();
  const H = +(html.match(/const W = P0\.W, H = P0\.H/) ? 0 : 0) || 0;
  // 从引擎常量读：字幕字号/最大宽/底部间距
  /* 字幕参数也要按 ORIENT 取：PRESET 里两套（横屏 subFont 40 / 竖屏 34）
     ⚠ 只抓第一个匹配会永远取到横屏那套（真实事故：竖屏 perLine 算成 37） */
  const orient = (html.match(/const ORIENT = '(landscape|portrait)'/) || [])[1] || 'landscape';
  const presetBlock = html.slice(html.indexOf('const PRESET = {'));
  const seg = presetBlock.slice(presetBlock.indexOf('\n  ' + orient + ':'), presetBlock.indexOf('\n  }', presetBlock.indexOf('\n  ' + orient + ':')));
  const subFont = +(seg.match(/subFont:\s*(\d+)/) || [])[1] || 40;
  const subMaxW = +(seg.match(/subMaxW:\s*(\d+)/) || [])[1] || 1560;
  const subBottom = +(seg.match(/subBottom:\s*(\d+)/) || [])[1] || 52;
  const W = +(seg.match(/W:\s*(\d+)/) || [])[1] || 1920;
  const H2 = +(seg.match(/H:\s*(\d+)/) || [])[1] || 1080;

  // 每行能放多少视觉宽度：subMaxW / subFont（扣掉 padding 40*2）
  const perLine = Math.max(1, Math.floor((subMaxW - 82) / subFont) - 1);

  const out = [];
  for (let i = 0; i < ranges.length; i++) {
    const [a, b] = ranges[i];
    const inScene = subs.filter(s => s.s >= a - 0.3 && s.s < b + 0.3);
    let worst = 1, worstText = '';
    for (const s of inScene) {
      const lines = breakLine(s.t, perLine, 3);
      if (lines.length > worst) { worst = lines.length; worstText = s.t; }
    }
    const lineH = Math.round(subFont * 1.35);
    const boxH = worst * lineH + 40;                    // padding 20*2
    const boxTop = H2 - subBottom - boxH;
    out.push({
      n: i + 1, start: a, end: b,
      subs: inScene.length,
      lines: worst, worstText,
      subTop: Math.round(boxTop),
      safeBottom: Math.round(boxTop - 16),               // 正文底边要在这之上
      lineH, perLine,
    });
  }
  return { scenes: out, perLine, subFont, subMaxW, subBottom, W, H: H2 };
}

export function report(plan) {
  const lines = ['字幕断行与正文让位（按每场最长的字幕算，不按固定比例）', ''];
  lines.push(`每行可放 ${plan.perLine} 个中文字（字幕最大宽 ${plan.subMaxW} − 内边距，字号 ${plan.subFont}）`);
  lines.push('');
  lines.push('  场次  字幕条数  最多行数  字幕顶边  正文底边应 ≤');
  for (const s of plan.scenes) {
    lines.push(`  S${String(s.n).padStart(2)}   ${String(s.subs).padStart(6)}  ${String(s.lines).padStart(7)}  ${String(s.subTop).padStart(7)}px  ${String(s.safeBottom).padStart(9)}px`);
  }
  const worst = plan.scenes.reduce((a, b) => (a.safeBottom <= b.safeBottom ? a : b), plan.scenes[0] || { safeBottom: 0 });
  if (plan.scenes.length) {
    lines.push('');
    lines.push(`全片最紧的一场是 S${worst.n}（正文底边不能超过 ${worst.safeBottom}px）`);
    if (worst.lines >= 3) lines.push(`⚠ S${worst.n} 的字幕到 ${worst.lines} 行 —— 「${String(worst.worstText).slice(0, 30)}…」；` +
      `   要么把这句话拆短，要么把这一场正文再上移。`);
  }
  lines.push('');
  lines.push('用法：场景里用 VH_UI.safeArea() 拿安全区（它已扣掉字幕区），别写死比例。');
  return lines.join('\n');
}
