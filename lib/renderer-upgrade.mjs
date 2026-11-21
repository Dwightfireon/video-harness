/* Repair only the known array-spread launch bug in project-local copies.
 * Never replace a custom renderer wholesale or edit the global skill scaffold. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { maskJS } from './js-mask.mjs';
import { performanceRendererSource, PERFORMANCE_MARK, KNOWN_RENDERER_HASHES } from './renderer-performance-upgrade.mjs';
import { secureRendererSource, SECURITY_MARK } from './renderer-security-upgrade.mjs';

export const RENDERER_UPGRADE_MARK = 'vh:chrome-args-v1';

// Only exact known source and its deterministic upgrades have the legacy
// editorial checklist whose --force semantics we understand. A marker alone
// is not proof: unknown custom renderers are neither rewritten nor forced.
export function knownRendererReviewGate(source, scaffold = '') {
  const digest = text => createHash('sha256').update(text).digest('hex');
  const hashes = new Set(KNOWN_RENDERER_HASHES);
  if (hashes.has(digest(scaffold))) {
    const optimized = performanceRendererSource(scaffold);
    for (const version of [scaffold, optimized, secureRendererSource(scaffold), optimized && secureRendererSource(optimized)])
      if (version) hashes.add(digest(version));
  }
  return hashes.has(digest(source));
}
export function repairRenderer(project) {
  const file = path.join(project, 'render.mjs');
  if (!fs.existsSync(file)) return { changed: false };
  if (!fs.lstatSync(file).isFile()) throw new Error('render.mjs 必须是普通文件，未修改渲染器');
  const before = fs.readFileSync(file, 'utf8');
  const optimized = performanceRendererSource(before);
  const secured = secureRendererSource(optimized || before);
  if (optimized || secured) return writeUpgrade(project, file, before, secured || optimized, optimized ? 'performance' : 'browser-security');
  const masked = maskJS(before);
  // Object-valued custom launch options legitimately use {...launchArgs}.
  // Only repair the known array form; do not guess its type from the name.
  if (!/\bconst\s+launchArgs\s*=\s*\[/.test(masked)) return { changed: false };
  const buggy = 'chromium.launch({ ...launchArgs, executablePath: localBrowser })';
  const at = masked.indexOf(buggy);
  if (at < 0 || before.indexOf(buggy, at + buggy.length) >= 0) return { changed: false };
  const next = before.slice(0, at) + `chromium.launch({ args: launchArgs, executablePath: localBrowser }) /* ${RENDERER_UPGRADE_MARK} */` + before.slice(at + buggy.length);
  return writeUpgrade(project, file, before, next, 'chrome-args');
}

function writeUpgrade(project, file, before, next, kind) {
  const backupDir = path.join(project, 'out/.vh-renderer-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, Date.now() + '-' + randomUUID() + '.mjs');
  fs.writeFileSync(backup, before, { flag: 'wx', mode: 0o600 });
  if (fs.readFileSync(file, 'utf8') !== before) throw new Error('渲染器在修复期间改变，未覆盖；请核对后重试');
  fs.writeFileSync(file, next);
  return { changed: true, backup, kind };
}

export function rendererIdentity(project) {
  const source = fs.readFileSync(path.join(project, 'render.mjs'), 'utf8');
  return { upgraded: source.includes(RENDERER_UPGRADE_MARK) || source.includes(PERFORMANCE_MARK), performance: source.includes(PERFORMANCE_MARK), browserSecurity: source.includes(SECURITY_MARK), sha256: createHash('sha256').update(source).digest('hex') };
}
