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

  'funnel-flow': {
    name: '漏斗损耗',
    when: '总量逐级筛选、转化衰减或瓶颈断点（如候选→复核→有效→落地）',
    code: () => `root => {
  bg(root);
  const W = window.W, H = window.H, S = window.VH_UI.safeArea();
  const pad = S.pad;
  const title = abs(mk('div','','这里放<b class="hl">漏斗断点结论</b>'), pad, Math.round(S.top + S.h * 0.05), S.W - pad * 2, Math.round(S.h * 0.12));
  type(title, 'h1'); root.appendChild(title);

  const stages = [
    { label: '候选总数', ratio: 1.00, value: '1,000', drop: '' },
    { label: '外部复核', ratio: 0.42, value: '420', drop: '筛选掉 58%' },
    { label: '确认有效', ratio: 0.24, value: '240', drop: '' },
    { label: '最终落地', ratio: 0.06, value: '60', drop: '主要断点' },
  ];
  /* 定稿时改为本场四句各自唯一的字幕片段；null 仅用于展示骨架。 */
  const cueLines = null;
  if (cueLines && (!Array.isArray(cueLines) || cueLines.length !== stages.length || !window.VH_FILM?.sceneCue)) {
    throw new Error('漏斗字幕锚点需要四句唯一片段和 VH_FILM.sceneCue');
  }
  const atTimes = cueLines ? cueLines.map(text => window.VH_FILM.sceneCue(root, text)) : [.5, 1.1, 1.7, 2.3];
  if (atTimes.some((t, i) => !Number.isFinite(t) || (i && t <= atTimes[i - 1]))) throw new Error('漏斗字幕锚点必须按讲述顺序递增');

  const labelW = Math.min(Math.round(S.W * 0.22), 240);
  const valW = Math.min(Math.round(S.W * 0.24), 260);
  const barX = pad + labelW + 16;
  const maxBarW = Math.max(140, S.W - barX - pad - valW - 18);
  const rowStep = Math.round(Math.min(110, (S.h * 0.64) / stages.length));
  const startY = Math.round(S.top + S.h * 0.23);

  const els = stages.map((st, i) => {
    const y = startY + i * rowStep;
    const lbl = abs(mk('div','', st.label), pad, y, labelW, 44);
    type(lbl, 'h2'); root.appendChild(lbl);
    const barH = 30;
    const bar = abs(mk('div',''), barX, y + 8, 0, barH);
    const isBottleneck = i === stages.length - 1;
    bar.setAttribute('data-vh-role', 'decoration');
    bar.style.cssText += 'background:' + (isBottleneck ? 'var(--accent)' : 'var(--ink2)') + ';border-radius:6px;opacity:' + (isBottleneck ? 1 : (0.78 - i * 0.14));
    root.appendChild(bar);
    const valText = st.drop ? st.value + ' · ' + st.drop : st.value;
    const val = abs(mk('div','', valText), barX + maxBarW + 18, y, valW, 44);
    type(val, 'note'); val.style.fontFamily = 'var(--font-mono)';
    val.style.color = isBottleneck ? 'var(--accent)' : 'var(--ink2)';
    root.appendChild(val);
    return { lbl, bar, val, ratio: st.ratio, at: atTimes[i] };
  });

  const note = abs(mk('div','','口径说明：写出分母、时间范围与来源'), pad, Math.round(S.bottom - 52), S.W - pad * 2, 42);
  type(note, 'note'); label(note, 22, 400, 'var(--ink3)'); root.appendChild(note);

  return { render(rt){
    enter(title, rt, .15, { dy: 12, blur: 0, dur: .65 });
    els.forEach(o => {
      const targetW = Math.max(24, Math.round(maxBarW * o.ratio));
      o.bar.style.width = Math.round(eOut3(P(rt, o.at, .65)) * targetW) + 'px';
      enter(o.lbl, rt, o.at, { dy: 8, blur: 0, dur: .45 });
      enter(o.val, rt, o.at + .15, { dy: 8, blur: 0, dur: .45 });
    });
    enter(note, rt, atTimes[atTimes.length - 1] + .5, { dy: 8, blur: 0, dur: .45 });
  }};
}`,
  },

  'state-chain': {
    name: '主体状态演进',
    when: '同一对象经历状态变化、出错传播、检查发现与恢复（保留位置与编号参照）',
    code: () => `root => {
  bg(root);
  const W = window.W, H = window.H, S = window.VH_UI.safeArea();
  const pad = S.pad;
  const title = abs(mk('div','','同一对象如何<b class="hl">从出错到恢复</b>'), pad, Math.round(S.top + S.h * 0.06), S.W - pad * 2, Math.round(S.h * 0.12));
  type(title, 'h1'); root.appendChild(title);

  const states = [
    { id: '01', name: '初始状态', detail: '输入与基准一致', tone: 'normal' },
    { id: '02', name: '发生偏差', detail: '某一步改错未察觉', tone: 'alert' },
    { id: '03', name: '状态传播', detail: '后续动作建立在错结果上', tone: 'alert' },
    { id: '04', name: '外部检出', detail: '检查拦截并重建状态', tone: 'recover' },
  ];
  /* 定稿时改为本场四句各自唯一的字幕片段；null 仅用于展示骨架。 */
  const cueLines = null;
  if (cueLines && (!Array.isArray(cueLines) || cueLines.length !== states.length || !window.VH_FILM?.sceneCue)) {
    throw new Error('状态演进字幕锚点需要四句唯一片段和 VH_FILM.sceneCue');
  }
  const atTimes = cueLines ? cueLines.map(text => window.VH_FILM.sceneCue(root, text)) : [.5, 1.3, 2.1, 2.9];
  if (atTimes.some((t, i) => !Number.isFinite(t) || (i && t <= atTimes[i - 1]))) throw new Error('状态演进字幕锚点必须按讲述顺序递增');

  const vertical = S.W < 1400;
  const contentW = S.W - pad * 2;
  const gap = Math.round(Math.min(36, contentW * 0.03));
  const colW = Math.floor((contentW - gap * 3) / 4);
  const axisY = Math.round(S.top + S.h * 0.42);
  const rowY = i => Math.round(S.top + S.h * (0.22 + i * 0.17));

  const rail = abs(mk('div',''), pad + 8,
    vertical ? rowY(0) + 8 : axisY + 8, vertical ? 2 : 0, vertical ? 0 : 2);
  rail.setAttribute('data-vh-role', 'decoration');
  rail.style.cssText += 'background:var(--line)'; root.appendChild(rail);

  const nodes = states.map((st, i) => {
    const x = vertical ? pad : pad + i * (colW + gap);
    const y = vertical ? rowY(i) : axisY;
    const dot = abs(mk('div',''), x, y, 18, 18);
    dot.setAttribute('data-vh-role', 'decoration');
    const color = st.tone === 'alert' ? 'var(--accent)' : 'var(--ink)';
    dot.style.cssText += 'border-radius:50%;background:' + color + ';border:2px solid ' + color;
    root.appendChild(dot);

    const tag = abs(mk('div','', st.id + ' · ' + st.name),
      vertical ? x + 36 : x, vertical ? y - 6 : y - 54, vertical ? contentW - 36 : colW, 38);
    type(tag, 'h2');
    if (st.tone === 'alert') tag.style.color = 'var(--accent)';
    root.appendChild(tag);

    const desc = abs(mk('div','', st.detail),
      vertical ? x + 36 : x, vertical ? y + 34 : y + 34, vertical ? contentW - 36 : colW, 64);
    type(desc, 'note'); label(desc, 22, 400, 'var(--ink2)');
    root.appendChild(desc);

    return { dot, tag, desc, at: atTimes[i] };
  });

  const foot = abs(mk('div','','机制要点：同一编号对象贯穿四步，状态变化来自明确条件'), pad, Math.round(S.bottom - 52), S.W - pad * 2, 42);
  type(foot, 'note'); label(foot, 22, 400, 'var(--ink3)'); root.appendChild(foot);

  return { render(rt){
    enter(title, rt, .15, { dy: 12, blur: 0, dur: .65 });
    const segs = states.length - 1;
    let sum = 0;
    for (let i = 1; i < states.length; i++) sum += eOut3(P(rt, atTimes[i], .55));
    const progress = sum / segs;
    if (vertical) rail.style.height = Math.round((rowY(segs) - rowY(0)) * progress) + 'px';
    else rail.style.width = Math.round(segs * (colW + gap) * progress) + 'px';
    nodes.forEach(n => {
      n.dot.style.opacity = String(P(rt, n.at, .3));
      enter(n.tag, rt, n.at, { dy: 8, blur: 0, dur: .45 });
      enter(n.desc, rt, n.at + .12, { dy: 8, blur: 0, dur: .45 });
    });
    enter(foot, rt, atTimes[segs] + .5, { dy: 8, blur: 0, dur: .45 });
  }};
}`,
  },

  'curve-reveal': {
    name: '曲线演进',
    when: '随步数/时间/规模变化的衰减、增长曲线与门槛阈值（近旁直标，示意明说非实测）',
    code: () => `root => {
  bg(root);
  const W = window.W, H = window.H, S = window.VH_UI.safeArea();
  const pad = S.pad;
  const title = abs(mk('div','','这里放<b class="hl">曲线趋势与门槛</b>'), pad, Math.round(S.top + S.h * 0.05), S.W - pad * 2, Math.round(S.h * 0.12));
  type(title, 'h1'); root.appendChild(title);

  /* 定稿时改为本场两句唯一字幕片段（开画与拐点）；null 仅用于展示骨架。 */
  const cueLines = null;
  if (cueLines && (!Array.isArray(cueLines) || cueLines.length !== 2 || !window.VH_FILM?.sceneCue)) {
    throw new Error('曲线字幕锚点需要两句唯一片段和 VH_FILM.sceneCue');
  }
  const atTimes = cueLines ? cueLines.map(text => window.VH_FILM.sceneCue(root, text)) : [.5, 1.8];
  if (atTimes.some((t, i) => !Number.isFinite(t) || (i && t <= atTimes[i - 1]))) throw new Error('曲线字幕锚点必须按讲述顺序递增');

  const chartX = pad, chartY = Math.round(S.top + S.h * 0.22);
  const chartW = S.W - pad * 2, chartH = Math.round(S.h * 0.54);
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + chartW + ' ' + chartH);
  svg.setAttribute('width', String(chartW));
  svg.setAttribute('height', String(chartH));
  svg.setAttribute('data-vh-role', 'decoration');
  abs(svg, chartX, chartY, chartW, chartH);

  const mL = 56, mR = 40, mT = 24, mB = 42;
  const pW = chartW - mL - mR, pH = chartH - mT - mB;
  const axis = document.createElementNS(svgNS, 'path');
  axis.setAttribute('d', 'M ' + mL + ' ' + mT + ' L ' + mL + ' ' + (mT + pH) + ' L ' + (mL + pW) + ' ' + (mT + pH));
  axis.setAttribute('fill', 'none');
  axis.setAttribute('stroke', 'var(--line)');
  axis.setAttribute('stroke-width', '2');
  svg.appendChild(axis);

  const threshY = Math.round(mT + pH * 0.55);
  const thresh = document.createElementNS(svgNS, 'line');
  thresh.setAttribute('x1', String(mL)); thresh.setAttribute('x2', String(mL + pW));
  thresh.setAttribute('y1', String(threshY)); thresh.setAttribute('y2', String(threshY));
  thresh.setAttribute('stroke', 'var(--ink3)');
  thresh.setAttribute('stroke-dasharray', '6 6');
  thresh.setAttribute('stroke-width', '1.5');
  svg.appendChild(thresh);

  const pts = [0, 0.2, 0.4, 0.6, 0.8, 1.0].map(u => {
    const x = Math.round(mL + u * pW);
    const y = Math.round(mT + (1 - Math.pow(0.18, u)) * pH * 0.92);
    return x + ' ' + y;
  });
  const curve = document.createElementNS(svgNS, 'path');
  curve.setAttribute('d', 'M ' + pts.join(' L '));
  curve.setAttribute('fill', 'none');
  curve.setAttribute('stroke', 'var(--accent)');
  curve.setAttribute('stroke-width', '4');
  curve.setAttribute('stroke-linecap', 'round');
  svg.appendChild(curve);
  root.appendChild(svg);

  const curveLabel = abs(mk('div','','示例曲线 · 单步 0.95 几何衰减（单位：成功率）'), chartX + mL + 16, chartY + mT + 8, Math.min(520, pW - 24), 40);
  type(curveLabel, 'note'); curveLabel.style.color = 'var(--accent)'; root.appendChild(curveLabel);

  const threshLabel = abs(mk('div','','门槛线：50% 可用下限'), chartX + mL + Math.round(pW * 0.48), chartY + threshY - 38, Math.min(320, Math.round(pW * 0.5)), 34);
  type(threshLabel, 'note'); label(threshLabel, 22, 400, 'var(--ink2)'); root.appendChild(threshLabel);

  const xLabel = abs(mk('div','','横轴：连续步骤数（示意曲线，非实测数据）'), pad, Math.round(S.bottom - 52), S.W - pad * 2, 40);
  type(xLabel, 'note'); label(xLabel, 22, 400, 'var(--ink3)'); root.appendChild(xLabel);

  return { render(rt){
    enter(title, rt, .15, { dy: 12, blur: 0, dur: .65 });
    const prog = eOut3(P(rt, atTimes[0], 1.2));
    if (window.VH_FILM?.trace) window.VH_FILM.trace(curve, prog);
    else curve.style.opacity = String(prog);
    enter(curveLabel, rt, atTimes[0] + .3, { dy: 8, blur: 0, dur: .45 });
    thresh.style.opacity = String(P(rt, atTimes[1], .4));
    enter(threshLabel, rt, atTimes[1], { dy: 8, blur: 0, dur: .45 });
    enter(xLabel, rt, atTimes[0] + .4, { dy: 6, blur: 0, dur: .45 });
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
