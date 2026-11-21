/* lib/scene-recipes.mjs —— 场景配方库（vh scene）
 *
 * 为什么需要：引擎有 oneTake / stack / windowMock / 条形 / 步骤条等能力，
 * 但 agent 不会用 → 每支片子都是"标题 + 列表"。这里给**可直接运行**的骨架，
 * 它只需要填内容，不用手算坐标。
 *
 * 每条配方：{ key, name, when, code(ctx) }，code 返回一段 scenes.src.js 块。
 * 坐标一律用 window.W / window.H 计算（横竖屏都能跑）。
 */
export const RECIPES = {
  'hero-statement': {
    name: '大字断言',
    when: '一个结论、一句判据、开场钩子（一屏只留一句）',
    code: () => `root => {
  bg(root);
  const W = window.W, H = window.H, S = window.VH_UI.safeArea();
  const pad = S.pad;
  const t = abs(mk('div','','这里放<b class="hl">一句结论</b>'), pad, Math.round(S.top + S.h * 0.22), S.W - pad * 2, Math.round(S.h * 0.30));
  type(t, 'hero');
  const sub = abs(mk('div','','下面补一句人话：它是谁、为什么重要'), pad, Math.round(S.bottom - S.h * 0.16), Math.round(W * 0.8), Math.round(S.h * 0.1));
  type(sub, 'body'); label(sub, 26, 400, 'var(--ink2)');
  const rule = abs(mk('div',''), pad, Math.round(S.top + S.h * 0.16), 0, 4);
  rule.style.cssText += 'background:var(--accent);border-radius:2px';
  root.append(rule, t, sub);
  return { render(rt){
    enter(t, rt, .25, { dy: 18, blur: 0, dur: .8 });
    rule.style.width = (eOut3(P(rt, .1, .6)) * Math.round(S.W * 0.11)) + 'px';
    enter(sub, rt, .7, { dy: 14, blur: 4 });
  }};
}`,
  },

  'compare-bars': {
    name: '条形对比',
    when: '两个量比大小（价格、占比、耗时）——长度比读数字快',
    code: () => `root => {
  bg(root);
  const W = window.W, H = window.H, S = window.VH_UI.safeArea();
  const pad = S.pad;
  const title = line('这里放<b class="hl">对比结论</b>');
  abs(title.el, pad, Math.round(S.top + S.h * 0.06), S.W - pad * 2, Math.round(S.h * 0.1)); type(title.el, 'h1');
  root.appendChild(title.el);

  const rows = [
    { k: 'A 方案', v: 1.00, label: '100%' },
    { k: 'B 方案', v: 0.62, label: '62%' },
  ];
  /* 标签列按宽度算，别写死百分比：方屏/竖屏下 "默认 100 连接" 会折行压住条形 */
  const labelW = Math.min(Math.round(S.W * 0.30), 380);
  const barX = pad + labelW + 16;
  const barW = Math.max(120, Math.min(Math.round(S.W * 0.40), S.W - barX - pad - 170));
  const els = rows.map((r, i) => {
    const y = Math.round(S.top + S.h * (0.30 + i * 0.18));
    const k = abs(mk('div','',r.k), pad, y, labelW, 48); type(k, 'h2'); root.appendChild(k);
    const track = abs(mk('div',''), barX, y + 12, barW, 24);
    track.style.cssText += 'background:var(--line);border-radius:12px'; root.appendChild(track);
    const bar = abs(mk('div',''), barX, y + 12, 0, 24);
    bar.style.cssText += 'background:' + (i ? 'var(--ink3)' : 'var(--accent)') + ';border-radius:12px;opacity:' + (i ? .55 : 1);
    root.appendChild(bar);
    const val = abs(mk('div','',r.label), barX + barW + 18, y, Math.max(120, S.W - (barX + barW) - pad - 18), 48);
    type(val, 'h2'); val.style.fontFamily = 'var(--font-mono)'; val.style.color = i ? 'var(--ink2)' : 'var(--accent)';
    root.appendChild(val);
    return { bar, r, at: .8 + i * .45 };
  });
  const src = abs(mk('div','','来源：____（写清出处与口径）'), pad, Math.round(S.bottom - 52), S.W - pad * 2, 40);
  type(src, 'note'); label(src, 22, 400, 'var(--ink3)'); root.appendChild(src);
  return { render(rt){
    title.set(P(rt, .2, .7));
    els.forEach(o => { o.bar.style.width = (eOut3(P(rt, o.at, .9)) * barW * o.r.v) + 'px'; });
    enter(src, rt, 1.8, { dy: 10, blur: 3 });
  }};
}`,
  },

  'process-steps': {
    name: '三步流程',
    when: '有先后或依赖；以一条关系线组织步骤，不为占满画面堆卡片',
    code: () => `root => {
  bg(root);
  const W = window.W, H = window.H, S = window.VH_UI.safeArea();
  const pad = S.pad;
  const title = abs(mk('div','','这里放<b class="hl">流程标题</b>'), pad, Math.round(S.top + S.h * 0.08), S.W - pad * 2, Math.round(S.h * 0.15));
  type(title, 'h1'); root.appendChild(title);

  const steps = ['第一步：____', '第二步：____', '第三步：____'];
  /* 定稿时改为本场三句各自唯一的字幕片段；null 仅用于展示骨架。 */
  const cueLines = null;
  if (cueLines && (!Array.isArray(cueLines) || cueLines.length !== steps.length || !window.VH_FILM?.sceneCue)) {
    throw new Error('流程字幕锚点需要三句唯一片段和 VH_FILM.sceneCue');
  }
  const atTimes = cueLines ? cueLines.map(text => window.VH_FILM.sceneCue(root, text)) : [.6, 1.4, 2.2];
  if (atTimes.some((t, i) => !Number.isFinite(t) || (i && t <= atTimes[i - 1]))) throw new Error('流程字幕锚点必须按讲述顺序递增');
  const vertical = S.W < 1400;
  const contentW = S.W - pad * 2;
  const gap = Math.round(Math.min(48, contentW * 0.04));
  const colW = Math.floor((contentW - gap * 2) / 3);
  const axisY = Math.round(S.top + S.h * 0.37);
  const rowY = i => Math.round(S.top + S.h * (0.25 + i * 0.20));
  const connector = abs(mk('div',''), pad + 6,
    vertical ? rowY(0) + 6 : axisY + 6, vertical ? 2 : 0, vertical ? 0 : 2);
  connector.setAttribute('data-vh-role', 'decoration');
  connector.style.cssText += 'background:var(--line)'; root.appendChild(connector);
  const els = steps.map((s, i) => {
    const x = vertical ? pad : pad + i * (colW + gap);
    const y = vertical ? rowY(i) : axisY;
    const dot = abs(mk('div',''), x, y, 14, 14);
    dot.setAttribute('data-vh-role', 'decoration');
    dot.style.cssText += 'background:var(--accent);border-radius:50%'; root.appendChild(dot);
    const number = abs(mk('div','', '0' + (i + 1)), vertical ? x + 42 : x, vertical ? y - 6 : y - 55,
      vertical ? 44 : colW, 32);
    type(number, 'note'); number.style.color = 'var(--ink2)'; root.appendChild(number);
    const labelEl = abs(mk('div','',s), vertical ? x + 100 : x, vertical ? y - 7 : y + 34,
      vertical ? contentW - 100 : colW, Math.round(S.h * 0.12));
    type(labelEl, 'h2'); root.appendChild(labelEl);
    return { dot, number, labelEl, at: atTimes[i] };
  });
  const note = abs(mk('div','','补一句边界：什么情况不适用'), pad, Math.round(S.bottom - 52), S.W - pad * 2, 44);
  type(note, 'note'); label(note, 24, 400, 'var(--ink3)'); root.appendChild(note);
  return { render(rt){
    enter(title, rt, .2, { dy: 12, blur: 0, dur: .7 });
    const progress = (eOut3(P(rt, atTimes[1], .6)) + eOut3(P(rt, atTimes[2], .6))) / 2;
    if (vertical) connector.style.height = Math.round((rowY(2) - rowY(0)) * progress) + 'px';
    else connector.style.width = Math.round(2 * (colW + gap) * progress) + 'px';
    els.forEach(o => {
      o.dot.style.opacity = String(P(rt, o.at, .35));
      enter(o.number, rt, o.at, { dy: 8, blur: 0, dur: .45 });
      enter(o.labelEl, rt, o.at + .1, { dy: 10, blur: 0, dur: .5 });
    });
    enter(note, rt, atTimes[2] + .6, { dy: 8, blur: 0, dur: .45 });
  }};
}`,
  },

  'window-walkthrough': {
    name: '窗口实拍感',
    when: '讲"机器里发生的事"——真实界面比示意图可信',
    code: () => `root => {
  bg(root);
  const W = window.W, H = window.H, U = window.VH_UI, S = U.safeArea();
  const pad = S.pad;
  const title = line('这里放<b class="hl">界面里的一处</b>');
  abs(title.el, pad, Math.round(S.top + S.h * 0.04), S.W - pad * 2, Math.round(S.h * 0.1)); type(title.el, 'h1');
  root.appendChild(title.el);

  /* 窗口按比例放在左/上，右侧留文案位（小屏自动上下排） */
  /* 宽屏左右排、窄屏上下排：比例一律按安全区算，竖屏才不会被裁 */
  const wide = S.W >= 1400;
  const winW = Math.round(wide ? S.W * 0.54 : S.W - pad * 2);
  /* 高度按宽度算时**必须夹住安全区**：sw*0.52 可能比剩余高度更大，
     结果窗口压到字幕条上（真实事故：fit 量出来底边 957 > 安全区 918）。 */
  const winY = Math.round(S.top + S.h * 0.26);
  const winH = Math.round(Math.min(winW * 0.52, S.bottom - winY - 8));
  const winX = pad;
  const { el: win } = U.windowMock(root, winX, winY, winW, winH, '终端 · 示例');
  U.codeLine(win, 60, '$ npm run build');
  U.codeLine(win, 100, '✓ built in 1.2s', 'ok');
  U.codeLine(win, 140, '▲ 警告：____', 'warn');

  const sideX = wide ? winX + winW + Math.round(S.W * 0.04) : pad;
  const sideY = wide ? winY : winY + winH + 36;
  const pts = ['这里说清这一屏在做什么', '这里给一个可核的数字或结果'];
  const els = pts.map((s, i) => {
    const e = abs(mk('div','', (i + 1) + '. ' + s), sideX, sideY + i * 86, Math.round(wide ? S.W * 0.3 : S.W - pad * 2), 76);
    e.style.cssText += 'font-size:24px;line-height:1.5;color:var(--ink2)';
    root.appendChild(e);
    return e;
  });
  return { render(rt){
    title.set(P(rt, .2, .7));
    enter(win, rt, .5, { dy: 20, blur: 5 });
    els.forEach((e, i) => enter(e, rt, 1.0 + i * .2, { dy: 14, blur: 4 }));
  }};
}`,
  },

  'one-take': {
    name: '一镜到底',
    when: '同一主体、多个层次 —— 不切镜，靠推拉与文案交接换场',
    code: () => `root => {
  bg(root);
  const W = window.W, H = window.H, U = window.VH_UI, S = U.safeArea();
  const pad = S.pad;

  /* 镜头表：at=到位秒，move=走位时长，px/py=看哪里，k=多近，cx/cy=落点 */
  /* 坐标全用 W/H，横竖屏都能跑。⚠ 主体别铺满整屏：推近会把它推到画外。 */
  const shots = [
    { at: 0,  move: 0, px: W / 2,     py: H / 2, k: 1.00, cx: W / 2, cy: H / 2 },
    { at: 4.5, move: 2.5, px: W * 0.5, py: H * 0.47, k: 1.10, cx: W / 2, cy: H * 0.5 },
    { at: 9,  move: 2.5, px: W * 0.47, py: H * 0.48, k: 1.22, cx: W / 2, cy: H * 0.5 },
  ];
  const st = U.oneTake(root, shots);

  /* 主体放进 world（会跟镜头缩放）。只占画面中间一小块，四周留白—— */
  /* 这样推近时主体仍在框内，不会变成一片白。 */
  /* 卡片底边必须停在字幕安全区上方（1080p 下 840px），否则字幕条会压住内容 */
  /* 卡片放在安全区里：底边绝不越到字幕条下面。
     高度跟着内容走 —— 卡片比内容高出一截 = 一大块留白，density 会报 blank-card。 */
  /* 行高与宽度跟着安全区走：竖屏窄，卡片要更宽、行距更大，否则下半屏一片白 */
  const rows = [
    ['01-python-basics.mp4', '3:12', 'ok'],
    ['02-fastapi-deploy.mp4', '5:47', 'ok'],
    ['03-postgres-tuning.mp4', '4:05', 'ok'],
    ['04-k8s-rollout.mp4', '6:31', 'warn'],
    ['05-redis-cache.mp4', '4:48', 'ok'],
    ['06-ci-pipeline.mp4', '7:02', 'ok'],
    ['07-observability.mp4', '5:20', 'ok'],
    ['08-cost-review.mp4', '3:55', 'ok'],
  ];
  const headH = 54;
  const cardW = Math.round(S.W * (S.W < 1400 ? 0.86 : 0.6));
  /* 目标：卡片高度占安全区 ~62%（横屏）/ ~58%（竖屏），行高在 42–66 之间自适应 */
  const targetH = S.h * (S.W < 1400 ? 0.58 : 0.62);
  const rowH = Math.round(Math.max(42, Math.min(66, (targetH - headH - 74) / rows.length)));
  const cardH = Math.round(headH + rows.length * rowH + 74);
  const cardX = Math.round((S.W - cardW) / 2), cardY = Math.round(S.top + S.h * 0.22);
  const { el: win } = U.windowMock(st.world, cardX, cardY, cardW, cardH, '工作台 · 成片');

  /* 卡片里必须填满真实内容：一片空白卡片 = 观众看到的是白屏 */
  rows.forEach(([name, dur, tone], i) => {
    const y = Math.round(headH + 12 + i * rowH);
    U.codeLine(win, y, (tone === 'warn' ? '▲ ' : '✓ ') + name, tone === 'warn' ? 'warn' : 'ok');
    const d = abs(mk('div', '', dur), cardW - 104, y, 76, 28);
    d.style.cssText += 'font-family:var(--font-mono);font-size:19px;color:var(--ink3);text-align:right';
    win.appendChild(d);
  });
  const bar = abs(mk('div', ''), 26, cardH - 44, cardW - 52, 6);
  bar.style.cssText += 'background:var(--line);border-radius:3px;overflow:hidden';
  const fill = mk('div', ''); fill.style.cssText = 'height:100%;width:72%;background:var(--accent);border-radius:3px';
  bar.appendChild(fill); win.appendChild(bar);

  /* 文案不进 world（不跟缩放）。固定在上方一条带里 —— 不要按镜头择边： */
  /* 同一场里边左右跳，观众会以为画面闪了一下。 */
  const capTop = Math.round(S.top + S.h * 0.04);
  const caps = [
    '左边素材，右边成片——一行一支',
    '推近：每行都有时长和状态',
    '再推近：一条进度，就是还剩多少',
  ].map(s => {
    const el = abs(mk('div', '', s), pad, capTop, Math.round(S.W - pad * 2), Math.round(S.h * 0.13));
    type(el, 'h1'); el.style.lineHeight = '1.25'; root.appendChild(el); return el;
  });
  const runBeats = U.beats([
    { el: caps[0], in: .3, out: 4.2 },
    { el: caps[1], in: 4.8, out: 8.7 },
    { el: caps[2], in: 9.3, out: null },
  ]);

  return { render(rt){
    st.apply(rt);
    runBeats(rt);
  }};
}`,
  },
};

export const list = () => Object.entries(RECIPES).map(([k, r]) => ({ key: k, name: r.name, when: r.when }));
export const get = (key) => RECIPES[key] || null;

/* 给 agent 的一行示例（提示里用） */
export function promptHints() {
  return list().map(r => `· ${r.key}（${r.name}）：${r.when} → node vh.mjs scene ${r.key}`).join('\n');
}
