/* Read-only asset fingerprints. No author-code execution, network, dependencies,
 * timestamp cache, or writes. Every call costs O(all assets bytes + source bytes);
 * large media are hashed synchronously in bounded chunks, not decoded as UTF-8.
 *
 * Coverage note: all regular files beneath assets/ (including unused/hidden files)
 * plus common, whitespace-free resource literals in the three root sources below.
 * Literals in comments or ordinary strings can conservatively be false positives.
 * This is NOT a JS/CSS/HTML interpreter: dynamically constructed/escaped paths,
 * whitespace-containing paths, srcset, external stylesheets and transitive resource
 * dependencies outside assets/ are not proven covered. Keep such inputs in assets/.
 * Source files themselves belong to the caller's separate source fingerprint.
 * As with other filesystem observations this is not an atomic snapshot against
 * concurrent directory replacement; stable symlinks at any project-local component
 * are rejected and file opens also use O_NOFOLLOW. Never read symlink targets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const SOURCES = ['engine.tpl.html', 'scenes.src.js', 'scene.html'];
const RESOURCE = /\.(?:svg|png|jpe?g|webp|gif|mp4|webm|mov|mp3|m4a|wav|woff2?|ttf|otf)$/i;
const CHUNK_SIZE = 64 * 1024;
const MAX_LITERAL = 8192;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const slash = value => value.split(path.sep).join('/');
const outside = value => value === '..' || value.startsWith('../') || path.isAbsolute(value);
const failure = (kind, file, code) => `${kind}: ${file}${code ? ` (${code})` : ''}`;

/* Comments may contain usage examples such as `videoEl(root,'assets/demo.mp4')`.
 * They are documentation, not loaded resources. Blank them while preserving
 * offsets/newlines. This is region-aware rather than a JS parser: running a JS
 * quote state machine over HTML prose would swallow real attributes after an
 * apostrophe (and silently stop detecting missing assets). */
function withoutComments(file, text) {
  const blank = s => s.replace(/[^\r\n]/g, ' ');
  const stripJs = s => {
    let out = '', i = 0;
    while (i < s.length) {
      const c = s[i], n = s[i + 1];
      if (c === '/' && n === '/') {
        const end = s.indexOf('\n', i + 2), stop = end < 0 ? s.length : end;
        out += blank(s.slice(i, stop)) + (end < 0 ? '' : '\n'); i = end < 0 ? s.length : end + 1;
      } else if (c === '/' && n === '*') {
        const end = s.indexOf('*/', i + 2), stop = end < 0 ? s.length : end + 2;
        out += blank(s.slice(i, stop)); i = stop;
      } else if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < s.length) { if (s[j] === '\\') { j += 2; continue; } if (s[j] === c) { j++; break; } j++; }
        out += s.slice(i, j); i = j;
      } else { out += c; i++; }
    }
    return out;
  };
  if (file === 'scenes.src.js') return stripJs(text);
  if (file === 'engine.tpl.html') return stripJs(text.replace(/<!--[\s\S]*?-->/g, blank));
  if (file !== 'scene.html') return text;
  return text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi, (_m, open, body, close) => open + stripJs(body) + close)
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_m, open, body, close) =>
      open + body.replace(/\/\*[\s\S]*?\*\//g, blank) + close);
}

// Search only bounded path-shaped literals, rather than pairing every quote in
// this JS/HTML/CSS mixture. An apostrophe in prose must not hide the next literal.
// The overlap also finds attributes inside templates and across read boundaries.
function sourceScanner(accept) {
  let tail = '';
  return text => {
    const window = tail + text;
    for (const match of window.matchAll(/(["'`])((?:\\\/|[^\s"'`<>{}()[\]\\\x00-\x1f]){1,8192})(?:\\)?\1/g)) {
      // Simple escaped slashes/HTML quotes are supported, never JS evaluation.
      accept(match[2].replace(/\\\//g, '/'));
    }
    for (const match of window.matchAll(/\burl\(\s*(?:"([^"\r\n]{1,8192})"|'([^'\r\n]{1,8192})'|([^\s)'"\r\n]{1,8192}))\s*\)/gi)) {
      accept(match[1] ?? match[2] ?? match[3]);
    }
    for (const match of window.matchAll(/\b(?:src|poster|href)\s*=\s*([^\s"'`=<>]{1,8192})/gi)) accept(match[1]);
    tail = window.slice(-MAX_LITERAL * 2);
  };
}

/**
 * Deterministic asset identity: { signature, files: [{ file, sha256, size }], issues }.
 * Paths and issue statuses, never mtime/absolute project location, define identity.
 * Missing assets/ and absent optional source files are normal empty inputs; missing
 * referenced files, unreadable paths, non-files and symlinks are explicit issues.
 * See the coverage note above: a signature cannot prove dynamic-path coverage.
 */
export function assetInputs(project) {
  const files = [], issues = new Set(), references = new Set();
  const result = () => {
    files.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    const sortedIssues = [...issues].sort();
    return { signature: sha256(JSON.stringify({ version: 1, files, issues: sortedIssues })), files, issues: sortedIssues };
  };
  let root;
  try {
    const info = fs.lstatSync(path.resolve(project));
    if (info.isSymbolicLink()) { issues.add(failure('symlink', '.')); return result(); }
    if (!info.isDirectory()) { issues.add(failure('not-directory', '.')); return result(); }
    // Resolve the explicitly supplied root once (e.g. macOS /var -> /private/var).
    root = fs.realpathSync(project);
  } catch (error) { issues.add(failure('unreadable', '.', error.code || 'UNKNOWN')); return result(); }

  function inspect(file, optional = false) {
    if (outside(file)) { issues.add(failure('outside-project', file)); return null; }
    let info;
    const parts = file.split('/');
    for (let i = 0; i < parts.length; i++) {
      const component = parts.slice(0, i + 1).join('/');
      try { info = fs.lstatSync(path.join(root, component)); }
      catch (error) {
        if (!(optional && error.code === 'ENOENT')) issues.add(failure(error.code === 'ENOENT' ? 'missing' : 'unreadable', file, error.code));
        return null;
      }
      if (info.isSymbolicLink()) { issues.add(failure('symlink', component)); return null; }
      if (i < parts.length - 1 && !info.isDirectory()) { issues.add(failure('not-directory', component)); return null; }
    }
    return info;
  }

  function readChunks(file, info, consume) {
    let fd;
    try {
      fd = fs.openSync(path.join(root, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
        issues.add(failure('changed-or-not-file', file)); return null;
      }
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(CHUNK_SIZE);
      let size = 0, n;
      while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) {
        const bytes = buffer.subarray(0, n);
        hash.update(bytes); size += n;
        consume?.(bytes);
      }
      const after = fs.fstatSync(fd);
      // Timestamps only detect a concurrent edit, never stand in for byte identity.
      if (after.size !== size || opened.size !== size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
        issues.add(failure('changed-during-read', file)); return null;
      }
      return { file, sha256: hash.digest('hex'), size };
    } catch (error) { issues.add(failure(error.code === 'ELOOP' ? 'symlink' : 'unreadable', file, error.code || 'UNKNOWN')); return null; }
    finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); }
        catch (error) { issues.add(failure('unreadable', file, error.code || 'UNKNOWN')); }
      }
    }
  }

  function accept(raw) {
    let value = raw.trim();
    // Do not fetch, inspect, or even stat network URLs, embedded bytes or anchors.
    if (!value || value.startsWith('#') || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return;
    value = value.split(/[?#]/, 1)[0];
    if (!RESOURCE.test(value) || /[\s<>"'`{}()[\]\\\x00-\x1f]/.test(value)) return;
    if (!path.posix.basename(value).replace(RESOURCE, '')) return;
    try { value = decodeURIComponent(value); }
    catch { issues.add(failure('invalid-path', value)); return; }
    if (/[\x00-\x1f\\]/.test(value)) { issues.add(failure('invalid-path', value.replace(/[\x00-\x1f]/g, '?'))); return; }
    // Normalizing before touching the filesystem catches ../ and encoded escapes.
    const file = slash(path.relative(root, path.resolve(root, value)));
    if (outside(file)) { issues.add(failure('outside-project', file)); return; }
    if (file) references.add(file);
  }

  for (const source of SOURCES) {
    const info = inspect(source, true);
    if (!info) continue;
    if (!info.isFile()) { issues.add(failure('not-file', source)); continue; }
    const decoder = new StringDecoder('utf8'), parts = [];
    readChunks(source, info, bytes => parts.push(decoder.write(bytes)));
    parts.push(decoder.end());
    // Mask comments only after a bounded chunked read; offsets/newlines stay intact.
    const scan = sourceScanner(accept);
    const text = withoutComments(source, parts.join(''));
    scan(text);
    scan('');
  }

  const pending = ['assets'], visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    const info = inspect(file, file === 'assets');
    if (!info) continue;
    if (info.isDirectory()) {
      try {
        for (const name of fs.readdirSync(path.join(root, file)).sort()) pending.push(`${file}/${name}`);
      } catch (error) { issues.add(failure('unreadable', file, error.code || 'UNKNOWN')); }
    } else if (info.isFile()) {
      visited.add(file);
      const fingerprint = readChunks(file, info);
      if (fingerprint) files.push(fingerprint);
    } else issues.add(failure('not-file', file));
  }
  for (const file of [...references].sort()) {
    if (visited.has(file)) continue;
    const info = inspect(file);
    if (!info) continue;
    if (!info.isFile()) { issues.add(failure('not-file', file)); continue; }
    const fingerprint = readChunks(file, info);
    if (fingerprint) files.push(fingerprint);
  }
  return result();
}
