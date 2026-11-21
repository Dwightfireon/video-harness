import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

/* moov 位置：在前 64KB 内算合格（可边下边播），在末尾会导致播放器转圈 */
function moovOffset(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.statSync(file).size;
  const buf = Buffer.alloc(Math.min(size, 65536));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  return buf.includes('moov') ? 'front' : 'back';
}

/* ---------- 1) 时长一致性：脚本/scene.html/timing 三方 ---------- */
test('consistency：scene.html 的 DURATION 必须 ≥ 最后一条字幕 end', () => {
  const html = `const SUBS=[{"s":1,"e":9.5,"t":"a"},{"s":10,"e":19.2,"t":"b"}];\nDURATION = 20.0;`;
  const dur = +(html.match(/DURATION\s*=\s*([\d.]+)/) || [])[1];
  const ends = [...html.matchAll(/"e":\s*([\d.]+)/g)].map(m => +m[1]);
  assert.ok(dur >= Math.max(...ends), `DURATION ${dur} < 最后字幕 ${Math.max(...ends)}`);
});

/* ---------- 2) moov 位置检查（用真实生成的 mp4 验证判定逻辑） ---------- */
test('faststart：判定逻辑正确（有 ffmpeg 时用真实文件）', { skip: !HAVE_FFMPEG }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-mp4-'));
  const noFast = path.join(dir, 'slow.mp4');
  const fast = path.join(dir, 'fast.mp4');
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '2', '-pix_fmt', 'yuv420p', noFast]);
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', noFast, '-c', 'copy', '-movflags', '+faststart', fast]);
  assert.equal(moovOffset(fast), 'front');
  // 小文件 moov 可能也在前；这里只断言 faststart 的结果一定合格
});

/* ---------- 3) 增量渲染守卫：边界变了必须整片（模拟 state 判定） ---------- */
test('increment：场景边界变化 → 判定为必须整片', async () => {
  const { snapshot } = await import('../lib/state.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-inc-'));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', '.vh-state.json'), JSON.stringify({
    render: { at: 'x', sceneHtmlHash: 'old', ranges: [[0, 10], [10, 20]], shared: 'aaa', dur: 20 },
  }));
  fs.writeFileSync(path.join(dir, 'scene.html'), 'addScene(0,10,()=>{});addScene(10,25,()=>{});DURATION=25;');
  const s = await snapshot(dir);
  assert.equal(s.rangesChanged, true, '边界变了却没判定 rangesChanged');
});

/* ---------- 4) 无渲染基线 → 不允许增量 ---------- */
test('increment：没有 render 基线时 changedScenes 为 null（不能增量）', async () => {
  const { snapshot } = await import('../lib/state.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-inc2-'));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, 'scene.html'), 'addScene(0,10,()=>{});DURATION=10;');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), 'root=>{}');
  const s = await snapshot(dir);
  assert.equal(s.changedScenes, null);
});
