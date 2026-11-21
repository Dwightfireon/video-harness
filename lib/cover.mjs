/* lib/cover.mjs —— 封面生成（vh cover）
 *
 * 为什么需要：你发布 5 支片子，封面全是手工截图裁的。
 * 这里按 发布文案.md 的「封面文案」+ 成片关键帧，生成三个平台比例的封面：
 *   16:9（B站/YouTube）、4:3（公众号/知乎）、3:4（小红书/抖音）
 *
 * 做法：Playwright 渲染一张 HTML（背景用成片抽帧，压暗 + 叠字），截图导出。
 * 全部确定性：同一输入必得同一张图。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { publishInputs } from './publish.mjs';
import { assetInputs } from './asset-inputs.mjs';

const RATIOS = {
  '16x9': { w: 1920, h: 1080, label: 'B站 / YouTube' },
  '4x3': { w: 1600, h: 1200, label: '公众号 / 知乎' },
  '3x4': { w: 1080, h: 1440, label: '小红书 / 抖音' },
};

/* 从 发布文案.md 抽封面文案：主 / 副 */
export function parseCoverCopy(md) {
  const out = { main: '', sub: '' };
  if (!md) return out;
  let cur = null;
  for (const raw of md.split('\n')) {
    const h = raw.match(/^##\s*(.+?)\s*$/);
    if (h) { cur = /封面/.test(h[1]) ? 'cover' : null; continue; }
    if (cur !== 'cover') continue;
    const m = raw.match(/^\s*(主|副)\s*[：:]\s*(.+)$/);
    if (m) out[m[1] === '主' ? 'main' : 'sub'] = m[2].trim();
  }
  return out;
}

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* 封面沿用地主项目强调色：换主题后封面不该还是默认绿。
   只读 :root 里的 --accent，读不到就退回默认。 */
function projectAccent(project) {
  try {
    const tpl = fs.readFileSync(path.join(project, 'engine.tpl.html'), 'utf8');
    const m = tpl.match(/--accent\s*:\s*(#[0-9a-fA-F]{6})/);
    return m ? m[1] : '';
  } catch { return ''; }
}

export function buildHtml({ ratio, bg = '', main, sub = '', brand = '', style = 'editorial', accent = '' }) {
  if (!Object.hasOwn(RATIOS, ratio) || !['editorial', 'frame'].includes(style)) throw new Error('未知封面比例或样式');
  const { w, h } = RATIOS[ratio];
  const ACC = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#147A3A';
  if (style === 'editorial') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      html,body{width:${w}px;height:${h}px;overflow:hidden}
      .wrap{position:relative;width:${w}px;height:${h}px;background:#F5F6F1;color:#1E2721}
      .wrap:after{content:'';position:absolute;left:9%;right:9%;bottom:11%;height:2px;background:${ACC}}
      .brand{position:absolute;left:9%;top:9%;font:24px "PingFang SC",sans-serif;color:#52644F}
      .content{position:absolute;left:9%;right:9%;top:${h > w ? 22 : 20}%;bottom:18%;display:flex;flex-direction:column;justify-content:center}
      .content>*{flex-shrink:0}
      .rule{height:6px;width:100px;background:${ACC};margin-bottom:40px;flex-shrink:0}
      h1{font-family:"Songti SC","STSong",serif;font-size:${h > w ? 112 : w > 1600 ? 164 : 144}px;line-height:1.18;font-weight:700;white-space:pre-line;text-wrap:balance;overflow-wrap:anywhere}
      p{font:500 ${h > w ? 42 : 48}px/1.5 "PingFang SC",sans-serif;color:#52644F;margin-top:40px;white-space:pre-line;overflow-wrap:anywhere}
    </style></head><body><div class="wrap">${brand ? `<div class="brand">${esc(brand)}</div>` : ''}
      <div class="content"><div class="rule"></div><h1>${esc(main)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
    </div></body></html>`;
  }
  const isPortrait = h > w;
  const mainSize = isPortrait ? 92 : (w > 1600 ? 96 : 84);
  const subSize = isPortrait ? 38 : 34;
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${w}px; height:${h}px; overflow:hidden; }
  .wrap { position:relative; width:${w}px; height:${h}px; background:#0E1512; }
  .bg {
    position:absolute; inset:0;
    background:url('${bg}') center/cover no-repeat;
    filter:saturate(.95) brightness(.95);
  }
  .scrim {
    position:absolute; inset:0;
    background:linear-gradient(105deg, rgba(8,14,11,.96) 0%, rgba(8,14,11,.86) 52%, rgba(8,14,11,.55) 100%);
  }
  .grain { position:absolute; inset:0; opacity:.10;
    background-image:radial-gradient(rgba(255,255,255,.35) 1px, transparent 1px);
    background-size:3px 3px; }
  .content {
    position:absolute; left:${isPortrait ? 64 : 110}px; right:${isPortrait ? 64 : 110}px;
    top:22%; bottom:18%; display:flex; flex-direction:column; justify-content:center;
  }
  .rule { width:120px; height:5px; background:#D97757; border-radius:3px; margin-bottom:34px; }
  h1 {
    font-family:"Songti SC","STSong","Source Han Serif SC",serif;
    font-size:${Math.max(mainSize, w * .075)}px; line-height:1.22; letter-spacing:-.02em;
    color:#FAF9F5; font-weight:700;
    text-wrap:balance;
  }
  h1 em { color:#D97757; font-style:normal; }
  p { margin-top:26px; font-family:"PingFang SC","Hiragino Sans GB",sans-serif;
      font-size:${subSize}px; line-height:1.5; color:rgba(250,249,245,.78); }
  .brand { position:absolute; left:${isPortrait ? 64 : 110}px; top:${isPortrait ? 90 : 80}px;
    font-family:"SF Mono",Menlo,monospace; font-size:24px; letter-spacing:.14em;
    color:rgba(250,249,245,.55); }
</style></head><body>
<div class="wrap">
  <div class="bg"></div><div class="scrim"></div><div class="grain"></div>
   ${brand ? `<div class="brand">${esc(brand)}</div>` : ''}
  <div class="content">
    <div class="rule"></div>
    <h1>${esc(main)}</h1>
    ${sub ? `<p>${esc(sub)}</p>` : ''}
  </div>
</div></body></html>`;
}

/* 抽一帧当背景（默认取全片 35% 处，通常已进入内容）。
   ⚠ 成片里的字幕是烧进画面的：直接 ffmpeg 抽帧会把字幕叠到封面上（真实事故：封面出现两条字幕）。
   正确做法是回到 scene.html，把字幕条和进度条临时隐藏后重新截图 —— 同一个 t 的场景画面，
   没有字幕，也没有裁切损失。scene.html 打不开时才退回 ffmpeg 抽帧。 */
export async function grabFrameClean(project, atSec) {
  const scene = path.join(project, 'scene.html');
  if (!fs.existsSync(scene)) return { ok: false, error: '没有 scene.html，无法生成无字幕底图' };
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { return { ok: false, error: 'node 解析不到 playwright' }; }
  const dur = (() => {
    try {
      const m = fs.readFileSync(scene, 'utf8').match(/DURATION\s*=\s*([\d.]+)/);
      return m ? Number(m[1]) : 0;
    } catch { return 0; }
  })();
  const t = atSec != null ? Number(atSec) : Math.max(1, (dur || 60) * 0.35);
  if (!Number.isFinite(t) || t < 0 || dur > 0 && t >= dur) return { ok: false, error: '封面底图时间必须落在当前视频范围内' };
  const out = path.join(project, 'out', 'cover-bg.jpg');
  const browser = await launchBrowser(chromium, { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(scene).href);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async (tt) => {
      // 隐藏字幕与进度条：封面自己排版，不要和烧进画面的字打架
      const css = document.createElement('style');
      css.textContent = '#subs,#bar{display:none !important}';
      document.head.appendChild(css);
      if (window.__ready) await window.__ready;
      else if (window.VH_UI?.assetsReady) await window.VH_UI.assetsReady();
      if (typeof window.renderAt !== 'function') throw new Error('缺少 renderAt');
      await window.renderAt(tt);
    }, t);
    await page.screenshot({ path: out, type: 'jpeg', quality: 92 });
    return { ok: true, file: out, at: +t.toFixed(1), clean: true };
  } catch (e) {
    return { ok: false, error: '无字幕截图失败：' + e.message.slice(0, 120) };
  } finally { await browser.close(); }
}

/* 退回方案：从成片抽帧（会带字幕，只在 scene.html 不可用时用） */
export function grabFrame(project, atSec) {
  const video = path.join(project, 'out', 'video-voice.mp4');
  if (!fs.existsSync(video)) return { ok: false, error: '没有 out/video-voice.mp4（先出片）' };
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { encoding: 'utf8' });
  const dur = parseFloat(r.stdout) || 0;
  const t = atSec != null ? atSec : Math.max(1, dur * 0.35);
  const out = path.join(project, 'out', 'cover-bg.jpg');
  const g = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(t), '-i', video, '-frames:v', '1', '-q:v', '3', out], { encoding: 'utf8' });
  if (g.status !== 0) return { ok: false, error: '抽帧失败：' + (g.stderr || '').slice(-200) };
  return { ok: true, file: out, at: +t.toFixed(1) };
}

export async function render(project, opt = {}) {
  const copyMd = (() => { try { return fs.readFileSync(path.join(project, '发布文案.md'), 'utf8'); } catch { return ''; } })();
  const copy = parseCoverCopy(copyMd);
  const main = opt.main || copy.main || '（缺封面主文案）';
  const sub = opt.sub || copy.sub || '';
  if (!copy.main && !opt.main) return { ok: false, error: '没有封面文案：在 发布文案.md 的「## 封面文案」里写「主：…」「副：…」' };

  const style = opt.style || 'editorial';
  if (!['editorial', 'frame'].includes(style)) return { ok: false, error: '封面样式只接受 editorial 或 frame' };
  let inputs;
  try { inputs = coverInputs(project, style); }
  catch (e) { return { ok: false, error: '无法核验封面输入：' + e.message }; }
  // Default covers do not inherit body text and do not need a rendered video.
  const fr = style === 'frame' ? await grabFrameClean(project, opt.at != null ? Number(opt.at) : null) : { ok: true };
  if (!fr.ok) return fr;

  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { return { ok: false, error: 'node 解析不到 playwright' }; }
  const browser = await launchBrowser(chromium, { headless: true, args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
  const outDir = path.join(project, 'out', 'cover');
  fs.mkdirSync(outDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(outDir, '.cover-'));
  const made = [];
  try {
    const accent = projectAccent(project);
    for (const ratio of Object.keys(RATIOS)) {
      const { w, h } = RATIOS[ratio];
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      const html = buildHtml({ ratio, bg: fr.file ? pathToFileURL(fr.file).href : '', main, sub, style, brand: opt.brand || '', accent });
      const tmp = path.join(staging, `${ratio}.html`);
      fs.writeFileSync(tmp, html, 'utf8');
      await page.goto(pathToFileURL(tmp).href);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(120);
      const fit = await page.evaluate(({ w, h }) => {
        const title = document.querySelector('h1'), content = document.querySelector('.content');
        const min = Math.ceil(20 * w / 320), lines = h > w ? 4 : 3;
        let size = parseFloat(getComputedStyle(title).fontSize);
        while (size >= min) {
          title.style.fontSize = size + 'px';
          const a = title.getBoundingClientRect(), box = content.getBoundingClientRect();
          const children = [...content.children].map(el => el.getBoundingClientRect());
          const count = a.height / parseFloat(getComputedStyle(title).lineHeight);
          const textRects = [...content.querySelectorAll('h1,p')].map(el => { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect(); });
          if (count <= lines + .05 && title.scrollWidth <= title.clientWidth + 1 && content.scrollHeight <= content.clientHeight + 1 &&
              textRects.every(r => r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1) &&
              (textRects.length < 2 || textRects[0].bottom <= textRects[1].top) &&
              children.every(r => r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1))
            return { ok: true, fontSize: size, titlePixelsAt320: size * 320 / w, lines: Math.round(count) };
          size -= 2;
        }
        return { ok: false };
      }, { w, h });
      if (!fit.ok) return { ok: false, error: ratio + ' 封面文案过长或越界；请缩短主/副标题，不缩到不可读或截字' };
      const file = path.join(staging, `cover-${ratio}.png`);
      const fullImage = await page.screenshot({ path: file, type: 'png', animations: 'disabled' });
      const thumbH = Math.round(h * 320 / w);
      const thumbnail = path.join(staging, `thumb-${ratio}.png`);
      // Downsample the actual full PNG, not a resized viewport: some Chrome/GPU
      // combinations retain stale compositor tiles after CSS scaling.
      const thumb = await page.evaluate(async ({ png, height }) => {
        const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = height;
        const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, 320, height); return canvas.toDataURL('image/png').split(',')[1];
      }, { png: fullImage.toString('base64'), height: thumbH });
      fs.writeFileSync(thumbnail, Buffer.from(thumb, 'base64'));
      fs.rmSync(tmp, { force: true });
      await page.close();
      made.push({ ratio, file: path.join(outDir, path.basename(file)), thumbnail: path.join(outDir, path.basename(thumbnail)), w, h, label: RATIOS[ratio].label, fit });
    }
    let currentInputs;
    try { currentInputs = coverInputs(project, style); } catch {}
    if (JSON.stringify(inputs) !== JSON.stringify(currentInputs)) return { ok: false, error: '生成期间脚本/文案/底图或本地素材依赖改变；未覆盖原封面' };
    const files = made.map(item => ({ file: path.basename(item.file), ...coverFingerprint(path.join(staging, path.basename(item.file))) }));
    const manifest = { version: 1, style, inputs, main, sub, brand: opt.brand || '', reviewed: false, files };
    const previous = fs.readdirSync(outDir).filter(name => /^(?:cover|thumb)-(?:16x9|4x3|3x4)\.png$|^manifest\.json$/.test(name));
    if (previous.length) {
      const backup = path.join(project, 'out/cover-history', randomUUID()); fs.mkdirSync(backup, { recursive: true });
      for (const name of previous) fs.copyFileSync(path.join(outDir, name), path.join(backup, name));
    }
    for (const name of fs.readdirSync(staging)) fs.renameSync(path.join(staging, name), path.join(outDir, name));
    const temp = path.join(outDir, '.' + randomUUID() + '.json');
    fs.writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n'); fs.renameSync(temp, path.join(outDir, 'manifest.json'));
  } finally { await browser.close(); fs.rmSync(staging, { recursive: true, force: true }); }
  return { ok: true, made, copy: { main, sub }, style, frameAt: fr.at };
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function coverFingerprint(file) {
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('封面必须是普通文件');
  const bytes = fs.readFileSync(file); return { size: bytes.length, sha256: digest(bytes) };
}
/* 封面只继承「封面文案」那两个标题；简介、标签、置顶评论改了不影响已生成的图。
 * 以前整份发布文案的字节哈希都算输入，程序往简介补参考链接就误判“封面过期”。 */
function coverInputs(project, style) {  let copy = '';
  try { copy = parseCoverCopy(fs.readFileSync(path.join(project, '发布文案.md'), 'utf8')); } catch {}
  let frame = {};
  if (style === 'frame') {
    // Match the media/build dependency contract, including local image/font bytes.
    // Reject dependency issues before reading scene.html or launching Chrome.
    const assets = assetInputs(project);
    if (assets.issues.length) throw new Error('本地素材依赖无效：' + assets.issues.join('；'));
    frame = { sceneHash: digest(fs.readFileSync(path.join(project, 'scene.html'))),
      ...(assets.files.length ? { assetSignature: assets.signature } : {}) };
  }
  return { ...publishInputs(project), coverCopyHash: digest(JSON.stringify(copy)), ...frame };
}
export function coverStatus(project) {
  const dir = path.join(project, 'out/cover');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
  catch { return { ok: false, files: [], code: 'missing', reason: '还没有生成封面（vh cover）' }; }
  try {
    if (manifest.version !== 1 || !['editorial', 'frame'].includes(manifest.style)) return { ok: false, files: [], code: 'invalid', reason: '封面清单格式无效' };
    if (!Array.isArray(manifest.files) || manifest.files.length !== 3) return { ok: false, files: [], code: 'invalid', reason: '封面清单缺少某个比例' };
    // 旧清单绑定整份文案字节，无法判断是否只改了简介；一次性重生成即可。
    if (!Object.hasOwn(manifest.inputs || {}, 'coverCopyHash')) {
      return { ok: false, files: [], code: 'legacy', reason: '封面由旧版本生成（当时绑定整份文案），请重新生成一次' };
    }
    if (JSON.stringify(manifest.inputs) !== JSON.stringify(coverInputs(project, manifest.style))) {
      return { ok: false, files: [], code: manifest.style === 'frame' ? 'input-changed' : 'copy-changed',
        reason: manifest.style === 'frame' ? '封面底图依赖的画面或素材已改变，请重新生成' : '封面文案已改变，请重新生成' };
    }
    const names = new Set();
    for (const file of manifest.files) {
      if (!/^cover-(16x9|4x3|3x4)\.png$/.test(file.file) || names.has(file.file)) return { ok: false, files: [], code: 'invalid', reason: '封面清单条目无效' };
      names.add(file.file);
      let actual;
      try { actual = coverFingerprint(path.join(dir, file.file)); }
      catch { return { ok: false, files: [], code: 'missing-file', reason: '封面图片文件缺失：' + file.file }; }
      if (file.sha256 !== actual.sha256 || file.size !== actual.size) return { ok: false, files: [], code: 'tampered', reason: '封面图片与清单指纹不符：' + file.file };
    }
    return { ok: true, files: manifest.files, reviewed: false };
  } catch (error) {
    return { ok: false, files: [], code: 'error', reason: '无法核验封面：' + error.message };
  }
}
