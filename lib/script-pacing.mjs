/* 视听与口播节奏确定性体检（vh script-pacing）
 *
 * 定位：纯确定性、零模型调用，分析 脚本.md（以及可选 timing.json）的节奏结构线索：
 *   1. 开场 S1 信息落点与长难句提醒；
 *   2. 超长单场静态疲劳风险（>45s 或估算 >210 汉字）；
 *   3. 过长单句（>38 汉字，句级 sceneCue 锚点易与句尾核心词脱节）；
 *   4. 全片篇幅与场长分布。
 * 原则：只给线索，不硬截时长、不设固定分钟数或句数配额。
 */
import fs from 'node:fs';
import path from 'node:path';

const CJK_RE = /[\u4e00-\u9fff]/g;
const countCjk = text => (String(text || '').match(CJK_RE) || []).length;

export function parseScriptScenes(markdown) {
  const scenes = [];
  let current = null;
  for (const raw of String(markdown || '').split('\n')) {
    const heading = /^##\s+S(\d+)\s*[·•\-—]?\s*(.*)$/.exec(raw);
    if (heading) {
      current = { scene: Number(heading[1]), title: (heading[2] || '').trim(), lines: [] };
      scenes.push(current);
      continue;
    }
    if (/^##\s/.test(raw)) { current = null; continue; }
    const line = /^\s*\d+[.、)]\s+(.+)$/.exec(raw);
    if (current && line) current.lines.push(line[1].trim());
  }
  return scenes.filter(s => s.lines.length > 0);
}

export function analyzeScriptPacing(project, { speed = 1.25 } = {}) {
  const scriptPath = path.join(project, '脚本.md');
  if (!fs.existsSync(scriptPath)) return { ok: false, findings: [], scenes: [], note: '找不到 脚本.md' };
  const scenes = parseScriptScenes(fs.readFileSync(scriptPath, 'utf8'));
  if (!scenes.length) return { ok: false, findings: [], scenes: [], note: '脚本.md 中未解析到编号旁白' };

  let timing = null;
  try { timing = JSON.parse(fs.readFileSync(path.join(project, 'timing.json'), 'utf8')); } catch {}
  const measuredRanges = Array.isArray(timing?.scenes) && timing.scenes.length === scenes.length ? timing.scenes : null;
  const cjkPerSec = 3.5 * (Number(timing?.measurement?.speed) || speed);

  const findings = [];
  const summary = scenes.map((sc, idx) => {
    const cjk = sc.lines.reduce((sum, l) => sum + countCjk(l), 0);
    const estSec = measuredRanges ? +(measuredRanges[idx][1] - measuredRanges[idx][0]).toFixed(1)
      : +(cjk / cjkPerSec + sc.lines.length * 0.35).toFixed(1);
    const longLines = sc.lines.map((text, i) => ({ index: i + 1, cjk: countCjk(text), text }))
      .filter(item => item.cjk > 38);

    if (sc.scene === 1 && longLines.length) {
      findings.push({
        kind: 'opening-long-line', scene: 1,
        msg: `开场 S1 有 ${longLines.length} 句超过 38 汉字（最长 ${Math.max(...longLines.map(x => x.cjk))} 字），前 15 秒听觉负担偏高，建议拆短或提炼主问题`,
      });
    }
    if (estSec > 45 || cjk > 210) {
      findings.push({
        kind: 'long-scene', scene: sc.scene,
        msg: `S${sc.scene}「${sc.title || '未命名'}」时长约 ${estSec}s（${cjk} 汉字），单场偏长；若画面缺少场内多步推进，建议拆分或用 sceneCue 安排 2–3 个视觉节点`,
      });
    }
    if (sc.scene !== 1 && longLines.length) {
      findings.push({
        kind: 'long-cue-line', scene: sc.scene,
        msg: `S${sc.scene} 有 ${longLines.length} 句超过 38 汉字（第 ${longLines.map(x => x.index).join('/')} 句），句级 sceneCue 锚点易与句尾重点错位`,
      });
    }
    return { scene: sc.scene, title: sc.title, lines: sc.lines.length, cjk, seconds: estSec, measured: Boolean(measuredRanges) };
  });

  const totalCjk = summary.reduce((s, x) => s + x.cjk, 0);
  const totalSec = +(summary.reduce((s, x) => s + x.seconds, 0)).toFixed(1);
  const avgSec = +(totalSec / summary.length).toFixed(1);
  const longest = summary.reduce((a, b) => (b.seconds > a.seconds ? b : a), summary[0]);

  return {
    ok: findings.length === 0,
    measured: Boolean(measuredRanges),
    sceneCount: summary.length,
    totalCjk,
    totalSec,
    avgSec,
    longest,
    scenes: summary,
    findings,
    note: '纯确定性节奏线索（非硬性时长限制）；用于提前发现长单场、过长单句与开场负担。',
  };
}

export function report(res) {
  if (res.note && !res.scenes?.length) return res.note;
  const tag = res.measured ? '实测' : '估算';
  const lines = [
    `口播与视听节奏体检（${tag}）：共 ${res.sceneCount} 场 · ${res.totalCjk} 汉字 · 总长约 ${res.totalSec}s · 场均 ${res.avgSec}s`,
    `最长单场：S${res.longest.scene}（${res.longest.seconds}s / ${res.longest.cjk} 字）`,
    '',
  ];
  if (!res.findings.length) {
    lines.push('✓ 未发现超长单场、开场超长句或句级锚点风险（仍需结合画面与实听判断整体节奏）');
  } else {
    for (const f of res.findings) lines.push(`⚠ [S${f.scene}] ${f.msg}`);
  }
  return lines.join('\n');
}
