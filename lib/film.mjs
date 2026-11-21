/* 小而确定的镜头语法。色彩和具体物体归作者，不把高级感做成评分。 */
export const clamp = x => Math.max(0, Math.min(1, x));
export const smooth = x => { const p = clamp(x); return p * p * p * (p * (p * 6 - 15) + 10); };
export function phase(t, start, end) {
  if (![t, start, end].every(Number.isFinite) || !(end > start)) throw new Error('镜头区间必须为有限时间且 end > start');
  return clamp((t - start) / (end - start));
}

// 在字幕重测后重新求触发点。匹配缺失或歧义必须报错，不能悄悄回退到 0 秒。
export function cue(subs, text, edge = 's', offset = 0) {
  if (!['s', 'e'].includes(edge)) throw new Error('cue edge 必须为 s 或 e');
  if (!Array.isArray(subs) || typeof text !== 'string' || !text.trim() || !Number.isFinite(offset)) throw new Error('cue 需要有效字幕、非空片段与有限偏移');
  const hits = subs.filter(s => s.t.includes(text));
  if (hits.length !== 1) throw new Error('触发句必须唯一：' + text + '（匹配 ' + hits.length + ' 句）');
  if (!Number.isFinite(hits[0][edge])) throw new Error('无效字幕时间');
  const n = hits[0][edge] + offset;
  if (!Number.isFinite(n)) throw new Error('无效字幕时间');
  return n;
}

export function cameraAt(keys, t) {
  if (!keys.length || keys.some((k, i) => !Number.isFinite(k.t) || !Number.isFinite(k.x) ||
       !Number.isFinite(k.y) || !Number.isFinite(k.scale) || !(k.scale > 0) || (i && k.t <= keys[i - 1].t))) {
    throw new Error('镜头需要递增时间、有限坐标和正数缩放');
  }
  if (!Number.isFinite(t)) throw new Error('无效采样时间');
  if (t <= keys[0].t) return { ...keys[0] };
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i], a = keys[i - 1];
    if (t <= b.t) {
      const p = b.cut ? (t < b.t ? 0 : 1) : smooth(phase(t, a.t, b.t));
      return { t, x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p,
        scale: a.scale + (b.scale - a.scale) * p };
    }
  }
  return { ...keys.at(-1) };
}

export function projectPoint(point, camera, width = 1920, height = 1080) {
  return { x: width / 2 + (point.x - camera.x) * camera.scale,
    y: height / 2 + (point.y - camera.y) * camera.scale };
}

// 不读上一帧，不叠加 transform，不使用时钟。可反向、跳播、并行采样。
export function applyCamera(el, camera, width = 1920, height = 1080) {
  el.setAttribute('transform', 'translate(' + width / 2 + ' ' + height / 2 + ') scale(' +
    camera.scale + ') translate(' + -camera.x + ' ' + -camera.y + ')');
}

export function trace(el, value) {
  if (!Number.isFinite(value)) throw new Error('描画进度必须为有限数');
  el.setAttribute('pathLength', '1');
  el.setAttribute('stroke-dasharray', '1');
  el.setAttribute('stroke-dashoffset', String(1 - clamp(value)));
}

/* 取景精度：世界中的整个矩形必须落入可读区域，字幕占用空间由 insets 明确给出。
 * 返回现有 cameraAt/applyCamera/projectPoint 的同一坐标约定，避免标注与镜头各算一套。 */
export function fitCamera(rect, opt = {}) {
  const width = opt.width ?? 1920, height = opt.height ?? 1080;
  const padding = opt.padding ?? 48, insets = opt.insets ?? {};
  const minScale = opt.minScale ?? .01, maxScale = opt.maxScale ?? 4;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height, width, height, padding, minScale, maxScale].every(Number.isFinite) ||
      rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0 || padding < 0 || minScale <= 0 || maxScale < minScale) {
    throw new Error('取景需要有限矩形、正数尺寸和有效缩放范围');
  }
  const margins = ['left', 'right', 'top', 'bottom'].map(key => insets[key] ?? 0);
  if (margins.some(n => !Number.isFinite(n) || n < 0)) throw new Error('取景安全边必须为有限非负数');
  const [left, right, top, bottom] = margins;
  const w = width - left - right - padding * 2, h = height - top - bottom - padding * 2;
  if (w <= 0 || h <= 0) throw new Error('字幕/安全边占满画幅，无法取景');
  const scale = Math.min(maxScale, w / rect.width, h / rect.height);
  if (scale < minScale) throw new Error('指定最小缩放下无法完整容纳主体；请缩小主体或调整安全边');
  const cx = (left + width - right) / 2, cy = (top + height - bottom) / 2;
  return { x: rect.x + rect.width / 2 - (cx - width / 2) / scale,
    y: rect.y + rect.height / 2 - (cy - height / 2) / scale, scale };
}

/* 标准生成器由 harness 在 build(root) 前登记边界，重测后自动得到当前值。
 * 自定义生成器不匹配时明确失败，不能把缺失属性用 Number(null) 猜成0秒。 */
export function sceneTiming(root) {
  const a = root?.getAttribute?.('data-vh-scene-start'), b = root?.getAttribute?.('data-vh-scene-end');
  if (a == null || b == null || !String(a).trim() || !String(b).trim()) throw new Error('根元素缺少当前场景边界；先用 vh build，或显式提供 start/end');
  const start = Number(a), end = Number(b);
  if (![start, end].every(Number.isFinite) || start < 0 || end <= start) throw new Error('根元素的当前场景边界无效');
  return { start, end };
}

/* A scene-local cue for ordinary enter/P animations, not only compileMotion.
 * Numeric selectors are 1-based narration positions; text selectors must be unique.
 * No cached absolute start: every build/remeasure resolves against current SUBS. */
export function cueInScene(subs, start, end, selector, edge = 's', offset = 0) {
  if (!Array.isArray(subs) || ![start, end, offset].every(Number.isFinite) || start < 0 || end <= start || !['s', 'e'].includes(edge))
    throw new Error('场内字幕锚点需要有效字幕、场景边界和有限偏移');
  if (subs.some(s => !s || typeof s.t !== 'string' || !Number.isFinite(s.s) || !Number.isFinite(s.e) || s.e <= s.s))
    throw new Error('场内字幕时间或正文无效');
  const clock = n => Number(n.toFixed(9));
  const local = subs.filter(s => clock(s.s - start) >= 0 && clock(s.s - start) < clock(end - start)).sort((a, b) => a.s - b.s);
  if (local.some((s, i) => clock(s.e - end) > 0 || i > 0 && clock(s.s - local[i - 1].e) < 0)) throw new Error('场内字幕越界或重叠');
  let absolute;
  if (typeof selector === 'number') {
    if (!Number.isInteger(selector) || selector < 1 || selector > local.length) throw new Error('本场不存在第 ' + selector + ' 句旁白');
    absolute = local[selector - 1][edge] + offset;
  } else absolute = cue(local, selector, edge, offset);
  const relative = clock(absolute - start);
  if (!Number.isFinite(relative) || relative < 0 || relative > clock(end - start)) throw new Error('字幕锚点偏移越出本场');
  return relative;
}

export function sceneCue(root, selector, { subs = typeof SUBS === 'undefined' ? null : SUBS, edge = 's', offset = 0 } = {}) {
  const { start, end } = sceneTiming(root);
  return cueInScene(subs, start, end, selector, edge, offset);
}

/* 句级动作编排。先编译绝对时刻，再以场内秒数采样；不使用墙上时钟或上一帧。
 * hold 是同一属性的显式阅读保持，不是让每个对象一直动。 */
export function compileMotion({ subs = [], start, end, targets, beats = [] } = {}) {
  if (![start, end].every(Number.isFinite) || end <= start) throw new Error('Motion 场景需要有限 start/end 且 end > start');
  if (!targets || typeof targets !== 'object' || Array.isArray(targets) || !Object.keys(targets).length || !Array.isArray(beats)) {
    throw new Error('Motion 需要具名对象与动作列表');
  }
  if (!Array.isArray(subs) || subs.some(s => !s || typeof s.t !== 'string' ||
      !Number.isFinite(s.s) || !Number.isFinite(s.e) || s.e <= s.s)) throw new Error('Motion 字幕时间或正文无效');
  // 同一 1ns 网格用于编译、冲突判定和采样；不能验证时放行容差，采样却永远够不到末帧。
  const clock = value => Number(value.toFixed(9));
  const duration = clock(end - start);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Motion 场景时长无效或小于时间精度');
  const localSubs = subs.filter(s => clock(s.s - start) >= 0 && clock(s.s - start) < duration);
  const defaults = { x: 0, y: 0, scale: 1, opacity: 1, rotate: 0, progress: 0 };
  const validPose = pose => {
    if (!pose || typeof pose !== 'object' || Array.isArray(pose)) throw new Error('Motion 状态必须为属性表');
    for (const [key, value] of Object.entries(pose)) {
      if (!Object.hasOwn(defaults, key) || !Number.isFinite(value)) throw new Error('Motion 状态包含未知属性或非有限数：' + key);
      if (key === 'scale' && value <= 0) throw new Error('Motion scale 必须大于零');
      if (['opacity', 'progress'].includes(key) && (value < 0 || value > 1)) throw new Error('Motion ' + key + ' 必须在 0–1');
    }
  };
  // 不以普通对象的继承属性识别 target，__proto__ 等名字也不会改动原型。
  const bases = Object.create(null), tracks = new Map(), ids = new Set();
  for (const [id, pose] of Object.entries(targets)) {
    if (!id.trim()) throw new Error('Motion 对象必须具名');
    validPose(pose); bases[id] = Object.freeze({ ...defaults, ...pose }); tracks.set(id, new Map());
  }
  const compiled = beats.map(beat => {
    if (!beat || typeof beat.id !== 'string' || !beat.id.trim() || ids.has(beat.id)) throw new Error('Motion 动作 id 必须非空且唯一');
    ids.add(beat.id);
    if (!Object.hasOwn(bases, beat.target)) throw new Error('Motion 未知对象：' + beat.target);
    if ((beat.at != null) === (beat.cue != null)) throw new Error('Motion 动作必须且只能选择 at 或 cue');
    let at;
    if (beat.cue != null) {
      const c = beat.cue;
      if (!c || typeof c !== 'object' || (c.text != null) === (c.line != null)) throw new Error('Motion cue 必须选择 text 或 line，并可带 edge/offset');
      at = cueInScene(localSubs, start, end, c.line ?? c.text, c.edge ?? 's', c.offset ?? 0);
    } else at = beat.at;
    let dur = beat.dur ?? .8, hold = beat.hold ?? 0;
    if (![at, dur, hold].every(Number.isFinite) || dur < 0 || hold < 0) {
      throw new Error('Motion 动作/阅读保持越出场景或时间无效：' + beat.id);
    }
    at = clock(at) + 0; // 统一 -0 与 0。
    dur = clock(dur); hold = clock(hold);
    if (at < 0 || clock(at + dur + hold) > duration) throw new Error('Motion 动作/阅读保持越出场景或时间无效：' + beat.id);
    validPose(beat.to);
    if (!Object.keys(beat.to).length) throw new Error('Motion 动作缺少目标属性：' + beat.id);
    return { id: beat.id, target: beat.target, at, end: clock(at + dur), dur, hold, to: { ...beat.to } };
  }).sort((a, b) => a.at - b.at);
  for (const beat of compiled) {
    const objectTracks = tracks.get(beat.target), from = {};
    for (const [key, to] of Object.entries(beat.to)) {
      const track = objectTracks.get(key) ?? [];
      const previous = track.at(-1);
      if (previous && (beat.at === previous.at || beat.at < clock(previous.end + previous.hold))) {
        throw new Error('Motion 同一属性的动作/保持重叠：' + beat.target + '.' + key + '（' + previous.id + ' / ' + beat.id + '）');
      }
      from[key] = previous ? previous.to : bases[beat.target][key];
      track.push({ id: beat.id, at: beat.at, end: beat.end, dur: beat.dur, hold: beat.hold, from: from[key], to });
      objectTracks.set(key, track);
    }
    beat.from = Object.freeze(from); Object.freeze(beat.to); Object.freeze(beat);
  }
  const sample = rt => {
    if (!Number.isFinite(rt)) throw new Error('Motion 采样时间必须为有限秒数');
    const time = clock(rt);
    const states = Object.create(null);
    for (const [id, base] of Object.entries(bases)) {
      const pose = { ...base };
      for (const [key, track] of tracks.get(id)) {
        for (const event of track) {
          if (time < event.at) break;
          const p = event.dur === 0 || time >= event.end ? 1 : smooth(clamp((time - event.at) / event.dur));
          pose[key] = p >= 1 ? event.to : event.from + (event.to - event.from) * p;
        }
      }
      states[id] = pose;
    }
    return { targets: states };
  };
  return Object.freeze({ duration, beats: Object.freeze(compiled), sample });
}

export function browserSource() {
  return '\n/* vh:film-start */\n/* VH_FILM: deterministic camera + subtitle cues */\nwindow.VH_FILM = (() => {\n' +
    [clamp, smooth, phase, cue, cameraAt, projectPoint, applyCamera, trace, fitCamera, sceneTiming, cueInScene, sceneCue, compileMotion]
      .map(fn => 'const ' + fn.name + ' = ' + fn.toString() + ';').join('\n') +
    '\nreturn {clamp,smooth,phase,cue,cameraAt,projectPoint,applyCamera,trace,fitCamera,sceneTiming,cueInScene,sceneCue,compileMotion};\n})();\n/* vh:film-end */\n';
}
