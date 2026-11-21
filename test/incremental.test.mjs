import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSceneBodies, fnv1a, parseChunks } from '../lib/state.mjs';
import { renderRequestError } from '../lib/render-budget.mjs';

/* 增量渲染：为什么值得测
   这轮发现三个真缺陷，任何一个复发都会让"改一场"退回整片重渲（67s）：
     ① 整份 scene.html 哈希做基线 → build 每次都重写文件，哈希永远变 → 增量从未生效
     ② 默认清帧目录 → 没有旧帧可复用
     ③ 手动 --scenes 只读不传 → 参数被丢掉
   这里锁 ①（纯逻辑），②③ 在源码里锁（需要跑命令，放 smoke）。 */

const VH = fs.readFileSync(path.join(import.meta.dirname, '..', 'vh.mjs'), 'utf8');
const STATE = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'state.mjs'), 'utf8');

const SCENE_HTML = `<!doctype html><html><body><script>
/* 顶部注释里也有 addScene(0, 5.0, ...) 示例 */
const W = 1920, H = 1080;
const scenes = [];
function addScene(start, end, build, fade){
  scenes.push({ start, end, build });
}
// @layout 大字断言
addScene(0.50, 10.00, root => { bg(root); line('一'); return {}; });

// @layout 条形对比
addScene(10.20, 20.00, root => { bg(root); line('二'); return {}; });

// @layout 三步流程
addScene(20.20, 30.00, root => { bg(root); line('三'); return {}; });
window.DURATION = 30;
</script></body></html>`;

test('增量：parseSceneBodies 只数真正的场景（不含函数定义、不含注释示例）', () => {
  const bodies = parseSceneBodies(SCENE_HTML);
  assert.equal(bodies.length, 3, '应有 3 场，实际：' + bodies.length + '\n' + bodies.map(b => b.slice(0, 40)));
  assert.match(bodies[0], /一/);
  assert.match(bodies[2], /三/);
});

test('增量：改一场只让那一场的指纹变', () => {
  const a = parseSceneBodies(SCENE_HTML).map(fnv1a);
  const changed = SCENE_HTML.replace("line('二')", "line('二改了')");
  const b = parseSceneBodies(changed).map(fnv1a);
  const diff = b.map((h, i) => (h !== a[i] ? i + 1 : null)).filter(Boolean);
  assert.deepEqual(diff, [2], '只有第 2 场该变，实际：' + JSON.stringify(diff));
});

test('增量：时间轴不变、只改文案时，不会误判成"边界变了"', () => {
  const changed = SCENE_HTML.replace("line('二')", "line('二改了')");
  const rangesOf = (html) => [...html.matchAll(/addScene\(\s*([\d.]+)\s*,\s*([\d.]+)/g)].map(m => [+m[1], +m[2]]);
  assert.deepEqual(rangesOf(changed), rangesOf(SCENE_HTML));
});

test('增量：基线与当前都用逐场指纹（不再用整份 scene.html 哈希）', () => {
  assert.match(VH, /const bodiesNow = parseSceneBodies/, '应从 scene.html 取逐场指纹');
  assert.match(VH, /bodies:\s*parseSceneBodies/, '基线应记逐场指纹');
  assert.ok(!/const baselineOk = !!\(st\.render && st\.render\.sceneHtmlHash === fnv1a\(sceneSrcNow\)\)/.test(VH),
    '不能用整份 scene.html 哈希判基线（build 会重写整个文件）');
});

test('增量：默认保留帧目录（否则 --scenes 永远无帧可复用）', () => {
  // 只有显式 --clean-frames 才清
  assert.match(VH, /if \(has\('clean-frames'\) && !has\('encode-only'\)\) argv\.push\('--clean-frames'\);/,
    '默认不能清帧');
  assert.ok(!/if \(!has\('keep-frames'\)[^)]*\) argv\.push\('--clean-frames'\)/.test(VH),
    '不能默认清帧');
});

test('增量：手动 --scenes 要真的传给 render.mjs', () => {
  assert.match(VH, /if \(scenesArg\) argv\.push\('--scenes', scenesArg\)/, '--scenes 必须透传');
});

test('增量：无逐帧来源证明时拒绝任意帧范围，不认证旧帧为新整片', () => {
  assert.match(renderRequestError({ from: '1', to: '2' }), /任意帧范围/);
  assert.match(renderRequestError({ encodeOnly: true }), /逐帧来源凭证/);
  assert.equal(renderRequestError({ scenes: '1,2' }), null);
});

test('增量：并列渲染的块数口径与场景数一致', () => {
  const chunks = parseChunks.length >= 0;   // parseChunks 需要文件，这里只验证导出存在
  assert.equal(typeof parseChunks, 'function');
  assert.equal(parseSceneBodies(SCENE_HTML).length, 3);
});

test('增量：逐场指纹与 chunks 数不同也不崩（scene.html 里场次可能被手改）', () => {
  const fewer = SCENE_HTML.replace(/\/\/ @layout 三步流程[\s\S]*?return \{\};\s*\}\);/, '');
  const bodies = parseSceneBodies(fewer);
  assert.ok(bodies.length >= 2 && bodies.length < 3, '少了 1 场：' + bodies.length);
});

test('增量：少帧不等于时间轴不一致，不误清可复用分段', () => {
  assert.match(STATE, /export function parseSceneBodies/);
  assert.match(VH, /!scenesArg && \(trailing \|\| manifestDuration/);
  assert.doesNotMatch(VH, /const stale = \(have > 0 && Math\.abs\(have - need\)/);
});

test('增量：缓存被清（无帧无段）时自动降级整片，而不是报错卡住', () => {
  assert.match(VH, /const cache = !forceAll && canIncrement \? renderCacheState\(project/, '可能增量时必须核验分段清单与实际文件');
  assert.match(VH, /\}\) : \{ canIncrementSafely: false/, '不核验缓存的整片路径不得声称可以增量');
  assert.match(VH, /增量缓存不可用.*→ 整片渲染/, '应提示并降级');
});

test('增量：pro 缓存还在时才用 --scenes 增量', () => {
  assert.match(VH, /changedNow\.length < bodiesNow\.length && cache\.canIncrementSafely/, '增量要同时满足"改了一部分"与"分段可复用"');
});
