/* lib/assets.mjs —— 真实素材接入（vh asset）
 *
 * 为什么需要：现在的画面全是 CSS 画的框和字。观众能"看懂"，但不会"相信"——
 * 讲产品没有产品截图、讲数据没有真图、讲过程没有录屏，片子就是幻灯片。
 *
 * 三件事：
 *   1. add/list：把图片/视频/CSV 收进项目 assets/（统一命名、去重、给尺寸）
 *   2. check   ：扫 scenes.src.js 里引用的文件，报"找不到/太大/尺寸不对"
 *   3. chartSvg：把一组数字画成真 SVG 图（坐标轴、刻度、标注）——
 *                图表不该是几个 div 假装，观众会看刻度
 *
 * 约定：场景里用 window.VH_UI.bgImg(el, 'assets/x.jpg') 铺图（引擎已有），
 *      视频用 VH_UI.videoEl（下面注入）。路径一律相对项目根。
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripVisualIntents } from './scene-visual.mjs';

const IMG = /\.(png|jpe?g|webp|avif|gif|svg)$/i;
const VID = /\.(mp4|webm|mov|m4v)$/i;
const DATA = /\.(csv|tsv|json)$/i;

export const kinds = (f) => ({ img: IMG.test(f), vid: VID.test(f), data: DATA.test(f) });

/* 目录：项目内 assets/（和 harness 自己的 assets/ 区分开） */
export const assetsDir = (project) => path.join(project, 'assets');

export function list(project) {
  const dir = assetsDir(project);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => !f.startsWith('.')).sort().map(f => {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    return { name: f, rel: 'assets/' + f, bytes: st.size, kind: kinds(f) };
  });
}

/* 图片尺寸：读文件头（不引依赖）——PNG / JPEG / WebP 够用了 */
export function imageSize(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {          // PNG
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: 'png' };
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {            // JPEG：扫 SOF
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), type: 'jpeg' };
        }
        i += 2 + len;
      }
    }
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = b.toString('ascii', 12, 16);
      if (fmt === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), type: 'webp' };
      if (fmt === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, type: 'webp' };
    }
  } catch {}
  return null;
}

/* 加素材：复制进 assets/，重名加序号，返回最终名字 */
export function add(project, src, opt = {}) {
  if (!fs.existsSync(src)) throw new Error('找不到文件：' + src);
  const dir = assetsDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const base = (opt.name || path.basename(src)).replace(/[^\w.\-\u4e00-\u9fff]/g, '-');
  let name = base, n = 2;
  while (fs.existsSync(path.join(dir, name))) {
    const ext = path.extname(base), stem = base.slice(0, -ext.length || undefined);
    name = `${stem}-${n++}${ext}`;
  }
  fs.copyFileSync(src, path.join(dir, name));
  const size = kinds(name).img ? imageSize(path.join(dir, name)) : null;
  return { name, rel: 'assets/' + name, bytes: fs.statSync(path.join(dir, name)).size, size };
}

/* 检查：场景里引用的素材在不在、够不够大、会不会糊 */
export function check(project) {
  const sceneSrc = (() => { try { return fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'); } catch { return ''; } })();
  const found = list(project);
  const have = new Set(found.map(f => f.name));
  const findings = [];

  // 引用：bgImg(el,'assets/x.jpg') / src='assets/x' / url(assets/x)
  const refs = [...stripVisualIntents(sceneSrc).matchAll(/assets\/([\w.\-\u4e00-\u9fff]+)/g)].map(m => m[1]);
  for (const r of [...new Set(refs)]) {
    if (!have.has(r)) {
      findings.push({
        kind: 'missing',
        msg: `场景引用了 assets/${r}，但项目 assets/ 里没有这个文件 —— 渲染出来是空白（而且不报错）`,
        fix: `node vh.mjs asset add <原文件路径>   # 或把文件放到 assets/${r}`,
      });
    }
  }
  // 未被引用的素材（占体积）：没有引用时也要报——它纯占磁盘
  for (const f of found) {
    if (!refs.includes(f.name)) {
      findings.push({ kind: 'unused', msg: `assets/${f.name} 没被任何场景引用（${(f.bytes / 1024).toFixed(0)}KB）`, fix: '用不上就删掉，或者接进某一场景。' });
    }
  }
  // 图片太小会糊：铺满 1920 宽至少要 1280
  for (const f of found) {
    if (!f.kind.img) continue;
    const s = imageSize(path.join(assetsDir(project), f.name));
    if (s && s.w < 1280) {
      findings.push({
        kind: 'small',
        msg: `assets/${f.name} 只有 ${s.w}×${s.h} —— 铺满画面会糊`,
        fix: '换 1920 宽以上的图；或缩小它在画面里的占比（别铺满）。',
      });
    }
    if (f.bytes > 8 * 1024 * 1024) {
      findings.push({ kind: 'huge', msg: `assets/${f.name} 有 ${(f.bytes / 1048576).toFixed(1)}MB —— 渲染会变慢（每帧都要解码）`, fix: '压到 2MB 以内。' });
    }
  }
  return { ok: findings.length === 0, assets: found, refs: [...new Set(refs)], findings };
}

/* ---------- CSV → 数值序列（图表用） ---------- */
export function parseCsv(text) {
  const lines = String(text).trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { header: [], rows: [] };
  const split = (l) => l.split(/\s*[,;\t]\s*/);
  const header = split(lines[0]);
  const rows = lines.slice(1).map(l => split(l));
  const numeric = rows.every(r => r.slice(1).every(v => Number.isFinite(+v)));
  return { header, rows, numeric };
}

/* ---------- 真 SVG 图表：条形 / 折线 ----------
 * 为什么不是 div：同一条数值轴要能读出刻度、要比得出长短、要有来源。
 * 返回 SVG 字符串（可塞进 innerHTML）。坐标按传入宽高算，横竖屏都能用。
 */
export function chartSvg(opt = {}) {
  const W = opt.w || 760, H = opt.h || 420;
  const padL = opt.padL || 84, padR = 36, padT = 34, padB = 62;
  const items = (opt.items || []).map(it => ({ label: String(it.label ?? ''), value: +it.value || 0 }));
  if (!items.length) return '';
  const type = opt.type === 'line' ? 'line' : 'bar';
  const max = Math.max(...items.map(i => i.value), 1);
  const niceMax = (v) => {
    const mag = Math.pow(10, Math.floor(Math.log10(v || 1)));
    const n = v / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  };
  const top = niceMax(max * 1.08);
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const ticks = 4;
  const y = (v) => padT + innerH * (1 - v / top);
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (v) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : String(Math.round(v * 100) / 100));

  const out = [];
  out.push(`<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">`);

  // 网格 + Y 轴刻度（浅墨，不抢主体）
  for (let t = 0; t <= ticks; t++) {
    const v = top * t / ticks, yy = y(v);
    out.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="currentColor" stroke-opacity="${t === 0 ? 0.32 : 0.12}" stroke-width="1"/>`);
    out.push(`<text x="${padL - 14}" y="${(yy + 6).toFixed(1)}" text-anchor="end" font-size="20" fill="currentColor" fill-opacity="0.55" font-family="ui-monospace,monospace">${esc(fmt(v))}</text>`);
  }

  if (type === 'bar') {
    const slot = innerW / items.length;
    const bw = Math.min(slot * 0.54, 110);
    items.forEach((it, i) => {
      const cx = padL + slot * (i + 0.5);
      const h = Math.max(2, (innerH * it.value) / top);
      const isLast = i === items.length - 1;
      out.push(`<rect x="${(cx - bw / 2).toFixed(1)}" y="${(padT + innerH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="6" fill="currentColor" fill-opacity="${isLast ? 1 : 0.34}"/>`);
      out.push(`<text x="${cx.toFixed(1)}" y="${(padT + innerH - h - 14).toFixed(1)}" text-anchor="middle" font-size="24" font-weight="700" fill="currentColor" font-family="ui-monospace,monospace">${esc(fmt(it.value))}</text>`);
      out.push(`<text x="${cx.toFixed(1)}" y="${(H - padB + 34).toFixed(1)}" text-anchor="middle" font-size="21" fill="currentColor" fill-opacity="0.7">${esc(it.label)}</text>`);
    });
  } else {
    const step = items.length > 1 ? innerW / (items.length - 1) : 0;
    const pts = items.map((it, i) => [padL + step * i, y(it.value)]);
    out.push(`<polyline points="${pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`);
    pts.forEach((p, i) => {
      out.push(`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="6" fill="currentColor"/>`);
      out.push(`<text x="${p[0].toFixed(1)}" y="${(p[1] - 18).toFixed(1)}" text-anchor="middle" font-size="22" font-weight="700" fill="currentColor" font-family="ui-monospace,monospace">${esc(fmt(items[i].value))}</text>`);
      out.push(`<text x="${p[0].toFixed(1)}" y="${(H - padB + 34).toFixed(1)}" text-anchor="middle" font-size="20" fill="currentColor" fill-opacity="0.7">${esc(items[i].label)}</text>`);
    });
  }

  // 轴名（可选）
  if (opt.unit) out.push(`<text x="${padL - 14}" y="${padT - 12}" text-anchor="end" font-size="18" fill="currentColor" fill-opacity="0.5">${esc(opt.unit)}</text>`);
  out.push('</svg>');
  return out.join('');
}
