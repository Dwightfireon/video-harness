/* lib/state.mjs —— 项目状态：指纹、场景清单、过期判定、步骤规划
 *
 * 状态文件：out/.vh-state.json（harness 自己的记账，不动 skill 的产物）。
 * 唯一目标：回答「现在哪些东西过期了、下一步最小代价是什么」。
 *
 * 增量渲染的正确性全靠两个基线（都只由 render 写入，build/measure 不得碰）：
 *   - chunksRendered：上次渲染时 scenes.src.js 每一块的指纹 → 判断「哪几场变了」
 *   - render.ranges：上次渲染时的场景边界（秒） → 边界变了就不能增量（分段按帧号切，错位会静默拼错）
 *   - render.shared：上次渲染时 scene.html 的共享部分指纹 → 引擎/CSS/配色变了必须整片重渲
 */
import fs from 'node:fs';
import { voiceTimingCompatibility } from './voice-upgrade.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { artifactStatus, fnv1a, hashFile } from './artifact-status.mjs';
import { parsePublish, publishStatus, reviewStatus, deliveryTarget } from './publish.mjs';
import { maskJS } from './js-mask.mjs';
import { workflowPolicy } from './workflow-policy.mjs';
export { parsePublish } from './publish.mjs';
export { FNV_SEED, fnv1a, hashFile, probeDuration } from './artifact-status.mjs';

/* ---------- 工具 ---------- */
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/* ---------- skill 定位 ---------- */
const HOME = process.env.HOME || '';
export function skillDir(explicit) {
  const cands = [
    explicit, process.env.ARTICLE_VIDEO_SKILL_DIR,
    path.join(HOME, '.config', 'opencode', 'skills', 'article-video'),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(path.join(c, 'SKILL.md'))) return c;
  return null;
}

/* ---------- 场景解析（与 render.mjs 同口径） ---------- */
export function parseSceneRanges(sceneSrc) {
  const ranges = [...sceneSrc.matchAll(/addScene\(\s*([\d.]+)\s*,\s*([\d.]+)/g)]
    .map(m => [+m[1], +m[2]]);
  const dur = +(sceneSrc.match(/DURATION\s*=\s*([\d.]+)/) || [])[1] || null;
  return { ranges, duration: dur };
}

/* ---------- 脚本.md 解析：## S{n} · 标题 + 编号旁白 ---------- */
export function parseScript(mdText) {
  const sections = [];
  let cur = null;
  for (const raw of mdText.split('\n')) {
    const hm = raw.match(/^##\s*S(\d+)\s*[·•\-—]?\s*(.*)$/);
    if (hm) {
      cur = { n: +hm[1], title: (hm[2] || '').trim(), lines: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) continue;
    const lm = raw.match(/^\s*(\d+)[\.、)]\s*(.+)$/);
    if (lm) cur.lines.push({ n: +lm[1], t: lm[2].trim() });
  }
  return sections.filter(s => s.lines.length);
}

/* ---------- scenes.src.js 分块：//--- 一块一场 ---------- */
export function parseChunks(srcPath) {
  if (!exists(srcPath)) return [];
  const src = fs.readFileSync(srcPath, 'utf8');
  return src.split(/^\/\/---\s*$/m).map(s => s.trim()).filter(Boolean);
}


/* ---------- scene.html 里的逐场代码（增量渲染的基线比对用） ----------
 * 为什么不能比整份 scene.html 的哈希：每次 build 都会重写整个文件
 * （时间轴、SUBS、场景顺序都可能挪动），整份哈希永远变 →
 * baselineOk 永远 false → 自动增量一次都没生效过（真实事故：改一场也整片重渲）。
 * 这里把 scene.html 按 addScene 调用切块，逐场比对"这一场的代码有没有变"。
 * 口径与 render.mjs 的 --scenes 一致：按 addScene 出现顺序。 */
export function parseSceneBodies(sceneHtml) {
  const bodies = [];
  /* 只从 `const scenes = [];` 之后扫：文件顶部注释里有 addScene 示例，
     从 0 开始扫会把注释里那一条当成第 1 场（真实事故：8 场被数成 10 场）。 */
  const anchor = sceneHtml.indexOf('const scenes = [];');
  const from = anchor > 0 ? anchor : 0;
  const scan = maskJS(sceneHtml.slice(from));
  const re = /(^|[^\w$.])addScene\s*\(/g;
  let m;
  const idx = [];
  while ((m = re.exec(scan))) {
    const at = from + m.index + m[0].indexOf('addScene');
    /* 排除 `function addScene(...)` 定义本身：它是引擎的一部分，不是一场 */
    if (/function\s+$/.test(sceneHtml.slice(Math.max(0, at - 20), at))) continue;
    idx.push(at);
  }
  // 转场表/帧屏障常在文件尾部，但影响全片；不能只算作最后一场的依赖。
  // 安全优先：这些共享运行时变化时整片失效，普通单场改稿仍只改一场。
  const common = [
    sceneHtml.match(/window\.__vhTrans\s*=\s*\[[^;]*\];/)?.[0],
    sceneHtml.match(/\/\* vh:frame-runtime \*\/[\s\S]*?\/\* vh:frame-runtime-end \*\//)?.[0],
  ].filter(Boolean).join('\n');
  for (let k = 0; k < idx.length; k++) {
    const a = idx[k];
    const b = k + 1 < idx.length ? idx[k + 1] : sceneHtml.length;
    bodies.push(sceneHtml.slice(a, b).trim() + (common ? '\n/* vh:shared-dependencies */\n' + common : ''));
  }
  return bodies;
}

/* ---------- 发布文案解析（发布文案.md） ---------- */
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };


/* ---------- timing.json 有效性（复用项目内 timeline.mjs 校验） ---------- */
export async function timingVerdict(project) {
  const tp = path.join(project, 'timing.json');
  if (!exists(tp)) return { state: 'missing', note: null };
  let timeline;
  try {
    timeline = await import(pathToFileURL(path.join(project, 'timeline.mjs')).href);
  } catch (e) {
    return { state: 'unknown', note: 'timeline.mjs 加载失败：' + e.message };
  }
  try {
    const groups = timeline.scriptGroups(fs.readFileSync(path.join(project, '脚本.md'), 'utf8'));
    const d = JSON.parse(fs.readFileSync(tp, 'utf8'));
    const v = timeline.validateTiming(d, groups, {});
    const identity = voiceTimingCompatibility(project, d);
    if (!identity.ok) return { state: 'invalid', note: '配音缓存身份已失效：' + identity.reason + '；先 vh measure 重测' };
    return { state: 'valid', subs: v.subs, total: v.total };
  } catch (e) {
    return { state: 'invalid', note: String(e.message || e).split('\n')[0] };
  }
}

/* ---------- 状态读写 ---------- */
const STATE_PATH = p => path.join(p, 'out', '.vh-state.json');
export const STATE_VERSION = 2;
export function loadState(project) {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_PATH(project), 'utf8'));
    if (!d || typeof d !== 'object') return {};
    // 版本迁移：v1（无版本号）→ v2；未知的高版本不猜，原样返回但标注
    if (!d.schemaVersion) d.schemaVersion = STATE_VERSION;
    if (d.schemaVersion > STATE_VERSION) d.__newerThanHarness = true;
    return d;
  } catch { return {}; }
}
export function saveState(project, patch) {
  const next = { ...loadState(project), ...patch, schemaVersion: STATE_VERSION };
  // 补丁值为 null 表示清字段
  for (const k of Object.keys(patch)) if (patch[k] === null) delete next[k];
  fs.mkdirSync(path.join(project, 'out'), { recursive: true });
  const target = STATE_PATH(project), temp = target + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temp, target); }
  finally { try { fs.unlinkSync(temp); } catch {} }
  return next;
}

/* ---------- 全量状态快照（status/go 与 _api/state 共用） ---------- */
export async function snapshot(project) {
  const p = f => path.join(project, f);
  const st = loadState(project);
  const sceneExists = exists(p('scene.html'));
  const sceneSrc = sceneExists ? fs.readFileSync(p('scene.html'), 'utf8') : '';
  const { ranges, duration } = parseSceneRanges(sceneSrc);
  const m = /const SUBS = (\[\s*\{[\s\S]*?\}\s*\]);/.exec(sceneSrc);
  let subs = [];
  if (m) { try { subs = JSON.parse(m[1].replace(/,\s*\]/g, ']')); } catch { subs = []; } }

  const chunks = parseChunks(p('scenes.src.js'));
  const chunkHashes = chunks.map(c => fnv1a(c));
  const rendered = st.chunksRendered || null;
  const changedScenes = (rendered && rendered.length === chunkHashes.length && chunkHashes.length)
    ? chunkHashes.map((h, i) => (h !== rendered[i] ? i + 1 : null)).filter(Boolean)
    : null;

  const rangesKey = JSON.stringify(ranges);
  const rangesChanged = st.render ? JSON.stringify(st.render.ranges) !== rangesKey : null;
  const tv = await timingVerdict(project);
  const script = exists(p('脚本.md')) ? parseScript(fs.readFileSync(p('脚本.md'), 'utf8')) : [];

  const scriptHash = hashFile(p('脚本.md'));
  const artifacts = artifactStatus(project, { state: st });
  const stale = { ...artifacts.stale };

  // —— 逐场代码指纹（比整份 scene.html 稳：build 会重写整个文件） ——
  const sceneBodies = parseSceneBodies(sceneSrc);

  // —— 指纹共享部分（引擎 + CSS + SUBS 区块：改了它，分段复用就失效） ——
  const mark = sceneSrc.indexOf('const scenes = [];');
  const shared = mark > 0 ? fnv1a(sceneSrc.slice(0, mark + 'const scenes = [];'.length)) : null;
  const sharedChanged = st.render ? st.render.shared !== shared : null;

  // —— 产物过期判定 ——
  if (tv.state === 'missing') stale.timing = 'timing.json 不存在（未测量）：草稿用 --estimate，正式出片前 vh measure';
  if (tv.state === 'invalid') stale.timing = 'timing.json 与当前脚本/音色/语速不符：' + (tv.note || '');
  if (exists(p('timing.json')) && exists(p('脚本.md'))) {
    const lm = st.lastMeasure || null;
    if (!lm || lm.scriptHash !== scriptHash) stale.measure = '脚本.md 改过之后还没重新测量（vh measure --apply）';
  }
  const stillsDir = path.join(p('out'), 'stills');
  const stillCount = exists(stillsDir) ? fs.readdirSync(stillsDir).filter(f => /^s-\d+\.jpg$/.test(f)).length : 0;
  if (sceneExists && ranges.length && stillCount !== ranges.length) {
    stale.stills = `静帧 ${stillCount} 张 / ${ranges.length} 场，跑 vh stills`;
  }

  // 内容深度摘要（供工作台显示；不阻塞快照）
  let depth = null;
  try {
    const { analyze: depthAnalyze } = await import('./depth.mjs');
    const d = depthAnalyze(project);
    depth = { ok: d.ok, count: d.count, est: Math.round(d.est), target: d.target ? Math.round(d.target) : null,
              hard: d.hard, thin: d.scenes.filter(x => x.issues.length).map(x => ({ n: x.n, title: x.title, issues: x.issues })) };
  } catch {}

  const publishMd = readText(path.join(project, '发布文案.md'));
  const publish = parsePublish(publishMd);

  const outDir = path.join(project, 'out');
  const videos = exists(outDir)
    ? fs.readdirSync(outDir).filter(f => f.endsWith('.mp4')).map(f => {
        const s = fs.statSync(path.join(outDir, f));
        return { file: f, size: s.size, mtime: s.mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime)
    : [];

  const sceneList = ranges.map(([a, b], i) => ({
    i: i + 1, start: a, end: b,
    text: (subs.find(s => s.s >= a - 0.01 && s.s < b) || {}).t || '',
    still: `/out/stills/s-${String(i + 1).padStart(2, '0')}.jpg`,
    stillReady: stillCount >= ranges.length,
  }));

  const videoFormat = artifacts.videoFormat;
  const workflow = workflowPolicy(project);

  return {
    videoFormat,
    name: path.basename(project),
    project,
    duration,
    sceneM: mtime(p('scene.html')),
    scenes: sceneList,
    subs,
    script,
    stale,
    videos,
    stillsCount: stillCount,
    changedScenes,           // 距上次「渲染」变了内容的场号（null = 没有基线，不能增量）
    sceneBodies,             // 逐场代码（scene.html 切块）
    rangesChanged,           // 边界变了 → 必须整片重渲
    sharedChanged,           // 共享部分变了 → 必须整片重渲
    publish,
    workflow,
    delivery: {
      target: deliveryTarget(project),
      video: { state: artifacts.deliverable.stale ? (artifacts.voice.exists ? 'stale' : 'missing') : 'checked', reason: artifacts.deliverable.reason },
      publish: publishStatus(project),
      review: { ...reviewStatus(project), required: workflow.releaseReviewRequired },
    },
    depth,
    timing: { state: tv.state, note: tv.note || null, total: tv.total ?? null },
    running: st.running || null,
  };
}
