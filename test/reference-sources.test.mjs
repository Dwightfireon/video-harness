import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeUrl, arxivUrl, linksInLine, scriptSources, collectReferences,
  appendReferencesToCopy } from '../lib/reference-sources.mjs';
import { referenceText, mergeIntoDescription } from '../lib/reference-format.mjs';

function project(t, { script = '', copy = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-refs-'));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  if (script) fs.writeFileSync(path.join(dir, '脚本.md'), script);
  if (copy) fs.writeFileSync(path.join(dir, '发布文案.md'), copy);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SOURCES_BLOCK = `# 脚本

## S1 · 开场

1. 第一句。

## 数字与来源

- 2026-02-09 启动测试 → OpenAI《在 ChatGPT 中测试广告》，openai.com/index/testing-ads-in-chatgpt/
- 71.9% 带广告卡 → LLM Pulse 抽样，llmpulse.ai/blog/ads
- 实验部分 → Wu 等《Ads in AI Chatbots?》，arXiv:2604.08525v3（COLM 2026）
`;

test('URL 归一：裸域名补 https，非法值返回 null', () => {
  assert.equal(normalizeUrl('openai.com/index/x'), 'https://openai.com/index/x');
  assert.equal(normalizeUrl('https://a.test/b'), 'https://a.test/b');
  assert.equal(normalizeUrl('不是链接'), null);
  assert.equal(normalizeUrl('v1.2'), null, '版本号不是域名');
  assert.equal(normalizeUrl(''), null);
});

test('arXiv 编号转摘要页，允许版本号', () => {
  assert.equal(arxivUrl('arXiv:2604.08525v3'), 'https://arxiv.org/abs/2604.08525');
  assert.equal(arxivUrl('arXiv:2409.15436'), 'https://arxiv.org/abs/2409.15436');
  assert.equal(arxivUrl('2604.08525'), null);
});

test('一行里同时有普通链接与 arXiv 编号时都能取到', () => {
  const links = linksInLine('→ 某文，openai.com/a；另一篇 arXiv:2604.08525v3（COLM 2026）');
  const urls = links.map(l => l.url);
  assert.ok(urls.includes('https://openai.com/a'));
  assert.ok(urls.includes('https://arxiv.org/abs/2604.08525'));
});

test('同一行里重复链接只取一次', () => {
  const links = linksInLine('openai.com/a 和 https://openai.com/a');
  assert.equal(new Set(links.map(l => l.url)).size, links.length);
});

test('从脚本「数字与来源」提取，断言部分不进 label', t => {
  const dir = project(t, { script: SOURCES_BLOCK });
  const sources = scriptSources(dir);
  assert.equal(sources.length, 3);
  const first = sources.find(s => s.url.includes('testing-ads'));
  assert.ok(!first.label.includes('2026-02-09'), '断言不该出现在参考标题里');
  assert.match(first.label, /OpenAI/);
});

test('没有「数字与来源」小节时返回空，不报错', t => {
  const dir = project(t, { script: '# 脚本\n\n## S1 · 开场\n\n1. 一句话。\n' });
  assert.deepEqual(scriptSources(dir), []);
  assert.deepEqual(collectReferences(dir), []);
});

test('参考段落格式：标题 + 链接成对', () => {
  const text = referenceText([{ url: 'https://a.test/x', label: '某来源' }]);
  assert.match(text, /^参考资料/);
  assert.match(text, /· 某来源\nhttps:\/\/a\.test\/x/);
});

test('合并简介：超限时逐条减少，不截断单条链接', () => {
  const sources = Array.from({ length: 6 }, (_, i) => ({ url: `https://a.test/${i}`, label: '来源' + i }));
  const desc = '短简介';
  const wide = mergeIntoDescription(desc, sources, { limit: 2000 });
  assert.equal(wide.added, 6);
  const tight = mergeIntoDescription(desc, sources, { limit: 120 });
  assert.ok(tight.added < 6);
  assert.equal(tight.dropped, 6 - tight.added);
  // 每条都必须是完整链接，不能出现半条
  for (const line of tight.text.split('\n')) {
    if (line.startsWith('https://')) assert.match(line, /^https:\/\/a\.test\/\d+$/);
  }
});

test('写回发布文案：只动简介一节，其它小节原样', t => {
  const copy = '# 发布文案\n\n## 标题\n\n标题甲\n\n## 简介\n\n正文一段。\n\n## 标签\n\nAI\n';
  const dir = project(t, { script: SOURCES_BLOCK, copy });
  const result = appendReferencesToCopy(dir);
  assert.equal(result.ok, true);
  assert.equal(result.added, 3);
  const md = fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8');
  assert.match(md, /标题甲/);
  assert.match(md, /正文一段。/);
  assert.match(md, /参考资料/);
  assert.match(md, /## 标签\n\nAI/);
});

test('写回是幂等的：重复调用不会叠出第二份参考段落', t => {
  const copy = '# 发布文案\n\n## 简介\n\n正文。\n\n## 标签\n\nAI\n';
  const dir = project(t, { script: SOURCES_BLOCK, copy });
  assert.equal(appendReferencesToCopy(dir).added, 3);
  const second = appendReferencesToCopy(dir);
  assert.equal(second.added, 0);
  assert.equal(second.reason, 'already-present');
  const md = fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8');
  assert.equal((md.match(/参考资料/g) || []).length, 1);
});

test('没有来源时不写文件', t => {
  const copy = '# 发布文案\n\n## 简介\n\n正文。\n';
  const dir = project(t, { script: '# 脚本\n\n## S1\n\n1. 一句话。\n', copy });
  const before = fs.statSync(path.join(dir, '发布文案.md')).mtimeMs;
  const result = appendReferencesToCopy(dir);
  assert.equal(result.added, 0);
  assert.equal(fs.statSync(path.join(dir, '发布文案.md')).mtimeMs, before);
});

test('没有发布文案时安全返回，不创建文件', t => {
  const dir = project(t, { script: SOURCES_BLOCK });
  const result = appendReferencesToCopy(dir);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-copy');
  assert.ok(!fs.existsSync(path.join(dir, '发布文案.md')));
});

test('claims.json 与脚本来源合并去重', t => {
  const dir = project(t, { script: SOURCES_BLOCK });
  fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify([{
    id: 'C1', assertion: '测试', kind: '外部事实', sourceType: 'external',
    evidence: [{ url: 'https://openai.com/index/testing-ads-in-chatgpt/', title: '官方公告' }],
  }]));
  const merged = collectReferences(dir);
  const urls = merged.map(m => m.url);
  assert.equal(new Set(urls).size, urls.length, '不应有重复');
  const official = merged.find(m => m.url.includes('testing-ads'));
  assert.equal(official.label, '官方公告', 'claims.json 的标题优先');
});

/* 脚本的「数字与来源」常写成表格，出处只写机构名和时间，不放 URL。
 * 真正的链接在 research/ 里。只看脚本会得到 0 条——真实发生过。 */
import { researchSources } from '../lib/reference-sources.mjs';

const RESEARCH_MD = `# 调研资料

## 一、分母

### 1. Google 官方：一年超过 5 万亿次搜索（已读到原文）
- 出处：Search Engine Land, 2025-03-03
  https://searchengineland.com/google-5-trillion-452928
- 旁证：https://business.google.com/think/takeaways/

### 2. 仅二手转述的条目
- 见 https://unreliable.example/thread

## 二、分子

### 3. Ahrefs 2026-02-11（已抓到全文）
- 出处：https://ahrefs.com/blog/chatgpt-search-volume
`;

test('从 research/ 提取：每条小标题只取第一个链接', t => {
  const dir = project(t, { script: '# 脚本\n\n## S1\n\n1. 一句话。\n' });
  fs.mkdirSync(path.join(dir, 'research'));
  fs.writeFileSync(path.join(dir, 'research/资料.md'), RESEARCH_MD);
  const sources = researchSources(dir);
  const urls = sources.map(s => s.url);
  assert.ok(urls.includes('https://searchengineland.com/google-5-trillion-452928'));
  assert.ok(urls.includes('https://ahrefs.com/blog/chatgpt-search-volume'));
  // 第一条小标题下的旁证不该进清单
  assert.ok(!urls.includes('https://business.google.com/think/takeaways/'));
});

test('research 里标为「仅二手转述」的条目不作为公开来源', t => {
  const dir = project(t, { script: '# 脚本\n\n## S1\n\n1. 一句话。\n' });
  fs.mkdirSync(path.join(dir, 'research'));
  fs.writeFileSync(path.join(dir, 'research/资料.md'), RESEARCH_MD);
  const urls = researchSources(dir).map(s => s.url);
  assert.ok(!urls.includes('https://unreliable.example/thread'));
});

test('label 去掉「已读到原文」「已抓到全文」这类核证过程说明', t => {
  const dir = project(t, { script: '# 脚本\n\n## S1\n\n1. 一句话。\n' });
  fs.mkdirSync(path.join(dir, 'research'));
  fs.writeFileSync(path.join(dir, 'research/资料.md'), RESEARCH_MD);
  const sources = researchSources(dir);
  const google = sources.find(s => s.url.includes('searchengineland'));
  assert.equal(google.label, 'Google 官方：一年超过 5 万亿次搜索');
  assert.doesNotMatch(google.label, /已读到原文/);
});

test('脚本没有 URL、research 有时，仍然能收集到参考链接', t => {
  const dir = project(t, {
    script: '# 脚本\n\n## 数字与来源\n\n| 数字 | 出处 |\n|---|---|\n| 5 万亿 | Google 博文 2025-01 |\n',
  });
  fs.mkdirSync(path.join(dir, 'research'));
  fs.writeFileSync(path.join(dir, 'research/资料.md'), RESEARCH_MD);
  assert.equal(collectReferences(dir).length >= 2, true);
});

test('research 与脚本有同一个链接时只保留一条', t => {
  const dir = project(t, {
    script: '# 脚本\n\n## 数字与来源\n\n- 官方 → openai.com/index/x\n',
  });
  fs.mkdirSync(path.join(dir, 'research'));
  fs.writeFileSync(path.join(dir, 'research/资料.md'),
    '### 1. 同一条\n- 出处：https://openai.com/index/x\n');
  const urls = collectReferences(dir).map(s => s.url);
  assert.equal(urls.filter(u => u === 'https://openai.com/index/x').length, 1);
});

/* 入队时保存的 materials/选题.md 里带着检索来源，但项目没有 claims.json、
 * 脚本也没写 URL 时，旧实现完全不读它 —— 真实片子的简介因此一条链接都没有。 */
import { materialSources } from '../lib/reference-sources.mjs';

test('从 materials 的「检索来源」取链接：常见三种写法都识别', t => {
  const dir = project(t, { script: '# 脚本\n\n## S1\n\n1. 一句话。\n' });
  fs.mkdirSync(path.join(dir, 'materials'));
  fs.writeFileSync(path.join(dir, 'materials/选题.md'),
    '题目：某题\n\n检索来源（待阅读核对，不代表已核实）：\n\n' +
    '- https://www.nature.com/articles/s41591-026-04297-7\n' +
    '- doi:10.1038/s41591-026-04297-7\n' +
    '- 10.21203/rs.3.rs-9988886/v1\n' +
    '- https://pmc.ncbi.nlm.nih.gov/articles/PMC13190235/\n');
  const urls = materialSources(dir).map(item => item.url);
  assert.ok(urls.includes('https://www.nature.com/articles/s41591-026-04297-7'));
  assert.ok(urls.includes('https://doi.org/10.1038/s41591-026-04297-7'), 'doi: 前缀要转成可点链接');
  assert.ok(urls.includes('https://doi.org/10.21203/rs.3.rs-9988886/v1'), '裸 DOI 也要识别');
  assert.ok(urls.includes('https://pmc.ncbi.nlm.nih.gov/articles/PMC13190235/'));
});

test('materials 只读「检索来源」段，不读正文里的其他链接', t => {
  const dir = project(t, { script: '# 脚本\n\n## S1\n\n1. 一句话。\n' });
  fs.mkdirSync(path.join(dir, 'materials'));
  fs.writeFileSync(path.join(dir, 'materials/选题.md'),
    '题目：某题\n\n参考 https://noise.example/intro\n\n检索来源：\n- https://kept.example/paper\n');
  const urls = materialSources(dir).map(item => item.url);
  assert.deepEqual(urls, ['https://kept.example/paper']);
});

test('没有 materials 目录时返回空数组，不抛错', t => {
  const dir = project(t, { script: '# 脚本\n\n## S1\n\n1. 一句话。\n' });
  assert.deepEqual(materialSources(dir), []);
});

test('同一篇论文的 doi 与出版方页面合并成一条，保留 DOI 并借用可读标题', t => {
  const dir = project(t, { script: '# 脚本\n\n## S1\n\n1. 一句话。\n' });
  fs.mkdirSync(path.join(dir, 'materials'));
  fs.writeFileSync(path.join(dir, 'materials/选题.md'),
    '检索来源：\n- https://www.nature.com/articles/s41591-026-04297-7\n- doi:10.1038/s41591-026-04297-7\n');
  const sources = collectReferences(dir);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, 'https://doi.org/10.1038/s41591-026-04297-7');
  assert.match(sources[0].label, /nature\.com/);
});

test('不同站点的同名末段不合并，普通页面保持两条', t => {
  const dir = project(t, { script: '# 脚本\n\n## S1\n\n1. 一句话。\n' });
  fs.mkdirSync(path.join(dir, 'materials'));
  fs.writeFileSync(path.join(dir, 'materials/选题.md'),
    '检索来源：\n- https://a.test/x/report\n- https://b.test/y/report\n');
  assert.equal(collectReferences(dir).length, 2);
});

test('doi.org 链接与裸 DOI 视为同一条，简介里不重复添加', t => {
  const copy = '# 发布文案\n\n## 简介\n\n正文。\n';
  const dir = project(t, { copy });
  fs.mkdirSync(path.join(dir, 'materials'));
  fs.writeFileSync(path.join(dir, 'materials/选题.md'),
    '检索来源：\n- https://doi.org/10.1038/s41591-026-04297-7\n- 10.1038/s41591-026-04297-7\n');
  const first = appendReferencesToCopy(dir);
  assert.equal(first.added, 1);
  assert.equal(appendReferencesToCopy(dir).reason, 'already-present');
});

/* 写入实现只有 reference-write 一处：claims 路径与脚本路径共用标题和上限。 */
test('claims 路径与脚本路径共用同一标题，且不会写出两段参考资料', async t => {
  const copy = '# 发布文案\n\n## 简介\n\n正文。\n';
  const dir = project(t, { script: SOURCES_BLOCK, copy });
  fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify([{
    id: 'C1', kind: '外部事实', sourceType: 'external',
    evidence: [{ url: 'https://openai.com/index/testing-ads-in-chatgpt/', title: '官方公告' }],
  }]));
  const { appendClaimReferences: appendReferences } = await import('../lib/reference-sources.mjs');
  appendReferences(dir);
  appendReferencesToCopy(dir);
  const md = fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8');
  assert.equal((md.match(/参考资料/g) || []).length, 1, '不能写出两段参考资料');
  assert.doesNotMatch(md, /片中数字的出处/);
});

test('简介超过 2000 字上限时整条丢弃并报数，不截断链接', t => {
  const long = '简'.repeat(1980);
  const copy = `# 发布文案\n\n## 简介\n\n${long}\n`;
  const dir = project(t, { script: SOURCES_BLOCK, copy });
  const result = appendReferencesToCopy(dir);
  assert.equal(result.ok, true);
  assert.equal(result.added, 0);
  assert.equal(result.reason, 'no-room');
  assert.ok(result.dropped > 0);
  const md = fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8');
  assert.equal(md.includes('https://'), false);
  assert.ok(md.includes(long));
});

test('已有参考段落时追加进同一段，不另起标题也不越过条数上限', async t => {
  const copy = '# 发布文案\n\n## 简介\n\n正文。\n\n参考资料\n\n· 来源甲\nhttps://a.example/x\n\n## 标签\n\nAI\n';
  const dir = project(t, { script: SOURCES_BLOCK, copy });
  const result = appendReferencesToCopy(dir);
  assert.equal(result.ok, true);
  const md = fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8');
  assert.equal((md.match(/^参考资料$/gm) || []).length, 1, '不能出现两个参考资料标题');
  assert.match(md, /https:\/\/a\.example\/x/);
  assert.match(md, /## 标签/);
});

test('追加后仍守住 2000 字：宁可少放，也不截断链接', async t => {
  const long = '简'.repeat(1900);
  const copy = `# 发布文案\n\n## 简介\n\n${long}\n\n参考资料\n\n· 已有\nhttps://existing.example/x\n`;
  const dir = project(t, { script: SOURCES_BLOCK, copy });
  const result = appendReferencesToCopy(dir);
  assert.equal(result.ok, true);
  assert.ok(result.dropped > 0);
  const md = fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8');
  assert.match(md, /https:\/\/existing\.example\/x/, '已有链接不能被裁掉');
  for (const url of result.urls || []) assert.match(md, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

/* 全流程：只有 materials 有来源时，go/pack 用的自动补链接也要生效并报到。
 * 直接调用编排层的同一个函数，不启动渲染。 */
import { execFileSync } from 'node:child_process';
const ROOT = new URL('../', import.meta.url).pathname;

test('只有 materials 有来源时，vh refs --append 能写入并报出条数', t => {
  const copy = '# 发布文案\n\n## 简介\n\n正文。\n';
  const dir = project(t, { script: '# 脚本\n\n## S1\n\n1. 一句。\n', copy });
  fs.mkdirSync(path.join(dir, 'materials'));
  fs.writeFileSync(path.join(dir, 'materials/选题.md'), '检索来源：\n- doi:10.1038/s41591-026-04297-7\n');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'vh.mjs'), 'refs', '--append', '--dir', dir], { encoding: 'utf8' });
  assert.match(out, /已把 1 条来源链接追加到简介末尾/);
  const md = fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8');
  assert.match(md, /https:\/\/doi\.org\/10\.1038\/s41591-026-04297-7/);
  assert.match(md, /正文。/);
});

test('没有可收集来源时，命令明确说明四个来源都没有链接', t => {
  const copy = '# 发布文案\n\n## 简介\n\n正文。\n';
  const dir = project(t, { script: '# 脚本\n\n## S1\n\n1. 一句。\n', copy });
  let failed = null;
  try { execFileSync(process.execPath, [path.join(ROOT, 'vh.mjs'), 'refs', '--dir', dir], { encoding: 'utf8' }); }
  catch (error) { failed = error; }
  assert.ok(failed, '没有来源时应以非零退出');
  assert.match(String(failed.stdout || '') + String(failed.stderr || ''), /没有可公开引用的来源.*materials/);
});

/* 程序自动补完参考链接后，版本回执按 system 重新关联：
 * 不冒充人工核对，也不让一次确定性写入把文案长期显示成"有手动修改"。 */
test('system 关联：补完链接后状态为 current，并保留确认来源', async t => {
  const copy = '# 发布文案\n\n## 简介\n\n正文。\n';
  const dir = project(t, { script: '# 脚本\n\n## S1\n\n1. 一句。\n', copy });
  fs.mkdirSync(path.join(dir, 'materials'));
  fs.writeFileSync(path.join(dir, 'materials/选题.md'), '检索来源：\n- doi:10.1038/s41591-026-04297-7\n');
  const { confirmPublishRevision, publishRevision, checkPublish } = await import('../lib/publish.mjs');
  const { appendReferencesToCopy } = await import('../lib/reference-sources.mjs');
  const { writeFileSync, readFileSync } = fs;
  writeFileSync(path.join(dir, '脚本.md'), '# 脚本\n\n## S1\n\n1. 一句。\n');
  writeFileSync(path.join(dir, '发布文案.md'), '# 发布文案\n\n## 标题\n\n标题\n\n## 简介\n\n正文。\n\n## 置顶评论\n\n评论。\n\n## 标签\n\nAI\n\n## 封面文案\n\n主：甲\n副：乙\n');
  appendReferencesToCopy(dir);
  assert.equal(publishRevision(dir).state, 'untracked');
  const current = publishRevision(dir);
  confirmPublishRevision(dir, { sourceSignature: current.sourceSignature, publishHash: current.publishHash, by: 'system' });
  const after = publishRevision(dir);
  assert.equal(after.state, 'current');
  assert.equal(after.confirmedBy, 'system');
  assert.equal(checkPublish(readFileSync(path.join(dir, '发布文案.md'), 'utf8')).ok, true);
});
