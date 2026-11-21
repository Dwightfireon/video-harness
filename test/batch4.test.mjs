import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, extractNumbers } from '../lib/claims.mjs';
import { parseCoverCopy } from '../lib/cover.mjs';
import { doctor, report } from '../lib/doctor.mjs';

const mk = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-b4-'));
  for (const [n, b] of Object.entries(files)) {
    const p = path.join(dir, n);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, b);
  }
  return dir;
};

/* ---------------- claims ---------------- */
test('claims：抽出脚本里的百分比与倍数（坐标不算）', () => {
  const md = `## S1 · 场\n1. 首轮固定开销里，系统提示约占 27%。\n2. 换档位成本能差 3 倍以上。\n3. 这里有个坐标 140, 300, 1600, 100 不该被算。\n\n← 依赖：无\n`;
  const nums = extractNumbers(md);
  const raws = nums.map(n => n.raw);
  assert.ok(raws.some(r => /27/.test(r)), JSON.stringify(raws));
  assert.ok(raws.some(r => /3\s*倍/.test(r)), JSON.stringify(raws));
  assert.ok(!raws.some(r => /140/.test(r)), '坐标被误算：' + JSON.stringify(raws));
});

test('claims：脚本有数字但 claims 没登记 → 报 unclaimed', () => {
  const dir = mk({
    '脚本.md': '## S1 · 场\n1. 这里说 27% 但没登记。\n\n← 依赖：无\n',
    'claims.json': JSON.stringify({ claims: [{ id: 'C1', assertion: '另一件事', url: 'https://x', kind: '官方', scope: 'x' }] }),
  });
  const r = analyze(dir);
  assert.ok(r.findings.some(f => f.kind === 'unclaimed'), JSON.stringify(r.findings));
});

test('claims：登记齐全且脚本一致 → 无 unclaimed', () => {
  const dir = mk({
    '脚本.md': '## S1 · 场\n1. 系统提示约占 27%。\n\n← 依赖：无\n',
    'claims.json': JSON.stringify({ claims: [{ id: 'C1', assertion: '系统提示约占 27%', scriptLine: '系统提示约占 27%', evidence: '测量', url: 'https://x', kind: '一手', scope: '2026-09' }] }),
  });
  const r = analyze(dir);
  assert.ok(!r.findings.some(f => f.kind === 'unclaimed'), JSON.stringify(r.findings));
});

test('claims：缺 url/kind/scope → 报字段缺失', () => {
  const dir = mk({
    '脚本.md': '## S1 · 场\n1. 无数字。\n\n← 依赖：无\n',
    'claims.json': JSON.stringify({ claims: [{ id: 'C9', assertion: '某断言' }] }),
  });
  const r = analyze(dir);
  const f = r.findings.find(x => x.kind === 'claim-field');
  assert.ok(f, JSON.stringify(r.findings));
  assert.match(f.msg, /url/);
});

test('claims：登记了但脚本已删该数字 → 报 stale', () => {
  const dir = mk({
    '脚本.md': '## S1 · 场\n1. 脚本已经没有那个数字了。\n\n← 依赖：无\n',
    'claims.json': JSON.stringify({ claims: [{ id: 'C1', assertion: '提升 90%', scriptLine: '提升 90%', evidence: 'x', url: 'https://x', kind: '厂商', scope: 'x' }] }),
  });
  const r = analyze(dir);
  assert.ok(r.findings.some(f => f.kind === 'stale-claim'), JSON.stringify(r.findings));
});

/* ---------------- cover ---------------- */
test('cover：解析封面文案的主/副', () => {
  const md = '## 封面文案（1920×1080）\n\n主：四个变量，一道门槛\n副：清单外访问，后三个变量一并作废\n';
  const c = parseCoverCopy(md);
  assert.equal(c.main, '四个变量，一道门槛');
  assert.equal(c.sub, '清单外访问，后三个变量一并作废');
});

test('cover：没有封面文案时 main 为空（调用方会报错）', () => {
  const c = parseCoverCopy('## 标题\n\n某标题\n');
  assert.equal(c.main, '');
});

/* ---------------- doctor ---------------- */
test('doctor：返回分组检查且能被报告渲染', async () => {
  const res = await doctor(null);
  assert.ok(Array.isArray(res.checks) && res.checks.length > 5);
  const groups = new Set(res.checks.map(c => c.group));
  for (const g of ['运行时', '渲染', '配音']) assert.ok(groups.has(g), '缺分组：' + g);
  const text = report(res);
  assert.match(text, /环境体检/);
});
