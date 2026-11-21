import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-content-first-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#fff;color:#111}#subbox{position:absolute;left:200px;top:900px;font:36px sans-serif}</style><div id="subbox"></div><script>
window.W=1920;window.H=1080;const DURATION=2;const SUBS=${JSON.stringify([{ s: .1, e: 1.9, t: '完整旁白。' }])};const scenes = [];
function addScene(){}addScene(0,2,()=>{});window.renderAt=t=>{document.querySelector('#subbox').textContent=t>=.1&&t<1.9?'完整旁白。':'';};</script>`;
  for (const [name, text] of Object.entries({
    'PROJECT.json': '{}', '脚本.md': '主体：示例\n\n## S1 · 示例\n1. 完整旁白。\n',
    'scenes.src.js': 'root=>({render(){}})', 'engine.tpl.html': "const ORIENT = 'landscape';",
    'gen.mjs': `import fs from 'node:fs';fs.writeFileSync('scene.html',${JSON.stringify(html)});`,
  })) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('默认 build 只做必要技术检查，不执行或生成形式审查报告；audit 仍可主动运行', t => {
  const dir = fixture(t), cli = path.resolve('vh.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, 'build', '--dir', dir, ...args], { encoding: 'utf8', timeout: 40000 });
  const normal = run();
  assert.equal(normal.status, 0, normal.stdout + normal.stderr);
  assert.match(normal.stdout, /字幕实际显示/);
  assert.doesNotMatch(normal.stdout, /解释质量|解释形式|内容深度|图文对应|可选叙事弧|浏览器版式检查|check.mjs 结构检查/);
  assert.equal(fs.existsSync(path.join(dir, '审查.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'out/.vh-layout-measured.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'out/subtitle-review.json'))).probes, 3);
  const audited = run('--audit');
  assert.equal(audited.status, 0, audited.stdout + audited.stderr);
  assert.match(audited.stdout, /解释质量|解释形式/);
  assert.equal(fs.existsSync(path.join(dir, 'out/.vh-layout-measured.json')), true);
});

test('内容优先仍拒绝真实截断字幕，不记录成功 build 基线', t => {
  const dir = fixture(t), file = path.join(dir, 'gen.mjs');
  const source = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, source.replace("?'完整旁白。':''", "?'完整':''"));
  const r = spawnSync(process.execPath, [path.resolve('vh.mjs'), 'build', '--dir', dir], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /字幕实际显示未通过/);
  assert.equal(fs.existsSync(path.join(dir, 'out/.vh-state.json')), false);
});

test('标准工程不借略过旧审核而放行源稿与字幕错配，真实 CLI 在 renderer 启动前阻断', t => {
  const dir = fixture(t), cli = path.resolve('vh.mjs');
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const timing = { schemaVersion: 1, textHash: digest(['完整旁白。']), groupsHash: digest([['完整旁白。']]),
    measurement: { voice: 'test', speed: 1 }, scenes: [[0, 2]], dur: 2, subs: [{ s: .1, e: 1.9, t: '完整旁白。' }] };
  fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify(timing));
  fs.writeFileSync(path.join(dir, 'timeline.mjs'), 'export const scriptGroups=()=>[["完整旁白。"]];export const validateTiming=data=>({subs:data.subs,total:data.dur});');
  const built = spawnSync(process.execPath, [cli, 'build', '--dir', dir], { encoding: 'utf8', timeout: 30000 });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  fs.writeFileSync(path.join(dir, 'render.mjs'), 'import fs from "node:fs";fs.writeFileSync("renderer-started","yes");process.exit(23)');
  const current = spawnSync(process.execPath, [cli, 'render', '--dir', dir], { encoding: 'utf8', timeout: 30000 });
  assert.equal(current.status, 23, current.stdout + current.stderr);
  fs.unlinkSync(path.join(dir, 'renderer-started'));
  const html = path.join(dir, 'scene.html');
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replaceAll('完整旁白。', '旧版旁白。'));
  const result = spawnSync(process.execPath, [cli, 'render', '--dir', dir, '--force'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /生成字幕与当前脚本|生成字幕与.*时间轴|生成字幕/);
  assert.equal(fs.existsSync(path.join(dir, 'renderer-started')), false);
});
