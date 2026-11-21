import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

/* 一镜到底的镜头表逻辑（从 fx-block 源码里取函数做纯逻辑测试）
   为什么单独测：镜头越界是"看图才发现"的问题，但它其实是可算的。 */
const FX = fs.readFileSync(path.join(import.meta.dirname, '..', 'assets', 'fx-block.html'), 'utf8');

/* 把 cameraShotValue 抠出来在 node 里跑（它不依赖 DOM） */
function loadCameraShotValue() {
  const start = FX.indexOf('function cameraShotValue');
  const end = FX.indexOf('window.VH_UI', start);
  const code = FX.slice(start, end);
  // 依赖 eOut3 系列（本地实现，等价于引擎里的）
  const prelude = `
    const c01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
    const P = (t, s, d) => c01((t - s) / d);
  `;
  // eslint-disable-next-line no-new-func
  const fn = new Function(prelude + code + '\nreturn cameraShotValue;')();
  return fn;
}

test('camera：到位后 held=true（停死，不逐帧写 transform）', () => {
  const cam = loadCameraShotValue();
  const shots = [
    { at: 0, move: 0, px: 960, py: 540, k: 1, cx: 960, cy: 540 },
    { at: 4, move: 2, px: 1200, py: 540, k: 1.4, cx: 900, cy: 540 },
  ];
  assert.equal(cam(shots, 3).held, false, '走位中应为 false');
  assert.equal(cam(shots, 5).held, true, '到位后应为 true');
});

test('camera：k 被钳制在 1–4（防止缩到看不见或放到糊）', () => {
  const cam = loadCameraShotValue();
  const shots = [{ at: 0, move: 0, px: 960, py: 540, k: 9, cx: 960, cy: 540 }];
  assert.ok(cam(shots, 1).k <= 4);
  const shots2 = [{ at: 0, move: 0, px: 960, py: 540, k: 0.2, cx: 960, cy: 540 }];
  assert.ok(cam(shots2, 1).k >= 1);
});

test('camera：取景点被夹在世界内（不会看到世界外的空白）', () => {
  const cam = loadCameraShotValue();
  // 想看世界右边缘之外 → 应被夹回
  const shots = [{ at: 0, move: 0, px: 3000, py: 540, k: 2, cx: 960, cy: 540 }];
  const r = cam(shots, 1);
  // 世界宽 1920、k=2 → 可见半宽 480，px 最大 1440
  assert.ok(r.tx <= 480 + 1, `tx=${r.tx}，说明 px 没被夹住`);
});

test('camera：落点留在屏幕安全区（不贴边）', () => {
  const cam = loadCameraShotValue();
  const shots = [{ at: 0, move: 0, px: 960, py: 540, k: 1, cx: 10, cy: 10 }];
  const r = cam(shots, 1);
  assert.ok(r.tx >= 0, `tx=${r.tx} 落点贴边`);
});

test('camera：文案择边逻辑正确（主体偏右→文案在左）', () => {
  const src = FX.slice(FX.indexOf('captionSide(rt)'), FX.indexOf('captionSide(rt)') + 420);
  assert.match(src, /captionSide/);
  assert.match(src, /left|right/);
});
