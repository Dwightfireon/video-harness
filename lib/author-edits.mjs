/* Small author-file edits. No model calls, code execution, draft manifests or builds. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { unmountedElements } from './scene-mount.mjs';

const AUTHORS = new Set(['脚本.md', '方案.md', 'claims.json', 'scenes.src.js', 'engine.tpl.html', '发布文案.md', '审查.md']);
export const isAuthorFile = relative => AUTHORS.has(relative);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const inside = (root, file) => { const rel = path.relative(root, file); return rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); };

function snapshot(project, relative) {
  if (typeof relative !== 'string' || !AUTHORS.has(relative)) fail('INVALID_PATH', 'Only exact project-relative author text filenames are allowed; traversal and private state are forbidden.');
  const root = fs.realpathSync(project);
  const file = path.join(root, relative);
  const stat = fs.lstatSync(file);
  // Reject even internal symlinks: replacing a link would silently change its meaning.
  if (stat.isSymbolicLink() || !stat.isFile() || !inside(root, fs.realpathSync(file))) fail('INVALID_PATH', 'Author target must be a regular file inside the project, not a symlink.');
  const bytes = fs.readFileSync(file);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('NOT_TEXT', 'Author target must be valid UTF-8 text.'); }
  if (text.includes('\0')) fail('NOT_TEXT', 'Binary author targets are not allowed.');
  return { root, file, relative, stat, bytes, text, base_hash: hash(bytes) };
}

function cas(current, expected) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) fail('INVALID_BASE_HASH', 'base_hash must be the full-file SHA-256 returned by a read.');
  if (current.base_hash !== expected) fail('STALE_BASE_HASH', 'File changed since the read (stale base_hash); no write performed. Read it again before editing.');
}

// Deliberately never follow pre-existing links in the backup tree, even internal ones.
function directory(parent, name) {
  const dest = path.join(parent, name);
  try { fs.mkdirSync(dest, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const stat = fs.lstatSync(dest);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('INVALID_HISTORY', 'Edit history must be a real directory inside the project.');
  return dest;
}

function atomicFile(file, bytes, mode) {
  const temp = file + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function commit(current, text, details, recheck) {
  const next = Buffer.from(text, 'utf8');
  const result = { ok: true, path: current.relative, changed: !current.bytes.equals(next), previous_hash: current.base_hash,
    base_hash: hash(next), ...details };
  if (!result.changed) return { ...result, backup_path: null, message: 'Content is unchanged; no write or backup performed.' };
  const out = directory(current.root, 'out');
  const history = directory(out, '.vh-edit-history');
  const id = randomUUID();
  const entry = directory(history, id);
  const backup = path.join(entry, current.relative);
  atomicFile(backup, current.bytes, 0o600);
  atomicFile(path.join(entry, 'metadata.json'), JSON.stringify({ version: 1, id, created_at: new Date().toISOString(),
    path: current.relative, previous_hash: current.base_hash, base_hash: result.base_hash,
    original_mode: current.stat.mode & 0o7777, ...details }, null, 2) + '\n', 0o600);

  // Prepare the replacement completely before touching the original. Recheck CAS after
  // preparation, not only before it, so changes during backup cannot be overwritten.
  const temp = path.join(current.root, '.' + current.relative + '.' + id + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, next);
    fs.fchmodSync(fd, current.stat.mode & 0o7777);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    const latest = snapshot(current.root, current.relative);
    cas(latest, current.base_hash);
    if (latest.stat.ino !== current.stat.ino || latest.stat.dev !== current.stat.dev || latest.stat.mode !== current.stat.mode) fail('FILE_CHANGED', 'File identity or permissions changed during preparation; no write performed.');
    recheck?.();
    fs.renameSync(temp, current.file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return { ...result, backup_path: path.relative(current.root, backup).split(path.sep).join('/'), message: 'Exact edit saved atomically; original bytes backed up.' };
}

/** Zero-based line window; content retains its original line endings. Hash covers all bytes. */
export function readEditFile(project, relative, { start_line = 0, max_lines = 80 } = {}) {
  if (!Number.isInteger(start_line) || start_line < 0 || !Number.isInteger(max_lines) || max_lines < 1 || max_lines > 1000) fail('INVALID_WINDOW', 'start_line must be a nonnegative integer; max_lines must be 1–1000.');
  const current = snapshot(project, relative);
  const lines = current.text.match(/[^\n]*(?:\n|$)/g).filter(Boolean);
  return { path: relative, base_hash: current.base_hash, total_lines: lines.length, content: lines.slice(start_line, start_line + max_lines).join(''), start_line };
}

/** Chunked authoring for long documents: each call is bounded so one reply cannot
 *  exceed the model output limit. Existing files require the current full-file hash. */
export function appendText(project, relative, { base_hash, content, max_chars = 3000 } = {}, options = {}) {
  const root = fs.realpathSync(project);
  const file = path.join(root, relative);
  if (!AUTHORS.has(relative)) fail('INVALID_PATH', 'Only exact project-relative author text filenames are allowed.');
  if (!fs.existsSync(file)) {
    if (base_hash) fail('STALE_BASE_HASH', 'File does not exist, so base_hash cannot match; omit base_hash for the first batch.');
    const candidate = prepareAuthorEdit(relative, '', { operation: 'append_file', content, max_chars }, options);
    options.validate?.(candidate.text, candidate);
    options.beforeCommit?.();
    // First batch creates the file through the same atomic writer.
    const temp = path.join(root, '.' + relative + '.' + randomUUID() + '.tmp');
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, Buffer.from(content, 'utf8'));
      fs.closeSync(fd); fd = undefined;
      // Exclusive creation: unlike rename, linking cannot overwrite a file that
      // appeared after the initial existence check.
      options.validate?.(candidate.text, candidate);
      fs.linkSync(temp, file);
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    const created = snapshot(root, relative);
    return { ok: true, path: relative, changed: true, created: true, previous_hash: null, base_hash: created.base_hash,
      ...candidate.details, total_chars: created.text.length, backup_path: null,
      message: 'First batch created the file atomically; continue with append_file and this base_hash.' };
  }
  const current = snapshot(project, relative);
  cas(current, base_hash);
  const candidate = prepareAuthorEdit(relative, current.text, { operation: 'append_file', content, max_chars }, options);
  return { ...saveCandidate(current, candidate, options), total_chars: candidate.text.length };
}

/** Literal, non-overlapping replacements only. There is intentionally no full-file fallback. */
export function patchText(project, relative, { base_hash, ...edit } = {}, options = {}) {
  const current = snapshot(project, relative);
  cas(current, base_hash);
  return saveCandidate(current, prepareAuthorEdit(relative, current.text, { ...edit, operation: 'patch_text' }, options), options);
}

/** Read/CAS preflight for execution contracts; no backup, receipt or write. */
export function previewAuthorEdit(project, relative, { base_hash, ...edit }, options = {}) {
  const current = snapshot(project, relative);
  cas(current, base_hash);
  return prepareAuthorEdit(relative, current.text, edit, options);
}

function saveCandidate(current, candidate, options) {
  // All syntax, range, policy and baseline checks precede draft receipts/backups.
  options.validate?.(candidate.text, candidate);
  if (current.text !== candidate.text) options.beforeCommit?.();
  return commit(current, candidate.text, candidate.details, () => options.validate?.(candidate.text, candidate));
}

// A small lexical scanner, not a JavaScript evaluator. V8 handles actual syntax
// validation below; tokens establish the outer arrow and direct return/render shape.
function tokens(source) {
  const out = [];
  let i = 0, previous = '', controlClose = false, controlKeyword = false, statementClose = false;
  const parens = [], blocks = [];
  const expressionStart = () => controlClose || statementClose || !previous || /^(?:[({\[=,:;!?+*\/%<>~&|^\-]|=>|return|throw|case|delete|void|typeof|new|in|of|else|do|yield|await|&&|\|\||\?\?)$/.test(previous);
  function quoted(quote) {
    i++;
    while (i < source.length) { const ch = source[i++]; if (ch === '\\') i++; else if (ch === quote) return; }
    fail('INVALID_SCENE', 'Unterminated JavaScript literal.');
  }
  function template() {
    i++;
    while (i < source.length) {
      const ch = source[i++];
      if (ch === '\\') i++;
      else if (ch === '`') return;
      else if (ch === '$' && source[i] === '{') {
        i++;
        let depth = 1;
        const saved = { previous, controlClose, controlKeyword, statementClose };
        previous = '{'; controlClose = controlKeyword = statementClose = false;
        blocks.push(false); // interpolation's opening brace was consumed above
        while (i < source.length && depth) { const token = next(); if (!token) break; if (token.value === '{') depth++; if (token.value === '}') depth--; }
        ({ previous, controlClose, controlKeyword, statementClose } = saved);
        if (depth) fail('INVALID_SCENE', 'Unterminated template interpolation.');
      }
    }
    fail('INVALID_SCENE', 'Unterminated template literal.');
  }
  function next() {
    while (i < source.length) {
      if (/\s/.test(source[i])) { i++; continue; }
      if (source.startsWith('//', i)) { const end = /[\r\n\u2028\u2029]/.exec(source.slice(i + 2)); i = end ? i + 3 + end.index : source.length; continue; }
      if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); if (end < 0) fail('INVALID_SCENE', 'Unterminated JavaScript comment.'); i = end + 2; continue; }
      break;
    }
    if (i >= source.length) return null;
    const start = i;
    let value, kind;
    if (source[i] === '"' || source[i] === "'") { quoted(source[i]); value = '<literal>'; kind = 'string'; }
    else if (source[i] === '`') { template(); value = '<literal>'; kind = 'template'; }
    else if (source[i] === '/' && expressionStart()) {
      i++; let inClass = false, closed = false;
      while (i < source.length) {
        const ch = source[i++];
        if (ch === '\\') i++;
        else if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { closed = true; break; }
      }
      if (!closed) fail('INVALID_SCENE', 'Unterminated regular expression.');
      while (/[a-z]/i.test(source[i] || '') && i < source.length) i++;
      value = '<literal>';
    } else {
      const word = source.slice(i).match(/^(?:[\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*|\d+(?:\.\d+)?|=>|&&|\|\||\?\?|\+\+|--)/u);
      value = word ? word[0] : source[i]; i += value.length;
    }
    const closesControl = value === ')' && parens.pop();
    if (value === '(') parens.push(controlKeyword);
    if (value === '{') blocks.push(controlClose || ['else', 'do', 'try', 'finally'].includes(previous));
    statementClose = value === '}' && !!blocks.pop();
    controlClose = !!closesControl;
    controlKeyword = /^(?:if|while|for|with|switch|catch)$/.test(value) && previous !== '.' ||
      value === 'await' && previous === 'for' && controlKeyword;
    previous = value;
    return { value, kind, start, end: i };
  }
  let token;
  while ((token = next())) out.push(token);
  return out;
}

// Delimiter-aware structure checks after V8 has compiled (but never executed)
// the scene. Literal tokens hide their contents, so braces in regex/templates
// and nested render methods cannot masquerade as direct object properties.
function delimiterPairs(list) {
  const pairs = new Map(), stack = [], opening = new Set(['(', '[', '{']);
  for (let i = 0; i < list.length; i++) {
    const value = list[i].value;
    if (opening.has(value)) stack.push(i);
    else if ([')', ']', '}'].includes(value)) {
      const start = stack.pop();
      if (start === undefined || ({ ')': '(', ']': '[', '}': '{' })[value] !== list[start].value) fail('INVALID_SCENE', 'Scene token delimiters are not balanced.');
      pairs.set(start, i);
    }
  }
  if (stack.length) fail('INVALID_SCENE', 'Scene token delimiters are not balanced.');
  return pairs;
}

function unwrapped(list, pairs, start, end) {
  while (list[start]?.value === '(' && pairs.get(start) === end - 1) { start++; end--; }
  return [start, end];
}

function callableValue(list, pairs, start, end) {
  [start, end] = unwrapped(list, pairs, start, end);
  if (list[start]?.value === 'async' && list[start + 1]?.value !== '=>') start++;
  if (list[start]?.value === 'function') {
    start++;
    if (list[start]?.value === '*') start++;
    if (list[start]?.value !== '(') start++; // optional function name
    const close = pairs.get(start), body = close + 1;
    return list[start]?.value === '(' && list[body]?.value === '{' && pairs.get(body) === end - 1;
  }
  const paramsEnd = list[start]?.value === '(' ? pairs.get(start) : start;
  // V8 already verified valid arrow parameters and body syntax. Requiring the
  // arrow immediately after its parameters excludes calls and ||/comma values.
  if (paramsEnd === undefined || list[paramsEnd + 1]?.value !== '=>' || paramsEnd + 2 >= end) return false;
  const body = paramsEnd + 2;
  if (list[body].value === '{') return pairs.get(body) === end - 1;
  for (let i = body; i < end; i++) {
    if (list[i].value === ',') return false;
    if (pairs.has(i)) i = pairs.get(i);
  }
  return true;
}

function propertyName(token, source) {
  if (token.kind !== 'string') return token.value;
  const raw = source.slice(token.start + 1, token.end - 1);
  // Decode string keys as data, never through eval/VM. Unknown legacy escapes
  // are rejected rather than allowing an escaped duplicate render to slip by.
  let name = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { name += raw[i]; continue; }
    const escaped = raw[++i];
    if (escaped === '\n' || escaped === '\u2028' || escaped === '\u2029') continue;
    if (escaped === '\r') { if (raw[i + 1] === '\n') i++; continue; }
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
    if (Object.hasOwn(simple, escaped)) { name += simple[escaped]; continue; }
    if (escaped === 'x' || escaped === 'u') {
      const braced = escaped === 'u' && raw[i + 1] === '{';
      const match = (braced ? /^\{([a-f0-9]+)\}/i : escaped === 'x' ? /^([a-f0-9]{2})/i : /^([a-f0-9]{4})/i).exec(raw.slice(i + 1));
      if (!match) fail('INVALID_SCENE', 'Cannot prove the returned object property name.');
      name += String.fromCodePoint(parseInt(match[1], 16)); i += match[0].length;
    } else if (/\d/.test(escaped)) fail('INVALID_SCENE', 'Legacy numeric escapes in returned object keys are unsupported.');
    else name += escaped;
  }
  return name;
}

function returnedObject(list, pairs, start, end, source) {
  [start, end] = unwrapped(list, pairs, start, end);
  if (list[start]?.value !== '{' || pairs.get(start) !== end - 1) fail('INVALID_SCENE', 'Scene must return a direct object literal with render.');
  let renders = 0;
  for (let at = start + 1; at < end - 1;) {
    const begin = at;
    // Find a whole direct property; nested groups (including parameter defaults,
    // templates and object-valued properties) never participate in key matching.
    while (at < end - 1 && list[at].value !== ',') at = pairs.has(at) ? pairs.get(at) + 1 : at + 1;
    const propertyEnd = at;
    let key = begin;
    if (['.', '['].includes(list[key]?.value)) fail('INVALID_SCENE', 'Computed keys and spread in the returned scene object cannot prove a stable render; use explicit properties.');
    let methodPrefix = false;
    if (['async', 'get', 'set'].includes(list[key]?.value) && list[key + 1]?.value !== ':' && list[key + 1]?.value !== '(') { methodPrefix = true; key++; }
    if (list[key]?.value === '*') key++;
    if (list[key]?.value === '[') fail('INVALID_SCENE', 'Computed keys in the returned scene object are unsupported; use explicit properties.');
    const name = propertyName(list[key], source);
    if (name === 'render') {
      renders++;
      if (renders > 1) fail('INVALID_SCENE', 'Duplicate render keys in the returned scene object are forbidden.');
      const next = list[key + 1]?.value;
      if (next === ':') {
        if (!callableValue(list, pairs, key + 2, propertyEnd)) fail('INVALID_SCENE', 'render must be a direct callable function or arrow.');
      } else {
        const close = pairs.get(key + 1), body = close + 1;
        const accessor = methodPrefix && ['get', 'set'].includes(list[begin].value);
        if (accessor || next !== '(' || list[body]?.value !== '{' || pairs.get(body) !== propertyEnd - 1) fail('INVALID_SCENE', 'render must be a callable method, not an accessor or shorthand value.');
      }
    }
    at++; // comma, or object end
  }
  if (renders !== 1) fail('INVALID_SCENE', 'The returned scene object must have one direct callable render property.');
}

function checkedScene(content, { requireMount = false, knownNames = null } = {}) {
  if (typeof content !== 'string' || !content.trim() || content.length > 50000 || content.includes('\0') || /^\/\/---\s*$/m.test(content)) fail('INVALID_SCENE', 'Supply one complete scene, without //--- separators, at most 50000 characters.');
  try {
    new Script(`(${content}\n)`);
    // A second compile in a property-value position also rules out comma-separated
    // arrow expressions without evaluating a function or relying on token guesses.
    new Script(`({ __vh_scene: ${content}\n})`);
  } catch { fail('INVALID_SCENE', 'Scene JavaScript is malformed, incomplete or contains extra expressions; no write performed.'); }
  const list = tokens(content), values = list.map(t => t.value), pairs = delimiterPairs(list);
  // The draft generator also accepts an expression-bodied arrow. Validate its
  // returned object with the SAME direct-render rule without normalizing or
  // rewriting any author bytes.
  const expression = values.slice(0, 2).join(' ') === 'root =>' ? 2 :
    values.slice(0, 4).join(' ') === '( root ) =>' ? 4 : null;
  if (expression != null && values[expression] === '(') {
    returnedObject(list, pairs, expression, list.length, content);
    if (requireMount) mountGuard(content, { strict: requireMount === 'strict', knownNames });
    return content.trim();
  }
  let open;
  if (values.slice(0, 3).join(' ') === 'root => {') open = 2;
  else if (values.slice(0, 5).join(' ') === '( root ) => {') open = 4;
  else if (values.slice(0, 5).join(' ') === 'function ( root ) {') open = 4;
  else fail('INVALID_SCENE', 'Scene must be one root builder returning an object with render.');
  const close = pairs.get(open);
  if (close !== list.length - 1) fail('INVALID_SCENE', 'Scene must be a single root builder; extra expressions are forbidden.');
  let returns = 0;
  for (let j = open + 1; j < close; j++) {
    if (values[j] === 'return' && values[j - 1] !== '.') {
      const start = j + 1;
      if (!list[start] || /[\r\n\u2028\u2029]/.test(content.slice(list[j].end, list[start].start))) fail('INVALID_SCENE', 'Scene return must not be separated from its object by a newline.');
      const end = pairs.has(start) ? pairs.get(start) + 1 : start + 1;
      returnedObject(list, pairs, start, end, content);
      // Do not confuse an accessed/called/conditional object expression with the
      // actual return value. A direct object may end with ;, }, or ASI newline.
      if (end < close && values[end] !== ';' && !/[\r\n\u2028\u2029]/.test(content.slice(list[end - 1].end, list[end].start))) fail('INVALID_SCENE', 'Scene must return the object itself, without extra expressions.');
      if (['.', '[', '(', '?', ',', '+', '-', '*', '/', '%', '&', '|', '^', '=', '!', '<', '>', '&&', '||', '??', 'in', 'instanceof'].includes(values[end]) || list[end]?.kind === 'template') fail('INVALID_SCENE', 'Scene must return the object itself, not a derived expression.');
      returns++; j = end - 1;
    } else if (pairs.has(j)) j = pairs.get(j);
  }
  if (!returns) fail('INVALID_SCENE', 'Scene must directly return an object with render; nested returns are not sufficient.');
  if (requireMount) mountGuard(content, { strict: requireMount === 'strict', knownNames });
  return content.trim();
}

function mountError(missing, { strict }) {
  const shown = missing.slice(0, 6).map(item => `第 ${item.line} 行 \`${item.name}\``).join('；');
  fail('UNMOUNTED_ELEMENTS',
    `这一场建了元素却没有挂到画面上，不会显示：${shown}${missing.length > 6 ? `（共 ${missing.length} 处）` : ''}。` +
    '每个 mk() 建出来的元素都要 root.appendChild(name)（或挂进一个已挂载的容器）；' +
    '否则整场是空的，语法检查看不出来。' +
    (strict ? '整场重写必须把这一场全部挂好再写。' : '补上这几行的挂载；不要新增「只建不挂」的元素。'));
}

function mountGuard(content, options = { strict: false, knownNames: null }) {
  const missing = unmountedElements(content);
  if (!missing.length) return;
  /* 局部补丁的判定是「不许新增空白元素」：旧场次本来就没挂好时，模型需要
   * 一处一处补 root.appendChild，不能因为还剩别的没挂就被整份否决。
   * 整场重写（写草稿 / replace_scene / 新增一场）必须一次挂好。 */
  if (!options.strict && options.knownNames) {
    const fresh = missing.filter(item => !options.knownNames.has(item.name));
    if (!fresh.length) return;
    return mountError(fresh, { strict: false });
  }
  mountError(missing, options);
}

// Draft generation and later edits must agree on which complete scene shapes
// are legal; syntax checks never execute a project's JavaScript.
// 草稿是「一整场」的完整交付，必须同时证明画面确实挂上去了；整文件补丁只对
// 被改动的场做这项检查（见 prepareAuthorEdit），否则一个旧场次不达标会让所有
// 后续补丁永久失败。
export const validateSceneSource = content => checkedScene(content, { requireMount: 'strict' });

function sceneChunks(text) {
  const chunks = [];
  let start = 0;
  for (const match of text.matchAll(/^\/\/---\s*$/gm)) {
    if (text.slice(start, match.index).trim()) chunks.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  if (text.slice(start).trim()) chunks.push({ start, end: text.length });
  return chunks;
}

function sceneSpan(text, scene) {
  const chunks = sceneChunks(text);
  if (!Number.isInteger(scene) || scene < 1 || scene > chunks.length) fail('INVALID_SCENE_NUMBER', `scene must be an integer in 1–${chunks.length}; no write performed.`);
  const chunk = chunks[scene - 1];
  const raw = text.slice(chunk.start, chunk.end);
  const list = tokens(raw);
  if (!list.length) fail('INVALID_SCENE', 'Selected chunk has no scene expression.');
  // Keep file headers and ordinary leading/trailing comments in place. Layout tags
  // belong to the replaceable scene; all whitespace outside that span stays exact.
  const prefix = raw.slice(0, list[0].start);
  const layout = /^\/\/\s*@layout\b[^\r\n]*/m.exec(prefix);
  const begin = layout ? layout.index : list[0].start;
  const end = list[list.length - 1].end;
  return { chunks, start: chunk.start + begin, end: chunk.start + end,
    content: raw.slice(begin, end), scene, total_scenes: chunks.length };
}

function sceneSnapshot(project, scene) {
  const current = snapshot(project, 'scenes.src.js');
  return { current, ...sceneSpan(current.text, scene) };
}

/** scene_hash covers precisely the returned content; base_hash covers the whole file. */
export function readScene(project, sceneNumber) {
  const scene = sceneSnapshot(project, sceneNumber);
  return { scene: scene.scene, total_scenes: scene.total_scenes, base_hash: scene.current.base_hash,
    scene_hash: hash(scene.content), content: scene.content };
}

export function replaceScene(project, sceneNumber, { base_hash, content } = {}, options = {}) {
  const current = snapshot(project, 'scenes.src.js');
  cas(current, base_hash);
  return saveCandidate(current, prepareAuthorEdit('scenes.src.js', current.text,
    { operation: 'replace_scene', scene: sceneNumber, content }, options), options);
}

function scriptChunks(text) {
  // Ignore example headings inside Markdown fences, preserving source offsets.
  let fence = null, offset = 0;
  const headings = [];
  for (const line of text.match(/[^\n]*(?:\n|$)/g).filter(Boolean)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (!fence) {
      const match = /^##\s*S(\d+)\b/.exec(line);
      if (match) headings.push({ index: offset, scene: Number(match[1]) });
    }
    offset += line.length;
  }
  return headings.map((m, i) => ({ start: m.index, end: headings[i + 1]?.index ?? text.length, scene: m.scene }));
}

export function authorEditImpact(relative, before, after) {
  if (before === after) return { affectedScenes: [], sharedImpact: false };
  if (relative === 'scenes.src.js') {
    const old = sceneChunks(before), next = sceneChunks(after);
    const affectedScenes = Array.from({ length: Math.max(old.length, next.length) }, (_, i) => i)
      .filter(i => !old[i] || !next[i] || before.slice(old[i].start, old[i].end) !== after.slice(next[i].start, next[i].end)).map(i => i + 1);
    const separators = text => [...text.matchAll(/^\/\/---\s*$/gm)].map(m => m[0]);
    return { affectedScenes, sharedImpact: old.length !== next.length || JSON.stringify(separators(before)) !== JSON.stringify(separators(after)) };
  }
  if (relative === '脚本.md') {
    const old = scriptChunks(before), next = scriptChunks(after), numbers = new Set([...old, ...next].map(c => c.scene));
    const part = (text, chunks, n) => chunks.filter(c => c.scene === n).map(c => text.slice(c.start, c.end)).join('');
    return { affectedScenes: [...numbers].filter(n => part(before, old, n) !== part(after, next, n)),
      sharedImpact: before.slice(0, old[0]?.start ?? before.length) !== after.slice(0, next[0]?.start ?? after.length) ||
        old.map(c => c.scene).join(',') !== next.map(c => c.scene).join(',') };
  }
  // No claim of runtime dependency analysis: common author inputs may affect all
  // scenes. Publish/review text does not change the video source itself.
  return { affectedScenes: [], sharedImpact: !['发布文案.md', '审查.md'].includes(relative) };
}

/** Pure candidate preparation. Never evaluates author JS or touches the filesystem.
 * scene is a trusted execution scope, not a parameter the model may grant itself.
 * Impact is a source-change receipt, NOT semantic completion or layout approval. */
export function prepareAuthorEdit(relative, before, edit, { scene: scope = null } = {}) {
  if (!AUTHORS.has(relative) || typeof before !== 'string') fail('INVALID_PATH', 'Only author text files are allowed.');
  const operation = edit.operation;
  let text, details = { operation }, ranges = [];
  if (operation === 'patch_text') {
    const { find, replace, expected_count = 1 } = edit;
    if (typeof find !== 'string' || !find || typeof replace !== 'string' || replace.includes('\0')) fail('INVALID_PATCH', 'find must be nonempty text and replace must be text.');
    if (!Number.isInteger(expected_count) || expected_count < 1 || expected_count > 1000) fail('INVALID_COUNT', 'expected_count must be an exact integer from 1 to 1000.');
    const parts = before.split(find), count = parts.length - 1;
    if (count !== expected_count) {
      /* 只报「期望 3 实际 1」等于让模型再猜一次。真实事故：模型连续两次
       * 在同一处猜 expected_count（3→1、2→1），每次都失败，并把失败当成
       * 「文件没读到」继续整份扫描，直到被判空转。这里直接给出实际命中的
       * 行号与可照抄的 expected_count，让下一步只有一种写法。 */
      const lineOf = (text, at) => text.slice(0, at).split('\n').length;
      const hits = [];
      let at = -1;
      while ((at = before.indexOf(find, at + 1)) >= 0 && hits.length < 8) hits.push({ line: lineOf(before, at), column: at - before.lastIndexOf('\n', at) });
      const where = [...new Set(hits.map(hit => hit.line))];
      const location = where.length === 1
        ? `第 ${where[0]} 行（第 ${hits.map(hit => hit.column).join('、')} 个字符处）`
        : `第 ${where.join('、')} 行`;
      const suggestion = count === 0
        ? `文件里没有这段原文（find 必须逐字匹配，包含缩进与换行）。先用 read_edit_file 取当前范围，照着页面上的原文复制。`
        : `实际命中 ${count} 处：${location}。` +
          (count === 1
            ? `把 expected_count 改成 1 即可。`
            : `要么把 expected_count 改成 ${count}（一次性全改），要么在 find 里多带几行上下文，只命中你想改的那一处。`);
      fail('OCCURRENCE_MISMATCH', `patch_text 未执行：期望精确 ${expected_count} 处，实际 ${count} 处。` + suggestion);
    }
    let offset = 0;
    for (let i = 0; i < count; i++) { offset += parts[i].length; ranges.push({ start: offset, end: offset + find.length }); offset += find.length; }
    text = parts.join(replace); details.replacements = count;
  } else if (operation === 'replace_scene') {
    if (relative !== 'scenes.src.js') fail('INVALID_PATH', 'replace_scene only edits scenes.src.js.');
    const selected = sceneSpan(before, edit.scene), replacement = checkedScene(edit.content);
    const suffix = before.slice(selected.end), tail = replacement.slice(tokens(replacement).at(-1).end);
    const boundary = /\/\/[^\r\n]*$/.test(tail) && /^[^\S\r\n]*\//.test(suffix) ? '\n' : '';
    text = replacement === selected.content ? before : before.slice(0, selected.start) + replacement + boundary + suffix;
    ranges = [{ start: selected.start, end: selected.end }];
    details = { ...details, scene: edit.scene, total_scenes: selected.total_scenes, scene_hash: hash(replacement) };
  } else if (operation === 'append_file' || operation === 'initialize_file') {
    if (typeof edit.content !== 'string' || !edit.content.trim() || edit.content.includes('\0')) fail('INVALID_CONTENT', 'content must be nonempty text without NUL bytes.');
    if (operation === 'append_file') {
      const { max_chars = 3000 } = edit;
      if (!Number.isInteger(max_chars) || max_chars < 500 || max_chars > 12000) fail('INVALID_LIMIT', 'max_chars must be 500–12000.');
      if (edit.content.length > max_chars) fail('CONTENT_TOO_LONG', `这一批 ${edit.content.length} 字符，超过单批上限 ${max_chars}；请拆成更小的批次，不要一次写完整文件。`);
      if (before.length && !before.endsWith('\n') && !edit.content.startsWith('\n')) fail('MISSING_SEPARATOR', 'Existing file does not end with a newline; start the next batch with a newline or use patch_text.');
    }
    text = operation === 'append_file' ? before + edit.content : edit.content;
    ranges = [{ start: operation === 'append_file' ? before.length : 0, end: before.length }];
    if (operation === 'append_file') details.appended_chars = edit.content.length;
  } else fail('INVALID_OPERATION', 'Unsupported author edit operation.');

  if (relative === 'scenes.src.js') {
    const chunks = sceneChunks(text);
    if (!chunks.length) fail('INVALID_SCENE', 'Candidate must contain complete scenes.');
    /* Validate EVERY chunk, including untouched scenes. A patch cannot bypass
     * the same complete return/render structure required by replace_scene.
     * 但「挂不挂到画面上」只对本次真正改动的场次强制：旧场次已有空白问题
     * 时，若每个补丁都被整份文件否决，修复就永远推进不了（真实事故：96 轮
     * 零写入，正是因为每次 patch 都撞在别人的旧问题上）。
     * 按「逐字相同」配对旧场次，因此插入/删除一场不会把其他场误判成已改动。 */
    const unchanged = new Set(sceneChunks(before).map(chunk => before.slice(chunk.start, chunk.end)));
    const preexistingUnmounted = new Set(sceneChunks(before)
      .flatMap(chunk => unmountedElements(before.slice(chunk.start, chunk.end)).map(item => item.name)));
    for (let i = 0; i < chunks.length; i++) {
      const body = text.slice(chunks[i].start, chunks[i].end);
      const isUnchanged = unchanged.delete(body);
      // 改动过的场：只要没有**新增**未挂载元素就放行，这样一处一处补挂载可以推进；
      // 退回空场（或新写一整场）仍然拒绝。
      try { checkedScene(body, { requireMount: !isUnchanged, knownNames: preexistingUnmounted }); }
      catch (error) { error.message = `S${i + 1}: ${error.message}`; throw error; }
    }
  }
  const actual = authorEditImpact(relative, before, text);
  if (scope != null) {
    if (!Number.isInteger(scope) || scope < 1) fail('INVALID_SCENE_NUMBER', 'Trusted scene scope must be a positive integer.');
    const chunks = relative === 'scenes.src.js' ? sceneChunks(before) : relative === '脚本.md' ? scriptChunks(before) : [];
    const selected = relative === '脚本.md' ? chunks.find(c => c.scene === scope) : chunks[scope - 1];
    if (!selected || (operation === 'replace_scene' && edit.scene !== scope) || actual.sharedImpact ||
      actual.affectedScenes.some(n => n !== scope) || ranges.some(r => r.start < selected.start || r.end > selected.end)) {
      fail('SCENE_SCOPE_VIOLATION', `当前任务是 S${scope}；候选修改越出本场范围，未写入。`);
    }
  }
  return { path: relative, text, details: { ...details, ...actual, impactBasis: 'author-source-bytes' }, ...actual };
}

/** Only an empty file or the exact installed scaffold can be initialized again.
 * This is not a full-file fallback for an existing authored draft. */
export function initializeAuthorFile(project, relative, content, options = {}) {
  const current = snapshot(project, relative);
  let installed;
  try { installed = JSON.parse(fs.readFileSync(path.join(current.root, 'PROJECT.json'), 'utf8')).installedFiles?.[relative]; } catch {}
  if (current.bytes.length && installed !== current.base_hash) fail('EXISTING_AUTHOR_FILE', `已有 ${relative} 不能整份覆盖；先 read_edit_file，再用 patch_text / append_file / replace_scene 受控修改并备份。`);
  const candidate = prepareAuthorEdit(relative, current.text, { operation: 'initialize_file', content }, options);
  return saveCandidate(current, candidate, options);
}
