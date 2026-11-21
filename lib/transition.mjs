/* lib/transition.mjs —— 转场语法（vh transition）
 *
 * 实测：全片 8 场、131 秒，转场只有一种 —— opacity 淡出淡入。
 * 观众看第 3 场就知道"又要淡一下"，这是"平"的第三个来源。
 *
 * 高质量片子的转场是有语法的：
 *   cut   直切     —— 快节奏、同类信息并列（"三张卡"之间）
 *   fade  淡入淡出 —— 换时间、换话题（章节之间）
 *   push  推入     —— 换空间（从"界面"到"日志"）
 *   wipe  擦除     —— 并列对比（A 方案 / B 方案）
 *
 * 判据：
 *   1. 全片转场类型 ≤ 1 种 → 报（现在就是这种）
 *   2. 同一种转场连用 ≥ 4 次 → 报（淡入连用 8 次）
 *   3. 章节处（@layout 大字/章节）应该用 fade，并列处（同版式相邻）应该用 cut
 *
 * 这一项需要引擎先支持多种转场（否则报了也改不了），所以同时提供 injectTransitions()。
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripVisualIntent } from './scene-visual.mjs';

export const KINDS = {
  cut: { name: '直切', when: '同类信息并列、快节奏' },
  fade: { name: '淡入淡出', when: '换时间/换话题/章节' },
  push: { name: '推入', when: '换空间（界面→日志）' },
  wipe: { name: '擦除', when: '并列对比（A/B）' },
};

/* 从 scene.html 读每场实际用的转场 */
export function scan(project) {
  const html = (() => { try { return fs.readFileSync(path.join(project, 'scene.html'), 'utf8'); } catch { return ''; } })();
  const src = (() => { try { return fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'); } catch { return ''; } })();
  if (!html) return { ok: true, scenes: [], findings: [], note: '没有 scene.html（先 build）' };

  const chunks = src.split(/^\/\/---\s*$/m).map(c => stripVisualIntent(c.trim())).filter(Boolean);
  const callRe = /addScene\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,[\s\S]*?\)/g;
  /* 读每场的第 4 参数：数字（fade 秒）或 {t:'push'} 或字符串 */
  /* 转场类型：从 build 写入的 window.__vhTrans 表读（那才是运行时真用的） */
  const tableM = html.match(/window\.__vhTrans = (\[[^;]*\]);/);
  const table = tableM ? JSON.parse(tableM[1]) : [];

  const lines = [...html.matchAll(/addScene\(([\d.]+),\s*([\d.]+),/g)];
  const scenes = lines.map((m, i) => {
    const chunk = chunks[i] || '';
    const tag = (chunk.match(/@layout\s+([^\s*·\n]+)/) || [])[1] || '';
    const fromTable = table[i] && table[i].k;
    const fromTag = transitionTagsFromChunk(chunk).kind;
    return {
      n: i + 1,
      start: +m[1], end: +m[2],
      kind: fromTable || fromTag || 'fade',
      layout: tag,
      source: fromTable ? 'runtime' : fromTag ? 'tag' : 'default',
    };
  });

  /* 引擎有没有多转场能力 */
  const tpl = (() => { try { return fs.readFileSync(path.join(project, 'engine.tpl.html'), 'utf8'); } catch { return ''; } })();
  const hasEngineSupport = /vh:transitions-v2/.test(tpl);

  const findings = [];
  const kinds = [...new Set(scenes.map(s => s.kind))];

  if (scenes.length >= 3 && kinds.length <= 1) {
    findings.push({
      kind: 'single-transition',
      msg: `全片 ${scenes.length} 场只识别到一种转场「${KINDS[kinds[0]]?.name || kinds[0]}」`,
      fix: '结合章节与叙事核对；统一转场可以是有意选择，不为种类数量加入转场。',
    });
  }

  /* 连用次数 */
  let run = 1;
  for (let i = 1; i < scenes.length; i++) {
    if (scenes[i].kind === scenes[i - 1].kind) run++;
    else run = 1;
    if (run === 4) {
      findings.push({
        kind: 'consecutive',
        scene: scenes[i].n,
        msg: `从第 ${scenes[i].n - 3} 场到第 ${scenes[i].n} 场连续 4 次「${KINDS[scenes[i].kind]?.name}」`,
        fix: '核对是否妨碍节奏或主体连续；有效时可以保持一致。',
      });
    }
  }

  return {
    ok: findings.length === 0,
    scenes, findings, kinds,
    hasEngineSupport,
    note: null,
  };
}

export function report(res) {
  if (res.note) return res.note;
  const lines = ['转场语法（全片是不是只有一种转场）', ''];
  lines.push('  场次  转场     版式');
  for (const s of res.scenes) {
    lines.push(`  S${String(s.n).padStart(2)}  ${(KINDS[s.kind]?.name || s.kind).padEnd(8)} ${s.layout}`);
  }
  lines.push('');
  lines.push(`用到的转场：${res.kinds.map(k => KINDS[k]?.name || k).join(' / ')}`);
  if (!res.hasEngineSupport) {
    lines.push('');
    lines.push('⚠ 引擎还不支持多转场（只有 opacity 淡入淡出）');
    lines.push('   仅在内容确有需要时考虑升级；不要为了数量注入转场。');
  }
  lines.push('');
  if (!res.findings.length) {
    lines.push('未触发转场分布提示；不代表视觉节奏通过。');
  } else {
    for (const f of res.findings) {
      lines.push(`⚠ ${f.msg}`);
      if (f.fix) lines.push(`   → ${f.fix}`);
    }
  }
  lines.push('');
  lines.push('四种转场的用法：');
  for (const [k, v] of Object.entries(KINDS)) lines.push(`  ${k.padEnd(6)} ${v.name}　${v.when}`);
  return lines.join('\n');
}

/* ---------- 注入：给引擎加 4 种转场 ----------
 * 做法：把 window.renderAt 里的"opacity 淡入"换成"按 s.transition 分派"。
 * 不改 skill 本体（只改项目里的 scene.html，且由 build 幂等注入）。
 */
export const TRANSITION_RUNTIME = `
/* vh:transitions —— 4 种转场（cut / fade / push / wipe）
   为什么需要：只有 opacity 淡入，全片一个味。转场是有语法的：
   cut 直切（并列）/ fade 淡入（换时间）/ push 推入（换空间）/ wipe 擦除（对比） */
window.__vhTransition = function(scene, prevScene, t, p) {
  /* p: 0→1 的转场进度（由 renderAt 算好传入） */
  const kind = scene.transition || 'fade';
  const root = scene.root;
  const e = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  switch (kind) {
    case 'cut':
      root.style.opacity = p >= .5 ? 1 : 0;
      root.style.transform = 'none';
      break;
    case 'push': {
      /* 新场从右侧推入，旧场向左退出 */
      const dir = scene.pushDir || 1;
      root.style.opacity = 1;
      root.style.transform = 'translateX(' + ((1 - e) * 100 * dir) + '%)';
      if (prevScene && p < .5) prevScene.root.style.transform = 'translateX(' + (-e * 40 * dir) + '%)';
      break;
    }
    case 'wipe':
      root.style.opacity = 1;
      root.style.clipPath = 'inset(0 ' + ((1 - e) * 100) + '% 0 0)';
      break;
    case 'fade':
    default:
      root.style.opacity = 1 - e;
      root.style.transform = 'none';
      break;
  }
};
`;


/* ---------- 不改 gen.mjs 的 TAILTXT：在它生成 renderAt 之后**包装**一层 ----------
 * 做法：等 DOMContentLoaded 后（此时 window.renderAt 已存在），
 * 用同一个签名重写一遍，内部按 scene.transition 分派。
 * 这样与 gen.mjs 的解耦，也不需要改 skill。
 */
export const RUNTIME_FOR_TPL = `
/* vh:transitions-v2 —— 4 种转场（cut / fade / push / wipe）
   包装 gen.mjs 生成的 window.renderAt：转场类型从 window.__vhTrans 读（build 时写入）。 */
(function(){
  const ease = p => p < .5 ? 4*p*p*p : 1 - Math.pow(-2*p+2, 3)/2;
  function boot(){
    if (typeof window.renderAt !== 'function' || window.renderAt.__vhTrans) return;
    const DUR = window.DURATION || 0;
    const Wd = window.W || 1920;
    const Scenes = (typeof scenes !== 'undefined' && Array.isArray(scenes)) ? scenes : null;
    if (!Scenes) return;

    /* 把 build 时写入的标签挂到每个场景对象上 */
    const tags = window.__vhTrans || [];
    Scenes.forEach((s, i) => {
      const t = tags[i] || {};
      s.transition = t.k || 'fade';
      s.transitionDur = t.d == null ? 0.45 : t.d;
    });

    function applyScene(s, t){
      const trans = s.transition || 'fade';
      const td = Math.max(0, Math.min(s.transitionDur == null ? .45 : s.transitionDur, (s.end - s.start) / 2));
      s.root.style.display = 'block';
      if (trans === 'cut' || td === 0){
        s.root.style.opacity = 1; s.root.style.transform = 'none'; s.root.style.clipPath = 'none';
        return;
      }
      if (t < s.start){
        const p = ease(Math.max(0, Math.min(1, (t - (s.start - td)) / td)));
        s.root.style.zIndex = '2';
        if (trans === 'push'){
          s.root.style.opacity = 1;
          s.root.style.transform = 'translateX(' + ((1 - p) * 100) + '%)';
        } else if (trans === 'wipe'){
          s.root.style.opacity = 1; s.root.style.transform = 'none';
          s.root.style.clipPath = 'inset(0 ' + ((1 - p) * 100) + '% 0 0)';
        } else {
          s.root.style.opacity = p;
          s.root.style.transform = 'none'; s.root.style.clipPath = 'none';
        }
        return;
      }
      if (t >= s.end){
        const p = ease(Math.max(0, Math.min(1, (t - s.end) / td)));
        s.root.style.zIndex = '1';
        if (trans === 'push'){
          s.root.style.opacity = 1;
          s.root.style.transform = 'translateX(' + (-p * 30) + '%)';
        } else if (trans === 'wipe'){
          s.root.style.opacity = 1;
          s.root.style.clipPath = 'inset(0 0 0 ' + (p * 100) + '%)';
        } else {
          s.root.style.opacity = Math.max(0, 1 - p);
        }
        return;
      }
      s.root.style.zIndex = '1';
      s.root.style.opacity = 1; s.root.style.transform = 'none'; s.root.style.clipPath = 'none';
    }

    window.renderAt = function(t){
      t = Math.max(0, Math.min(DUR, t));
      for (const s of Scenes){
        const td = s.transition === 'cut' ? 0 : Math.max(0, Math.min(s.transitionDur == null ? .45 : s.transitionDur, (s.end - s.start) / 2));
        const on = t >= s.start - td && t < s.end + td;
        if (!on) { s.root.style.display = 'none'; continue; }
        applyScene(s, t);
        s.render(t - s.start);
      }
      if (typeof renderSubs === 'function') renderSubs(t);
      const bar = document.getElementById('bar');
      if (bar) bar.style.width = (t / DUR * Wd) + 'px';
    };
    window.renderAt.__vhTrans = true;
    window.renderAt(0);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);
})();
/* vh:transitions-end */
`;

/* ---------- 注入实现（幂等）----------
 * 把 scene.html 里的 window.renderAt 整体替换成支持多转场的版本；
 * 并从每场 addScene 上方的 `// @transition push` 注释读取转场类型。
 */
export function inject(project) {
  /* ⚠ 必须写 engine.tpl.html：build 每次从模板重新生成 scene.html，
     直接改产物会被下一次 build 冲掉（真实事故：注入后 build 一次就没了）。 */
  const p = path.join(project, 'engine.tpl.html');
  if (!fs.existsSync(p)) return { ok: false, error: '没有 engine.tpl.html' };
  let html = fs.readFileSync(p, 'utf8');
  if (html.includes('vh:transitions-v2')) {
    if (html.includes(RUNTIME_FOR_TPL.trim())) return { ok: true, already: true };
    const old = html.match(/\/\* vh:transitions-v2[\s\S]*?\n\}\)\(\);(?:\s*\/\* vh:transitions-end \*\/)?/);
    if (!old) return { ok: false, error: '无法识别旧转场块的边界；未覆盖模板' };
    const backup = p + '.bak-transition-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(p, backup);
    fs.writeFileSync(p, html.replace(old[0], () => RUNTIME_FOR_TPL.trim()), 'utf8');
    return { ok: true, injected: true, updated: true, backup: path.basename(backup) };
  }
  fs.writeFileSync(p, html.replace(/\s*$/, '') + '\n' + RUNTIME_FOR_TPL + '\n', 'utf8');
  return { ok: true, injected: true };
}

/* Only standalone tags in a scene's leading comment block are instructions.
 * A visual-intent JSON value, an example in a string, or a later code comment
 * is not a transition declaration. Keep legacy standalone tag syntax. */
export function transitionTagsFromChunk(chunk) {
  const leading = String(chunk).trim().match(/^(?:\s*\/\/[^\n]*(?:\n|$))*/)?.[0] || '';
  const kind = leading.match(/^[ \t]*\/\/[ \t]*@transition[ \t]+(\w+)(?:[ \t\r]|$)/m)?.[1] || null;
  const dur = leading.match(/^[ \t]*\/\/[ \t]*@transition-dur[ \t]+([\d.]+)(?:[ \t\r]|$)/m)?.[1];
  return { kind, dur: dur == null ? null : Number(dur) };
}

/* 从 scenes.src.js 读每场的 @transition 标签，返回数组（按场序） */
export function readTransitionTags(project) {
  const src = (() => { try { return fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'); } catch { return ''; } })();
  const chunks = src.split(/^\/\/---\s*$/m).map(c => c.trim()).filter(Boolean);
  return chunks.map(transitionTagsFromChunk);
}

/* 旧 renderer 的增量 padding 只读 addScene.fade（缺省 .45），不认识标签时长。
 * 无法证明边界覆盖完整就整片渲染；不能带着漏帧给新版本登记凭证。 */
export function incrementalTransitionError(html) {
  const raw = html.match(/window\.__vhTrans\s*=\s*(\[[^;]*\]);/)?.[1];
  if (!raw) return null;
  let tags;
  try { tags = JSON.parse(raw); } catch { return '转场表无法解析，不能确认增量边界'; }
  if (!Array.isArray(tags) || tags.some(t => !t || typeof t !== 'object' ||
    (t.d != null && (!Number.isFinite(t.d) || t.d < 0)))) return '转场时长无效，不能确认增量边界';
  return tags.some(t => t.k !== 'cut' && t.d > .45)
    ? '自定义转场超过 0.45 秒，旧 renderer 不支持对应的增量边界' : null;
}
