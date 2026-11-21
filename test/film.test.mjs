import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { cameraAt, cue, phase, projectPoint, browserSource, trace } from '../lib/film.mjs';

const keys = [{ t: 2, x: 960, y: 540, scale: 1 }, { t: 6, x: 1200, y: 300, scale: 3 }];
test('film：镜头边界、插值和停留', () => {
  assert.equal(cameraAt(keys, -10).scale, 1);
  assert.equal(cameraAt(keys, 4).scale, 2);
  assert.equal(cameraAt(keys, 20).scale, 3);
  assert.equal(cameraAt(keys, 4).x, 1080);
});
test('film：倒放、跳播与顺播结果一致', () => {
  const expected = cameraAt(keys, 4.5);
  [6, 2, 5, 3].forEach(t => cameraAt(keys, t));
  assert.deepEqual(cameraAt(keys, 4.5), expected);
});
test('film：cut 不在中途插值', () => {
  const cut = keys.map(k => ({ ...k, cut: true }));
  assert.equal(cameraAt(cut, 5.99).scale, 1);
  assert.equal(cameraAt(cut, 6).scale, 3);
});
test('film：无效镜头与无效区间明确报错', () => {
  assert.throws(() => cameraAt([], 0));
  assert.throws(() => cameraAt([...keys].reverse(), 0));
  assert.throws(() => cameraAt([{ ...keys[0], scale: 0 }], 0));
  assert.throws(() => cameraAt(keys, NaN));
  assert.throws(() => phase(1, 2, 2));
});
test('film：标注锚点随世界坐标投影', () => {
  assert.deepEqual(projectPoint({ x: 1200, y: 300 }, keys[1]), { x: 960, y: 540 });
  assert.deepEqual(projectPoint({ x: 1210, y: 300 }, keys[1]), { x: 990, y: 540 });
});
test('film：字幕重新测量，镜头触发点随之改变', () => {
  const subs = [{ t: '开口边角出现应力集中', s: 10, e: 15 }];
  assert.equal(cue(subs, '开口边角'), 10);
  assert.equal(cue(subs.map(s => ({ ...s, s: 14 })), '开口边角'), 14);
  assert.equal(cue(subs, '开口边角', 'e', -.5), 14.5);
});
test('film：缺失、歧义触发句禁止静默降级', () => {
  assert.throws(() => cue([], '不存在'), /必须唯一/);
  assert.throws(() => cue([{ t: '重复' }, { t: '重复' }], '重复'), /匹配 2/);
  assert.throws(() => cue([{ t: '重复', s: 0 }], '重复', 'bad'));
});
test('film：裂纹描画每次写绝对进度，支持收回', () => {
  const attrs = {};
  const el = { setAttribute: (k, v) => { attrs[k] = v; } };
  trace(el, .9); trace(el, .2);
  assert.equal(attrs['stroke-dashoffset'], '0.8');
  trace(el, 2); assert.equal(attrs['stroke-dashoffset'], '0');
});
test('film：浏览器注入版与 Node 实现同源、行为相同', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(browserSource(), sandbox);
  const actual = sandbox.window.VH_FILM.cameraAt(keys, 4);
  assert.equal(JSON.stringify(actual), JSON.stringify(cameraAt(keys, 4)));
});
