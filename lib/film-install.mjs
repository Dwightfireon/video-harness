import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { browserSource } from './film.mjs';
import { maskJS } from './js-mask.mjs';

function standardRange(source, code, assignment) {
  const marker = '/* VH_FILM: deterministic camera + subtitle cues */';
  const header = source.lastIndexOf(marker, assignment);
  if (header < 0 || code.slice(header + marker.length, assignment).trim()) throw new Error('无法识别标准 VH_FILM 开头；未覆盖作者实现');
  const open = /^window\.VH_FILM\s*=\s*\(\s*\(\s*\)\s*=>\s*\{/.exec(code.slice(assignment));
  if (!open) throw new Error('无法识别标准 VH_FILM 函数；未覆盖作者实现');
  // 按配平后的真实函数结束定位，不能用“下一个独占行 })();”吞到作者的 IIFE。
  let i = assignment + open[0].length, depth = 1;
  for (; i < code.length && depth; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
  }
  const close = /^\s*\)\s*\(\s*\)\s*;/.exec(code.slice(i));
  if (depth || !close) throw new Error('无法识别标准 VH_FILM 结束；未覆盖作者实现');
  let start = header, end = i + close[0].length;
  const modern = source.lastIndexOf('/* vh:film-start */', header);
  if (modern >= 0 && !code.slice(modern, header).trim()) {
    const tail = /^\s*\/\* vh:film-end \*\//.exec(source.slice(end));
    if (!tail) throw new Error('标准 VH_FILM 结束标记缺失；未覆盖作者实现');
    start = modern; end += tail[0].length;
  }
  return { start, end };
}

/* 只显式更新标准注入块；保留块外作者代码。--force 不是覆盖未知边界的授权。 */
export function installFilm(project, { force = false } = {}) {
  const file = path.join(project, 'engine.tpl.html');
  const source = fs.readFileSync(file, 'utf8'), block = browserSource().trim();
  const code = maskJS(source);
  const assignments = [...code.matchAll(/\bwindow\.VH_FILM\s*=(?!=|>)/g)];
  if (source.includes(block) && assignments.length === 1) return { changed: false, current: true };
  const installed = assignments.length > 0;
  if (installed && !force) return { changed: false, current: false, note: '已有 VH_FILM；显式 --film --force 才备份升级动作编排助手' };
  if (source.lastIndexOf('<script') <= source.lastIndexOf('</script>')) {
    throw new Error('enhance --film 需要生成器的开放 script 模板；未修改手写 HTML');
  }
  let next;
  if (installed) {
    if (assignments.length !== 1) {
      throw new Error('无法唯一识别标准 VH_FILM 块；未覆盖作者实现');
    }
    const range = standardRange(source, code, assignments[0].index);
    next = source.slice(0, range.start) + block + source.slice(range.end);
  } else next = source.replace(/\s*$/, '') + '\n' + block + '\n';
  const backup = file + '.bak-film-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  const temp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, next, { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
  return { changed: true, current: true, updated: installed, backup };
}
