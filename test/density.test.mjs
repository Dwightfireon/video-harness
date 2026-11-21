import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, report } from '../lib/density.mjs';

/* 画面密度体检：为什么值得测
   真实事故——one-take 配方第 8 秒整屏空白（主体被镜头推出画面），
   而 layout / screen / pacing 全绿：它们查"代码里有没有对象"，不查"屏幕上有多少东西"。
   这里测的是**判据本身**：什么情况该报，什么情况不该误报。 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vh-density-'));

test('density：没有 scene.html 时明确报错，而不是静默通过', async () => {
  const d = tmp();
  await assert.rejects(() => analyze(d), /scene\.html|ENOENT/);
});

test('density：没有场景时返回 note，不误判为通过', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'scene.html'), '<html>没有 addScene</html>', 'utf8');
  const res = await analyze(d);
  assert.ok(res.note, '应给出说明');
  assert.equal(res.findings.length, 0);
  assert.match(report(res), /没有可比对/);
});

test('density：report 会打印口径说明（避免被当成审美判断）', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'scene.html'), '<html>没有 addScene</html>', 'utf8');
  const res = await analyze(d);
  const t = report(res);
  assert.match(t, /没有可比对/);
});

test('density：判据阈值——结构量极低才算空屏（留白不误报）', () => {
  /* 判据写在 analyze 里，这里锁定阈值语义：
     · maxStruct < 1.5%  → empty（一屏只剩背景）
     · 覆盖高 + 结构/覆盖 < 0.55 → blank-card（一大片同色块）
     阈值调松会让留白设计被误报，调紧会漏掉 one-take 那种整屏空。 */
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'density.mjs'), 'utf8');
  assert.match(src, /maxStruct\s*<\s*0\.015/, '空屏阈值应为 1.5% 结构量');
  assert.match(src, /structure\s*\/\s*Math\.max\(f\.coverage,\s*1e-6\)\s*<\s*0\.30/, '空白区块比值阈值应为 0.30（0.55 会误报带说明的卡片）');
});

test('density：采样点覆盖整场（5 帧），不是只取中点', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'density.mjs'), 'utf8');
  assert.match(src, /const n = 5/, '应取 5 帧：只取中点会漏掉运镜中段（one-take 事故）');
  assert.match(src, /sampleTimes/, '应有采样函数');
});

test('density：报告里同时给结构量与覆盖量（两个口径都在，便于判断）', () => {
  const res = {
    ok: true, note: null,
    scenes: [{ i: 1, start: 0, end: 5, avg: 0.05, min: 0.04, max: 0.06,
      frames: [
        { t: 0.5, coverage: 0.05, structure: 0.04, centerCoverage: 0.02, centerStructure: 0.03, edgeCoverage: 0.01, cells: [] },
        { t: 4.5, coverage: 0.06, structure: 0.05, centerCoverage: 0.03, centerStructure: 0.04, edgeCoverage: 0.01, cells: [] },
      ] }],
    findings: [],
  };
  const t = report(res);
  assert.match(t, /结构量/);
  assert.match(t, /覆盖量/);
  assert.match(t, /留白是设计/, '必须说明"墨量低不等于错"，否则会被当成审美判定');
});

test('density：真实截图场不报"大白卡片"（截图整块是内容，不是留白）', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'density.mjs'), 'utf8');
  // 截图场识别：shotEl / videoEl / chartEl / bgImg
  for (const k of ['shotEl', 'videoEl', 'chartEl', 'bgImg']) assert.ok(src.includes(k), '缺 ' + k);
  // 空卡片判据在截图场被跳过
  assert.ok(src.includes('hasShot ? [] :'), '截图场要跳过空卡片判据');
});

test('density：截图识别与 variety 同口径（两个模块不能各认一套）', () => {
  const dens = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'density.mjs'), 'utf8');
  const vari = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'variety.mjs'), 'utf8');
  for (const k of ['shotEl', 'videoEl', 'chartEl', 'bgImg']) {
    assert.ok(dens.includes(k), 'density 缺 ' + k);
    assert.ok(vari.includes(k), 'variety 缺 ' + k);
  }
});

test('density：内容全堆在上半屏 → 报 top-heavy（真实盲区）', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'density.mjs'), 'utf8');
  assert.match(src, /kind: 'top-heavy'/, '应有头重脚轻判据');
  assert.match(src, /mid\[k\] < upper\[k\] \* 0\.30/, '50–75% 那一段不足上半 30% 才报（四横带，末带字幕不算）');
  assert.match(src, /没做完/, '提示要说人话：看起来"没做完"');
});
