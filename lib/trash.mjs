/* Only explicitly listed trash directories may be purged; hidden or unrelated
 * entries in the trash root are not part of a visible confirmation. */
import fs from 'node:fs';
import path from 'node:path';

function trashDir(root) {
  const dir = path.join(root, '.vh-trash');
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('回收站不是普通目录');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return dir;
}

export function trashNames(root) {
  try {
    return fs.readdirSync(trashDir(root), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name).sort();
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function trashEntry(root, name) {
  if (typeof name !== 'string' || !name || name.startsWith('.') || name.includes('/') || name.includes('\\') || !trashNames(root).includes(name)) {
    throw Object.assign(new Error('回收站里没有这一项'), { statusCode: 404 });
  }
  return path.join(trashDir(root), name);
}

export function emptyTrash(root, expectedNames) {
  if (!Array.isArray(expectedNames) || expectedNames.some(name => typeof name !== 'string') || new Set(expectedNames).size !== expectedNames.length) {
    throw Object.assign(new Error('请重新列出并确认回收站项目'), { statusCode: 400 });
  }
  const actual = trashNames(root);
  if (JSON.stringify(actual) !== JSON.stringify([...expectedNames].sort())) {
    throw Object.assign(new Error('回收站项目已变化；未删除，请刷新后重新确认'), { statusCode: 409 });
  }
  for (const name of actual) fs.rmSync(trashEntry(root, name), { recursive: true });
  const dir = trashDir(root);
  // Never remove unseen hidden files, non-directory entries or newly added items.
  try { fs.rmdirSync(dir); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
  return actual;
}
