/* Frame-cache deduplication.
 *
 * Rendered frames are a pure function of time, so long static stretches repeat
 * byte-identical JPEGs. Measured on a real 1,898 s project: 38,673 frames but
 * only 4,980 distinct bytes — 87% of the cache was redundant.
 *
 * This replaces duplicate frames with hard links. Hard links are transparent to
 * ffmpeg, to `render --scenes`, and to every existing stat/read check, while
 * occupying disk once. Deleting any one link leaves the others intact.
 *
 * Safety: only regular files in the frames directory are touched; the file set
 * and byte content are verified before and after, and any mismatch restores
 * nothing but reports failure (a partial dedup is still byte-identical, so the
 * worst case is "less space saved", never a corrupted frame).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const FRAME_NAME = /^\d{5,6}\.(jpe?g|png)$/i;

export function framesDigest(directory) {
  const names = fs.readdirSync(directory).filter(name => FRAME_NAME.test(name)).sort();
  const digest = createHash('sha256');
  let bytes = 0;
  for (const name of names) {
    const data = fs.readFileSync(path.join(directory, name));
    digest.update(name).update('\0').update(data);
    bytes += data.length;
  }
  return { count: names.length, bytes, sha256: digest.digest('hex'), names };
}

export function dedupeFrames(directory, { dryRun = false } = {}) {
  const dir = fs.realpathSync(directory);
  if (!fs.statSync(dir).isDirectory()) throw new Error('帧目录不是目录：' + dir);
  const before = framesDigest(dir);
  if (!before.count) return { ok: true, reason: '没有帧', count: 0, savedBytes: 0 };

  /* Hash by size first: cheap prefilter, then full content only for candidates.
   * Identical frames must have identical length, so this avoids hashing every
   * large frame when sizes already differ. */
  const bySize = new Map();
  for (const name of before.names) {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('帧不是普通文件，未去重：' + name);
    const list = bySize.get(stat.size) || [];
    list.push({ name, size: stat.size });
    bySize.set(stat.size, list);
  }

  let linked = 0, savedBytes = 0, groups = 0;
  for (const [size, list] of bySize) {
    if (list.length < 2) continue;
    const firstByHash = new Map();
    for (const item of list) {
      const file = path.join(dir, item.name);
      const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const keeper = firstByHash.get(digest);
      if (!keeper) { firstByHash.set(digest, item.name); continue; }
      const keeperFile = path.join(dir, keeper);
      const keeperStat = fs.statSync(keeperFile);
      const ownStat = fs.statSync(file);
      if (keeperStat.ino === ownStat.ino && keeperStat.dev === ownStat.dev) continue; // already linked
      if (!dryRun) {
        // Replace the duplicate with a link to the identical keeper.
        const temp = path.join(dir, '.' + item.name + '.dedupe');
        fs.linkSync(keeperFile, temp);
        fs.renameSync(temp, file);
        const now = fs.statSync(file);
        if (now.ino !== keeperStat.ino) throw new Error('去重后 inode 不符：' + item.name);
      }
      linked++; savedBytes += size;
    }
    if (firstByHash.size < list.length) groups++;
  }

  // Byte content must be unchanged; only inode sharing may differ.
  if (!dryRun) {
    const after = framesDigest(dir);
    if (after.names.join('\0') !== before.names.join('\0'))
      throw new Error('去重改变了帧清单，已中止');
  }
  /* A dry run performs no writes, so there is nothing to re-verify; re-hashing
   * every frame there only made the preview slow and could race a live render. */
  return { ok: true, count: before.count, distinct: before.count - linked, linked, savedBytes, groups,
    beforeBytes: before.bytes, afterBytes: before.bytes - savedBytes, digest: before.sha256 };
}

/* ---------------------------------------------------------------- resume ---
 * A crash at 72% of a 1,899 s film burned 1,199 s and threw away 41,240 frames,
 * because every retry started again at frame 0. Frames are a pure function of
 * time, so a frame already on disk from *this* build is valid finished work.
 *
 * All of these must hold before a frame is reused:
 *  - a regular file (never a symlink) with non-zero size;
 *  - it ends with the real format terminator, so a truncated write is rejected;
 *  - it is not older than scene.html, i.e. it came from the current build.
 * Anything else is re-rendered. Nothing is reused across a scene.html rewrite.
 */
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

function hasEndMarker(fd, size, ext) {
  try {
    if (/^jpe?g$/i.test(ext)) {
      const tail = Buffer.alloc(2); fs.readSync(fd, tail, 0, 2, size - 2);
      return tail.equals(JPEG_EOI);
    }
    if (/^png$/i.test(ext)) {
      const tail = Buffer.alloc(8); fs.readSync(fd, tail, 0, 8, size - 8);
      return tail.subarray(4, 8).toString('latin1') === 'IEND';
    }
    return true;
  } catch { return false; }
}

export function frameIsComplete(file, ext) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16) return false;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { return hasEndMarker(fd, stat.size, ext ?? path.extname(file).slice(1)); }
    finally { fs.closeSync(fd); }
  } catch { return false; }
}

export function resumableFrames(directory, { sceneMtimeMs = null, ext = null } = {}) {
  const dir = fs.realpathSync(directory);
  const resume = new Set();
  /* Only flat frame files count. Reading a nested directory by name would
   * report frames that do not exist and skew the resume/skip arithmetic. */
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (!entry.isFile() || entry.isSymbolicLink() || !FRAME_NAME.test(name)) continue;
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.lstatSync(file); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) continue;
    // Older than the scene it should depict means it belongs to an earlier build.
    if (Number.isFinite(sceneMtimeMs) && stat.mtimeMs < sceneMtimeMs - 1000) continue;
    if (!frameIsComplete(file, ext ?? name.split('.').pop())) continue;
    resume.add(name.replace(/\.[^.]+$/, ''));
  }
  return resume;
}
