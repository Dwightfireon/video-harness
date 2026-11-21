import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { skillDir } from '../lib/state.mjs';
import { normalizeGeneratedMetadata } from '../lib/generator-metadata.mjs';

const vh = path.resolve('vh.mjs');
test('enhance --force：更新 FX 边界准确，不吞掉后面的作者助手和 FILM', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-fx-upgrade-'));
  try {
    fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
    const current = fs.readFileSync(new URL('../assets/fx-block.html', import.meta.url), 'utf8');
    const legacy = current.replace('/* vh:fx-end */', '').replace('opt.draw(ctx, slot / fps, W, H);', 'opt.draw(ctx, rt, W, H);');
    const tail = '\nwindow.VH_UI = Object.assign(window.VH_UI, {authorTool:42});\nwindow.VH_FILM = {author:true};\n';
    const original = '<script>\n' + legacy + tail;
    const file = path.join(dir, 'engine.tpl.html'); fs.writeFileSync(file, original);
    execFileSync(process.execPath, [vh, 'enhance', '--force', '--dir', dir]);
    const result = fs.readFileSync(file, 'utf8');
    assert.ok(result.endsWith(tail)); assert.match(result, /opt\.draw\(ctx, slot \/ fps/);
    assert.equal(result.split('window.__assetsReady = assetsReady;').length, 2);
    const backups = fs.readdirSync(dir).filter(name => name.includes('.bak-'));
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('enhance --film：保留作者模板、先备份、重复安装不重复写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-film-install-'));
  try {
    fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
    const original = '<!doctype html><script>\n/* author-owned */\nconst CUSTOM = 42;\n';
    fs.writeFileSync(path.join(dir, 'engine.tpl.html'), original);
    execFileSync(process.execPath, [vh, 'enhance', '--film', '--dir', dir]);
    const first = fs.readFileSync(path.join(dir, 'engine.tpl.html'), 'utf8');
    assert.ok(first.startsWith(original));
    assert.match(first, /window\.VH_FILM =/);
    const backups = fs.readdirSync(dir).filter(f => f.includes('.bak-film-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
    execFileSync(process.execPath, [vh, 'enhance', '--film', '--dir', dir]);
    assert.equal(fs.readFileSync(path.join(dir, 'engine.tpl.html'), 'utf8'), first);
    assert.equal(fs.readdirSync(dir).filter(f => f.includes('.bak-film-')).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('enhance --film --force：CLI 真正升级旧 FILM，且保留作者尾部', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-film-upgrade-cli-'));
  try {
    fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
    const original = '<script>\n/* VH_FILM: deterministic camera + subtitle cues */\n' +
      'window.VH_FILM = (() => {\nreturn {};\n})();\nconst AUTHOR_TAIL = 42;\n';
    const file = path.join(dir, 'engine.tpl.html'); fs.writeFileSync(file, original);
    execFileSync(process.execPath, [vh, 'enhance', '--film', '--dir', dir]);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    execFileSync(process.execPath, [vh, 'enhance', '--film', '--force', '--dir', dir]);
    const current = fs.readFileSync(file, 'utf8');
    assert.match(current, /compileMotion/); assert.match(current, /fitCamera/);
    assert.ok(current.endsWith('const AUTHOR_TAIL = 42;\n'));
    const backups = fs.readdirSync(dir).filter(name => name.includes('.bak-film-'));
    assert.equal(backups.length, 1); assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
    execFileSync(process.execPath, [vh, 'enhance', '--film', '--force', '--dir', dir]);
    assert.equal(fs.readFileSync(file, 'utf8'), current);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('标准生成器：作者注释不挤走布局标签，不依赖用户演示项目', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-film-gen-'));
  try {
    const assets = path.join(skillDir(), 'assets');
    for (const f of ['gen.mjs', 'timeline.mjs']) fs.copyFileSync(path.join(assets, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 示例\n1. 机身承受载荷。\n');
    fs.writeFileSync(path.join(dir, 'engine.tpl.html'), '<!doctype html><script>\n');
    fs.writeFileSync(path.join(dir, 'scenes.src.js'), '// @layout 连续机制特写\n// @tone dark\nroot => {\n' +
      Array.from({ length: 20 }, (_, i) => '// author note ' + i).join('\n') + '\nreturn { render(){} };\n}');
    execFileSync(process.execPath, [path.join(dir, 'gen.mjs'), '--estimate']);
    assert.equal(normalizeGeneratedMetadata(dir), true);
    assert.equal(normalizeGeneratedMetadata(dir), false);
    const out = fs.readFileSync(path.join(dir, 'scene.html'), 'utf8');
    assert.match(out, /\/\/ @layout 连续机制特写\n\/\/ @tone dark\naddScene\(/);
    assert.match(out, /root\.setAttribute\("data-vh-scene-start", String\(start\)\);/);
    assert.match(out, /root\.setAttribute\("data-vh-scene-end", String\(end\)\);/);
    assert.doesNotMatch(out, /author note/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
