/* Machine-only production gate. No state edits, waivers, TTS or media writes.
 * API: await productionQuality(project, { profile = 'strict', phase = 'final',
 *   checkers?, exec?, voice?, speed?, reuseRendered = false }); productionQualityStatus(project,
 *   { profile = 'strict', phase = 'final' }) is read-only.
 * Profiles are explicit (callers resolve workflow policy): technical retains all
 * input/build/runtime/resource/subtitle/media checks but NEVER runs contrast or
 * layout, recording { ok:null, status:'not-run', required:false } for each.
 * Strict requires both visual checks. A technical reader accepts a complete
 * current strict receipt, never vice versa. Profile-less v1 receipts mean strict.
 * reuseRendered:true only allows final to reuse a byte-current, fully validated
 * pre-render receipt of the SAME profile. Its browser evidence is copied with
 * receipt/source provenance; final artifact/SRT/decode/audio and both identity
 * boundaries still run. Defaults to false (direct audits always rerun browser).
 * Test seams: checkers.{contrast,layout,subtitles}(project) and
 * exec(command,args,{timeout,maxBuffer,onStdout}) -> {status,stdout,stderr,error?}.
 * There is deliberately no skip/force/threshold override. A checker needs positive
 * sampling evidence as well as ok:true. Injected checks are trusted test code,
 * not a security boundary; persisted receipts are not cryptographically signed.
 *
 * Identity costs O(source + assets + media bytes), synchronously in bounded chunks,
 * at BOTH boundaries (also on read-only status). No timestamp-only hash cache.
 * Asset coverage/limitations are those documented in asset-inputs.mjs: keep all
 * transitive/dynamic local resources in assets/. Remote resources are not pinned.
 * Boundary snapshots detect changed end state, not adversarial change-and-restore
 * between observations; this is not a filesystem transaction or a sandbox.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { artifactStatus } from './artifact-status.mjs';
import { assetInputs } from './asset-inputs.mjs';
import { subtitleData, subtitleStatus } from './subtitle-export.mjs';
import { observeSubtitleBatch } from './subtitle-observation.mjs';
import { sampleTextContrast } from './contrast-rendered.mjs';
import { layoutFindings, layoutTimes, settledTimes, activeLayoutFrame, sceneSubjectCount, mergeLayoutFindings, LAYOUT_POLICY_VERSION } from './layout-geometry.mjs';
import { observeLayoutBatch, layoutProbeBatches } from './layout-observation.mjs';
import { launchBrowser } from './browser.mjs';
import { timingObservation } from './timing-observation.mjs';
import { parseSceneRanges, parseSceneBodies, parseScript, hashFile } from './state.mjs';
import { maskJS } from './js-mask.mjs';
import { assertVideoFormat } from './video-format.mjs';
import { assertDurationLimit } from './duration-limit.mjs';
import { registerProductionChild } from './production-lock.mjs';

const VERSION = 1;
const RECEIPT = 'out/.vh-production-quality.json';
const MEDIA = 'out/video-voice.mp4';
const SOURCES = ['脚本.md', 'scenes.src.js', 'engine.tpl.html', 'timing.json', 'scene.html', 'PROJECT.json', 'claims.json'];
const BASE = ['inputs', 'assets', 'timing', 'structure', 'build', 'contrast', 'layout', 'subtitles'];
const FINAL = ['artifact', 'srt', 'decode', 'audio'];
const TIMEOUT = 120000;
const scope = '仅机器抽样可读性、真实文字行框/组件碰撞/裁切/安全区、字幕实显及最终媒体完整解码/首条音轨全静音与严重近满幅检测；不代表逐帧无错、语义、事实、审美、同步、听感或人工审片通过。';
const profileScope = profile => profile === 'strict' ? scope :
  '仅机器核验输入/构建、浏览器运行与资源、每句字幕首中尾实显及最终媒体完整解码/首条音轨全静音与严重近满幅检测；未执行对比度或版式审计，不代表逐帧无错、语义、事实、审美、同步、听感或人工审片通过。';
const sha = data => createHash('sha256').update(data).digest('hex');
const message = e => String(e?.message || e).slice(0, 500);
const issue = (category, text, hint) => ({ category, message: message(text), hint });
const pass = (id, details = {}) => ({ id, ok: true, status: 'passed', issues: [], ...details });
const fail = (id, category, text, hint, status = 'failed') => ({ id, ok: false, status, issues: [issue(category, text, hint)] });
const visualChecks = ['contrast', 'layout'];
const notRun = id => ({ id, ok: null, status: 'not-run', required: false, issues: [], reason: 'technical profile does not audit visual design' });
const validProfile = profile => ['strict', 'technical'].includes(profile);

// O_NOFOLLOW and regular-file checks avoid following an output symlink/FIFO.
function fingerprint(project, name, optional = false) {
  const file = path.join(project, name);
  for (const part of name.split('/').slice(0, -1)) {
    // These inputs only have one directory component (out/).
    try { if (!fs.lstatSync(path.join(project, part)).isDirectory()) throw new Error('不是普通目录：' + part); }
    catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error('不是普通文件：' + name);
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0, n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) { hash.update(buffer.subarray(0, n)); size += n; }
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    if (size !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        current.ino !== before.ino || current.dev !== before.dev) throw new Error('读取期间文件变化：' + name);
    return { file: name, size, sha256: hash.digest('hex') };
  } catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function inputs(project, phase) {
  const assets = assetInputs(project);
  if (assets.issues.length) throw new Error('素材无法核验：' + assets.issues.slice(0, 4).join('；'));
  const files = [...SOURCES, ...(phase === 'final' ? ['out/subtitles.srt'] : [])]
    .map(name => fingerprint(project, name, name !== 'scene.html'));
  return sha(JSON.stringify({ version: VERSION, layoutPolicy: LAYOUT_POLICY_VERSION, files, assets: assets.signature }));
}
function mediaIdentity(project) {
  return { media: fingerprint(project, MEDIA), renderMedia: fingerprint(project, 'out/video.mp4') };
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Pure data only: never import a project's timeline.mjs/gen.mjs or skill checks.
function structuralChecks(project, requested) {
  const checks = [];
  const run = (id, hint, fn) => { try { fn(); checks.push(pass(id)); } catch (e) { checks.push(fail(id, id, e, hint)); } };
  run('assets', '修复缺失/不可读/符号链接素材；本地动态依赖请放 assets/ 下', () => {
    const assets = assetInputs(project); if (assets.issues.length) throw new Error(assets.issues.slice(0, 4).join('；'));
  });
  run('timing', '先 vh measure 生成匹配当前脚本的标准实测时间轴，再 vh build', () => {
    const timing = timingObservation(project, requested);
    if (timing.state !== 'valid') throw new Error(timing.reason || '标准时间轴未通过核验');
  });
  run('structure', '修复场数/场景区间/总时长/字幕数据，再 vh build；不得用 force 掩盖结构错误', () => {
    const html = fs.readFileSync(path.join(project, 'scene.html'), 'utf8');
    const code = maskJS(html);
    const { ranges, duration } = parseSceneRanges(code);
    const bodies = parseSceneBodies(html), script = parseScript(fs.readFileSync(path.join(project, '脚本.md'), 'utf8'));
    const timing = JSON.parse(fs.readFileSync(path.join(project, 'timing.json'), 'utf8'));
    const chunks = fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8').split(/^\/\/---\s*$/m).filter(s => s.trim());
    const headers = [...fs.readFileSync(path.join(project, '脚本.md'), 'utf8').matchAll(/^##\s*S(\d+)\b/gm)];
    if (!script.length || headers.length !== script.length || script.some((s, i) => s.n !== i + 1) ||
      script.length !== ranges.length || bodies.length !== ranges.length || chunks.length !== ranges.length)
      throw new Error('脚本/源场景/生成场景数量或 S 编号不一致（空场不允许）');
    if (!Number.isFinite(duration) || duration <= 0 || ranges.some(([a, b], i) => !Number.isFinite(a + b) ||
      a < 0 || b <= a || i > 0 && a < ranges[i - 1][1] - 1e-6) ||
      Math.abs(ranges.at(-1)[1] - duration) > 1e-6) throw new Error('场景区间须有序不重叠，最后一场覆盖至 DURATION');
    if (Math.abs(timing.dur - duration) > 1e-6 || !equal(ranges, timing.scenes)) throw new Error('生成场景区间/DURATION 与 timing.json 不一致');
    const subs = subtitleData(html), lines = script.flatMap(s => s.lines.map(l => l.t));
    const cues = data => data?.map(({ s, e, t }) => ({ s, e, t }));
    if (!equal(cues(subs), cues(timing.subs)) || subs.length !== lines.length || subs.some((s, i) => s.t !== lines[i] || s.e > duration))
      throw new Error('生成字幕与当前脚本/实测时间轴不完整或不一致');
    assertDurationLimit(project, duration, '时间轴');
    assertVideoFormat(project); // Accept both explicitly selected orientations.
  });
  run('build', '源输入已变或缺构建基线；先 vh build，再重跑完整质量检查', () => {
    const state = JSON.parse(fs.readFileSync(path.join(project, 'out/.vh-state.json'), 'utf8'));
    const stamp = state.genStamp;
    if (!stamp || stamp.scriptHash !== hashFile(path.join(project, '脚本.md')) || stamp.scenesHash !== hashFile(path.join(project, 'scenes.src.js')))
      throw new Error('画面缺少匹配当前脚本/场景源码的构建基线');
    if (stamp.sourceHashes && SOURCES.filter(n => !['scene.html', 'PROJECT.json', 'claims.json'].includes(n))
      .some(n => stamp.sourceHashes[n] !== hashFile(path.join(project, n)))) throw new Error('画面构建输入基线已过期');
  });
  return checks;
}

async function bounded(run) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(run), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('检查超时，不能视为通过')), TIMEOUT);
  })]); } finally { clearTimeout(timer); }
}

// One real browser pass, using the actual W/H rather than a landscape-only viewport.
// Layout uses entry/exit, periodic and cue-edge probes; contrast keeps two
// settled frames/scene. Subtitle start/middle/end probes. No empty-pass success.
async function renderedChecks(project, { profile = 'strict' } = {}) {
  const html = fs.readFileSync(path.join(project, 'scene.html'), 'utf8');
  const subs = subtitleData(html);
  const { ranges } = parseSceneRanges(maskJS(html));
  if (!ranges.length || ranges.some(([a, b]) => !Number.isFinite(a + b) || b <= a)) throw new Error('没有有效场景采样区间；先 vh build');
  const { chromium } = await import('playwright');
  const browser = await launchBrowser(chromium, { headless: true, args: ['--mute-audio'], timeout: 30000 });
  const timer = setTimeout(() => { void browser.close().catch(() => {}); }, TIMEOUT);
  const errors = [], contrast = [], layout = [], failures = [];
  const layoutEvidence = new Map(), contrastEvidence = new Map();
  let measured = 0, probes = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(30000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('requestfailed', r => errors.push('资源加载失败：' + r.url()));
    page.on('response', r => { if (r.status() >= 400) errors.push('资源响应失败：' + r.status() + ' ' + r.url()); });
    await page.goto(pathToFileURL(path.join(project, 'scene.html')).href);
    const size = await page.evaluate(() => ({ width: window.W, height: window.H }));
    if (![size.width, size.height].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw new Error('画布 W/H 无效；先 vh build');
    await page.setViewportSize(size);
    await page.evaluate(async () => {
      await document.fonts.ready;
      if (window.__ready) await window.__ready;
      else if (window.VH_UI?.assetsReady) await window.VH_UI.assetsReady();
      if (typeof window.renderAt !== 'function') throw new Error('缺少 renderAt');
      if ([...document.images].some(img => !img.complete || !img.naturalWidth)) throw new Error('图片未成功加载');
    });
    // Do not even construct visual probes in technical mode: subtitle geometry
    // is the only geometry inspected, at every cue's start/middle/end.
    const contrastTimes = new Set(profile === 'strict' ? settledTimes(ranges) : []);
    const probesForLayout = profile === 'strict' ? layoutTimes(ranges, subs) : [];
    for (const batch of profile === 'strict' ? layoutProbeBatches(probesForLayout, contrastTimes) : []) {
      for (const { t: time, scene: sceneNo, frame: observed } of await page.evaluate(observeLayoutBatch, batch)) {
        const frame = activeLayoutFrame(observed, sceneNo);
        // A neighbouring scene fading in/out is not its settled reading state.
        // Inspect its layout while visible, but measure readability on its own
        // settled probes, rather than condemning every ordinary crossfade.
        const rows = frame.texts;
        const subjects = sceneSubjectCount(frame, sceneNo, { singleScene: ranges.length === 1 });
        layoutEvidence.set(sceneNo, (layoutEvidence.get(sceneNo) || 0) + subjects);
        for (const finding of layoutFindings(frame)) layout.push({ ...finding, t: time,
          msg: `t=${time.toFixed(2)} ${finding.msg}` });
        if (!contrastTimes.has(time)) continue;
        contrastEvidence.set(sceneNo, (contrastEvidence.get(sceneNo) || 0) + subjects);
        measured += rows.length;
        contrast.push(...await sampleTextContrast(page, rows, { t: time }));
      }
    }
    const subtitleProbes = subs.flatMap((sub, i) => [sub.s + Math.min(.02, (sub.e - sub.s) / 4), (sub.s + sub.e) / 2, sub.e - Math.min(.02, (sub.e - sub.s) / 4)]
      .map(time => ({ cue: i + 1, time, text: sub.t })));
    for (let start = 0; start < subtitleProbes.length; start += 24) {
      const batch = await page.evaluate(observeSubtitleBatch, subtitleProbes.slice(start, start + 24));
      probes += batch.length;
      for (const state of batch) if (state.missing || !state.visible || state.overflow || state.outside || !state.matches)
        failures.push({ msg: `字幕 ${state.cue} 在 ${state.time.toFixed(2)}s 缺失、隐藏、不完整或越界` });
    }
    // renderAt may introduce images after initial readiness. This is resource
    // validity, not a visual-design scan, and remains mandatory in both profiles.
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(async img => {
        await img.decode();
        if (!img.complete || !img.naturalWidth) throw new Error('图片未成功加载');
      }));
    });
    if (errors.length) throw new Error(errors.slice(0, 3).join('；'));
    for (const [scene, count] of layoutEvidence) if (!count) layout.push({ kind: 'empty-scene', scene, element: 'scene-' + scene,
      msg: `第 ${scene} 场采样未观测到文字或主体，不能借用其他场/全局文字的证据` });
    for (const [scene, count] of contrastEvidence) if (!count) contrast.push({ kind: 'empty-scene', scene, element: 'scene-' + scene,
      msg: `第 ${scene} 场停稳采样未观测到文字或主体，不能宣布对比度检查通过` });
    return { contrast: profile === 'strict' ? { ok: !contrast.length, findings: contrast, sampled: ranges.length * 2, measured, sceneEvidence: Object.fromEntries(contrastEvidence) } : notRun('contrast'),
      layout: profile === 'strict' ? { ok: !layout.length, findings: mergeLayoutFindings(layout), sampled: probesForLayout.length, measured, sceneEvidence: Object.fromEntries(layoutEvidence) } : notRun('layout'),
      subtitles: { ok: !failures.length, failures, errors: [], probes, cues: subs.length } };
  } finally { clearTimeout(timer); await browser.close(); }
}

function normalized(id, result, expectedCues) {
  const hint = id === 'contrast' ? '修改实际字色/底色后重跑质量检查' : id === 'layout' ? '修复文字盒子与画布边界后重跑' : '修复字幕实显与边界；先 vh build，再重跑';
  const findings = [...(Array.isArray(result?.findings) ? result.findings : []), ...(Array.isArray(result?.failures) ? result.failures : []),
    ...(Array.isArray(result?.errors) ? result.errors : [])];
  const evidence = id === 'subtitles' ? Number.isInteger(result?.cues) && result.cues > 0 && result.cues === expectedCues && Number.isInteger(result?.probes) &&
    result.probes >= result.cues * 3 : Number.isInteger(result?.sampled) && result.sampled > 0;
  if (result?.ok !== true || !evidence || findings.length || result?.error || result?.skipped ||
      result?.status != null && !['passed', 'clear'].includes(result.status))
    return { ...fail(id, evidence && findings.length ? 'quality' : 'checker', result?.error || result?.note || '检查未成功执行或发现硬错误', hint),
      issues: (findings.length ? findings.slice(0, 12).map(f => ({ ...issue('quality', f?.msg || f?.message || f, hint),
        ...(f?.kind ? { code: f.kind, scene: f.scene, element: f.element, other: f.other, t: f.t } : {}) })) :
        [issue('checker', result?.error || result?.note || '检查无成功采样证据，不能当作通过', hint)]) };
  return pass(id, { sampled: id === 'subtitles' ? result.probes : result.sampled,
    ...(id === 'subtitles' ? { cues: result.cues } : {}),
    ...(result.sceneEvidence ? { sceneEvidence: result.sceneEvidence, textMeasured: result.measured } : {}) });
}

// Streaming, bounded subprocess execution. All production ffmpeg outputs are null
// or pipe:1; no -y, no destination files and no shell. Timeouts kill the process.
function execute(command, args, { timeout, maxBuffer = 1024 * 1024, onStdout } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let timer, error, registration, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    if (child.pid && process.env.VH_PRODUCTION_LOCK_TOKEN) {
      try { registration = registerProductionChild(process.env.VH_PRODUCTION_LOCK_PROJECT, child.pid); }
      catch (e) { error = e; child.kill('SIGKILL'); }
    }
    const stop = reason => { error ||= reason; child.kill('SIGKILL'); };
    timer = setTimeout(() => stop(new Error('媒体探针超时')), timeout);
    child.on('error', e => { error = e; });
    child.stdout.on('data', chunk => {
      try { if (onStdout) onStdout(chunk); else if (stdout.length + chunk.length <= maxBuffer) stdout = Buffer.concat([stdout, chunk]); else stop(new Error('探针输出过大')); }
      catch (e) { stop(e); }
    });
    child.stderr.on('data', chunk => { if (stderr.length + chunk.length <= maxBuffer) stderr = Buffer.concat([stderr, chunk]); else stop(new Error('探针错误输出过大')); });
    child.on('close', status => { clearTimeout(timer); registration?.unregister(); resolve({ status, error, stdout: onStdout ? null : stdout, stderr: stderr.toString('utf8') }); });
  });
}
function execError(result) {
  if (!result || result.error || result.status !== 0 || result.signal) throw new Error(message(result?.error || result?.stderr || '媒体探针未成功结束'));
  if (String(result.stderr || '').trim()) throw new Error(message(result.stderr));
}
async function decode(file, exec) {
  const r = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-i', file, '-map', '0:v', '-map', '0:a', '-f', 'null', '-'], { timeout: TIMEOUT, maxBuffer: 1024 * 1024 });
  execError(r); return pass('decode');
}
async function audio(file, exec) {
  let tail = Buffer.alloc(0), samples = 0, nearFull = 0, peak = 0;
  const consume = chunk => {
    const bytes = Buffer.concat([tail, Buffer.from(chunk)]), end = bytes.length - bytes.length % 4;
    for (let i = 0; i < end; i += 4) {
      const v = Math.abs(bytes.readFloatLE(i)); if (!Number.isFinite(v)) throw new Error('音轨含无效采样');
      samples++; peak = Math.max(peak, v); if (v >= .999) nearFull++;
    }
    tail = Buffer.from(bytes.subarray(end));
  };
  const r = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-map', '0:a:0', '-vn', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
    { timeout: TIMEOUT, maxBuffer: 1024 * 1024, onStdout: consume });
  execError(r);
  if (r.stdout != null) consume(r.stdout); // Deterministic non-streaming test executors.
  if (!samples || tail.length) throw new Error('没有完整音频采样');
  const details = { samples, peak, nearFullRatio: nearFull / samples };
  if (peak <= 1e-6) return { ...fail('audio', 'silence', '首条音轨整体全静音（峰值 ≤ -120 dBFS）', '检查已有音频与混流；普通停顿不在本项拦截范围'), ...details };
  if (nearFull / samples >= .1) return { ...fail('audio', 'clipping', '首条音轨至少 10% 采样接近/超过满幅，疑似严重削波', '降低混流增益并核对原音频；本项不等于听感评价'), ...details };
  return pass('audio', details);
}

function artifactCheck(project) {
  const a = artifactStatus(project);
  return a?.deliverable?.stale === false && a.deliverable.video === MEDIA ? pass('artifact') :
    fail('artifact', 'stale', a?.deliverable?.reason || '交付产物无法核验', '按产物状态修复构建/渲染/混流基线后重跑');
}
function srtCheck(project) {
  const s = subtitleStatus(project);
  return s.ok === true ? pass('srt') : fail('srt', 'subtitles', s.reason || s.error || 'SRT 无效', '运行 vh subtitles 独立导出当前 SRT；不需要重做 TTS');
}
function atomicReceipt(project, receipt) {
  const dir = path.join(project, 'out');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('out 必须是普通目录');
  const target = path.join(project, RECEIPT), temp = target + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined; fs.renameSync(temp, target);
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
}

/** Both phases run the profile's required browser checks. Final additionally
 * requires a valid artifact contract, current SRT and full-media probes.
 * checkers are trusted test seams; technical never accesses visual checkers. */
export async function productionQuality(project, { profile = 'strict', phase = 'final', checkers = {}, exec = execute, voice, speed, reuseRendered = false } = {}) {
  if (!validProfile(profile)) throw new Error('profile 必须是 strict 或 technical');
  if (!['pre-render', 'final'].includes(phase)) throw new Error('phase 必须是 pre-render 或 final');
  const checks = []; let sourceSignature = null, identity = null;
  try { sourceSignature = inputs(project, phase); checks.push(pass('inputs')); }
  catch (e) { checks.push(fail('inputs', 'inputs', e, '修复缺失源文件/素材后重新构建并检查')); }
  checks.push(...structuralChecks(project, { voice, speed }));
  if (phase === 'final') {
    try { identity = mediaIdentity(project); }
    catch (e) { checks.push(fail('media-identity', 'media', e, '补齐有效的渲染与配音成片后重跑')); }
  }
  let real, expectedCues, reusable, renderedReuse;
  if (phase === 'final' && reuseRendered === true) {
    const previous = productionQualityStatus(project, { profile, phase: 'pre-render' });
    if (previous.ok && (previous.receipt.profile ?? 'strict') === profile) {
      reusable = previous.receipt;
      renderedReuse = { phase: 'pre-render', profile, sourceSignature: reusable.sourceSignature,
        receiptSignature: sha(JSON.stringify(reusable)), at: reusable.at,
        checks: profile === 'strict' ? ['contrast', 'layout', 'subtitles'] : ['subtitles'] };
    }
  }
  try { expectedCues = subtitleData(fs.readFileSync(path.join(project, 'scene.html'), 'utf8')).length; } catch {}
  for (const id of ['contrast', 'layout', 'subtitles']) {
    if (profile === 'technical' && visualChecks.includes(id)) { checks.push(notRun(id)); continue; }
    if (reusable) { checks.push(structuredClone(reusable.checks.find(c => c.id === id))); continue; }
    try {
      const checker = Object.hasOwn(checkers, id) ? checkers[id] : () => (real ??= renderedChecks(project, { profile })).then(r => r[id]);
      if (typeof checker !== 'function') throw new Error('检查器不可用：' + id);
      checks.push(normalized(id, await bounded(() => checker(project)), expectedCues));
    } catch (e) { checks.push(fail(id, 'checker', e, '修复检查器/浏览器环境后重跑；不得跳过或人工勾选放行')); }
  }
  if (phase === 'final') {
    for (const [id, run] of [['artifact', () => artifactCheck(project)], ['srt', () => srtCheck(project)],
      ['decode', () => decode(path.join(project, MEDIA), exec)], ['audio', () => audio(path.join(project, MEDIA), exec)]]) {
      try { checks.push(await bounded(run)); }
      catch (e) { checks.push(fail(id, 'checker', e, id === 'srt' ? '运行 vh subtitles；不需要重做 TTS' : '修复媒体/探针环境后重跑；不可跳过')); }
    }
  }
  try {
    if (!sourceSignature || inputs(project, phase) !== sourceSignature || phase === 'final' && (!identity || !equal(identity, mediaIdentity(project))))
      throw new Error('质量检查运行期间输入或成片改变，结果不得用于当前版本');
    checks.push(pass('stable'));
  } catch (e) { checks.push(fail('stable', 'changed', e, '等待编辑/渲染结束后，重新运行完整质量检查')); }
  for (const c of checks) c.required ??= true;
  const receipt = { version: VERSION, profile, phase, sourceSignature, ...(identity || {}), ...(renderedReuse ? { renderedReuse } : {}), checks,
    ok: checks.every(c => c.required === false || c.ok === true), at: new Date().toISOString(), scope: profileScope(profile) };
  try { atomicReceipt(project, receipt); }
  catch (e) { receipt.checks.push(fail('receipt', 'io', e, '修复 out 目录写入权限后重跑')); receipt.ok = false; }
  return receipt;
}

/** Read-only validation, not merely a JSON loader. Only a structurally complete,
 * successful receipt with current source/media identity is accepted. */
export function productionQualityStatus(project, { profile = 'strict', phase = 'final' } = {}) {
  const invalid = reason => ({ ok: false, stale: true, profile, phase, reason, receipt: null });
  if (!validProfile(profile)) return invalid('质量检查 profile 无效');
  if (!['pre-render', 'final'].includes(phase)) return invalid('质量检查阶段无效');
  let r;
  try { r = JSON.parse(fs.readFileSync(path.join(project, RECEIPT), 'utf8')); }
  catch { return invalid('缺少有效质量回执，请运行生产质量检查'); }
  const receiptProfile = r?.profile === undefined ? 'strict' : r.profile;
  if (!validProfile(receiptProfile) || profile === 'strict' && receiptProfile !== 'strict')
    return invalid('质量回执 profile 不符；strict 检查不能复用 technical 回执');
  const ids = [...BASE, ...(phase === 'final' ? FINAL : []), 'stable'];
  const required = ids.filter(id => receiptProfile === 'strict' || !visualChecks.includes(id));
  const passed = c => c?.ok === true && c.status === 'passed' && c.required !== false && Array.isArray(c.issues) && !c.issues.length;
  if (r?.version !== VERSION || r.phase !== phase || r.ok !== true || !Number.isFinite(Date.parse(r.at)) || !Array.isArray(r.checks) ||
      !ids.every(id => r.checks.filter(c => c?.id === id).length === 1) ||
      !required.every(id => passed(r.checks.find(c => c?.id === id))) ||
      r.checks.some(c => receiptProfile === 'technical' && visualChecks.includes(c?.id) ?
        c.ok !== null || c.status !== 'not-run' || c.required !== false || !Array.isArray(c.issues) || c.issues.length : !passed(c)) ||
      !(receiptProfile === 'strict' ? ['contrast', 'layout', 'subtitles'] : ['subtitles']).every(id =>
        Number.isInteger(r.checks.find(c => c?.id === id)?.sampled) && r.checks.find(c => c?.id === id).sampled > 0))
    return invalid('质量回执不完整、阶段不符或检查未通过，请修复后重跑');
  try {
    if (inputs(project, phase) !== r.sourceSignature) return invalid('当前源文件/素材/字幕已改变，请重跑质量检查');
    const structural = structuralChecks(project, {}).find(c => !c.ok);
    if (structural) return invalid(structural.issues[0].message);
    const cues = subtitleData(fs.readFileSync(path.join(project, 'scene.html'), 'utf8')).length;
    const subtitles = r.checks.find(c => c.id === 'subtitles');
    if (!cues || subtitles.sampled < cues * 3 || subtitles.cues !== undefined && subtitles.cues !== cues)
      return invalid('字幕回执未覆盖当前每句的首中尾采样，请重跑质量检查');
    if (phase === 'final') {
      if (!equal({ media: r.media, renderMedia: r.renderMedia }, mediaIdentity(project))) return invalid('最终媒体身份已改变，请重跑质量检查');
      const a = artifactCheck(project), s = srtCheck(project);
      if (!a.ok || !s.ok) return invalid((!a.ok ? a : s).issues[0].message);
    }
  } catch (e) { return invalid('无法核验当前输入/媒体：' + message(e)); }
  return { ok: true, stale: false, profile, phase, reason: null, receipt: r, scope: profileScope(receiptProfile) };
}
export function readProductionQuality(project, options) {
  return productionQualityStatus(project, options).receipt;
}
