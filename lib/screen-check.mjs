/* lib/screen-check.mjs —— 图文对应体检（vh screen）
 *
 * 来源：真实事故——电梯镜子那支片子四项机器检查全绿，
 * 但画面上只有标题、没有具体对象，还抄了一遍旁白。
 * vh layout 只能查"重复/越界/重叠"，查不出"这一场画的东西够不够撑起旁白"。
 *
 * 这个模块查三件机器能判的事：
 *   1. 每场的「画面具体性」：画面里有没有具体对象（数字/文件名/对比项/流程步骤/示例）
 *   2. 每场的「图文覆盖率」：画面元素数量 vs 旁白信息密度（一句话配一个标题 = 太空）
 *   3. 长停检测：某一场从头到尾画面几乎不变（>12 秒无变化）→ 观众会走神
 * 只给疑点清单，不判"对错"—— 对错仍需人看。
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripVisualIntent } from './scene-visual.mjs';

const readIf = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

export function analyze(project) {
  const src = read(path.join(project, 'scenes.src.js'));
  const sceneHtml = read(path.join(project, 'scene.html'));
  const script = read(path.join(project, '脚本.md'));
  if (!src) return { findings: [], scenes: [], ok: true, note: '没有 scenes.src.js' };

  const chunks = src.split(/^\/\/---\s*$/m).map(s => stripVisualIntent(s.trim())).filter(Boolean);
  // 脚本每场的旁白句与字数
  const scriptScenes = [];
  {
    let cur = null;
    for (const raw of script.split('\n')) {
      const h = raw.match(/^##\s*S(\d+)\s*[·•\-—]?\s*(.*)$/);
      if (h) { cur = { n: +h[1], title: (h[2] || '').trim(), lines: [] }; scriptScenes.push(cur); continue; }
      if (/^##\s/.test(raw)) { cur = null; continue; }
      const lm = raw.match(/^\s*\d+[.、)]\s*(.+)$/);
      if (cur && lm) cur.lines.push(lm[1].trim());
    }
  }
  // 场次区间（用于算时长）
  const ranges = [...sceneHtml.matchAll(/addScene\(\s*([\d.]+)\s*,\s*([\d.]+)/g)].map(m => [+m[1], +m[2]]);

  const findings = [];
  const scenes = [];

  chunks.forEach((chunk, i) => {
    const n = i + 1;
    const scriptScene = scriptScenes[i] || { lines: [], title: '' };
    const [start, end] = ranges[i] || [0, 0];
    const dur = end - start;

    // 具体对象线索：先剔除 abs() 的坐标参数（140, 300, 1200, 100 这种），再看真实数字
    const noCoords = chunk.replace(/abs\([^)]*?\)\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)/g, '')
      .replace(/(?:\d+\s*,\s*){3,}\d+/g, ' ');
    const hasNumber = /\d/.test(noCoords) || /\d/.test([...chunk.matchAll(/['"`]([^'"`]{1,40})['"`]/g)].map(m => m[1]).join(' '));
    const hasFile = /\.(js|ts|tsx|py|md|json|html|css)\b|\b(src|tests|dist)\//.test(chunk);
    const hasCompare = /(对比|对照|vs|VS|前后|左右|好坏|before|after)/.test(chunk);
    const hasSteps = /(①|②|③|1\)|2\)|3\)|step|步骤|先|然后|最后|\.row\(\s*\{)/.test(chunk);
    const hasExample = /(例如|比如|举例|示例|案例|假设)/.test(chunk);
    const hasChart = /(bar|track|条形|进度|chart|chart|比例|占比)/.test(chunk);
    const hasWindow = /(windowMock|codeLine|文件树|tree|terminal|终端)/.test(chunk);
    /* 真实素材也是"具体对象"：一张真截图能撑起一整场，
       不该因为"只写了 2 个元素"被判太空（真实误报：截图场/图表场全被判长停）。 */
    const hasShot = /(shotEl\s*\(|bgImg\s*\(|videoEl\s*\()/.test(chunk);
    const hasRealChart = /(chartEl\s*\(|chartSvg|<svg)/i.test(chunk);
    const objects = [hasNumber, hasFile, hasCompare, hasSteps, hasExample, hasChart, hasWindow, hasShot, hasRealChart].filter(Boolean).length;

    // 画面元素数量（abs 调用数）
    /* 元素计数：除了字面量 abs()，还要算"循环里生成的一组"。
       真实误报：三张卡片用 items.map(...) 生成，代码里只有 1 个 abs()，
       被数成 2 个元素 → 判"20 秒只有 2 个元素会长停"，而画面明明有三张卡。 */
    const loopCount = (() => {
      let n = 0;
      for (const m of chunk.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*\[([\s\S]{0,800}?)\];/g)) {
        const body = m[2] || '';
        /* 条目可能是对象 {..}，也可能是数组 ['01','标题'] —— 两种都数 */
        const objItems = (body.match(/\{\s*[\w'"`]/g) || []).length;
        const arrItems = (body.match(/^\s*\[|\n\s*\[/g) || []).length;
        const items = Math.max(objItems, arrItems);
        if (items >= 2 && new RegExp('\\b' + m[1] + '\\.(?:map|forEach)\\s*\\(').test(chunk)) n += items - 1;
      }
      for (const m of chunk.matchAll(/\[([^\]]{20,400})\]\s*\.\s*(?:map|forEach)\s*\(/g)) {
        const items = (m[1].match(/\{/g) || []).length || m[1].split(',').length;
        n += Math.max(0, items - 1);
      }
      return n;
    })();
    const elems = (chunk.match(/\babs\s*\(/g) || []).length
      + (chunk.match(/\bst\.row\s*\(|\.row\(\s*\{/g) || []).length
      + (chunk.match(/\bwindowMock\s*\(/g) || []).length * 2
      + (chunk.match(/\bcodeLine\s*\(/g) || []).length
      + loopCount;
    const textNodes = (chunk.match(/\.textContent\s*=|.innerHTML\s*=|\bline\(|\bcodeLine\(|\bwindowMock\(|\btype\(/g) || []).length;

    // 旁白信息量
    const chars = (scriptScene.lines.join('').match(/[\u4e00-\u9fff]/g) || []).length;
    const perMinute = dur > 0 ? Math.round(chars / (dur / 60)) : 0;

    const issues = [];
    if (objects === 0) issues.push('画面里没有任何具体对象（数字/文件/对比/步骤/例子/图表/窗口）—— 只是一段文字');
    /* 断言页 / 章节页豁免：这类版式的设计就是"一屏一句"，元素少是意图不是缺陷。
       判据看 @layout 标签（配方库生成时会自动带上）与代码特征（只有一个大字 + 一句副文）。
       ⚠ 只豁免"元素数量"，不豁免"有没有具体对象"—— 空屏仍然要报。 */
    const layoutTag = (chunk.match(/@layout\s+([^\s*·\n]+)/) || [])[1] || '';
    /* 真实素材场：一张截图/一个图表本身就是"承载"，不该按元素个数判太空 */
    const mediaLike = hasShot || hasRealChart || /视频|录屏|截图/i.test(layoutTag);
    const statementLike = /大字|断言|章节|标题页|钩子|hero/i.test(layoutTag)
      || (elems <= 3 && !/\babs\(/.test(chunk.replace(/abs\(\s*mk\([^)]*\)\s*,\s*window/g, '')) && /type\([^,]+,\s*'hero'\)/.test(chunk));
    // 元素太少：不看时长，一律提示（一场只有一个标题 = 没有信息承载）
    if (elems <= 1 && !statementLike && !mediaLike) issues.push(`画面只有 ${elems} 个元素 —— 除了标题什么都没有，静音时看不懂`);
    else if (elems <= 3 && chars > 60 && !statementLike && !mediaLike) issues.push(`画面只有 ${elems} 个元素，但这一场有 ${chars} 字旁白 —— 撑不住，观众会走神`);
    if (textNodes === 0) issues.push('画面没有任何文字层 —— 静音时完全看不懂');
    if (dur > 40 && objects <= 1) issues.push(`这一场 ${dur.toFixed(0)} 秒但只有 ${objects} 类具体对象 —— 太长、太空`);
    if (dur > 12 && elems <= 3 && !statementLike && !mediaLike) issues.push(`这一场 ${dur.toFixed(0)} 秒、只有 ${elems} 个元素 —— 很可能出现"长停"`);

    // 文字重叠：同一场内 codeLine 的 y 相近、又没有左侧偏移 → 两栏会叠在一起
    const codeLines = [...chunk.matchAll(/codeLine\([^,]+,\s*(\d+)/g)].map(m => +m[1]);
    if (codeLines.length >= 4) {
      const ys = codeLines.sort((a, b) => a - b);
      const near = ys.filter((y, i) => i > 0 && y - ys[i - 1] <= 4).length;
      if (near >= 2 && !/marginLeft|left:/.test(chunk)) {
        issues.push(`有 ${codeLines.length} 行代码文字、多行 y 相近但没做左右分栏 —— 很可能叠在一起`);
      }
    }

    scenes.push({ n, title: scriptScene.title, dur: +dur.toFixed(1), chars, perMinute, elems, objects, issues });
    for (const msg of issues) findings.push({ scene: n, msg });
  });

  return { scenes, findings, ok: findings.length === 0, count: chunks.length };
}

/* 生成"静音审阅"用的静帧：每场中点一帧，裁掉字幕区（底部 220px） */
export function silentFramesScript(project) {
  return {
    note: '用 vh screen --frames 批量生成各场中点的静音审阅帧；逐张核对画面，不以生成文件代替人工审阅',
  };
}

export function report(res) {
  if (!res.count) return '图文对应体检：没有场景';
  const lines = [`图文对应体检：${res.count} 场，${res.findings.length} 处疑点`];
  // 概览表
  lines.push('');
  lines.push('  场次   时长    旁白字数  每分钟   画面元素  具体对象');
  for (const s of res.scenes) {
    lines.push(`  S${String(s.n).padEnd(3)} ${String(s.dur).padStart(5)}s ${String(s.chars).padStart(7)} ${String(s.perMinute).padStart(7)} ${String(s.elems).padStart(8)} ${String(s.objects).padStart(8)}`);
  }
  if (res.findings.length) {
    lines.push('');
    lines.push('  疑点（机器只能指出"可能太空"，是否真的清楚要人看）：');
    for (const f of res.findings) lines.push(`   · S${f.scene}：${f.msg}`);
    lines.push('');
    lines.push('  修法方向：给这一场加一个具体对象——数字/文件名/前后对比/三步流程/一张窗口或文件树；');
    lines.push('  而不是继续加句子（句子有字幕在讲）。');
  }
  return lines.join('\n');
}
