import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeGeneratedMetadata, generatedCapabilities, generatorCapabilityWarning, inspectGeneratedCapabilities } from '../lib/generator-metadata.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-generator-capabilities-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), '// @transition cut\nroot=>({render(){}})');
  return dir;
}

test('标准旧出口的标记按版本报告，但静态观察不冒充运行验证', t => {
  const dir = fixture(t);
  const html = 'const scenes = [];\nfunction addScene(start, end, build, fade){\n  stage.appendChild(root);\n  const api = build(root) || {};\n}\n' +
    'addScene(0,2,root=>({}));\nwindow.DURATION = DURATION;\nwindow.renderAt(0);';
  fs.writeFileSync(path.join(dir, 'scene.html'), html);
  assert.equal(normalizeGeneratedMetadata(dir), true);
  const observation = generatedCapabilities(dir);
  assert.equal(observation.version, 1); assert.equal(observation.state, 'unverified');
  assert.equal(observation.adapter, 'legacy-compatible-pattern'); assert.deepEqual(observation.missing, []);
  assert.match(observation.note, /不代表运行验证/); assert.equal(generatorCapabilityWarning(dir), '');
  assert.equal(normalizeGeneratedMetadata(dir), false);
});

test('作者描述里引用的标记不算生成器能力', t => {
  const dir = fixture(t);
  const quoted = ['root.setAttribute("data-vh-scene-start", String(start));', 'root.setAttribute("data-vh-scene-end", String(end));',
    '/* vh:frame-runtime */', '/* vh:frame-runtime-end */', 'window.__vhTrans = []; /* vh:trans-table */'];
  const visual = '// @visual ' + JSON.stringify({ focus: quoted.join(' '), hierarchy: 'h', restraint: 'r', rhythm: 'r' });
  fs.writeFileSync(path.join(dir, 'scene.html'), visual + '\nconst scenes = [];\n<script>window.renderAt = t => 1;</script>');
  const observation = generatedCapabilities(dir);
  assert.equal(observation.state, 'unverified'); assert.equal(observation.adapter, 'custom-or-unknown');
  assert.deepEqual(observation.missing, ['场景时间边界', '素材帧屏障', '转场表', '布局辅助']);
  assert.match(generatorCapabilityWarning(dir), /未能识别/);
});

test('未知自定义出口只报告未识别，不覆盖或宣称功能缺失', t => {
  const dir = fixture(t), file = path.join(dir, 'scene.html');
  const custom = '<script>window.renderAt = t => customDraw(t);</script>';
  fs.writeFileSync(file, custom);
  assert.equal(normalizeGeneratedMetadata(dir), false); assert.equal(fs.readFileSync(file, 'utf8'), custom);
  const observation = generatedCapabilities(dir);
  assert.equal(observation.adapter, 'custom-or-unknown'); assert.equal(observation.state, 'unverified');
  assert.match(generatorCapabilityWarning(dir), /未能识别.*自定义生成器可能以其他方式实现/);
  assert.equal(inspectGeneratedCapabilities('').state, 'unavailable');
});
