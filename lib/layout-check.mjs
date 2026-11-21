/* lib/layout-check.mjs —— 版式体检（vh layout）
 *
 * 来源：真实事故——agent 把旁白原句直接抄成画面正文，结果
 *   · 画面文字与烧进画面的字幕**重复**，同屏两遍，看着像"不同步"
 *   · 正文与字幕条位置重叠，被压住
 * 机器能查的：① 画面正文与 SUBS 重复  ② 元素越出画布/压到字幕安全区  ③ 同屏元素重叠
 * 只做提示，不阻塞（视觉判断仍需人看）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripVisualIntent } from './scene-visual.mjs';

const SUB_SAFE_Y = 840;      // 1080p 下字幕安全区起始（engine 的 LAYOUT.subY 附近）
const W = 1920, H = 1080;

const norm = (s) => s.replace(/<[^>]+>/g, '').replace(/[\s，。、；：！？「」『』"'"'（）()]/g, '');

export function analyze(project) {
  const sceneHtml = (() => { try { return fs.readFileSync(path.join(project, 'scene.html'), 'utf8'); } catch { return ''; } })();
  const src = (() => { try { return fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'); } catch { return ''; } })();
  const findings = [];

  // 1) 画面正文 vs 字幕：完全或近似重复（≥10 个连续字符相同）
  const subs = [...sceneHtml.matchAll(/"s":\s*([\d.]+),\s*"e":\s*([\d.]+),\s*"t":\s*"((?:[^"\\]|\\.)*)"/g)]
    .map(m => ({ s: +m[1], e: +m[2], t: JSON.parse(`"${m[3]}"`) }));
  const subTexts = subs.map(s => norm(s.t)).filter(t => t.length >= 6);
  const chunks = src.split(/^\/\/---\s*$/m).map(c => stripVisualIntent(c.trim())).filter(Boolean);
  chunks.forEach((chunk, i) => {
    const texts = [
      ...chunk.matchAll(/\.textContent\s*=\s*['"`]([^'"`]{4,160})['"`]/g),
      ...chunk.matchAll(/\.innerHTML\s*=\s*['"`]([^'"`]{4,160})['"`]/g),
      ...chunk.matchAll(/\bline\(\s*['"`]([^'"`]{4,160})['"`]/g),
      ...chunk.matchAll(/\.set\(\s*['"`]([^'"`]{4,160})['"`]/g),
      ...chunk.matchAll(/\.textContent\s*=\s*([A-Za-z_$][\w$]*)/g),
    ].map(m => m[1]);
    for (const t of texts) {
      const nt = norm(t);
      if (nt.length < 8) continue;
      for (const st of subTexts) {
        // 近似判定：一方包含另一方 ≥10 字
        const hit = st.includes(nt.slice(0, Math.min(nt.length, 12))) || nt.includes(st.slice(0, Math.min(st.length, 12)));
        if (hit) {
          findings.push({
            kind: 'dup', scene: i + 1,
            msg: `第 ${i + 1} 场：画面文字与旁白/字幕重复 →「${t.slice(0, 28)}…」`,
            fix: '画面正文应是**提炼后的标题/关键词**（8–14 字），不是旁白原句；旁白让字幕去显示。',
          });
          break;
        }
      }
    }
  });

  // 2) 文本元素压到字幕安全区（abs 的 y + 高度 > 840 且该元素看起来是正文/标题）
  chunks.forEach((chunk, i) => {
    for (const m of chunk.matchAll(/(?:const\s+\w+\s*=\s*)?abs\(\s*mk\([^)]*\)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
      const [_, x, y, w, h] = m.map(Number);
      if (y + h > SUB_SAFE_Y + 40) {
        findings.push({
          kind: 'safe', scene: i + 1,
          msg: `第 ${i + 1} 场：元素底边到 ${y + h}px，压进字幕安全区（${SUB_SAFE_Y}px 以下）`,
          fix: '把这块上移，或缩短高度；字幕区一律留给字幕。',
        });
      }
      if (x + w > W - 40 || y < 60) {
        findings.push({ kind: 'edge', scene: i + 1, msg: `第 ${i + 1} 场：元素越界（x+w=${x + w}, y=${y}）`, fix: '检查 abs 的坐标是否超出画布边距。' });
      }
    }
  });

  // 3) 同一场里多个 abs 元素矩形重叠（粗判：中心点距离过近）
  chunks.forEach((chunk, i) => {
    const boxes = [...chunk.matchAll(/abs\(\s*mk\([^)]*\)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)]
      .map(m => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const A = boxes[a], B = boxes[b];
      const ov = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x)) *
                 Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
      const minArea = Math.min(A.w * A.h, B.w * B.h);
      const maxArea = Math.max(A.w * A.h, B.w * B.h);
      // 面积差 >3 倍 → 大概率是容器与子元素（正常嵌套），跳过
      const contained = (A.x >= B.x && A.y >= B.y && A.x + A.w <= B.x + B.w && A.y + A.h <= B.y + B.h) ||
                        (B.x >= A.x && B.y >= A.y && B.x + B.w <= A.x + A.w && B.y + B.h <= A.y + A.h);
      if (contained) continue;                       // 一个在另一个里面 = 正常嵌套
      const similar = maxArea > 0 && minArea / maxArea > 0.3;
      if (similar && minArea > 0 && ov / minArea > 0.55) {
        findings.push({ kind: 'overlap', scene: i + 1, msg: `第 ${i + 1} 场：两块元素重叠 ${(ov / minArea * 100).toFixed(0)}%（${A.x},${A.y} 与 ${B.x},${B.y}）`, fix: '挪开其中一块，或合并成一张卡。' });
      }
    }
  });

  // 2b) 字号撞车：文字元素的字号 ≥ 盒高（说明盒子装不下这行字，必挤压）
  chunks.forEach((chunk, i) => {
    const decls = [...chunk.matchAll(/(?:const\s+(\w+)\s*=\s*)?abs\(\s*mk\([^)]*\)\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(\d+)\s*\)/g)];
    for (const d of decls) {
      const name = d[1];
      const h = +d[2];
      if (!name) continue;
      const fm = new RegExp(name + "\\.style\\.fontSize\\s*=\\s*'(\\d+)px'").exec(chunk);
      if (!fm) continue;
      const fs2 = +fm[1];
      if (fs2 >= h * 0.9) {
        findings.push({ kind: 'font-tight', scene: i + 1,
          msg: `第 ${i + 1} 场：\`${name}\` 字号 ${fs2}px ≥ 盒高 ${h}px —— 中文会挤压/被裁`,
          fix: `把盒高改到 ≥ ${Math.ceil(fs2 * 1.6)}px，或把字号降到 ${Math.floor(h / 1.6)}px。` });
      }
    }
  });


  // 去重（同类同场只留一条）
  const seen = new Set();
  const uniq = findings.filter(f => { const k = f.kind + f.scene + f.msg.slice(0, 30); if (seen.has(k)) return false; seen.add(k); return true; });
  return { findings: uniq, dupCount: uniq.filter(f => f.kind === 'dup').length };
}

export function report(res) {
  if (!res.findings.length) return '✓ 版式体检通过（无重复文案、无越界、无明显重叠）';
  const lines = [`版式体检：${res.findings.length} 项（其中「画面文字抄旁白」${res.dupCount} 处）`];
  for (const f of res.findings.slice(0, 12)) {
    lines.push(`  · [${f.kind}] ${f.msg}`);
    if (f.fix) lines.push(`      修法：${f.fix}`);
  }
  if (res.findings.length > 12) lines.push(`  …（还有 ${res.findings.length - 12} 项）`);
  return lines.join('\n');
}
