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
