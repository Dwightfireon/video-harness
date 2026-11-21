/* Read-only artifact contract, shared by status and completion. No state/CLI imports.
 * CLI records createArtifactRecord() ONLY after a successful render/mux (and
 * faststart). Keep the existing incremental-render fields alongside `artifact`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { videoFormatState, videoMediaFormatError } from './video-format.mjs';
import { projectPendingChanges, projectSemanticReviewPending } from './change-contract.mjs';
import { durationLimit, durationLimitError, assertDurationLimit } from './duration-limit.mjs';
import { assetInputs } from './asset-inputs.mjs';

export const FNV_SEED = 0x811c9dc5;
export function fnv1a(str) {
  let h = FNV_SEED;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}
export const hashFile = file => { try { return fnv1a(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const json = file => { try { return JSON.parse(read(file)); } catch { return null; } };
const stat = file => { try { const s = fs.statSync(file); return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null; } catch { return null; } };
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.5;
const positive = n => Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null;
export const SOURCE_NAMES = Object.freeze(['脚本.md', 'scenes.src.js', 'engine.tpl.html', 'timing.json', 'scene.html']);

// Stable key order; useful for persisted metadata as well as source maps.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const metadataSignature = value => fnv1a(JSON.stringify(canonical(value)));

export function currentArtifactInputs(project) {
  const sourceHashes = Object.fromEntries(SOURCE_NAMES.map(name => [name, hashFile(path.join(project, name))]));
  const assets = assetInputs(project);
  // 空工程保持兼容；本地素材或明确问题状态一旦存在，其身份进入构建/媒体凭证。
  if (assets.files.length || assets.issues.length) sourceHashes['local-assets'] = assets.signature;
  // Only the production constraint matters, not PROJECT.json's unrelated UI metadata.
  sourceHashes['PROJECT.json#videoFormat'] = metadataSignature(json(path.join(project, 'PROJECT.json'))?.videoFormat ?? null);
  const config = json(path.join(project, 'PROJECT.json'));
  // 仅限启用预算的项目，旧项目凭证不因新增规则无端过期。
  if (config && Object.hasOwn(config, 'durationLimit')) sourceHashes['PROJECT.json#durationLimit'] = metadataSignature(config.durationLimit);
  const scene = read(path.join(project, 'scene.html'));
  return { sourceHashes, sourceSignature: metadataSignature(sourceHashes), assetIssues: assets.issues,
    sceneHtmlHash: sourceHashes['scene.html'],
    timelineDur: positive(scene.match(/DURATION\s*=\s*([\d.]+)/)?.[1]),
    ranges: [...scene.matchAll(/addScene\(\s*([\d.]+)\s*,\s*([\d.]+)/g)].map(m => [+m[1], +m[2]]) };
}

// Binary fingerprints use SHA-256, not UTF-8 decoding (and do not load a long
// movie into memory). A duration or mtime alone can never identify an artifact.
export function mediaFingerprint(file) {
  let fd;
  try {
    const info = stat(file);
    if (!info) return null;
    fd = fs.openSync(file, 'r');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n));
    return { ...info, sha256: hash.digest('hex') };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function probeMedia(file) {
  if (!stat(file)) return null;
  try {
    const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height,duration,sample_rate,channels', '-of', 'json', file],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) return null;
    const data = JSON.parse(result.stdout), duration = positive(data.format?.duration);
    if (!duration) return null;
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const video = streams.find(s => s.codec_type === 'video' && s.codec_name && s.width > 0 && s.height > 0);
    const audio = streams.find(s => s.codec_type === 'audio' && s.codec_name && s.channels > 0 && positive(s.sample_rate)
      && (s.duration == null || positive(s.duration)));
    return { duration, video: video || null, audio: audio || null };
  } catch { return null; }
}
export function probeDuration(file) { return probeMedia(file)?.duration ?? null; }

function durationError(media, timeline, voiced = false) {
  if (!media || !timeline) return null;
  const label = voiced ? '配音' : '成片';
  if (!near(media.duration, timeline)) return `${label}实际 ${media.duration.toFixed(2)}s，当前时间轴 ${timeline.toFixed(2)}s —— ${label}不是这一版，需要重新生成`;
  // A long audio/container duration must not hide a short video stream (or the
  // reverse). MP4 exposes these; other containers can omit stream duration.
  const videoDur = positive(media.video?.duration), audioDur = positive(media.audio?.duration);
  if (videoDur && !near(videoDur, timeline)) return `${label}视频流实际 ${videoDur.toFixed(2)}s，当前时间轴 ${timeline.toFixed(2)}s，需要重新渲染`;
  if (voiced && audioDur && !near(audioDur, timeline)) return `配音音轨实际 ${audioDur.toFixed(2)}s，当前时间轴 ${timeline.toFixed(2)}s，需要重新配音`;
  return null;
}

/** Read-only receipt factory. Persist as render.artifact / voice.artifact.
 * A duplicate under artifacts.render can survive measure clearing render; it
 * remains usable ONLY if all source hashes and the media SHA still match.
 * Never manufacture a receipt when merely checking old/untrusted media.
 */
export function createArtifactRecord(project, kind, { expectedInputs, expectedRenderMedia } = {}) {
  if (!['render', 'voice'].includes(kind)) throw new Error('Unknown artifact kind');
  const name = kind === 'render' ? 'out/video.mp4' : 'out/video-voice.mp4';
  const current = currentArtifactInputs(project), file = path.join(project, name), media = probeMedia(file);
  if (durationLimit(project)) {
    assertDurationLimit(project, current.timelineDur, '时间轴');
    assertDurationLimit(project, media?.duration, '成片');
  }
  if (expectedInputs && current.sourceSignature !== expectedInputs.sourceSignature) throw new Error('阶段运行期间作者文件/时间轴发生变化，拒绝为旧输入产物登记新版本凭证；请核对后重跑当前阶段');
  if (!current.timelineDur || !media?.video || durationError(media, current.timelineDur, kind === 'voice')
      || kind === 'voice' && !media.audio) throw new Error('无法记录无效、无音轨或时长不符的成片：' + name);
  const format = videoFormatState(project);
  const error = videoMediaFormatError(project, file, media);
  if (format.locked && format.pendingBuild || error) throw new Error(error || '预览尚未按所选画幅重建');
  const fingerprint = mediaFingerprint(file);
  if (!fingerprint) throw new Error('无法读取成片指纹：' + name);
  const renderMedia = kind === 'voice' ? mediaFingerprint(path.join(project, 'out/video.mp4')) : undefined;
  if (kind === 'voice' && !renderMedia) throw new Error('缺少配音所用的静音成片');
  if (kind === 'voice' && expectedRenderMedia && (renderMedia.sha256 !== expectedRenderMedia.sha256 || renderMedia.size !== expectedRenderMedia.size)) throw new Error('配音期间静音成片被替换，拒绝登记混流凭证');
  return { version: 1, kind, ...current, media: fingerprint,
    ...(renderMedia ? { renderMedia } : {}) };
}

function recordError(record, kind, current, media) {
  if (record?.version !== 1 || record.kind !== kind || !record.sourceHashes || !record.media?.sha256) return '产物指纹记录无效，需要重新生成';
  if (metadataSignature(record.sourceHashes) !== record.sourceSignature
      || record.sourceSignature !== current.sourceSignature
      || JSON.stringify(canonical(record.sourceHashes)) !== JSON.stringify(canonical(current.sourceHashes))) return '源文件内容已改变，需要重新渲染并配音';
  if (record.sceneHtmlHash !== current.sceneHtmlHash || record.timelineDur !== current.timelineDur
      || JSON.stringify(record.ranges) !== JSON.stringify(current.ranges)) return '时间轴或画面与产物记录不符，需要重新渲染';
  if (!media || record.media.sha256 !== media.sha256 || record.media.size !== media.size) return '成片文件与已记录指纹不符，需要重新生成';
  return null;
}

/** Pure decision layer. artifactStatus supplies read-only observations. */
export function evaluateArtifactStatus(observed) {
  const { current, state, sources, render, voice, format, formatError, manifestDur } = observed;
  const stale = {};
  const renderRecord = state.render?.artifact ?? state.artifacts?.render;
  const renderRecordError = renderRecord ? recordError(renderRecord, 'render', current, render.fingerprint) : null;
  const renderReceiptValid = !!renderRecord && !renderRecordError && render.exists && !!render.media?.video;
  if (!current.sceneHtmlHash) stale.scene = 'scene.html 不存在，先 vh build --estimate';
  else {
    const stamp = state.genStamp;
    if (!stamp) stale.scene = '缺少构建输入基线，先 vh build，再核对布局与下游产物';
    if (stamp && (stamp.scriptHash !== current.sourceHashes['脚本.md'] || stamp.scenesHash !== current.sourceHashes['scenes.src.js'])) stale.scene = '脚本.md 或 scenes.src.js 已改变，先 vh build';
    const buildHashes = stamp?.sourceHashes;
    if (buildHashes && SOURCE_NAMES.filter(n => n !== 'scene.html').some(n => buildHashes[n] !== current.sourceHashes[n])) stale.scene = '构建输入已改变，先 vh build';
    if (buildHashes && buildHashes['local-assets'] !== current.sourceHashes['local-assets']) stale.scene = '本地素材字节/依赖已改变，先 vh build，再重新渲染与配音';
    if (!renderReceiptValid && sources['engine.tpl.html']?.mtimeMs > sources['scene.html']?.mtimeMs) stale.scene = '引擎比 scene.html 新，先 vh build，再整片重渲';
    // videoFormatState also flags a timestamp-only template touch. A complete
    // matching receipt proves that the template/scene/constraint bytes are
    // unchanged; actual orientation and media dimensions still get checked.
    if (format?.locked && format.pendingBuild && (!renderReceiptValid || format.actualOrientation !== format.orientation)) stale.scene = '预览与项目所选画幅或最新引擎不一致，先 vh build，再整片重渲';
  }
  if (formatError) stale.scene = formatError;

  /* 提示文案是给人看的，必须能直接读懂并照做。
   * 旧文案「还没渲染过成片（vh render）」只是把命令名丢给用户，
   * 既没说这是"状态"不是"报错"，也没说下一步到底该做什么。 */
  if (!render.exists) stale.render = '成片还没生成（正常状态：这一步还没做到）。下一步先 vh build 出画面预览，再 vh render 渲染成片';
  else if (!render.media?.video) stale.render = '静音成片损坏或无法核验真实视频流，需要整片重渲';
  else if (renderRecord) stale.render = renderRecordError || undefined;
  else if (!state.render?.sceneHtmlHash) stale.render = '成片存在但没有渲染基线，需要整片重渲（时长相等不能证明画面未改）';
  else if (state.render.sceneHtmlHash !== current.sceneHtmlHash) stale.render = '画面比 out/video.mp4 新，需要渲染';
  else if (!state.genStamp || state.genStamp.scriptHash !== current.sourceHashes['脚本.md']
      || state.genStamp.scenesHash !== current.sourceHashes['scenes.src.js']) stale.render = '源文件缺少有效构建基线，需要重建并整片重渲';
  if (stale.scene) stale.render ||= stale.scene;
  /* 空项目里时间轴本来就不存在，这不算"成片无效"。
   * 只有当确实有画面/成片、却量不出时间轴时，才该报这条。 */
  if (!current.timelineDur) {
    if (stale.render && /成片还没生成/.test(stale.render)) { /* 保持更准确的原因 */ }
    else stale.render = '当前时间轴缺失或无效，不能核验成片（先 vh build 生成时间轴，再 vh measure 测量）';
  }
  const newer = item => Object.entries(sources).filter(([, s]) => s && item.info && s.mtimeMs > item.info.mtimeMs).map(([n]) => n);
  // Source/media content receipts are authoritative over timestamps. Mtimes
  // are a conservative fallback ONLY for legacy records without fingerprints.
  if (!renderRecord && newer(render).length) stale.render ||= '成片早于最新改动：' + newer(render).join(' / ') + '，需要重新渲染';
  if (render.formatError) stale.render = render.formatError;
  const renderDurationError = durationError(render.media, current.timelineDur);
  if (renderDurationError) stale.render = renderDurationError;
  if (current.timelineDur && Number.isFinite(manifestDur) && !near(manifestDur, current.timelineDur)) stale.render = `分段总长 ${manifestDur.toFixed(2)}s 与当前时间轴 ${current.timelineDur.toFixed(2)}s 不符（含旧分段），需要清缓存整片重渲`;

  if (!voice.exists) stale.voice = '还没配音（vh voice --srt），交付必须有 out/video-voice.mp4';
  else if (!voice.media?.video || !voice.media.audio) stale.voice = '配音成片损坏或没有真实音轨，需重新配音（vh voice --srt）';
  else {
    const record = state.voice?.artifact ?? state.artifacts?.voice;
    if (record) {
      stale.voice = recordError(record, 'voice', current, voice.fingerprint) || undefined;
      if (!record.renderMedia?.sha256 || record.renderMedia.sha256 !== render.fingerprint?.sha256
          || record.renderMedia.size !== render.fingerprint?.size) stale.voice ||= '配音所用的静音成片已改变，需重新混流';
    } else {
      const legacy = state.voice;
      const legacyMatches = legacy && positive(legacy.dur) && near(legacy.dur, voice.media.duration)
        && (legacy.timelineDur == null || near(legacy.timelineDur, current.timelineDur))
        && state.render?.sceneHtmlHash === current.sceneHtmlHash && !stale.render;
      if (!legacyMatches) stale.voice = '配音成片缺少有效配音基线，需要重新配音（vh voice --srt）';
      if (voice.info.mtimeMs < render.info?.mtimeMs) stale.voice ||= '配音比静音成片旧，跑 vh voice 重新混流';
      if (newer(voice).length) stale.voice ||= '配音早于最新源文件，需重新渲染并配音';
    }
    const voiceDurationError = durationError(voice.media, current.timelineDur, true);
    if (voiceDurationError) stale.voice = voiceDurationError;
    if (render.media && !near(render.media.duration, voice.media.duration)) stale.voice = `配音与成片时长不一致（成片 ${render.media.duration.toFixed(2)}s / 配音 ${voice.media.duration.toFixed(2)}s）——先 vh render 再 vh voice`;
  }
  if (voice.formatError) stale.voice = voice.formatError;
  // A voice mux can never launder a stale silent render into a full deliverable.
  if (stale.render) stale.voice ||= '静音成片已过期，需先渲染再重新配音';
  for (const key of Object.keys(stale)) if (!stale[key]) delete stale[key];
  const reason = stale.render || stale.voice || null;
  return { current, stale, render, voice, videoFormat: format,
    deliverable: { stale: !!reason, reason, video: voice.exists ? 'out/video-voice.mp4' : null } };
}

export function artifactStatus(project, { state } = {}) {
  state ??= json(path.join(project, 'out/.vh-state.json')) || {};
  const current = currentArtifactInputs(project);
  const sources = Object.fromEntries(SOURCE_NAMES.map(n => [n, stat(path.join(project, n))]));
  const observe = name => {
    const file = path.join(project, name), info = stat(file);
    const media = probeMedia(file);
    let formatError = null;
    try { formatError = videoMediaFormatError(project, file, media); } catch (e) { formatError = e.message; }
    return { file: name, exists: !!info, info, media, fingerprint: mediaFingerprint(file), formatError };
  };
  let format = null, formatError = null;
  try { format = videoFormatState(project); } catch (e) { formatError = e.message; }
  const result = evaluateArtifactStatus({ state, current, sources, render: observe('out/video.mp4'), voice: observe('out/video-voice.mp4'),
    format, formatError, manifestDur: json(path.join(project, 'out/seg/manifest.json'))?.duration ?? null });
  try {
    const limit = durationLimit(project);
    const error = limit && (durationLimitError(limit, current.timelineDur) ||
      (result.render.exists && durationLimitError(limit, result.render.media?.duration, '静音成片')) ||
      (result.voice.exists && durationLimitError(limit, result.voice.media?.duration, '配音成片')));
    if (error) result.stale.duration = error;
  } catch (e) { result.stale.duration = e.message; }
  if (result.stale.duration) result.deliverable = { ...result.deliverable, stale: true, reason: result.stale.duration };
  // 仅文案任务的待验收不使既有视频凭证失效；文案门槛由发布包合同负责。
  const pending = projectPendingChanges(project).filter(c => c.scope !== 'publish');
  if (pending.length) {
    result.stale.requirements = '用户修改要求尚未核验：' + pending.map(c => c.text.slice(0, 80)).join('；');
    result.deliverable = { stale: true, video: result.deliverable.video, reason: result.stale.requirements };
  }
  const semantic = projectSemanticReviewPending(project);
  if (semantic.length) {
    result.warnings = [...(result.warnings || []),
      '语义要求已执行但需人工复核：' + semantic.map(c => c.text.slice(0, 80)).join('；')];
  }
  return result;
}
