/* Browser measurement shared by ordinary render, fit and candidate review.
 * Strict production uses the same observer/policy within its contrast pass. */
import fs from 'node:fs';
import path from 'node:path';
import { openMeasurementPage } from './measurement-page.mjs';
import { parseSceneRanges } from './state.mjs';
import { subtitleData } from './subtitle-export.mjs';
import { maskJS } from './js-mask.mjs';
import { observeLayoutBatch, layoutProbeBatches } from './layout-observation.mjs';
import { layoutFindings, layoutTimes, activeLayoutFrame, sceneSubjectCount, mergeLayoutFindings, LAYOUT_POLICY_VERSION } from './layout-geometry.mjs';

export async function measureLayout(project, { at = null, step = 2, htmlFile = 'scene.html', session = null } = {}) {
  const file = path.resolve(project, htmlFile);
  if (!fs.existsSync(file)) return { ok: false, findings: [], sampled: 0, note: '没有 scene.html' };
  const html = fs.readFileSync(file, 'utf8'), { ranges } = parseSceneRanges(maskJS(html));
  if (!ranges.length) return { ok: false, findings: [], sampled: 0, note: '没有有效场景，不能视为版式通过' };
  // Standalone layout inspection also supports authored HTML without a SUBS
  // track. A present but malformed track must not be silently ignored.
  const cues = /\bSUBS\s*=/.test(maskJS(html)) ? subtitleData(html) : [];
  const times = at == null ? layoutTimes(ranges, cues, { step }) :
    [{ t: Number(at), scene: ranges.findIndex(([a, b]) => at >= a && at < b) + 1 }];
  if (times.some(p => !Number.isFinite(p.t) || !p.scene)) return { ok: false, findings: [], sampled: 0, note: '采样时间不在有效场景中' };
  if (session && session.file !== file) throw new Error('不能复用其他 HTML 的浏览器测量会话');
  const owned = !session;
  session ||= await openMeasurementPage(file);
  const { page, errors } = session;
  const findings = [], scenes = [], frames = [];
  const evidence = new Map();
  let geo, measured = 0;
  try {
    for (const batch of layoutProbeBatches(times)) {
      for (const { t, scene, frame: observed } of await page.evaluate(observeLayoutBatch, batch)) {
        const frame = activeLayoutFrame(observed, scene);
        geo = { W: frame.width, H: frame.height, subTop: frame.safeBottom };
        const subjects = sceneSubjectCount(frame, scene, { singleScene: ranges.length === 1 });
        evidence.set(scene, (evidence.get(scene) || 0) + subjects);
        measured += subjects;
        for (const f of layoutFindings(frame)) findings.push({ ...f, t, scene: f.scene || scene });
        frames.push({ scene, t, texts: frame.texts.length, components: frame.components.length });
      }
    }
    if (errors.length) throw new Error(errors.slice(0, 3).join('；'));
    for (const [scene, count] of evidence) if (!count) findings.push({ kind: 'empty-scene', scene,
      element: 'scene-' + scene, t: times.find(p => p.scene === scene).t, text: '',
      msg: '本场采样未观测到文字或主体组件，不能借用其他场/全局页码的证据宣布通过' });
    for (let i = 1; i <= ranges.length; i++) scenes.push({ i, probes: times.filter(p => p.scene === i).map(p => p.t) });
  } finally { if (owned) await session.close(); }
  const list = mergeLayoutFindings(findings);
  return { ok: list.length === 0, policyVersion: LAYOUT_POLICY_VERSION, findings: list, sampled: times.length, measured,
    sceneEvidence: Object.fromEntries(evidence), scenes, frames, geo,
    note: '真实文字行框、祖先裁切、画布/字幕安全区与组件碰撞；逐帧内判定，有限抽样，不代表审美或连续观看通过。' };
}

export function report(result) {
  if (!result.sampled) return result.note || '版式检查未成功执行';
  const lines = [`实测版式：${result.findings.length} 处问题（采样 ${result.sampled} 帧）`];
  for (const f of result.findings) lines.push(`  ✗ 第 ${f.scene || '?'} 场 ${f.t?.toFixed(2) || '0'}s ${f.msg}`);
  if (result.ok) lines.push('✓ 未发现文字重叠、组件碰撞、裁切、越界或压字幕区');
  return lines.join('\n');
}
