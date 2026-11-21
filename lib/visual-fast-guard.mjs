/* 轻量停稳帧视觉硬伤快检（vh visual-fast）
 *
 * 定位：专为 content-first 模式设计的秒级确定性硬伤兜底，不替代 audited 完整审校或人工审片。
 * 策略：每场只采 1 个停稳时刻（默认 end - 0.8s，短场取中点），复用既有 layout-observation
 * 与 layout-geometry 判定，只拦三类无歧义硬伤：
 *   1. 画布越界（out-of-bounds）
 *   2. 非字幕正文侵入底部字幕安全区（subtitle-overlap）
 *   3. 文字裁切或非授权重叠/碰撞（clipped / text-overlap / component-overlap）
 */
import fs from 'node:fs';
import path from 'node:path';
import { openMeasurementPage } from './measurement-page.mjs';
import { parseSceneRanges } from './state.mjs';
import { maskJS } from './js-mask.mjs';
import { observeLayoutBatch, layoutProbeBatches } from './layout-observation.mjs';
import { layoutFindings, activeLayoutFrame, sceneSubjectCount, mergeLayoutFindings, LAYOUT_POLICY_VERSION } from './layout-geometry.mjs';

export function settleTimes(ranges) {
  return ranges.map(([start, end], index) => {
    const dur = end - start;
    const t = dur > 1.4 ? +(end - 0.8).toFixed(3) : +(start + dur * 0.5).toFixed(3);
    return { scene: index + 1, t: Math.max(start, Math.min(end - 0.05, t)) };
  });
}

export async function runVisualFastGuard(project, { htmlFile = 'scene.html', session = null } = {}) {
  const file = path.resolve(project, htmlFile);
  if (!fs.existsSync(file)) return { ok: false, findings: [], sampled: 0, note: '没有 scene.html，请先运行 vh build' };
  const html = fs.readFileSync(file, 'utf8');
  const { ranges } = parseSceneRanges(maskJS(html));
  if (!ranges.length) return { ok: false, findings: [], sampled: 0, note: '没有有效场景，不能视为硬伤快检通过' };

  const times = settleTimes(ranges);
  if (session && session.file !== file) throw new Error('不能复用其他 HTML 的浏览器测量会话');
  const owned = !session;
  session ||= await openMeasurementPage(file);
  const { page, errors } = session;
  const findings = [];
  const evidence = new Map();
  const startedAt = Date.now();

  try {
    for (const batch of layoutProbeBatches(times)) {
      for (const { t, scene, frame: observed } of await page.evaluate(observeLayoutBatch, batch)) {
        const frame = activeLayoutFrame(observed, scene);
        const subjects = sceneSubjectCount(frame, scene, { singleScene: ranges.length === 1 });
        evidence.set(scene, (evidence.get(scene) || 0) + subjects);
        for (const f of layoutFindings(frame)) findings.push({ ...f, t, scene: f.scene || scene });
      }
    }
    if (errors.length) throw new Error(errors.slice(0, 3).join('；'));
    for (const [scene, count] of evidence) {
      if (!count) {
        const probe = times.find(p => p.scene === scene);
        findings.push({
          kind: 'empty-scene', scene, element: 'scene-' + scene, t: probe?.t || 0, text: '',
          msg: '停稳帧未观测到文字或主体组件（疑似白屏或元素未入场）',
        });
      }
    }
  } finally {
    if (owned) await session.close();
  }

  const list = mergeLayoutFindings(findings);
  return {
    ok: list.length === 0,
    mode: 'fast-settle-guard',
    policyVersion: LAYOUT_POLICY_VERSION,
    sampled: times.length,
    elapsedMs: Date.now() - startedAt,
    findings: list,
    note: '仅抽样每场 1 个停稳帧，用于秒级拦截越界、字幕遮挡、裁切与重叠硬伤；不替代连续动画与人工审片。',
  };
}

export function report(result) {
  if (!result.sampled) return result.note || '停稳帧硬伤快检未执行';
  const sec = (result.elapsedMs / 1000).toFixed(2);
  const lines = [`停稳帧硬伤快检：${result.findings.length} 处硬伤（每场 1 帧，共 ${result.sampled} 帧，耗时 ${sec}s）`];
  for (const f of result.findings) lines.push(`  ✗ S${f.scene || '?'} @ ${f.t?.toFixed(2) || '0'}s [${f.kind}] ${f.msg}`);
  if (result.ok) lines.push('✓ 未发现越界、压字幕区、裁切、重叠或空白停稳帧（仍建议看静帧确认审美）');
  return lines.join('\n');
}
