/* Read-only source comparison: never temporarily replace live scenes or run a
 * project's generator. Old snapshots without an actual preview fail honestly. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { assetInputs } from './asset-inputs.mjs';
import { parseSceneRanges } from './state.mjs';
import { maskJS } from './js-mask.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function shoot(project, html, dir, tag) {
  const { ranges } = parseSceneRanges(maskJS(html));
  if (!ranges.length) throw new Error('没有可比较的场景');
  const base = `<base href="${pathToFileURL(path.resolve(project) + path.sep).href}">`;
  if (!/<base\b/i.test(html)) {
    if (/<head\b[^>]*>/i.test(html)) html = html.replace(/<head\b[^>]*>/i, '$&' + base);
    else if (/<html\b[^>]*>/i.test(html)) html = html.replace(/<html\b[^>]*>/i, '$&<head>' + base + '</head>');
    else if (/^\s*<!doctype[^>]*>/i.test(html)) html = html.replace(/^\s*<!doctype[^>]*>/i, '$&' + base);
    else html = base + html;
  }
  const file = path.join(dir, tag + '.html'); fs.writeFileSync(file, html);
  const { chromium } = await import('playwright');
  const browser = await launchBrowser(chromium, { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.setDefaultTimeout(30000);page.on('pageerror', e => errors.push(e.message));
    page.on('requestfailed', r => errors.push('资源加载失败：' + r.url()));
    await page.goto(pathToFileURL(file).href);
    const size = await page.evaluate(() => ({ width: window.W, height: window.H }));
    if (![size.width, size.height].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw new Error('画布 W/H 无效');
    await page.setViewportSize(size);
    await page.evaluate(async () => { await document.fonts.ready; if (window.__ready) await window.__ready; });
    const shots = [];
    for (const [i, [a, b]] of ranges.entries()) {
      const t = (a + b) / 2;
      await page.evaluate(t => window.renderAt(t), t);
      const image = path.join(dir, `${tag}-${i + 1}.png`);
      await page.screenshot({ path: image });shots.push({ n: i + 1, t, file: image });
    }
    if (errors.length) throw new Error(errors.slice(0, 3).join('；'));
    return shots;
  } finally { await browser.close(); }
}

export async function compare(project) {
  const root = path.join(project, '.snapshots');
  let latest;
  try { latest = fs.readdirSync(root).filter(n => !/before-undo/.test(n) && fs.lstatSync(path.join(root, n)).isDirectory()).sort().at(-1); } catch {}
  if (!latest) return { ok: false, error: '没有快照：改稿前先跑 node vh.mjs snap "改前"' };
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(root, latest, '_meta.json'), 'utf8')); } catch {}
  if (meta?.preview?.file !== '_preview.html') return { ok: false, error: '旧快照没有保存真实预览，不能用当前引擎/时间轴伪造旧画面；以后请改稿前重新 vh snap。原稿未修改。' };
  let dir;
  try {
    const beforeHtml = fs.readFileSync(path.join(root, latest, '_preview.html'), 'utf8');
    if (sha(beforeHtml) !== meta.preview.sha256) throw new Error('快照预览指纹不匹配');
    const current = path.join(project, 'scene.html'), afterHtml = fs.readFileSync(current, 'utf8');
    const assets = assetInputs(project);
    if (assets.issues.length || assets.signature !== meta.preview.assets) throw new Error('素材已变或不可核验，旧预览不能借用新素材冒充原画面');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-compare-'));
    const before = await shoot(project, beforeHtml, dir, 'old'), after = await shoot(project, afterHtml, dir, 'new');
    if (fs.readFileSync(current, 'utf8') !== afterHtml || assetInputs(project).signature !== assets.signature)
      throw new Error('比较期间当前画面或素材改变，结果不能用于当前版本');
    const rows = Math.max(before.length, after.length), w = 480, h = 270, pad = 8, labelH = 26;
    const inputs = [], filters = [];let last = '[0:v]', count = 0;
    for (let i = 0; i < rows; i++) for (const [column, shot] of [before[i], after[i]].entries()) {
      if (!shot) continue;
      inputs.push('-i', shot.file);count++;
      filters.push(`[${count}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2[s${count}]`);
      filters.push(`${last}[s${count}]overlay=${pad + column * (w + pad)}:${pad + i * (h + labelH + pad) + labelH}[o${count}]`);
      last = `[o${count}]`;
    }
    const out = path.join(project, 'out');fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, `compare-${randomUUID()}.jpg`);
    const r = spawnSync('ffmpeg', ['-nostdin', '-n', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x111111:s=${w * 2 + pad * 3}x${rows * (h + labelH + pad) + pad}`,
      ...inputs, '-filter_complex', filters.join(';'), '-map', last, '-frames:v', '1', file], { encoding: 'utf8', timeout: 30000 });
    if (r.error || r.status !== 0) { try { fs.unlinkSync(file); } catch {} throw new Error('拼图失败：' + (r.error?.message || r.stderr || '').slice(-300)); }
    return { ok: true, file, rows, before: before.length, after: after.length,
      note: '左为快照真实预览，右为当前预览；每场中点抽样，不证明动画、语义或整片回归通过。素材改变时拒绝冒充历史画面。' };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
}
