import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileMotion, fitCamera, projectPoint, cameraAt, phase, cue, smooth, sceneTiming, browserSource } from '../lib/film.mjs';
import { installFilm } from '../lib/film-install.mjs';

function spec() {
  return { start: 30, end: 50,
    subs: [{ s: 1, e: 3, t: '文件已更新' }, { s: 33, e: 36, t: '文件已更新' }, { s: 40, e: 44, t: '只发送改动文件' }],
    targets: { file: { x: 0, opacity: 0 }, path: { progress: 0 } },
    beats: [
      { id: 'reveal', target: 'file', cue: { text: '文件已更新' }, dur: 1, hold: 1, to: { opacity: 1 } },
      { id: 'move', target: 'file', cue: { text: '只发送改动文件' }, dur: 2, hold: 2, to: { x: 240 } },
      { id: 'trace', target: 'path', at: 10, dur: 2, to: { progress: 1 } },
    ] };
}

test('motion plan：全局字幕只在编译时减场景起点，sample 使用场内时间', () => {
  const p = compileMotion(spec());
  assert.equal(p.duration, 20); assert.equal(p.beats[0].at, 3);
  assert.equal(p.sample(2).targets.file.opacity, 0);
  assert.equal(p.sample(3.5).targets.file.opacity, .5);
  assert.equal(p.sample(4).targets.file.opacity, 1);
  assert.equal(p.sample(11).targets.file.x, 120);
  assert.equal(p.sample(11).targets.path.progress, .5);
  assert.equal(p.sample(12).targets.file.x, 240);
});

test('motion plan：句尾触发、有限偏移，空匹配/场内歧义不得回退到0', () => {
  const input = spec(); input.beats[0].cue = { text: '文件已更新', edge: 'e', offset: .25 };
  assert.equal(compileMotion(input).beats[0].at, 6.25);
  input.beats[0].cue.text = '不存在'; assert.throws(() => compileMotion(input), /必须唯一/);
  input.beats[0].cue.text = '文件已更新'; input.subs.push({ s: 38, e: 39, t: '文件已更新' });
  assert.throws(() => compileMotion(input), /匹配 2/);
});

test('motion plan：重测旁白后重新编译，动作整体跟随当前字幕', () => {
  const original = spec(), changed = spec();
  changed.subs = changed.subs.map(s => ({ ...s, s: s.s + 2, e: s.e + 2 }));
  // 本例路径也锚定同一句，而非留一个未重测的魔法秒数。
  for (const input of [original, changed]) {
    delete input.beats[2].at; input.beats[2].cue = { text: '只发送改动文件' };
  }
  const a = compileMotion(original), b = compileMotion(changed);
  assert.equal(b.beats[0].at - a.beats[0].at, 2);
  assert.deepEqual(a.sample(11), b.sample(13));
  changed.start += 2; changed.end += 2;
  assert.deepEqual(a.sample(11), compileMotion(changed).sample(11));
});

test('motion plan：顺播、倒播、随机顺序与直达取值一致', () => {
  const p = compileMotion(spec()), points = [-2, 0, 3, 3.25, 4, 10, 10.5, 11, 12, 19, 30];
  const direct = points.map(t => p.sample(t));
  for (const t of [19, 3.25, 12, 0, 30, 4, 10.5, -2, 11, 3, 10]) p.sample(t);
  assert.deepEqual(points.map(t => p.sample(t)), direct);
  assert.equal(p.sample(-2).targets.file.x, 0); assert.equal(p.sample(30).targets.file.x, 240);
});

test('motion plan：读取/修改返回快照及输入对象不会污染后续帧', () => {
  const input = spec(), p = compileMotion(input), expected = p.sample(11);
  input.targets.file.x = 9999; input.beats[1].to.x = 9999;
  const sample = p.sample(11); sample.targets.file.x = -99;
  assert.deepEqual(p.sample(11), expected);
  assert.throws(() => { p.beats[1].to.x = 99; }, TypeError);
});

test('motion plan：同一属性不得重叠，显式阅读保持也不能被抢占', () => {
  const input = spec(); input.beats.push({ id: 'interrupt', target: 'file', at: 13, dur: 1, to: { x: 0 } });
  assert.throws(() => compileMotion(input), /保持重叠/);
  input.beats.at(-1).at = 14;
  const p = compileMotion(input); assert.equal(p.sample(13.999).targets.file.x, 240);
  assert.equal(p.sample(15).targets.file.x, 0);
});

test('motion plan：不同属性可同时变化，声明顺序不决定结果', () => {
  const input = spec(); input.beats.push({ id: 'dim', target: 'file', at: 10, dur: 2, to: { opacity: .5 } });
  const expected = compileMotion(input).sample(11);
  input.beats.reverse(); assert.deepEqual(compileMotion(input).sample(11), expected);
  assert.equal(expected.targets.file.opacity, .75); assert.equal(expected.targets.file.x, 120);
});

test('motion plan：零时长是精确切换，不出现NaN；停稳后严格保持终值', () => {
  const input = spec(); input.beats[1].dur = 0;
  const p = compileMotion(input);
  assert.equal(p.sample(9.999).targets.file.x, 0); assert.equal(p.sample(10).targets.file.x, 240);
  for (const t of [12, 12.001, 15, 19.99, 50]) assert.equal(p.sample(t).targets.file.x, 240);
});

test('motion plan：越界、歧义时间源、重复id和非法状态均明确拒绝', () => {
  const edits = [
    s => { s.beats[1].dur = 30; }, s => { s.beats[1].hold = 20; }, s => { s.beats[1].dur = -1; },
    s => { s.beats[1].at = 10; }, s => { delete s.beats[1].cue; }, s => { s.beats[1].target = 'missing'; },
    s => { s.beats[1].id = 'reveal'; }, s => { s.beats[1].to.x = Infinity; },
    s => { s.beats[1].to.opacity = 2; }, s => { s.targets.file.scale = 0; },
    s => { s.beats[1].to.filter = 2; }, s => { s.end = Infinity; }, s => { s.subs[1].e = 32; },
    s => { s.beats[1].cue.offset = '2'; }, s => { s.beats[1].cue.text = ''; },
  ];
  for (const edit of edits) { const input = spec(); edit(input); assert.throws(() => compileMotion(input)); }
  assert.throws(() => compileMotion(spec()).sample(NaN), /有限/);
});

test('motion plan：同属性同一时刻的两个硬切无隐含覆盖顺序', () => {
  const input = spec();
  input.beats = [1, 2].map(n => ({ id: 'cut' + n, target: 'file', at: 3, dur: 0, to: { x: n * 10 } }));
  assert.throws(() => compileMotion(input), /重叠/);
});

test('motion plan：浮点时间统一精度，不误拒场景起点或永远够不到终点硬切', () => {
  const a = compileMotion({ start: 1.1, end: 2, subs: [{ s: 1.2, e: 1.9, t: '开始' }], targets: { a: {} },
    beats: [{ id: 'begin', target: 'a', cue: { text: '开始', offset: -.1 }, dur: 0, to: { x: 1 } }] });
  assert.equal(a.beats[0].at, 0); assert.equal(a.sample(0).targets.a.x, 1);
  const atStart = compileMotion({ start: 1.1, end: 2, subs: [{ s: 1.2 - .1, e: 1.9, t: '开始' }], targets: { a: {} },
    beats: [{ id: 'begin', target: 'a', cue: { text: '开始' }, dur: 0, to: { x: 1 } }] });
  assert.equal(atStart.sample(0).targets.a.x, 1);
  const b = compileMotion({ start: 0, end: .3, targets: { a: {} },
    beats: [{ id: 'end', target: 'a', at: .1 + .2, dur: 0, to: { x: 1 } }] });
  assert.equal(b.beats[0].at, .3); assert.equal(b.sample(b.duration).targets.a.x, 1);
  assert.equal(b.sample(.3 - 1e-6).targets.a.x, 0);
  const c = compileMotion({ start: 0, end: 1, targets: { a: {} }, beats: [
    { id: 'first', target: 'a', at: 0, dur: .3, to: { x: 1 } },
    { id: 'second', target: 'a', at: .1 + .2, dur: 0, to: { x: 2 } },
  ] });
  assert.equal(c.sample(.3).targets.a.x, 2);
});

test('缓动纪律：无超调、单调，起止速度与加速度趋零，而非尾段持续漂移', () => {
  let previous = 0;
  for (let i = 0; i <= 1000; i++) { const p = smooth(i / 1000); assert.ok(p >= previous - 1e-12 && p <= 1); previous = p; }
  assert.equal(smooth(0), 0); assert.equal(smooth(1), 1);
  const epsilon = 1e-4;
  assert.ok(smooth(epsilon) / epsilon < 1e-6);
  assert.ok((1 - smooth(1 - epsilon)) / epsilon < 1e-6);
});

test('fitCamera：横竖画幅中主体四角均在字幕安全区内，锚点与镜头同坐标', () => {
  const rect = { x: 400, y: 100, width: 900, height: 600 };
  for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080]]) {
    const options = { width, height, padding: 40, insets: { left: 80, right: 120, top: 100, bottom: 240 } };
    const camera = fitCamera(rect, options);
    for (const x of [rect.x, rect.x + rect.width]) for (const y of [rect.y, rect.y + rect.height]) {
      const point = projectPoint({ x, y }, camera, width, height);
      assert.ok(point.x >= 120 - 1e-8 && point.x <= width - 160 + 1e-8);
      assert.ok(point.y >= 140 - 1e-8 && point.y <= height - 280 + 1e-8);
    }
  }
});

test('fitCamera：无法容纳或输入无效时报错，不偷偷裁主体或改最小缩放', () => {
  const rect = { x: 0, y: 0, width: 1000, height: 1000 };
  assert.throws(() => fitCamera(rect, { width: 400, height: 400, minScale: 1 }), /完整容纳/);
  assert.throws(() => fitCamera(rect, { insets: { bottom: 1080 } }), /占满/);
  assert.throws(() => fitCamera({ ...rect, width: 0 }));
  assert.throws(() => fitCamera(rect, { padding: NaN }));
  assert.throws(() => fitCamera(rect, { insets: { left: -10 } }));
});

test('已有镜头接口拒绝 Infinity、空触发句与非数字偏移', () => {
  assert.throws(() => cameraAt([{ t: 0, x: 0, y: 0, scale: Infinity }], 0));
  assert.throws(() => phase(NaN, 0, 1));
  assert.throws(() => cue([{ t: '一句话', s: 0, e: 3 }], ''));
  assert.throws(() => cue([{ t: '一句话', s: 0, e: 3 }], '一句话', 's', '2'));
});

test('场景边界读取：当前值随重测改变；缺失不能猜成0秒', () => {
  const attrs = { 'data-vh-scene-start': '30.25', 'data-vh-scene-end': '49.8' };
  const root = { getAttribute: key => attrs[key] ?? null };
  assert.deepEqual(sceneTiming(root), { start: 30.25, end: 49.8 });
  attrs['data-vh-scene-start'] = '32.5'; assert.equal(sceneTiming(root).start, 32.5);
  delete attrs['data-vh-scene-start']; assert.throws(() => sceneTiming(root), /缺少/);
  attrs['data-vh-scene-start'] = ''; assert.throws(() => sceneTiming(root), /缺少/);
  attrs['data-vh-scene-start'] = '50'; assert.throws(() => sceneTiming(root), /无效/);
});

test('编排与取景：浏览器注入和 Node 源码同源，JSON状态精确一致', () => {
  const sandbox = { window: {} }; vm.runInNewContext(browserSource(), sandbox);
  const browser = sandbox.window.VH_FILM, a = compileMotion(spec()), b = browser.compileMotion(spec());
  for (const t of [0, 3.5, 11, 12, 20]) assert.equal(JSON.stringify(a.sample(t)), JSON.stringify(b.sample(t)));
  const rect = { x: 12, y: 14, width: 300, height: 160 };
  assert.equal(JSON.stringify(fitCamera(rect)), JSON.stringify(browser.fitCamera(rect)));
});

test('FILM升级：默认不覆盖旧版，显式升级先备份、保留块外代码且幂等', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-film-motion-install-'));
  try {
    const file = path.join(dir, 'engine.tpl.html');
    const legacy = '<script>\n/* author head */\n/* VH_FILM: deterministic camera + subtitle cues */\n' +
      'window.VH_FILM = (() => {\nreturn {};\n})();\n/* author tail */\nconst custom = 42;\n';
    fs.writeFileSync(file, legacy);
    assert.equal(installFilm(dir).changed, false); assert.equal(fs.readFileSync(file, 'utf8'), legacy);
    const result = installFilm(dir, { force: true }); assert.equal(result.updated, true);
    assert.equal(fs.readFileSync(result.backup, 'utf8'), legacy);
    const current = fs.readFileSync(file, 'utf8'); assert.match(current, /compileMotion/);
    assert.ok(current.startsWith('<script>\n/* author head */')); assert.ok(current.endsWith('/* author tail */\nconst custom = 42;\n'));
    assert.equal(installFilm(dir, { force: true }).changed, false);
    fs.writeFileSync(file, '<script>\nwindow.VH_FILM = {custom:true};\n');
    assert.throws(() => installFilm(dir, { force: true }), /未覆盖/);
    assert.equal(fs.readFileSync(file, 'utf8'), '<script>\nwindow.VH_FILM = {custom:true};\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('FILM升级：结束行缩进不吞后续作者IIFE；相等判断/注释不算重新赋值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-film-boundary-'));
  try {
    const file = path.join(dir, 'engine.tpl.html');
    const tail = '\nconst author = (() => {\nreturn 42;\n})();\nif (window.VH_FILM === undefined) throw new Error("missing");\n' +
      '// window.VH_FILM = old;\nconst example = "window.VH_FILM = example";\n';
    fs.writeFileSync(file, '<script>\n/* VH_FILM: deterministic camera + subtitle cues */\n' +
      'window.VH_FILM = (() => {\nreturn {};\n  })();' + tail);
    const result = installFilm(dir, { force: true }); assert.equal(result.updated, true);
    assert.ok(fs.readFileSync(file, 'utf8').endsWith(tail));
    assert.equal(installFilm(dir, { force: true }).current, true);
    assert.equal(installFilm(dir, { force: true }).changed, false);
    // 再次升级一个带现代标记、但已非当前源码的完整标准块。
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('const clamp =', 'const clamp  ='));
    assert.equal(installFilm(dir, { force: true }).updated, true);
    assert.ok(fs.readFileSync(file, 'utf8').endsWith(tail));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
