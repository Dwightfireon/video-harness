/* 静态启发式检查用：保留位置/换行，屏蔽注释、字符串和正则字面量。
 * 不是 JS 语义解析器；模板字符串连同插值保守屏蔽，不把示例文本计为执行代码。 */
export function maskJS(source) {
  let out = '', i = 0, previous = '';
  const blank = text => text.replace(/[^\r\n]/g, ' ');
  while (i < source.length) {
    const start = i, c = source[i], next = source[i + 1];
    if (c === '/' && next === '/') {
      i = source.indexOf('\n', i + 2);
      if (i < 0) i = source.length;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === c) break;
      }
      previous = 'value';
    } else if (c === '/' && (!previous || /[=(:,!&|?;{}\[]$/.test(previous) || /^(return|throw|case|yield)$/.test(previous))) {
      i++;
      let bracket = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') bracket = true;
        if (source[i] === ']') bracket = false;
        if (source[i++] === '/' && !bracket) break;
      }
      while (/[a-z]/i.test(source[i] || '') && i < source.length) i++;
      previous = 'value';
    } else {
      const word = /^[\w$]+/.exec(source.slice(i));
      if (word) { out += word[0]; i += word[0].length; previous = word[0]; }
      else { out += c; i++; if (!/\s/.test(c)) previous = c; }
      continue;
    }
    out += blank(source.slice(start, i));
  }
  return out;
}
