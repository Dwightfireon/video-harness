/* 可再生缓存清理：只删能从源文件重建的东西，绝不动成片、字幕、静帧与作者文件。
 *
 * 真实事故：两次渲染留下的 out/frames 共 4.8GB、3 万张 JPEG；项目被移入
 * .vh-trash 后缓存仍原样搬走，Finder 默认又不显示点目录，磁盘悄悄涨到 5.6GB。
 */
import fs from 'node:fs';
import path from 'node:path';
import { trashNames } from './trash.mjs';
import { ttsCacheDirs } from './voice-script.mjs';

export const CACHE_DIRS = Object.freeze({
  frames: 'out/frames',
  seg: 'out/seg',
  tts: 'out/.voice-*',   // 任意引擎的配音缓存；解析见 ttsCacheDirs(project)
  pycache: '__pycache__',
});

/* 交付与作者文件：任何清理都不得触碰。 */
export const KEEP_FILES = Object.freeze(['out/video.mp4', 'out/video-voice.mp4', 'out/narration.m4a',
  'out/subtitles.srt', 'out/contact.jpg', '脚本.md', '方案.md', 'claims.json', 'scenes.src.js',
  'engine.tpl.html', 'timing.json', 'scene.html', 'PROJECT.json']);

export function dirBytes(dir) {
  let total = 0;
  const walk = current => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) { try { total += fs.statSync(file).size; } catch {} }
    }
  };
  walk(dir);
  return total;
}

/* keepSeg=true 时保留已编码分段，但旧 renderer 重编边界相邻段需要完整帧；
 * 清帧后下次改场会安全回退整片，不能把保留分段说成保留了增量能力。 */
export function stripProjectCaches(project, { keepSeg = true, only = null } = {}) {
  if (only && (!Array.isArray(only) || only.some(key => !Object.hasOwn(CACHE_DIRS, key)))) throw new Error('未知缓存类型');
  // tts 不是固定目录名：按前缀展开项目里实际存在的 out/.voice-*，避免写死某一种引擎。
  const expand = key => key === 'tts' ? ttsCacheDirs(project) : [CACHE_DIRS[key]];
  const keys = only ? [...new Set(only)] : ['frames', 'tts', 'pycache', ...(!keepSeg ? ['seg'] : [])];
  const targets = [...new Set(keys.flatMap(expand))];
  // 先核对全部目标，避免清掉一部分后才发现另一条路径穿过符号链接。
  const existing = targets.filter(rel => {
    let current = project;
    for (const part of rel.split('/')) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`缓存路径不是普通目录或经过符号链接：${rel}；未清理`);
    }
    return true;
  });
  const removed = [];
  let freed = 0;
  for (const rel of existing) {
    const abs = path.join(project, rel);
    freed += dirBytes(abs);
    fs.rmSync(abs, { recursive: true, force: true });
    removed.push(rel);
  }
  // 备份可能是唯一保留的作者版本，不属于可再生缓存。
  return { freed, removed };
}

/* 旧版渲染器的帧目录是 out/render-<theme>/frames；只在回收站里按“目录名 frames
 * 且含编号图片”识别，避免误删别的目录。 */
function legacyFrameDirs(project) {
  const out = path.join(project, 'out');
  const found = [];
  let entries = [];
  try { entries = fs.readdirSync(out, { withFileTypes: true }); } catch { return found; }
  const looksLikeFrames = dir => {
    try { return fs.lstatSync(dir).isDirectory() && fs.readdirSync(dir).some(name => /^\d{4,6}\.(jpg|png)$/.test(name)); } catch { return false; }
  };
  const direct = path.join(out, 'frames');
  if (fs.existsSync(direct) && looksLikeFrames(direct)) found.push(direct);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^render-[a-z0-9_-]+$/i.test(entry.name)) continue;
    const nested = path.join(out, entry.name, 'frames');
    if (fs.existsSync(nested) && looksLikeFrames(nested)) found.push(nested);
    // 编码分段与帧一样可由源文件重建。
    const segments = path.join(out, entry.name, 'seg');
    try {
      if (fs.lstatSync(segments).isDirectory() && fs.readdirSync(segments).some(name => /^seg-[\w-]+\.(mp4|webm)$/i.test(name))) found.push(segments);
    } catch {}
  }
  return found;
}

/* 回收站里的项目只会被恢复或彻底删除，不会继续渲染；把大缓存清掉再存放。 */
export function cleanTrashCaches(root) {
  const trash = path.join(root, '.vh-trash');
  let freed = 0;
  const projects = [];
  for (const name of trashNames(root)) {
    const project = path.join(trash, name);
    try { if (!fs.lstatSync(path.join(project, 'PROJECT.json')).isFile()) continue; } catch { continue; }
    const result = stripProjectCaches(project, { keepSeg: false });
    for (const dir of legacyFrameDirs(project)) {
      result.freed += dirBytes(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      result.removed.push(path.relative(project, dir).split(path.sep).join('/'));
    }
    if (result.removed.length) {
      freed += result.freed;
      projects.push({ name, freed: result.freed, removed: result.removed });
    }
  }
  return { freed, projects };
}

/* 预览回收站可释放量：与 cleanTrashCaches 使用同一识别规则，但绝不删除。 */
export function trashCacheBytes(root) {
  const trash = path.join(root, '.vh-trash');
  let total = 0;
  for (const name of trashNames(root)) {
    const project = path.join(trash, name);
    try { if (!fs.lstatSync(path.join(project, 'PROJECT.json')).isFile()) continue; } catch { continue; }
    total += cacheSummary(project).total;
    for (const dir of legacyFrameDirs(project)) total += dirBytes(dir);
  }
  return total;
}

/* 仅供状态/界面展示：缓存是可再生的，不计入“项目内容大小”。 */
export function cacheSummary(project) {
  const parts = {};
  let total = 0;
  for (const [key, rel] of Object.entries(CACHE_DIRS)) {
    const abs = path.join(project, rel);
    if (!fs.existsSync(abs)) continue;
    const bytes = dirBytes(abs);
    parts[key] = bytes;
    total += bytes;
  }
  return { total, parts };
}
