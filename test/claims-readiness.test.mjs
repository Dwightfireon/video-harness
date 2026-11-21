import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextPipelineWork } from '../lib/pipeline-work.mjs';
import { pendingSceneWork } from '../lib/scene-work.mjs';
import { claimsDocumentState } from '../lib/claims.mjs';

test('半份claims不能因文件存在就进入场景；阶段与工具的3000字符限额一致', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-claims-ready-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ workflow: { profile: 'audited' } }));
  fs.writeFileSync(path.join(dir, '方案.md'), '方案'); fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 一\n1. 展示过程。');
  const file = path.join(dir, 'claims.json');
  for (const text of ['[{"id":"C1"', '{"claims":', 'null', '{"other":[]}']) {
    fs.writeFileSync(file, text);
    assert.equal(claimsDocumentState(dir).ok, false);
    const work = await nextPipelineWork(dir, 'article');
    assert.equal(work.stage, 'draft_claims'); assert.match(work.note, /3000/); assert.ok(work.allowed.includes('patch_text'));
    assert.equal(pendingSceneWork(dir, 'article'), null);
  }
  fs.writeFileSync(file, '[]'); assert.equal(claimsDocumentState(dir).ok, true); assert.equal(pendingSceneWork(dir, 'article').scene, 1);
});

test('用户提供原文时，证据表阶段要先给 user-provided 通道，并限制核证预算', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-claims-user-provided-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ workflow: { profile: 'audited' } }));
  fs.writeFileSync(path.join(dir, '方案.md'), '方案');
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 一\n1. 展示过程。');
  const work = await nextPipelineWork(dir, 'article');
  assert.equal(work.stage, 'draft_claims');
  // 必须明确“用户原文就是主要来源”，否则模型会去全站核证
  assert.match(work.note, /用户已经给了文章|用户提供原文|user-provided/);
  // 必须点明 user-provided 不需要 URL、不标 verified
  assert.match(work.note, /research\/原文\.md/);
  assert.match(work.note, /不标 verified/);
  // 必须有核证预算，避免无休止搜索
  assert.match(work.note, /2 次/);
  // 必须给出可照抄的 user-provided 示例，避免模型退回 external 硬查
  assert.match(work.note, /"sourceType":"user-provided"/);
});
