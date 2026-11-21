import fs from 'node:fs';
import path from 'node:path';

const denied = () => Object.assign(new Error('文件不在公开范围内'), { statusCode: 403 });
const publicTypes = new Set(['.html', '.css', '.js', '.mjs', '.md', '.txt', '.srt', '.vtt', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.mp4', '.mov', '.webm', '.wav', '.mp3', '.m4a', '.ogg', '.woff', '.woff2', '.ttf', '.otf', '.pdf', '.zip']);
const authorFiles = new Set(['PROJECT.json', 'claims.json', 'timing.json', 'sources.json', 'voice-kokoro.py']);
const publicDirs = new Set(['assets', 'materials', 'research', 'out', 'stills', 'covers']);

export function publicParts(relative) {
  const parts = relative.split('/');
  if (!relative || parts.some(p => !p || p === '..' || p.startsWith('.') || p === 'node_modules' || p.includes('\\') || p.includes('\0'))) throw denied();
  return parts;
}

/* Open before reading and stream from that descriptor, never reopen by name.
 * macOS O_NOFOLLOW_ANY rejects symlinks in *every* component atomically. Linux
 * walks from pinned directory fds with O_NOFOLLOW (Node has no openat API).
 * Other platforms fail closed rather than claim a check-then-open is safe.
 * root must be a canonical, trusted root selected at server startup. */
export function openSafeFile(root, relative) {
  const parts = publicParts(relative);
  const { O_RDONLY, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK } = fs.constants;
  let fd;
  try {
    if (process.platform === 'darwin') {
      // Darwin rejects combining O_NOFOLLOW and O_NOFOLLOW_ANY (EINVAL).
      fd = fs.openSync(path.join(root, ...parts), O_RDONLY | O_NONBLOCK | 0x20000000 /* O_NOFOLLOW_ANY */);
    } else if (process.platform === 'linux') {
      let dir = fs.openSync(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      try {
        for (let i = 0; i < parts.length; i++) {
          const next = fs.openSync(`/proc/self/fd/${dir}/${parts[i]}`, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | (i < parts.length - 1 ? O_DIRECTORY : 0));
          if (i === parts.length - 1) fd = next;
          else { fs.closeSync(dir); dir = next; }
        }
      } finally { fs.closeSync(dir); }
    } else throw denied();
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw denied();
    return { fd, stat };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (['ELOOP', 'EMLINK', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw denied();
    if (error.code === 'ENOENT') error.statusCode = 404;
    throw error;
  }
}

/* Explicit public surface: bundled demos/shared assets, or author files and
 * media of a registered project. Never repository code, config or state. */
export function isPublicFile(root, relative) {
  const parts = publicParts(relative), name = parts.at(-1), ext = path.extname(name).toLowerCase();
  if (['demo', 'assets'].includes(parts[0]) && parts.length > 1) return publicTypes.has(ext) || (ext === '.json' && parts[0] === 'demo');
  for (let i = parts.length - 1; i > 0; i--) {
    let marker;
    try { marker = openSafeFile(root, [...parts.slice(0, i), 'PROJECT.json'].join('/')); }
    catch (error) { if (error.statusCode === 403) throw error; continue; }
    fs.closeSync(marker.fd);
    const within = parts.slice(i);
    if (within.length === 1) return authorFiles.has(name) || publicTypes.has(ext);
    return publicDirs.has(within[0]) && (publicTypes.has(ext) || (ext === '.json' && ['assets', 'materials', 'research'].includes(within[0])));
  }
  return false;
}

export function byteRange(value, size) {
  if (value == null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || !size) return false;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}
