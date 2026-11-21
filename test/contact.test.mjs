import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { build, contactPlan, report } from '../lib/contact.mjs';
import { currentArtifactInputs } from '../lib/artifact-status.mjs';

test('contact：多帧保持场内真实采样，保留场号、间隔和极短场精度', () => {
  const ranges = [[0.5, 10.5], [12, 12.00001], [15, 20]];
  const plan = contactPlan(ranges, { times: 3, scenes: [3, 2] });
  assert.deepEqual(plan.samples.map(s => s.scene), [2, 2, 2, 3, 3, 3]);
  assert.equal(plan.scenes, 2); assert.equal(plan.totalScenes, 3);
  for (const { scene, t } of plan.samples) assert.ok(t > ranges[scene - 1][0] && t < ranges[scene - 1][1]);
  assert.equal(contactPlan(ranges).samples[0].t, 5.5);
  assert.equal(contactPlan([[0, 6]], { times: 3 }).samples[0].t, 1);
});

test('contact：无效参数不静默截断或改成默认值', () => {
  for (const times of [0, 5, 1.5, NaN, '3']) assert.throws(() => contactPlan([[0, 1]], { times }), /times/);
  for (const cols of [0, 7, 2.5, NaN]) assert.throws(() => contactPlan([[0, 1]], { cols }), /cols/);
  for (const scenes of [[], [0], [2], [1, 1], [NaN], '1']) assert.throws(() => contactPlan([[0, 1]], { scenes }), /scenes/);
  for (const ranges of [[], [[1, 1]], [[-1, 1]], [[0, 2], [1, 3]], [[0, Infinity]]]) assert.throws(() => contactPlan(ranges));
});

test('contact：横竖屏保持完整比例，超大拼图提示分批而不漏帧', () => {
  const wide = contactPlan([[0, 6]], {}, 1920, 1080);
  const tall = contactPlan([[0, 6]], {}, 1080, 1920);
  assert.equal(wide.cellW, 440); assert.ok(wide.cellH < wide.cellW);
  assert.ok(tall.cellH > tall.cellW);
  assert.ok(Math.abs(tall.cellW / tall.cellH - 1080 / 1920) < 0.002);
  assert.throws(() => contactPlan(Array.from({ length: 300 }, (_, i) => [i, i + 1]), { times: 4 }, 1080, 1920), /scenes.*分批/);
});

test('contact：没有 HTML 给说明；报告不把生成当审阅', async () => {
  assert.equal((await build(path.join(os.tmpdir(), 'vh-contact-missing', 'not-created'))).ok, false);
  const text = report({ ok: true, out: '/x/contact.jpg', count: 12, scenes: 4, cols: 3, times: 3 });
  assert.match(text, /4 场/); assert.match(text, /stills --at/); assert.match(text, /生成不等于/);
});

function fixture(t, { portrait = false, failure = '', slow = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-contact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'assets'));
  const width = portrait ? 90 : 160, height = portrait ? 160 : 90;
  fs.writeFileSync(path.join(dir, 'assets/edges.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="green"/><rect width="100%" height="12" fill="red"/><rect y="${height - 12}" width="100%" height="12" fill="blue"/></svg>`);
  for (const [name, value] of Object.entries({ 'PROJECT.json': '{}', '脚本.md': '## S1 · 首尾素材\n1. 甲。\n## S2 · 次场\n1. 乙。\n',
    'scenes.src.js': 'root=>({})\n//---\nroot=>({})', 'engine.tpl.html': '<!-- fixture -->',
    'scene.html': `<!doctype html><style>body{margin:0;background:black}img{display:none;width:100%;height:100vh}</style>
      <img src="assets/edges.svg"><script>
      window.W=${width};window.H=${height};window.DURATION=6;function addScene(){};
      addScene(1,3,()=>{});addScene(4,6,()=>{});
      ${failure === 'assets' ? 'window.__ready=Promise.reject(new Error("fixture asset failure"));' : ''}
      window.renderAt=async t=>{await new Promise(r=>setTimeout(r,${slow ? 500 : 20}));
        ${failure === 'render' ? 'throw new Error("fixture render failure");' : 'document.querySelector("img").style.display="block";'}};
      </script>` })) fs.writeFileSync(path.join(dir, name), value);
  return dir;
}

function pixel(image, x, y) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', image, '-vf', `crop=2:2:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.equal(r.status, 0, String(r.stderr)); return [...r.stdout.subarray(0, 3)];
}

for (const portrait of [false, true]) test(`contact：真实${portrait ? '竖' : '横'}屏图片、相对素材、异步 renderAt 和输入凭证`, async t => {
  const dir = fixture(t, { portrait }), result = await build(dir, { times: 3, scenes: [2], cols: 3 });
  assert.equal(result.ok, true, result.error); assert.equal(result.count, 3); assert.equal(result.scenes, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'out/.vh-contact.json'), 'utf8'));
  assert.equal(receipt.sourceSignature, currentArtifactInputs(dir).sourceSignature);
  assert.equal(receipt.sha256, createHash('sha256').update(fs.readFileSync(result.out)).digest('hex'));
  assert.equal(receipt.reviewed, false); assert.ok(receipt.samples.every(s => s.scene === 2 && s.t > 4 && s.t < 6));
  const plan = contactPlan([[1, 3], [4, 6]], { times: 3, scenes: [2], cols: 3 }, portrait ? 90 : 160, portrait ? 160 : 90);
  const top = pixel(result.out, Math.floor(plan.cellW / 2), 4), bottom = pixel(result.out, Math.floor(plan.cellW / 2), plan.cellH - 6);
  assert.ok(top[0] > 180 && top[1] < 70 && top[2] < 70, `完整顶部红边 ${top}`);
  assert.ok(bottom[2] > 180 && bottom[0] < 70 && bottom[1] < 70, `完整底部蓝边 ${bottom}`);
});

for (const failure of ['assets', 'render']) test(`contact：${failure} 失败保留旧图、不登记新凭证`, async t => {
  const dir = fixture(t, { failure }), out = path.join(dir, 'out'); fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'contact.jpg'), 'old image'); fs.writeFileSync(path.join(out, '.vh-contact.json'), 'old receipt');
  const result = await build(dir);
  assert.equal(result.ok, false); assert.match(result.error, new RegExp(`fixture ${failure === 'assets' ? 'asset' : 'render'} failure`));
  assert.equal(fs.readFileSync(path.join(out, 'contact.jpg'), 'utf8'), 'old image');
  assert.equal(fs.readFileSync(path.join(out, '.vh-contact.json'), 'utf8'), 'old receipt');
});

test('contact：截图中改稿不把旧输入图登记成当前版本', async t => {
  const dir = fixture(t, { slow: true });
  const change = setTimeout(() => fs.appendFileSync(path.join(dir, 'scenes.src.js'), '\n// changed'), 100);
  t.after(() => clearTimeout(change));
  const result = await build(dir, { times: 2 });
  assert.equal(result.ok, false); assert.match(result.error, /截图期间输入发生变化/);
  assert.equal(fs.existsSync(path.join(dir, 'out/contact.jpg')), false);
  assert.equal(fs.existsSync(path.join(dir, 'out/.vh-contact.json')), false);
});

test('contact：CLI 帮助无制作副作用，无效参数非零退出', t => {
  const dir = fixture(t), cli = path.resolve(import.meta.dirname, '../vh.mjs');
  const help = spawnSync(process.execPath, [cli, 'contact', '--help', '--dir', dir], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stdout + help.stderr); assert.match(help.stdout, /--scenes/);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  const invalid = spawnSync(process.execPath, [cli, 'contact', '--times', 'bad', '--dir', dir], { encoding: 'utf8' });
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr); assert.match(invalid.stdout, /times/);
  assert.equal(fs.existsSync(path.join(dir, 'out/contact.jpg')), false);
});
