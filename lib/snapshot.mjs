/* lib/snapshot.mjs —— 快照与回滚（改坏能退）
 *
 * 为什么需要：内容创作里"改坏"比"写坏"常见——agent 越界改文件、
 * 手工试版式、换主题覆盖 :root，都需要能一键回到上一版。
 *
 * 设计：只快照"内容资产"（不是成片/缓存），体积很小：
 *   脚本.md 方案.md claims.json scenes.src.js engine.tpl.html 发布文案.md 审查.md
 * 存放在 .snapshots/<时间戳>/，用 vh snap 创建、vh undo 回滚。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assetInputs } from './asset-inputs.mjs';

export const SNAP_FILES = ['脚本.md', '方案.md', 'claims.json', 'scenes.src.js', 'engine.tpl.html', '发布文案.md', '审查.md', '审查-解释.md'];

const snapRoot = (project) => path.join(project, '.snapshots');

export function create(project, label = '') {
  const dir = path.join(snapRoot(project), new Date().toISOString().replace(/[:.]/g, '-') + (label ? '-' + label.replace(/[^\w\u4e00-\u9fff-]/g, '') : ''));
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const f of SNAP_FILES) {
    const src = path.join(project, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dir, f));
      saved.push(f);
    }
  }
  // Preserve the actual preview, not a future reconstruction with a different
  // engine/timeline. Sidecar is deliberately NOT restored by undo.
  let preview = null;
  const html = path.join(project, 'scene.html');
  if (fs.existsSync(html)) {
    const assets = assetInputs(project);
    if (!assets.issues.length) {
      const bytes = fs.readFileSync(html);
      fs.writeFileSync(path.join(dir, '_preview.html'), bytes, { flag: 'wx' });
      preview = { file: '_preview.html', sha256: createHash('sha256').update(bytes).digest('hex'), assets: assets.signature };
    }
  }
  fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({ at: new Date().toISOString(), label, files: saved, preview }, null, 2));
  return { dir, saved };
}

export function list(project) {
  const root = snapRoot(project);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(d => fs.statSync(path.join(root, d)).isDirectory()).sort().reverse()
    .map(d => {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(root, d, '_meta.json'), 'utf8')); } catch {}
      return { id: d, at: meta.at || d, label: meta.label || '', files: meta.files || [] };
    });
}

export function restore(project, id) {
  const root = snapRoot(project);
  const dirs = fs.readdirSync(root).filter(d => fs.statSync(path.join(root, d)).isDirectory());
  const target = id ? dirs.find(d => d === id || d.startsWith(id)) : dirs.sort().reverse()[0];
  if (!target) return { ok: false, error: '没有找到快照' };
  const dir = path.join(root, target);
  const restored = [];
  for (const f of SNAP_FILES) {
    const src = path.join(dir, f);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(project, f)); restored.push(f); }
  }
  return { ok: true, id: target, restored };
}

/* diff：当前文件与最近快照比，哪个文件变了、变了多少行 */
export function diff(project) {
  const snaps = list(project);
  if (!snaps.length) return { ok: false, error: '还没有快照（先跑 vh snap）' };
  const latest = path.join(snapRoot(project), snaps[0].id);
  const out = [];
  for (const f of SNAP_FILES) {
    const cur = path.join(project, f);
    const old = path.join(latest, f);
    const a = fs.existsSync(old) ? fs.readFileSync(old, 'utf8') : null;
    const b = fs.existsSync(cur) ? fs.readFileSync(cur, 'utf8') : null;
    if (a === b) continue;
    const la = a == null ? [] : a.split('\n');
    const lb = b == null ? [] : b.split('\n');
    let added = 0, removed = 0;
    // 粗 diff：按行集合算增删（不做 LCS，够用且快）
    const sa = new Set(la), sb = new Set(lb);
    for (const l of lb) if (!sa.has(l)) added++;
    for (const l of la) if (!sb.has(l)) removed++;
    out.push({ file: f, added, removed, isNew: a == null, isDeleted: b == null });
  }
  return { ok: true, snapshot: snaps[0], changes: out };
}
