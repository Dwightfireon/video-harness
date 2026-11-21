/* lib/contrast.mjs —— 文字对比度体检（vh contrast）
 *
 * 来源：真实事故——一支片子的场景文件沿用了深色主题配色
 * （ink:#F2EFE9 米白、mut:#8A8F98 灰），而引擎已经是浅色纸底（#F6F7F6）。
 * 结果整片文字"看起来是透明的"：米白画在米白上，对比度只有 1.07:1
 * （无障碍标准 4.5:1）。五个检查器全绿，因为没有一个真的算对比度。
 *
 * 这个模块只做机器能判的事：解析每场的配色，按 WCAG 算真实对比度。
 * 它不判断"好不好看"，只回答"这个字在这块底上，人眼看不看得清"。
 */
import fs from 'node:fs';
import path from 'node:path';

const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/* WCAG 2.1 相对亮度 */
export function luminance(hex) {
  const n = String(hex).replace('#', '');
  const full = n.length === 3 ? n.split('').map(c => c + c).join('') : n;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255);
  const f = c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/* WCAG 对比度：1:1（完全看不见）到 21:1（纯黑白） */
export function contrastRatio(fg, bg) {
  const a = luminance(fg), b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* 把 rgb()/rgba() 合到底色上，得到实际看到的颜色。
 * 半透明文字是最容易被忽略的一类"看不清"：color: #1E2721 + opacity: .9 看着没问题，
 * 但叠在深色块上就可能糊掉。 */
export function flatten(color, background, alpha = 1) {
  const parse = c => {
    const s = String(c).trim();
    if (s.startsWith('#')) {
      const n = s.slice(1);
      const f = n.length === 3 ? n.split('').map(x => x + x).join('') : n;
      return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16), 1];
    }
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (!m) return null;
    const parts = m[1].split(',').map(x => parseFloat(x));
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  };
  const f = parse(color), b = parse(background);
  if (!f || !b) return null;
  const a = f[3] * alpha;
  const mix = i => Math.round(f[i] * a + b[i] * (1 - a));
  const toHex = v => v.toString(16).padStart(2, '0');
  return '#' + [0, 1, 2].map(i => toHex(mix(i))).join('');
}

/* 从 engine.tpl.html 读主题底色。片子可能是浅色纸，也可能是深色场景。 */
export function themeBackgrounds(engineSrc) {
  const grab = name => {
    const m = new RegExp('--' + name + ':\\s*(#[0-9A-Fa-f]{3,8})').exec(engineSrc);
    return m ? m[1] : null;
  };
  return {
    paper: grab('bg') || '#FFFFFF',
    dark: grab('dark') || '#16211A',
    card: grab('card') || '#FFFFFF',
  };
}

/* 引擎里真实的 CSS 变量表。
 * ⚠ 真实事故：场景写 `var(--ink,#eef1f6)` 想表达"深卡上的浅字"，
 * 但引擎把 --ink 定义成浅底用的深色 #1E2721 —— 变量存在时回退值根本不生效，
 * 于是深字压在深卡上，接近不可见。检查器若只看回退值，就会把这种片子判为通过。 */
export function themeVars(engineSrc) {
  const vars = {};
  for (const m of engineSrc.matchAll(/--([\w-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})/g)) vars[m[1]] = m[2];
  return vars;
}

/* 从每场开头的 `const C = {...}` 里取出配色表。 */
export function scenePalettes(src) {
  const chunks = src.split(/^\/\/---\s*$/m).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const m = /const C\s*=\s*\{([^}]+)\}/.exec(chunk);
    if (!m) continue;
    const colors = {};
    for (const pair of m[1].matchAll(/(\w+)\s*:\s*'(#[0-9A-Fa-f]{3,8})'/g)) colors[pair[1]] = pair[2];
    const dark = /@tone\s+dark/.test(chunk);
    const fullimg = /fullimg|bgImg\(/.test(chunk);
    out.push({ index: i + 1, colors, dark, fullimg, chunk });
  }
  return out;
}

/* 主检查：返回问题清单。
 * 阈值按 WCAG AA：正文 4.5:1，大字号（≥24px 或 ≥19px 粗体）3:1。 */
export function analyze(project) {
  const src = read(path.join(project, 'scenes.src.js'));
  const engine = read(path.join(project, 'engine.tpl.html'));
  const findings = [];
  if (!src) return { findings, scenes: [], ok: true, note: '没有 scenes.src.js' };

  const bg = themeBackgrounds(engine);
  const palettes = scenePalettes(src);
  const BODY_MIN = 4.5, LARGE_MIN = 3;

  /* 真实事故：整片用内联 `var(--ink3,#6b7382)` 写颜色，没有 `const C = {...}`，
   * 旧检查直接返回“场景里没有配色表”并当作通过 —— 于是 3.79:1 的灰字一路放行。
   * 这里补上内联写法：只看 `color:` 声明，并按同一元素最近的 background 定底色。 */
  const inline = [];
  {
    const chunks = src.split(/^\/\/---\s*$/m).map(s => s.trim()).filter(Boolean);
    /* 变量优先级与浏览器一致：场景内局部声明 > 引擎全局变量 > 回退值。
     * 只看回退值会漏掉"深字压在深卡上"这类真实事故。 */
    const engineVars = themeVars(engine);
    const resolve = (vars, name, fallback) => vars[name] || engineVars[name] || fallback;
    chunks.forEach((chunk, i) => {
      const vars = {};
      for (const m of chunk.matchAll(/--([\w-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})/g)) vars[m[1]] = m[2];
      let base = bg.paper, lastCard = bg.paper;
      for (const line of chunk.split('\n')) {
        const bgm = /background\s*:\s*var\(--([\w-]+)\s*,\s*(#[0-9A-Fa-f]{3,8})\)/.exec(line)
          || /background\s*:\s*(#[0-9A-Fa-f]{3,8})/.exec(line);
        if (bgm) { lastCard = bgm[2] ? resolve(vars, bgm[1], bgm[2]) : bgm[1]; base = lastCard; }
        // color 声明（排除 background-color 之类）
        const cm = /(?<![-\w])color\s*:\s*var\(--([\w-]+)\s*,\s*(#[0-9A-Fa-f]{3,8})\)/.exec(line);
        if (!cm) continue;
        const hex = resolve(vars, cm[1], cm[2]);
        const size = +(/(?:font-size)\s*:\s*(\d+)/.exec(line) || /font-size\s*:\s*(\d+)/.exec(chunk) || [])[1] || 0;
        const strong = /font-weight\s*:\s*(?:[6-9]\d\d|bold)/.test(line);
        /* 子元素文字叠在卡片上时，静态分析看不出父子关系。
         * 同时考虑“本行底色 / 最近卡片底色 / 纸底 / 深底”，只有**全部**都不过线才报，
         * 宁可少报，也不用一堆误报把检查变成噪音。 */
        const bases = [...new Set([base, lastCard, bg.paper, bg.dark].filter(Boolean))];
        const checked = bases.map(b => ({ base: b, ratio: contrastRatio(hex, b) }));
        const worst = checked.reduce((a, b) => b.ratio < a.ratio ? b : a);
        inline.push({ index: i + 1, name: cm[1], hex, base: worst.base, ratio: worst.ratio,
          size, strong, checked, line: line.trim().slice(0, 80) });
      }
    });
  }
  for (const row of inline) {
    const ratio = row.ratio;
    const large = row.size >= 24 || (row.strong && row.size >= 19);
    const need = large ? LARGE_MIN : BODY_MIN;
    if (!row.checked.every(c => c.ratio < need)) continue;
    if (ratio < need) {
      findings.push({
        kind: 'contrast-inline', scene: row.index, key: row.name, color: row.hex, background: row.base,
        ratio: +ratio.toFixed(2), need,
        msg: `第 ${row.index} 场的文字 ${row.name}(${row.hex}) 在底色 ${row.base} 上只有 ${ratio.toFixed(2)}:1，低于 ${need}:1 —— ${large ? '大字也发灰' : '正文会看不清'}`,
        hint: row.line,
        fix: '换更深的文字色或更浅的底；次要信息也别低于 4.5:1，手机上会更糊。',
      });
    } else if (ratio < BODY_MIN && large) {
      findings.push({
        kind: 'contrast-inline-warn', scene: row.index, key: row.name, color: row.hex, background: row.base,
        ratio: +ratio.toFixed(2), need: BODY_MIN,
        msg: `第 ${row.index} 场的文字 ${row.name}(${row.hex}) 对比度 ${ratio.toFixed(2)}:1，只够大字；当成正文会吃力`,
      });
    }
  }
  if (!palettes.length && !inline.length) return { findings, scenes: [], ok: true, note: '场景里没有可识别的配色' };

  for (const scene of palettes) {
    /* 深色场（@tone dark）或全屏素材场，底色不是纸色；
     * 素材场的实际底色取决于图片，无法静态判断，只做提示不做 FAIL。 */
    const base = scene.dark ? bg.dark : bg.paper;
    if (scene.fullimg) continue;

    const rows = [];
    for (const [name, hex] of Object.entries(scene.colors)) {
      if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) continue;
      const ratio = contrastRatio(hex, base);
      rows.push({ name, hex, ratio });
    }

    /* 只检查"会被当作文字/图形前景"的键。line 是描边，不承载信息，跳过。 */
    const TEXT_KEYS = ['ink', 'mut', 'warn', 'clay', 'teal', 'accent'];
    for (const row of rows) {
      if (!TEXT_KEYS.includes(row.name)) continue;
      if (row.ratio < LARGE_MIN) {
        findings.push({
          kind: 'contrast-fail', scene: scene.index, key: row.name, color: row.hex,
          background: base, ratio: +row.ratio.toFixed(2), need: LARGE_MIN,
          msg: `第 ${scene.index} 场的 ${row.name}(${row.hex}) 在底色 ${base} 上只有 ${row.ratio.toFixed(2)}:1，低于 ${LARGE_MIN}:1 —— 文字会看不清`,
        });
      } else if (row.ratio < BODY_MIN) {
        findings.push({
          kind: 'contrast-warn', scene: scene.index, key: row.name, color: row.hex,
          background: base, ratio: +row.ratio.toFixed(2), need: BODY_MIN,
          msg: `第 ${scene.index} 场的 ${row.name}(${row.hex}) 对比度 ${row.ratio.toFixed(2)}:1，仅够大字号；正文里用会吃力`,
        });
      }
    }

    /* 半透明文字：opacity 或 rgba 的 alpha 会进一步压暗。
     * 真实事故里 color:ink + opacity:.85 让本就偏灰的字更容易糊。 */
    for (const m of scene.chunk.matchAll(/color:'?\+?C\.(\w+)\+?'?;opacity:\.(\d+)/g)) {
      const color = scene.colors[m[1]];
      if (!color) continue;
      const alpha = parseFloat('0.' + m[2]);
      const flat = flatten(color, base, alpha);
      if (!flat) continue;
      const ratio = contrastRatio(flat, base);
      if (ratio < LARGE_MIN) {
        findings.push({
          kind: 'contrast-alpha', scene: scene.index, key: m[1], color, background: base,
          ratio: +ratio.toFixed(2), need: LARGE_MIN,
          msg: `第 ${scene.index} 场的 ${m[1]} 加了 opacity:.${m[2]}，实际对比度降到 ${ratio.toFixed(2)}:1 —— 透明度会吃掉可读性`,
        });
      }
    }
  }

  const fails = findings.filter(f => f.kind !== 'contrast-warn');
  return {
    findings,
    scenes: palettes.map(p => ({ index: p.index, dark: p.dark, background: p.dark ? bg.dark : bg.paper })),
    ok: fails.length === 0,
    summary: fails.length
      ? `${fails.length} 处文字对比度不足（WCAG 最低 3:1）`
      : '所有文字对比度达标',
  };
}

export function report(result) {
  const L = [];
  if (result.note) { L.push(result.note); return L; }
  L.push(`对比度体检（WCAG AA：正文 4.5:1，大字 3:1）`);
  L.push('');
  for (const f of result.findings) {
    L.push((f.kind === 'contrast-warn' ? '  ⚠ ' : '  ✗ ') + f.msg);
  }
  if (!result.findings.length) L.push('  ✓ 所有场景的文字与底色对比度达标');
  L.push('');
  L.push(result.ok ? '✓ ' + (result.summary || '通过') : '✗ ' + result.summary);
  return L;
}
