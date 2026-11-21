/* 场景「建了元素却没挂到画面上」的静态判定。
 *
 * 真实事故：8 场里 6 场把卡片、标题、表头全部 mk() 建好了，却一次
 * root.appendChild 都没有 —— 语法合法、render 形状合法，于是空白场被当成
 * 完成稿组装进 scenes.src.js。build 期 check-scene 才报「创建了但没 append」，
 * 而修复提示只有变量名没有行号，模型只能把 1455 行来回读，96 轮零写入。
 *
 * 判定只认「能证明的挂载」：从 root 出发，沿 append / appendChild / add 边
 * 求可达集；bg()、frame()、VH_LAYOUT.* 视为已经挂上去。只对**场景顶层**声明
 * 的元素下结论 —— 函数内部先建容器、再 return 给调用方挂载是合法写法。
 *
 * 这是启发式，不是 JS 解析器：宁可漏判，也不把合法场景判死。
 * 它守的是「写进去时就发现」，不是「出片前替人补完」。
 */
import { maskJS } from './js-mask.mjs';

const DECL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
const MOUNT_EDGE = /([A-Za-z_$][\w$]*)\s*\.\s*(?:appendChild|append|add)\s*\(\s*([A-Za-z_$][\w$]*)/g;
// 自己会挂到 root 上、或返回已挂载对象的入口
const SELF_MOUNT = /^(?:frame|bg)\s*\(/;
const LAYOUT_MOUNT = /^VH_LAYOUT\s*\./;
// 自建元素（需要有人挂）与返回元素的调用（需要调用方挂）
const ELEMENT_CALL = /^(?:abs\s*\(\s*)?(?:mk\s*\(|document\s*\.\s*createElement)/;
const ELEMENT_RETURNING = /^[A-Za-z_$][\w$]*\s*\.\s*(?:map|flatMap)\s*\(/;
const NOT_ELEMENT = /^(?:[\[{'"`0-9-]|window\s*\.|Math\s*\.|JSON\s*\.|String\s*\(|Number\s*\(|Array\s*|Object\s*\.|Boolean\s*\(|parseInt\s*\(|parseFloat\s*\()/;

function depthTable(masked) {
  const depth = new Int32Array(masked.length + 1);
  let d = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{' || c === '(' || c === '[') { d++; depth[i] = d; }
    else if (c === '}' || c === ')' || c === ']') { depth[i] = d; d = Math.max(0, d - 1); }
    else depth[i] = d;
  }
  depth[masked.length] = d;
  return depth;
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/* 表达式体场景（root => ({...})）没有顶层语句，直接跳过。 */
function builderBody(masked) {
  const arrow = masked.search(/=>/);
  if (arrow < 0) return null;
  const rest = masked.slice(arrow + 2);
  const open = rest.search(/\S/);
  if (open < 0) return null;
  const at = arrow + 2 + open;
  if (masked[at] !== '{') return null;
  return at;
}

function classify(rhs) {
  const value = rhs.trim();
  if (!value) return 'skip';
  if (SELF_MOUNT.test(value) || LAYOUT_MOUNT.test(value)) return 'mounted';
  if (ELEMENT_CALL.test(value)) return 'element';
  if (ELEMENT_RETURNING.test(value)) return 'element';
  if (NOT_ELEMENT.test(value)) return 'skip';
  // 其余以「标识符(」开头的调用（companyBlock/ownership/priceCol/line/windowMock…）
  // 都可能返回元素或元素数组，必须由调用方挂载。
  return /^[A-Za-z_$][\w$]*\s*\(/.test(value) ? 'element' : 'skip';
}

/* 数组字面量 + forEach 挂载：`[a,b].forEach(x => root.appendChild(x))`。
 * 只要列表后面 600 字符内出现挂载调用，就把列表里的标识符都当作已挂。 */
function arrayForEachMounted(masked) {
  const names = new Set();
  for (const match of masked.matchAll(/\[([^\[\]]{1,400})\]\s*\.\s*forEach\s*\(/g)) {
    const tail = masked.slice(match.index, match.index + 600);
    if (!/\.\s*(?:appendChild|append|add)\s*\(/.test(tail)) continue;
    for (const word of match[1].matchAll(/[A-Za-z_$][\w$]*/g)) names.add(word[0]);
  }
  return names;
}

/* `.map(...)` 造数组时，挂载往往写在回调里（root.appendChild(row)）。
 * 回调自己的语句能挂载整个数组，所以数组变量不需要再被点名 append。
 * 括号配对扫描，避免把后面的无关挂载算进来。 */
/* 所有 .map()/.flatMap() 结果：一律不是 Node。 */
function selfMountingArraysAll(text) {
  const out = [];
  for (const match of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n;]*?\.\s*(?:map|flatMap)\s*\(/g)) out.push(match[1]);
  return out;
}

/**
 * `.map()` 回调里建好、定位好、却从没挂到任何容器上的元素。
 *
 * 真实事故（S6）：回调里 `const wrap = mk(...)` + `abs(wrap, ...)`，
 * 却又把 wrap 塞进 `els` 数组返回成对象 —— 整行都不上屏。
 * 这类可以安全地补在回调内部（挂到 root），不需要模型做内容判断。
 */
function unmountedInsideMapCallbacks(text) {
  const out = [];
  const masked = maskJS(text);
  for (const match of masked.matchAll(/\.\s*(?:map|flatMap)\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0, end = masked.length;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === '(') depth++;
      else if (masked[i] === ')') { depth--; if (!depth) { end = i; break; } }
    }
    const body = masked.slice(open, end);
    const bodyStart = open;
    const bodyText = text.slice(bodyStart, end);
    const declared = [];
    for (const decl of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:abs\(\s*)?mk\(/g))
      declared.push({ name: decl[1], index: bodyStart + decl.index });
    if (!declared.length) continue;
    const mountedNames = new Set();
    for (const edge of body.matchAll(MOUNT_EDGE)) {
      // appendChild / append / add 的接收者可以是任何已存在节点
      mountedNames.add(edge[2]);
    }
    // 挂进本地数组元素（els.push(wrap)）也算挂载：数组随后由调用方处理
    for (const push of body.matchAll(/\.\s*push\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) mountedNames.add(push[1]);
    for (const decl of declared) {
      if (mountedNames.has(decl.name)) continue;
      out.push({ name: decl.name, index: decl.index, line: lineAt(text, decl.index) });
    }
    void bodyText;
  }
  return out;
}

function selfMountingArrays(masked) {
  const names = new Set();
  for (const match of masked.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n;]*?\.\s*(?:map|flatMap)\s*\(/g)) {
    const open = masked.indexOf('(', match.index + match[0].length - 1);
    let depthHere = 0, end = masked.length;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === '(') depthHere++;
      else if (masked[i] === ')') { depthHere--; if (!depthHere) { end = i; break; } }
    }
    const callback = masked.slice(open, end);
    if (/\.\s*(?:appendChild|append|add)\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(callback)) names.add(match[1]);
  }
  return names;
}

/* 从声明起点找到该语句真正的结束位置（分号或换行处的深度归零点）。
 * 多行实参、数组字面量都靠括号深度判断，不能停在第一个换行。 */
function statementEndIn(sceneText, from) {
  const masked = maskJS(sceneText);
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth < 0) return i; }
    else if (depth === 0 && c === ';') return i + 1;
    else if (depth === 0 && c === '\n') {
      // 括号已闭合且行尾不再是续行（没有逗号/运算符）→ 语句结束
      const before = sceneText.slice(from, i).trimEnd();
      if (before && !/[,+\-*/&|?:=]$/.test(before)) return i;
    }
  }
  return masked.length;
}

/**
 * 生成「补挂载」的确定性修改计划。
 *
 * 只补最外层：如果 X 挂在同样没挂的容器 Y 里（strip.appendChild(stag)），
 * 补 Y 就够了；给 stag 也补 root.appendChild(stag) 会把它从容器里拽到画面上
 * 变成错位叠字。父级补好后重新计算，直到没有新的可补项。
 *
 * 这是机械变换，不是创作：元素已经建好、坐标也算好了，唯一缺的就是挂载。
 */
export function planMountFixes(text) {
  /* 场次行号是「相对本场」的，插入时必须换算成整文件行号；
   * 否则 S8 的第 7 行会被当成文件第 7 行，插进 S1 里（这个 bug 会让每轮都
   * 插错位置、下一轮又判定没修好，8 轮插出 400 多行）。 */
  const chunkSpans = () => {
    const spans = [];
    let start = 0;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\/\/---\s*$/.test(lines[i])) { spans.push({ start, end: i, startLine: start, text: lines.slice(start, i).join('\n') }); start = i + 1; }
    }
    spans.push({ start, end: lines.length, startLine: start, text: lines.slice(start).join('\n') });
    return spans;
  };
  const inserted = [];
  let current = text;
  for (let pass = 0; pass < 8; pass++) {
    const lines = current.split('\n');
    const chunks = [];
    { let start = 0;
      for (let i = 0; i < lines.length; i++) {
        if (/^\/\/---\s*$/.test(lines[i])) { chunks.push({ startLine: start, text: lines.slice(start, i).join('\n') }); start = i + 1; }
      }
      chunks.push({ startLine: start, text: lines.slice(start).join('\n') });
    }
    const mountingUnmounted = new Set();
    for (const chunk of chunks) {
      const masked = maskJS(chunk.text);
      const missing = new Set(unmountedElements(chunk.text).map(item => item.name));
      if (!missing.size) continue;
      for (const edge of masked.matchAll(MOUNT_EDGE)) {
        if (missing.has(edge[1]) && missing.has(edge[2])) mountingUnmounted.add(edge[2]);
      }
    }
    const arrayResult = new Set(selfMountingArraysAll(current));
    const fixes = [];
    for (const [index, chunk] of chunks.entries()) {
      // .map() 回调内部建好却没挂的元素：挂到 root 即可，位置已由 abs() 定好。
      for (const item of unmountedInsideMapCallbacks(chunk.text)) {
        const statementEnd = statementEndIn(chunk.text, item.index);
        fixes.push({ chunk: index, name: item.name, scene: index + 1,
          line: chunk.startLine + item.line - 1,
          insertAfter: chunk.startLine + chunk.text.slice(0, statementEnd).split('\n').length - 1 });
      }
      for (const item of unmountedElements(chunk.text)) {
        if (mountingUnmounted.has(item.name)) continue;
        // .map()/.flatMap() 的返回值是数组（有时还是对象数组），
        // root.appendChild(数组) 会在运行时抛出 "parameter 1 is not of type Node"。
        // 这类不能由程序代挂，留给模型按内容决定（forEach 里挂、或展开元素）。
        if (arrayResult.has(item.name)) continue;
        // 语句的结尾才是安全插入点：多维数组/多行实参的声明，行的末尾仍在
        // 参数列表中间，插在那里会得到 `priceCol(a, b,\n root.appendChild(pA);`
        // —— 语法直接坏掉（真实事故：修好的稿子 S7 变成 missing )）。
        const statementEnd = statementEndIn(chunk.text, item.index);
        const insertAfter = chunk.startLine + chunk.text.slice(0, statementEnd).split('\n').length - 1;
        fixes.push({ chunk: index, name: item.name, line: chunk.startLine + item.line - 1, insertAfter, scene: index + 1 });
      }
    }
    if (!fixes.length) break;
    // 从后往前插，行号才不会被自己的插入挤掉。
    for (const fix of [...fixes].sort((a, b) => b.insertAfter - a.insertAfter)) {
      // 语句结束后紧跟一行挂载，顺序与作者原先书写一致。
      // 缩进取「声明那一行」，不取语句结尾那一行：多行实参的末行通常更深，
      // 照抄它会把挂载行推进参数里，读起来像参数的一部分。
      const declarationLine = Math.max(0, Math.min(lines.length - 1, fix.line));
      const indent = ((lines[declarationLine] || '').match(/^\s*/) || [''])[0];
      lines.splice(fix.insertAfter + 1, 0, `${indent}root.appendChild(${fix.name});`);
      inserted.push({ scene: fix.scene, name: fix.name });
    }
    current = lines.join('\n');
  }
  return { text: current, inserted };
}

export function unmountedElements(sceneText) {
  if (typeof sceneText !== 'string' || !sceneText.trim()) return [];
  const masked = maskJS(sceneText);
  const body = builderBody(masked);
  if (body == null) return [];
  const depth = depthTable(masked);
  // depth[] 记的是「该位置已经在第几层括号内」。场景体 `{` 本身已经把深度
  // 推到 base，所以顶层语句的深度就等于 base（不是 base+1）。
  const base = depth[body];

  const declarations = [];
  for (const match of masked.matchAll(DECL)) {
    if (match.index <= body) continue;
    if (depth[match.index] !== base) continue; // 只认场景顶层；函数内部的先建后 return 不在此判定
    const rhsStart = match.index + match[0].length;
    // 取到本语句结束：分号或换行（masked 保留换行，字符串已被抹平）
    const lineEnd = masked.indexOf('\n', rhsStart);
    const semi = masked.indexOf(';', rhsStart);
    const stop = [lineEnd < 0 ? masked.length : lineEnd, semi < 0 ? masked.length : semi].sort((a, b) => a - b)[0];
    const kind = classify(masked.slice(rhsStart, stop));
    if (kind === 'skip') continue;
    declarations.push({ name: match[1], line: lineAt(sceneText, match.index), index: match.index, mounted: kind === 'mounted' });
  }
  if (!declarations.length) return [];

  const reachable = new Set(['root']);
  for (const d of declarations) if (d.mounted) reachable.add(d.name);
  for (const name of arrayForEachMounted(masked)) reachable.add(name);
  for (const name of selfMountingArrays(masked)) reachable.add(name);
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of masked.matchAll(MOUNT_EDGE)) {
      if (!reachable.has(edge[1]) || reachable.has(edge[2])) continue;
      reachable.add(edge[2]); changed = true;
    }
  }
  // 同名多次声明（例如不同分支各建一次）时，只要有一处挂上就放行：
  // 这里不具备作用域分析能力，宁可漏判。
  const mountedNames = new Set();
  for (const edge of masked.matchAll(MOUNT_EDGE)) {
    if (reachable.has(edge[1])) mountedNames.add(edge[2]);
  }
  return declarations
    .filter(d => !d.mounted && !reachable.has(d.name))
    .filter(d => !mountedNames.has(d.name));
}
