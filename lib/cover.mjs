/* lib/cover.mjs —— 封面生成（vh cover）
 *
 * 为什么需要：你发布 5 支片子，封面全是手工截图裁的。
 * 这里按 发布文案.md 的「封面文案」+ 成片关键帧，生成三个平台比例的封面：
 *   16:9（B站/YouTube）、4:3（公众号/知乎）、3:4（小红书/抖音）
 *
 * 做法：Playwright 渲染一张 HTML（默认高反差深色编辑部海报排版；--style frame 叠加成片抽帧），截图导出。
 * 全部确定性：同一输入必得同一张图。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { publishInputs } from './publish.mjs';
import { assetInputs } from './asset-inputs.mjs';

const RATIOS = {
  '16x9': { w: 1920, h: 1080, label: 'B站 / YouTube' },
  '4x3': { w: 1600, h: 1200, label: '公众号 / 知乎' },
  '3x4': { w: 1080, h: 1440, label: '小红书 / 抖音' },
};

/* 绝不自动强调的虚词/铺垫词/壳词：避免「放大了不该强调的对象」。 */
const WEAK_EMPHASIS_WORDS = new Set([
  '为什么', '为何', '怎么', '怎样', '如何', '其实', '背后', '关于',
  '这个', '那个', '这些', '那些', '是否', '到底', '究竟', '竟然',
  '居然', '原来', '真的', '确实', '视频', '一期', '本期', '深度',
  '解析', '揭秘', '真相', '盘点', '科普', '讲解', '分析', '看看',
  '告诉', '大家', '我们', '你们', '他们', '它们', '这里', '那里',
  '一个', '一种', '问题', '原因', '事情', '东西', '时候', '今天',
  '一下', '一起', '开始', '结束', '因为', '所以', '但是', '不过',
]);

/* 从 发布文案.md 抽封面文案：主 / 副（以及可选的 强调 / 角标）。
 * 兼容旧契约：未写 强调 / 角标 时仅返回 { main, sub }，避免旧清单无故失效。 */
export function parseCoverCopy(md) {
  const out = { main: '', sub: '' };
  if (!md) return out;
  let cur = null;
  let emphasis = '';
  let kicker = '';
  for (const raw of md.split('\n')) {
    const h = raw.match(/^##\s*(.+?)\s*$/);
    if (h) { cur = /封面/.test(h[1]) ? 'cover' : null; continue; }
    if (cur !== 'cover') continue;
    const m = raw.match(/^\s*(主|副|强调|重点|角标|眉标)\s*[：:]\s*(.+)$/);
    if (!m) continue;
    const key = m[1], val = m[2].trim();
    if (key === '主') out.main = val;
    else if (key === '副') out.sub = val;
    else if (key === '强调' || key === '重点') emphasis = val;
    else if (key === '角标' || key === '眉标') kicker = val;
  }
  if (emphasis) out.emphasis = emphasis;
  if (kicker) out.kicker = kicker;
  return out;
}

export function stripEmphasis(text) {
  return String(text || '').replace(/\*\*([^*\n]+?)\*\*/g, '$1').trim();
}

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function countVisibleChars(s) {
  return String(s || '').replace(/[\s/｜|·•，。！？：:；;、“”"'「」『』()（）【】[\]\-—_]/g, '').length;
}

export function isWeakEmphasis(token) {
  const cleaned = String(token || '').replace(/^[\s「」『』“”"'()（）【】[\]]+|[\s「」『』“”"'()（）【】[\]]+$/g, '').trim();
  if (!cleaned) return true;
  if (WEAK_EMPHASIS_WORDS.has(cleaned)) return true;
  if (/^[的了吗呢啊吧在是有被把给和与或及跟都也却就才还再又很太更最]+$/.test(cleaned)) return true;
  // 单字除非带数字/符号（如 0、3×），否则不作为自动强调词
  if (countVisibleChars(cleaned) < 2 && !/\d/.test(cleaned)) return true;
  return false;
}

function splitTitleLines(raw) {
  const normalized = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [''];
  // 支持显式换行或用 `/` / `｜` 分行（排除数字比值如 16/9、24/7）
  const lines = normalized.split('\n').flatMap(line =>
    line.split(/\s*(?:｜|(?<!\d)\/(?!\d))\s*/).map(s => s.trim()).filter(Boolean)
  );
  return lines.length ? lines : [normalized];
}

function highlightInPlainLine(line, targets) {
  if (!targets.length) return esc(line);
  const ranges = [];
  for (const term of targets) {
    if (!term) continue;
    let from = 0;
    while (from < line.length) {
      const idx = line.indexOf(term, from);
      if (idx < 0) break;
      const end = idx + term.length;
      if (!ranges.some(r => idx < r.end && end > r.start)) {
        ranges.push({ start: idx, end });
        break; // 每个目标词在一行内最多高亮一次，避免重复喧宾夺主
      }
      from = end;
    }
  }
  if (!ranges.length) return esc(line);
  ranges.sort((a, b) => a.start - b.start);
  let html = '';
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) html += esc(line.slice(cursor, r.start));
    html += `<em class="hl">${esc(line.slice(r.start, r.end))}</em>`;
    cursor = r.end;
  }
  if (cursor < line.length) html += esc(line.slice(cursor));
  return html;
}

/* 两行主标题自动建立「铺垫行（line-setup）→ 爆点主行（line-hero）」字阶落差，
 * 避免上下两行等大堆砌、像两块砖头一样平淡。 */
function wrapLinesWithHierarchy(renderedLines) {
  if (renderedLines.length !== 2) {
    return renderedLines.map(html => `<span class="line line-hero">${html}</span>`).join('');
  }
  const hasHl = renderedLines.map(html => html.includes('<em class="hl">'));
  // 若仅第 1 行有焦点，第 1 行为主行、第 2 行为承接；其余情况默认第 1 行铺垫、第 2 行爆点
  const heroIdx = hasHl[0] && !hasHl[1] ? 0 : 1;
  return renderedLines
    .map((html, idx) => `<span class="line ${idx === heroIdx ? 'line-hero' : 'line-setup'}">${html}</span>`)
    .join('');
}

/* 封面主标题语义强调解析：
 * 1) 优先尊重作者显式标注的 `**重点词**`（最多 2 处，且防整句标满）；
 * 2) 其次使用独立字段 `强调：…` 在主标题中的精确匹配；
 * 3) 都未指定时，仅对高置信度的量化数字/引号核心词做克制高亮；
 *    绝不把虚词/铺垫词瞎放大，没把握时保持平衡层级。 */
export function formatCoverTitle(main, { emphasis = '' } = {}) {
  const raw = String(main || '').trim();
  const plainFull = stripEmphasis(raw);
  const totalChars = Math.max(1, countVisibleChars(plainFull));
  const rawLines = splitTitleLines(raw);

  // 1) 显式 `**...**` 标注
  const inlineMatches = [...raw.matchAll(/\*\*([^*\n]+?)\*\*/g)].map(m => m[1].trim()).filter(Boolean);
  if (inlineMatches.length) {
    const valid = inlineMatches.filter(t => !isWeakEmphasis(t)).slice(0, 2);
    const covered = valid.reduce((sum, t) => sum + countVisibleChars(t), 0);
    if (valid.length && covered / totalChars <= 0.68) {
      let used = 0;
      const renderedLines = rawLines.map(line => {
        let out = '';
        let last = 0;
        for (const m of line.matchAll(/\*\*([^*\n]+?)\*\*/g)) {
          const text = m[1].trim();
          out += esc(line.slice(last, m.index));
          if (used < 2 && valid.includes(text)) {
            out += `<em class="hl">${esc(text)}</em>`;
            used++;
          } else {
            out += esc(text);
          }
          last = m.index + m[0].length;
        }
        out += esc(line.slice(last));
        return out;
      });
      return {
        html: wrapLinesWithHierarchy(renderedLines),
        plain: rawLines.map(stripEmphasis).join('\n'),
        highlights: valid,
        mode: 'explicit-inline',
      };
    }
  }

  const plainLines = rawLines.map(stripEmphasis);

  // 2) 独立 `强调：…` 字段
  if (emphasis && String(emphasis).trim()) {
    const terms = String(emphasis)
      .split(/[、,，/｜|]+/)
      .map(s => stripEmphasis(s))
      .filter(t => t && !isWeakEmphasis(t) && plainFull.includes(t))
      .slice(0, 2);
    const covered = terms.reduce((sum, t) => sum + countVisibleChars(t), 0);
    if (terms.length && covered / totalChars <= 0.68) {
      return {
        html: wrapLinesWithHierarchy(plainLines.map(l => highlightInPlainLine(l, terms))),
        plain: plainLines.join('\n'),
        highlights: terms,
        mode: 'explicit-field',
      };
    }
  }

  // 3) 高置信度克制兜底：仅高亮引号内短语或带单位的醒目量化数字，绝不乱猜虚词
  const autoCandidates = [];
  const quoteMatch = plainFull.match(/[「“]([^」”\n]{2,8})[」”]/);
  if (quoteMatch && !isWeakEmphasis(quoteMatch[1])) {
    autoCandidates.push(quoteMatch[1]);
  }
  if (!autoCandidates.length) {
    const numRe = /(?:\d+(?:\.\d+)?\s*(?:(?:万亿|亿|万|千|百)(?:%|倍|元|美元|刀|星|天|小时|分钟|秒|年|个月|次|个|条|家|款|代)?|(?:%|倍|元|美元|刀|星|天|小时|分钟|秒|年|个月|次|个|条|家|款|代|nm|GB|TB|MB|K|M|B|×))|[$¥€]\s*\d+(?:\.\d+)?)/i;
    const numMatch = plainFull.match(numRe);
    if (numMatch && countVisibleChars(numMatch[0]) / totalChars <= 0.55) {
      autoCandidates.push(numMatch[0]);
    }
  }

  if (autoCandidates.length) {
    return {
      html: wrapLinesWithHierarchy(plainLines.map(l => highlightInPlainLine(l, autoCandidates))),
      plain: plainLines.join('\n'),
      highlights: autoCandidates,
      mode: 'auto-signal',
    };
  }

  // 无高置信度词时：保持克制均衡的编辑部层级，不盲目放大任何词
  return {
    html: wrapLinesWithHierarchy(plainLines.map(l => esc(l))),
    plain: plainLines.join('\n'),
    highlights: [],
    mode: 'balanced',
  };
}

/* 副标题渲染：若为 `A · B · C` 短标签组，渲染为高可读标签胶囊；否则渲染为带竖线引导的副标。 */
export function formatCoverSub(sub) {
  const clean = stripEmphasis(sub);
  if (!clean) return { html: '', isChips: false };
  const parts = clean.split(/\s*[·•｜|]\s*/).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2 && parts.length <= 4 && parts.every(p => p.length <= 16)) {
    const chips = parts.map(p => `<span class="sub-chip">${esc(p)}</span>`).join('');
    return { html: `<p class="sub sub-chips">${chips}</p>`, isChips: true };
  }
  return { html: `<p class="sub sub-line">${esc(clean)}</p>`, isChips: false };
}

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function relativeLuminance([r, g, b]) {
  const f = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/* 深色海报底上自动提亮偏暗的项目强调色（保留原色相），保证对比度 ≥ 7:1 且通透高级。 */
export function liftAccentForDark(hex, fallback = '#F28C63') {
  const rgb = hexToRgb(hex);
  if (!rgb) return fallback;
  if (relativeLuminance(rgb) >= 0.34) return rgbToHex(rgb);
  let [r, g, b] = rgb;
  for (let i = 0; i < 12 && relativeLuminance([r, g, b]) < 0.38; i++) {
    r = r + (255 - r) * 0.22;
    g = g + (255 - g) * 0.22;
    b = b + (255 - b) * 0.22;
  }
  return rgbToHex([r, g, b]);
}

function rgba(hex, alpha, fallback = `rgba(242,140,99,${alpha})`) {
  const rgb = hexToRgb(hex);
  return rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})` : fallback;
}

/* 封面沿用项目强调色：保留项目色相，再按深色海报底自动提亮以保证高反差。 */
function projectTheme(project) {
  try {
    const tpl = fs.readFileSync(path.join(project, 'engine.tpl.html'), 'utf8');
    const m = tpl.match(/--accent\s*:\s*(#[0-9a-fA-F]{6})/);
    return { accent: m ? m[1] : '' };
  } catch {
    return { accent: '' };
  }
}

export function buildHtml({
  ratio,
  bg = '',
  main,
  sub = '',
  brand = '',
  kicker = '',
  emphasis = '',
  style = 'editorial',
  accent = '',
}) {
  if (!Object.hasOwn(RATIOS, ratio) || !['editorial', 'frame'].includes(style)) throw new Error('未知封面比例或样式');
  const { w, h } = RATIOS[ratio];
  const isPortrait = h > w;
  const title = formatCoverTitle(main, { emphasis });
  const subBlock = formatCoverSub(sub);
  const ACC = liftAccentForDark(accent, '#F28C63');

  if (style === 'editorial') {
    const padX = isPortrait ? 88 : Math.round(w * 0.084);
    const padRight = isPortrait ? 88 : Math.round(w * 0.14);
    const topY = isPortrait ? 88 : 80;
    const baseFont = isPortrait ? 124 : (w > 1600 ? 176 : 152);
    const subFont = isPortrait ? 40 : (w > 1600 ? 44 : 40);

    return `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      html,body{width:${w}px;height:${h}px;overflow:hidden;background:#0F1312}
      .wrap{position:relative;width:${w}px;height:${h}px;overflow:hidden;color:#F7F6F1;
        background:linear-gradient(135deg, #101514 0%, #151C1A 56%, #0D1110 100%)}
      .canvas-glow{position:absolute;inset:0;background:
        radial-gradient(circle at ${isPortrait ? '86% 14%' : '90% 18%'}, ${rgba(ACC, 0.24)} 0%, transparent 48%),
        radial-gradient(circle at 12% 92%, ${rgba(ACC, 0.09)} 0%, transparent 44%)}
      .canvas-grid{position:absolute;inset:0;
        background-image:radial-gradient(rgba(255,255,255,.055) 1.3px, transparent 1.3px);
        background-size:34px 34px}
      .spine{position:absolute;left:0;top:0;bottom:0;width:${isPortrait ? 14 : 16}px;
        background:linear-gradient(180deg, ${ACC} 0%, ${rgba(ACC, 0.28)} 100%)}
      .side-panel{position:absolute;right:-6%;top:-8%;width:${isPortrait ? '44%' : '34%'};height:116%;
        background:linear-gradient(160deg, rgba(255,255,255,.045) 0%, rgba(255,255,255,.01) 100%);
        border-left:1px solid rgba(255,255,255,.08);transform:skewX(-10deg);pointer-events:none}
      .deco-art{position:absolute;right:${isPortrait ? '-70px' : '-10px'};top:${isPortrait ? '4%' : '8%'};
        width:${isPortrait ? 440 : 540}px;height:${isPortrait ? 440 : 540}px;pointer-events:none;opacity:.22}
      .topbar{position:absolute;left:${padX}px;right:${padX}px;top:${topY}px;display:flex;align-items:center;gap:22px}
      .kicker{display:inline-flex;align-items:center;gap:14px;padding:12px 26px;border-radius:999px;
        background:${rgba(ACC, 0.14)};border:1.5px solid ${rgba(ACC, 0.42)};
        font:700 ${isPortrait ? 30 : 32}px/1 "PingFang SC","Hiragino Sans GB",sans-serif;letter-spacing:.10em;color:${ACC}}
      .kicker-dot{width:12px;height:12px;border-radius:50%;background:${ACC};box-shadow:0 0 12px ${rgba(ACC, 0.85)};flex-shrink:0}
      .top-rule{flex:1;height:1px;background:linear-gradient(90deg, rgba(255,255,255,.18) 0%, transparent 100%)}
      .brand{font:600 ${isPortrait ? 26 : 26}px/1 "SF Mono",Menlo,"PingFang SC",sans-serif;letter-spacing:.12em;color:rgba(247,246,241,.58)}
      .content{position:absolute;left:${padX}px;right:${padRight}px;top:${isPortrait ? 19 : 18}%;bottom:${isPortrait ? 13 : 14}%;
        display:flex;flex-direction:column;justify-content:center}
      .content>*{flex-shrink:0}
      h1{font-family:"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Source Han Sans SC",sans-serif;
        font-size:${baseFont}px;line-height:1.14;font-weight:900;letter-spacing:-.028em;color:#F7F6F1;
        white-space:pre-line;text-wrap:balance;overflow-wrap:anywhere}
      h1 .line{display:block}
      h1 .line-setup{font-size:0.56em;font-weight:600;line-height:1.3;letter-spacing:.01em;color:rgba(247,246,241,.74);margin-bottom:0.26em}
      h1 .line-hero{font-size:1em;font-weight:900;line-height:1.12;letter-spacing:-.03em;color:#FFFFFF}
      /* 零水平内边距：严格保证多行左边缘像素级对齐，不出现左缩进错位 */
      h1 em.hl{font-style:normal;font-weight:900;color:${ACC};
        box-shadow:inset 0 -0.14em 0 ${rgba(ACC, 0.28)};
        box-decoration-break:clone;-webkit-box-decoration-break:clone}
      p.sub{margin-top:${isPortrait ? 52 : 48}px;font-family:"PingFang SC","Hiragino Sans GB",sans-serif;
        font-size:${subFont}px;line-height:1.4;font-weight:600;color:rgba(247,246,241,.86);overflow-wrap:anywhere}
      p.sub-line{padding-left:24px;border-left:5px solid ${ACC};white-space:pre-line}
      p.sub-chips{display:flex;flex-wrap:wrap;gap:16px;align-items:center}
      .sub-chip{display:inline-flex;align-items:center;padding:12px 26px;border-radius:12px;
        background:rgba(255,255,255,.08);border:1.5px solid rgba(255,255,255,.16);
        color:rgba(247,246,241,.92);font-weight:600;line-height:1.2}
    </style></head><body><div class="wrap">
      <div class="canvas-glow"></div>
      <div class="canvas-grid"></div>
      <div class="spine"></div>
      <div class="side-panel"></div>
      <svg class="deco-art" viewBox="0 0 400 400" fill="none" aria-hidden="true">
        <circle cx="240" cy="180" r="146" stroke="${ACC}" stroke-width="1.5"/>
        <circle cx="240" cy="180" r="96" stroke="${ACC}" stroke-width="1" stroke-dasharray="6 9"/>
        <line x1="70" y1="180" x2="390" y2="180" stroke="${ACC}" stroke-width="1"/>
        <line x1="240" y1="16" x2="240" y2="344" stroke="${ACC}" stroke-width="1"/>
      </svg>
      ${(kicker || brand) ? `<div class="topbar">${kicker ? `<div class="kicker"><span class="kicker-dot"></span><span>${esc(kicker)}</span></div>` : ''}<span class="top-rule"></span>${brand ? `<div class="brand">${esc(brand)}</div>` : ''}</div>` : ''}
      <div class="content">
        <h1>${title.html}</h1>
        ${subBlock.html}
      </div>
    </div></body></html>`;
  }

  const mainSize = isPortrait ? 114 : (w > 1600 ? 156 : 134);
  const subSize = isPortrait ? 38 : 40;
  const frameAccent = liftAccentForDark(accent, '#F28C63');
  const padX = isPortrait ? 76 : 118;
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${w}px; height:${h}px; overflow:hidden; }
  .wrap { position:relative; width:${w}px; height:${h}px; background:#0D1310; overflow:hidden; }
  .bg {
    position:absolute; inset:0;
    background:url('${bg}') center/cover no-repeat;
    filter:saturate(.95) brightness(.86);
  }
  .scrim {
    position:absolute; inset:0;
    background:linear-gradient(102deg, rgba(8,12,10,.96) 0%, rgba(8,12,10,.88) 54%, rgba(8,12,10,.48) 100%);
  }
  .grain { position:absolute; inset:0; opacity:.09;
    background-image:radial-gradient(rgba(255,255,255,.35) 1px, transparent 1px);
    background-size:3px 3px; }
  .spine { position:absolute; left:0; top:0; bottom:0; width:${isPortrait ? 14 : 16}px;
    background:linear-gradient(180deg, ${frameAccent} 0%, ${rgba(frameAccent, 0.25)} 100%); }
  .topbar { position:absolute; left:${padX}px; right:${padX}px; top:${isPortrait ? 84 : 76}px; display:flex; align-items:center; gap:20px; }
  .kicker { display:inline-flex; align-items:center; gap:12px; padding:11px 24px; border-radius:999px;
    background:${rgba(frameAccent, 0.16)}; border:1.5px solid ${rgba(frameAccent, 0.44)};
    font:700 28px/1 "PingFang SC","Hiragino Sans GB",sans-serif; letter-spacing:.08em; color:${frameAccent}; }
  .kicker-dot { width:11px; height:11px; border-radius:50%; background:${frameAccent}; }
  .brand { font-family:"SF Mono",Menlo,monospace; font-size:24px; letter-spacing:.14em; color:rgba(250,249,245,.62); margin-left:auto; }
  .content {
    position:absolute; left:${padX}px; right:${padX}px;
    top:19%; bottom:15%; display:flex; flex-direction:column; justify-content:center;
  }
  .content>* { flex-shrink:0; }
  h1 {
    font-family:"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Source Han Sans SC",sans-serif;
    font-size:${mainSize}px; line-height:1.14; letter-spacing:-.028em;
    color:#FAF9F5; font-weight:900; white-space:pre-line; text-wrap:balance; overflow-wrap:anywhere;
  }
  h1 .line { display:block; }
  h1 .line-setup { font-size:0.56em; font-weight:600; line-height:1.3; letter-spacing:.01em; color:rgba(250,249,245,.76); margin-bottom:0.26em; }
  h1 .line-hero { font-size:1em; font-weight:900; line-height:1.12; letter-spacing:-.03em; color:#FFFFFF; }
  h1 em.hl, h1 em {
    color:${frameAccent}; font-style:normal; font-weight:900;
    box-shadow:inset 0 -0.14em 0 ${rgba(frameAccent, 0.30)};
    box-decoration-break:clone; -webkit-box-decoration-break:clone;
  }
  p.sub { margin-top:42px; font-family:"PingFang SC","Hiragino Sans GB",sans-serif;
      font-size:${subSize}px; line-height:1.4; font-weight:600; color:rgba(250,249,245,.86); overflow-wrap:anywhere; }
  p.sub-line { padding-left:22px; border-left:5px solid ${frameAccent}; white-space:pre-line; }
  p.sub-chips { display:flex; flex-wrap:wrap; gap:14px; align-items:center; }
  .sub-chip { display:inline-flex; align-items:center; padding:11px 24px; border-radius:12px;
    background:rgba(255,255,255,.10); border:1.5px solid rgba(255,255,255,.18); color:rgba(250,249,245,.94); font-weight:600; line-height:1.2; }
</style></head><body>
<div class="wrap">
  <div class="bg"></div><div class="scrim"></div><div class="grain"></div><div class="spine"></div>
  ${(kicker || brand) ? `<div class="topbar">${kicker ? `<div class="kicker"><span class="kicker-dot"></span><span>${esc(kicker)}</span></div>` : ''}${brand ? `<div class="brand">${esc(brand)}</div>` : ''}</div>` : ''}
  <div class="content">
    <h1>${title.html}</h1>
    ${subBlock.html}
  </div>
</div></body></html>`;
}

/* 抽一帧当背景（默认取全片 35% 处，通常已进入内容）。
   ⚠ 成片里的字幕是烧进画面的：直接 ffmpeg 抽帧会把字幕叠到封面上（真实事故：封面出现两条字幕）。
   正确做法是回到 scene.html，把字幕条和进度条临时隐藏后重新截图 —— 同一个 t 的场景画面，
   没有字幕，也没有裁切损失。scene.html 打不开时才退回 ffmpeg 抽帧。 */
export async function grabFrameClean(project, atSec) {
  const scene = path.join(project, 'scene.html');
  if (!fs.existsSync(scene)) return { ok: false, error: '没有 scene.html，无法生成无字幕底图' };
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { return { ok: false, error: 'node 解析不到 playwright' }; }
  const dur = (() => {
    try {
      const m = fs.readFileSync(scene, 'utf8').match(/DURATION\s*=\s*([\d.]+)/);
      return m ? Number(m[1]) : 0;
    } catch { return 0; }
  })();
  const t = atSec != null ? Number(atSec) : Math.max(1, (dur || 60) * 0.35);
  if (!Number.isFinite(t) || t < 0 || dur > 0 && t >= dur) return { ok: false, error: '封面底图时间必须落在当前视频范围内' };
  const out = path.join(project, 'out', 'cover-bg.jpg');
  const browser = await launchBrowser(chromium, { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(scene).href);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async (tt) => {
      // 隐藏字幕与进度条：封面自己排版，不要和烧进画面的字打架
      const css = document.createElement('style');
      css.textContent = '#subs,#bar{display:none !important}';
      document.head.appendChild(css);
      if (window.__ready) await window.__ready;
      else if (window.VH_UI?.assetsReady) await window.VH_UI.assetsReady();
      if (typeof window.renderAt !== 'function') throw new Error('缺少 renderAt');
      await window.renderAt(tt);
    }, t);
    await page.screenshot({ path: out, type: 'jpeg', quality: 92 });
    return { ok: true, file: out, at: +t.toFixed(1), clean: true };
  } catch (e) {
    return { ok: false, error: '无字幕截图失败：' + e.message.slice(0, 120) };
  } finally { await browser.close(); }
}

/* 退回方案：从成片抽帧（会带字幕，只在 scene.html 不可用时用） */
export function grabFrame(project, atSec) {
  const video = path.join(project, 'out', 'video-voice.mp4');
  if (!fs.existsSync(video)) return { ok: false, error: '没有 out/video-voice.mp4（先出片）' };
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { encoding: 'utf8' });
  const dur = parseFloat(r.stdout) || 0;
  const t = atSec != null ? atSec : Math.max(1, dur * 0.35);
  const out = path.join(project, 'out', 'cover-bg.jpg');
  const g = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(t), '-i', video, '-frames:v', '1', '-q:v', '3', out], { encoding: 'utf8' });
  if (g.status !== 0) return { ok: false, error: '抽帧失败：' + (g.stderr || '').slice(-200) };
  return { ok: true, file: out, at: +t.toFixed(1) };
}

export async function render(project, opt = {}) {
  const copyMd = (() => { try { return fs.readFileSync(path.join(project, '发布文案.md'), 'utf8'); } catch { return ''; } })();
  const copy = parseCoverCopy(copyMd);
  const main = opt.main || copy.main || '（缺封面主文案）';
  const sub = opt.sub || copy.sub || '';
  const kicker = opt.kicker || copy.kicker || '';
  const emphasis = opt.emphasis || copy.emphasis || '';
  if (!copy.main && !opt.main) return { ok: false, error: '没有封面文案：在 发布文案.md 的「## 封面文案」里写「主：…」「副：…」' };

  const style = opt.style || 'editorial';
  if (!['editorial', 'frame'].includes(style)) return { ok: false, error: '封面样式只接受 editorial 或 frame' };
  let inputs;
  try { inputs = coverInputs(project, style); }
  catch (e) { return { ok: false, error: '无法核验封面输入：' + e.message }; }
  // Default covers do not inherit body text and do not need a rendered video.
  const fr = style === 'frame' ? await grabFrameClean(project, opt.at != null ? Number(opt.at) : null) : { ok: true };
  if (!fr.ok) return fr;

  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { return { ok: false, error: 'node 解析不到 playwright' }; }
  const browser = await launchBrowser(chromium, { headless: true, args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
  const outDir = path.join(project, 'out', 'cover');
  fs.mkdirSync(outDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(outDir, '.cover-'));
  const made = [];
  try {
    const theme = projectTheme(project);
    for (const ratio of Object.keys(RATIOS)) {
      const { w, h } = RATIOS[ratio];
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      const html = buildHtml({
        ratio,
        bg: fr.file ? pathToFileURL(fr.file).href : '',
        main,
        sub,
        kicker,
        emphasis,
        style,
        brand: opt.brand || '',
        accent: theme.accent,
      });
      const tmp = path.join(staging, `${ratio}.html`);
      fs.writeFileSync(tmp, html, 'utf8');
      await page.goto(pathToFileURL(tmp).href);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(120);
      const fit = await page.evaluate(({ w, h }) => {
        const title = document.querySelector('h1'), content = document.querySelector('.content');
        const min = Math.ceil(20 * w / 320), lines = h > w ? 4 : 3;
        let size = parseFloat(getComputedStyle(title).fontSize);
        while (size >= min) {
          title.style.fontSize = size + 'px';
          const a = title.getBoundingClientRect(), box = content.getBoundingClientRect();
          const children = [...content.children].map(el => el.getBoundingClientRect());
          const count = a.height / parseFloat(getComputedStyle(title).lineHeight);
          const textRects = [...content.querySelectorAll('h1,p')].map(el => { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect(); });
          if (count <= lines + .05 && title.scrollWidth <= title.clientWidth + 1 && content.scrollHeight <= content.clientHeight + 1 &&
              textRects.every(r => r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1) &&
              (textRects.length < 2 || textRects[0].bottom <= textRects[1].top) &&
              children.every(r => r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1))
            return { ok: true, fontSize: size, titlePixelsAt320: size * 320 / w, lines: Math.round(count) };
          size -= 2;
        }
        return { ok: false };
      }, { w, h });
      if (!fit.ok) return { ok: false, error: ratio + ' 封面文案过长或越界；请缩短主/副标题，不缩到不可读或截字' };
      const file = path.join(staging, `cover-${ratio}.png`);
      const fullImage = await page.screenshot({ path: file, type: 'png', animations: 'disabled' });
      const thumbH = Math.round(h * 320 / w);
      const thumbnail = path.join(staging, `thumb-${ratio}.png`);
      // Downsample the actual full PNG, not a resized viewport: some Chrome/GPU
      // combinations retain stale compositor tiles after CSS scaling.
      const thumb = await page.evaluate(async ({ png, height }) => {
        const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = height;
        const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, 320, height); return canvas.toDataURL('image/png').split(',')[1];
      }, { png: fullImage.toString('base64'), height: thumbH });
      fs.writeFileSync(thumbnail, Buffer.from(thumb, 'base64'));
      fs.rmSync(tmp, { force: true });
      await page.close();
      made.push({ ratio, file: path.join(outDir, path.basename(file)), thumbnail: path.join(outDir, path.basename(thumbnail)), w, h, label: RATIOS[ratio].label, fit });
    }
    let currentInputs;
    try { currentInputs = coverInputs(project, style); } catch {}
    if (JSON.stringify(inputs) !== JSON.stringify(currentInputs)) return { ok: false, error: '生成期间脚本/文案/底图或本地素材依赖改变；未覆盖原封面' };
    const files = made.map(item => ({ file: path.basename(item.file), ...coverFingerprint(path.join(staging, path.basename(item.file))) }));
    const manifest = { version: 1, style, inputs, main: stripEmphasis(main), sub: stripEmphasis(sub), kicker, emphasis, brand: opt.brand || '', reviewed: false, files };
    const previous = fs.readdirSync(outDir).filter(name => /^(?:cover|thumb)-(?:16x9|4x3|3x4)\.png$|^manifest\.json$/.test(name));
    if (previous.length) {
      const backup = path.join(project, 'out/cover-history', randomUUID()); fs.mkdirSync(backup, { recursive: true });
      for (const name of previous) fs.copyFileSync(path.join(outDir, name), path.join(backup, name));
    }
    for (const name of fs.readdirSync(staging)) fs.renameSync(path.join(staging, name), path.join(outDir, name));
    const temp = path.join(outDir, '.' + randomUUID() + '.json');
    fs.writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n'); fs.renameSync(temp, path.join(outDir, 'manifest.json'));
  } finally { await browser.close(); fs.rmSync(staging, { recursive: true, force: true }); }
  return { ok: true, made, copy: { main: stripEmphasis(main), sub: stripEmphasis(sub), kicker, emphasis }, style, frameAt: fr.at };
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function coverFingerprint(file) {
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('封面必须是普通文件');
  const bytes = fs.readFileSync(file); return { size: bytes.length, sha256: digest(bytes) };
}
/* 封面只继承「封面文案」那两个标题；简介、标签、置顶评论改了不影响已生成的图。
 * 以前整份发布文案的字节哈希都算输入，程序往简介补参考链接就误判“封面过期”。 */
function coverInputs(project, style) {  let copy = '';
  try { copy = parseCoverCopy(fs.readFileSync(path.join(project, '发布文案.md'), 'utf8')); } catch {}
  let frame = {};
  if (style === 'frame') {
    // Match the media/build dependency contract, including local image/font bytes.
    // Reject dependency issues before reading scene.html or launching Chrome.
    const assets = assetInputs(project);
    if (assets.issues.length) throw new Error('本地素材依赖无效：' + assets.issues.join('；'));
    frame = { sceneHash: digest(fs.readFileSync(path.join(project, 'scene.html'))),
      ...(assets.files.length ? { assetSignature: assets.signature } : {}) };
  }
  return { ...publishInputs(project), coverCopyHash: digest(JSON.stringify(copy)), ...frame };
}
export function coverStatus(project) {
  const dir = path.join(project, 'out/cover');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
  catch { return { ok: false, files: [], code: 'missing', reason: '还没有生成封面（vh cover）' }; }
  try {
    if (manifest.version !== 1 || !['editorial', 'frame'].includes(manifest.style)) return { ok: false, files: [], code: 'invalid', reason: '封面清单格式无效' };
    if (!Array.isArray(manifest.files) || manifest.files.length !== 3) return { ok: false, files: [], code: 'invalid', reason: '封面清单缺少某个比例' };
    // 旧清单绑定整份文案字节，无法判断是否只改了简介；一次性重生成即可。
    if (!Object.hasOwn(manifest.inputs || {}, 'coverCopyHash')) {
      return { ok: false, files: [], code: 'legacy', reason: '封面由旧版本生成（当时绑定整份文案），请重新生成一次' };
    }
    if (JSON.stringify(manifest.inputs) !== JSON.stringify(coverInputs(project, manifest.style))) {
      return { ok: false, files: [], code: manifest.style === 'frame' ? 'input-changed' : 'copy-changed',
        reason: manifest.style === 'frame' ? '封面底图依赖的画面或素材已改变，请重新生成' : '封面文案已改变，请重新生成' };
    }
    const names = new Set();
    for (const file of manifest.files) {
      if (!/^cover-(16x9|4x3|3x4)\.png$/.test(file.file) || names.has(file.file)) return { ok: false, files: [], code: 'invalid', reason: '封面清单条目无效' };
      names.add(file.file);
      let actual;
      try { actual = coverFingerprint(path.join(dir, file.file)); }
      catch { return { ok: false, files: [], code: 'missing-file', reason: '封面图片文件缺失：' + file.file }; }
      if (file.sha256 !== actual.sha256 || file.size !== actual.size) return { ok: false, files: [], code: 'tampered', reason: '封面图片与清单指纹不符：' + file.file };
    }
    return { ok: true, files: manifest.files, reviewed: false };
  } catch (error) {
    return { ok: false, files: [], code: 'error', reason: '无法核验封面：' + error.message };
  }
}
