/* lib/theme.mjs —— 美术方向（references/art-directions.md 的可执行版）
 * 只改 engine.tpl.html 里 :root 的 CSS 变量，场景代码无需改动。
 * 三个方向：warm-paper（暖纸编辑部）/ dark-stage（暗色舞台）/ documentary（纪实纸本）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const THEMES = {
  'warm-paper': {
    name: '暖纸编辑部（Claude/Anthropic token）',
    best: '讲机制 / 心理 / 人文 / 教程',
    vars: {
      '--bg': '#FAF9F5', '--ink': '#141413', '--ink2': '#5E5D59', '--ink3': '#87867F',
      '--accent': '#D97757', '--accent-soft': '#F5E3C7', '--line': '#E8E6DC', '--card': '#FFFFFF',
      '--dot': '#E3DACC', '--radius': '20px', '--dark': '#181715', '--code': '#0F1412',
      '--on-dark': '#9BE0B8', '--on-dark-warn': '#F0B49B',
      '--warn': '#B4471F', '--warn-soft': '#FBEDE7', '--good-soft': '#F4F2EA', '--good-line': '#DDD8C8',
      '--neutral-soft': '#F5F2EA', '--chip': '#EDEAE1',
      '--paper-hi': '#FFFEFB', '--paper-lo': '#F2EFE7', '--edge': 'rgba(20,20,19,.05)',
      '--vignette': 'rgba(255,255,255,.55)',
    },
  },
  'dark-stage': {
    name: '暗色舞台（产品/发布，需配运动）',
    best: '产品 / 工具 / 性能对比 / 版本更新',
    vars: {
      '--bg': '#0E1512', '--ink': '#E9EDEA', '--ink2': '#9FB0A6', '--ink3': '#6F827A',
      '--accent': '#7BE3A4', '--accent-soft': 'rgba(123,227,164,.12)', '--line': 'rgba(255,255,255,.10)',
      '--card': '#16211A', '--dot': 'rgba(255,255,255,.06)', '--radius': '18px',
      '--dark': '#0B1210', '--code': '#08100D', '--on-dark': '#7BE3A4', '--on-dark-warn': '#F0B49B',
      '--warn': '#F0B49B', '--warn-soft': 'rgba(240,180,155,.12)',
      '--good-soft': 'rgba(123,227,164,.10)', '--good-line': 'rgba(123,227,164,.35)',
      '--neutral-soft': 'rgba(255,255,255,.05)', '--chip': 'rgba(255,255,255,.08)',
      '--paper-hi': '#101815', '--paper-lo': '#0A100D', '--edge': 'rgba(0,0,0,.35)',
      /* 深底上不能有白雾：中心改成极淡的提亮，用量级比浅色主题小一个数量级 */
      '--vignette': 'rgba(255,255,255,.045)',
    },
  },
  documentary: {
    name: '纪实纸本（新闻整理 / 事实核查）',
    best: '事实核查 / 争议话题 / 多来源对比',
    vars: {
      '--bg': '#F4F1EA', '--ink': '#1A1A18', '--ink2': '#4A4A46', '--ink3': '#77776F',
      '--accent': '#4A5240', '--accent-soft': '#E6E7DD', '--line': '#DAD5C8', '--card': '#FBF9F4',
      '--dot': '#D8D2C2', '--radius': '14px', '--dark': '#1C1B19', '--code': '#14130F',
      '--on-dark': '#B9C6A8', '--on-dark-warn': '#E0B49B',
      '--warn': '#B4471F', '--warn-soft': '#F5E7DF', '--good-soft': '#EBEEE4', '--good-line': '#C6CDB8',
      '--neutral-soft': '#F3F1E9', '--chip': '#E9E5DA',
      '--paper-hi': '#FAF8F2', '--paper-lo': '#EDE9DE', '--edge': 'rgba(26,26,24,.05)',
      '--vignette': 'rgba(255,255,255,.42)',
    },
  },
};

export function applyTheme(project, key) {
  const t = THEMES[key];
  if (!t) return { ok: false, error: '未知方向：' + key + '；可选 ' + Object.keys(THEMES).join(' / ') };
  const tpl = path.join(project, 'engine.tpl.html');
  if (!fs.existsSync(tpl)) return { ok: false, error: '项目里没有 engine.tpl.html' };
  let src = fs.readFileSync(tpl, 'utf8');
  const start = src.indexOf(':root{');
  const end = src.indexOf('}', start);
  if (start < 0 || end < 0) return { ok: false, error: 'engine.tpl.html 里找不到 :root{…} 变量块' };
  const block = src.slice(start, end);
  let next = block;
  const applied = [], missing = [];
  for (const [k, v] of Object.entries(t.vars)) {
    const re = new RegExp('(' + k.replace(/[-]/g, '\\-') + '\\s*:\\s*)([^;]*)(;)', 'm');
    if (re.test(next)) { next = next.replace(re, '$1 ' + v + '$3'); applied.push(k); }
    else missing.push(k);
  }
  const bak = tpl + '.bak-theme-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(tpl, bak);
  fs.writeFileSync(tpl, src.slice(0, start) + next + src.slice(end), 'utf8');
  return { ok: true, applied: applied.length, missing, backup: path.basename(bak), theme: t };
}

function parseHex(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]) {
  const f = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(fgHex, bgHex) {
  const a = parseHex(fgHex), b = parseHex(bgHex);
  if (!a || !b) return null;
  const l1 = luminance(a), l2 = luminance(b);
  return +((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2);
}

export function auditThemeContrast(theme) {
  const v = theme?.vars || {};
  const pairs = [
    ['--ink', '--bg', 7.0],
    ['--ink', '--card', 7.0],
    ['--ink2', '--bg', 4.5],
    ['--ink2', '--card', 4.5],
    ['--accent', '--bg', 2.9],
  ];
  const checks = pairs.map(([fg, bg, min]) => {
    const ratio = contrastRatio(v[fg], v[bg]);
    return { fg, bg, ratio, min, ok: ratio != null && ratio >= min };
  });
  return { ok: checks.every(c => c.ok), checks };
}

/* 可解释的主题建议：只读脚本与方案关键词，给建议与依据，不自动改写模板。 */
export function suggestTheme(project) {
  const read = name => { try { return fs.readFileSync(path.join(project, name), 'utf8'); } catch { return ''; } };
  const text = (read('脚本.md') + '\n' + read('方案.md')).slice(0, 20000);
  if (!text.trim()) return { key: 'warm-paper', name: THEMES['warm-paper'].name, confidence: 'low', reason: '未找到脚本或方案，默认推荐暖纸编辑部' };
  const count = re => (text.match(re) || []).length;
  const darkHits = count(/CLI|命令行|终端|开源|发布|版本|性能|基准|benchmark|GPU|芯片|显卡|渲染|框架|引擎|工具/gi);
  const docHits = count(/核查|口径|统计|样本|论文|实验|随机对照|争议|账单|监管|分母|置信区间|偏差|财报|审计/gi);
  const warmHits = count(/机制|原理|心理|记忆|认知|故事|教程|类比|概念|思维|习惯|模型/gi);
  if (darkHits >= docHits + 3 && darkHits >= warmHits + 3) {
    return { key: 'dark-stage', name: THEMES['dark-stage'].name, confidence: 'high',
      reason: `工具/产品/性能类线索较多（${darkHits} 处），适合暗色舞台突出界面与数据反差` };
  }
  if (docHits >= darkHits + 2 && docHits >= warmHits + 2) {
    return { key: 'documentary', name: THEMES.documentary.name, confidence: 'high',
      reason: `统计口径/事实核查类线索较多（${docHits} 处），适合纪实纸本呈现克制、客观的证据对照` };
  }
  return { key: 'warm-paper', name: THEMES['warm-paper'].name, confidence: warmHits >= 4 ? 'high' : 'low',
    reason: `偏机制讲解或综合科普（机制线索 ${warmHits} 处），暖纸编辑部阅读疲劳最低` };
}
