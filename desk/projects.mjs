/* 项目扫描：目录枚举 + 通过 adapter 读取项目内容 + compose 组装草稿。
 *
 * 这一层不解析 发布文案.md、不知道成片凭证怎么算；那些都在 harness-adapter 里。
 * 单测注入假 adapter 即可，不需要真实视频或 ffmpeg。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarnessAdapter } from './harness-adapter.mjs';
import { composeDraft } from './draft.mjs';
import { projectBusy, sameProjectAttempt } from '../lib/project-state.mjs';

export const DESK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECTS_DIR = path.join(DESK_ROOT, 'projects');

const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return '' }; };
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const isDir = file => { try { return fs.statSync(file).isDirectory(); } catch { return false; } };

/* 没有发布文案时，用脚本里的第一句/标题当线索，否则列表只剩目录名，认不出是哪个视频。 */
export function scriptHint(dir) {
  const script = read(path.join(dir, '脚本.md'));
  if (!script.trim()) return '';
  // 优先取 "## S1 · XXX" 的场景标题
  const scene = script.match(/^##\s*S\d+\s*[·•\-—]?\s*(.+)$/m);
  if (scene?.[1]) return scene[1].trim().slice(0, 40);
  // 退一步取第一句旁白
  const line = script.split('\n').map(l => l.replace(/^\d+\.\s*/, '').trim())
    .find(l => l && !l.startsWith('#') && !l.startsWith('**') && !l.startsWith('←'));
  return line ? line.slice(0, 40) : '';
}


/* 目录名只允许单层、无分隔符、无 ..；再比一次 realpath，挡住符号链接外逃。 */
export function resolveProject(root, name) {
  const base = path.join(root, 'projects');
  if (typeof name !== 'string' || !name || name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error('项目名无效');
  }
  const dir = path.join(base, name);
  try {
    if (!fs.statSync(path.join(dir, 'PROJECT.json')).isFile()) throw Object.assign(new Error('不是视频项目（缺少 PROJECT.json）：' + name), { code: 'PROJECT_NOT_FOUND' });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw Object.assign(new Error('不是视频项目（缺少 PROJECT.json）：' + name), { code: 'PROJECT_NOT_FOUND' });
    throw error;
  }
  const real = fs.realpathSync(dir), realBase = fs.realpathSync(base);
  if (path.dirname(real) !== realBase) throw new Error('项目路径越界：' + name);
  return real;
}

export function listProjectDirs(root = DESK_ROOT) {
  const base = path.join(root, 'projects');
  if (!isDir(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .filter(entry => isFile(path.join(base, entry.name, 'PROJECT.json')))
    .map(entry => ({ id: entry.name, dir: path.join(base, entry.name) }));
}

export async function listProjects(root = DESK_ROOT, adapter = createHarnessAdapter()) {
  const out = [];
  for (const { id, dir } of listProjectDirs(root)) {
    let copy = null;
    try { copy = await adapter.readCopy(dir); } catch { copy = null; }
    let video = null;
    try { video = await adapter.readVideo(dir); } catch { video = null; }
    const updatedAt = Math.max(...['PROJECT.json', '发布文案.md', video?.file || 'PROJECT.json']
      .map(name => { try { return fs.statSync(path.join(dir, name)).mtimeMs; } catch { return 0; } }));
    out.push({ id, name: id, title: copy?.title || '', hint: copy?.title ? '' : scriptHint(dir),
      hasCopy: Boolean(copy?.title), video: video?.file || null, updatedAt });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/* 读一个项目的完整草稿。coverIssues 由调用方注入（封面尺寸检查需要 ffprobe）。 */
export async function projectDraft(root, name, adapter = createHarnessAdapter(), { coverIssues = null, productionLease } = {}) {
  const dir = resolveProject(root, name);
  const initialTask = typeof adapter.readProduction === 'function' ? await adapter.readProduction(dir, { productionLease }) : null;
  const unverified = error => ({ stale: true, reason: '无法核验成片：' + error.message });
  const media = typeof adapter.readMedia === 'function'
    ? adapter.readMedia(dir, { metadataOnly: projectBusy(initialTask) && initialTask?.productionLock?.owner?.command !== 'publish-upload' })
      .catch(error => ({ video: null, videoState: unverified(error) }))
    : Promise.all([adapter.readVideo(dir).catch(() => null), adapter.readVideoState(dir).catch(unverified)])
      .then(([video, videoState]) => ({ video, videoState }));
  const [copy, copyStatus, { video, videoState }, cover, review] = await Promise.all([
    adapter.readCopy(dir).catch(() => null),
    adapter.readCopyStatus(dir).catch(() => ({ ok: false, warnings: [], errors: [] })),
    media,
    adapter.readCover(dir).catch(error => ({ ok: false, reason: error.message })),
    typeof adapter.readReview === 'function'
      ? adapter.readReview(dir).catch(error => ({ ok: false, state: 'unavailable', statuses: {}, issues: [{ message: '无法核验审阅：' + error.message }] }))
      : Promise.resolve({ ok: false, state: 'unavailable', statuses: {}, issues: [{ message: '当前适配器未提供审阅状态' }] }),
  ]);
  const issues = cover?.ok
    ? (typeof coverIssues === 'function' ? coverIssues(cover.path) : (coverIssues || []))
    : [];
  const task = typeof adapter.readProduction === 'function' ? await adapter.readProduction(dir, { productionLease }) : null;
  const productionChanged = initialTask && (!sameProjectAttempt(initialTask, task) || projectBusy(initialTask) !== projectBusy(task));
  return composeDraft({ id: name, dir, copy, copyStatus, video, videoState, cover, review, coverIssues: issues, task, productionChanged });
}
