import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { artifactStatus, currentArtifactInputs, createArtifactRecord } from '../lib/artifact-status.mjs';
import { saveState } from '../lib/state.mjs';
import { createPublicPackage } from '../lib/public-package.mjs';

test('素材字节与媒体凭证闭环：同大小同mtime替换失效，旧包不能通过，恢复相同字节可复用', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-asset-media-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = name => path.join(dir, name); fs.mkdirSync(p('assets')); fs.mkdirSync(p('out'));
  for (const [name, text] of Object.entries({ 'PROJECT.json': '{"deliveryTarget":"video"}', '脚本.md': '## S1 · 一\n1. 内容。',
    'scenes.src.js': 'root=>({render(t){}})', 'engine.tpl.html': "const ORIENT = 'landscape';", 'scene.html': 'const DURATION = 0.4; addScene(0,0.4,()=>{});' })) fs.writeFileSync(p(name), text);
  const asset = p('assets/illustration.png'); fs.writeFileSync(asset, Buffer.from([0, 1, 2, 255])); const mtime = fs.statSync(asset).mtime;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=64x36:duration=0.4:rate=30', '-f', 'lavfi', '-i', 'sine=duration=0.4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', p('out/video-voice.mp4')], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
  fs.copyFileSync(p('out/video-voice.mp4'), p('out/video.mp4'));
  const input = currentArtifactInputs(dir);
  saveState(dir, { genStamp: { sourceHashes: input.sourceHashes, scriptHash: input.sourceHashes['脚本.md'], scenesHash: input.sourceHashes['scenes.src.js'] },
    render: { artifact: createArtifactRecord(dir, 'render') }, voice: { artifact: createArtifactRecord(dir, 'voice') } });
  assert.equal(artifactStatus(dir).deliverable.stale, false);
  fs.writeFileSync(asset, Buffer.from([255, 2, 1, 0])); fs.utimesSync(asset, mtime, mtime);
  assert.notEqual(currentArtifactInputs(dir).sourceSignature, input.sourceSignature);
  const stale = artifactStatus(dir); assert.equal(stale.deliverable.stale, true); assert.match(stale.stale.scene, /素材/);
  assert.throws(() => createArtifactRecord(dir, 'render', { expectedInputs: input }), /阶段运行期间/);
  assert.throws(() => createPublicPackage(dir, p('export'), { target: 'video', force: true }), /不能打包/);
  assert.equal(fs.existsSync(p('export')), false);
  fs.writeFileSync(asset, Buffer.from([0, 1, 2, 255]));
  assert.equal(currentArtifactInputs(dir).sourceSignature, input.sourceSignature);
  assert.equal(artifactStatus(dir).deliverable.stale, false);
});
