/* 调研摘录包：把已抓到的原文正文变成写作者能直接读的逐字片段。
 *
 * 这一层的边界必须守住，否则它会变成新的编造来源：
 *   - 只逐字截取，不改写、不总结、不推断哪条更重要；
 *   - 找不到正文时返回 available:false，由调用方保持原有简报，绝不补空；
 *   - 记录路径必须在工作台根目录内，越界直接拒绝；
 *   - 默认关闭（VH_RESEARCH_PACK），正式流程的简报文字逐字不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { researchPack, formatResearchPack, DEFAULT_PACK_CHARS } from '../lib/research-pack.mjs';
import { topicBrief, researchPackEnabled } from '../lib/schedule.mjs';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'out/topic-research'), { recursive: true });
  return root;
}

const PAGE = `# Some Paper

## Abstract

Long-horizon agents remain unreliable even as benchmark success rates climb. We argue this gap is
largely an artifact of task horizon, because production workloads demand an order of magnitude more
dependent steps. We measure 10,664 trajectories across nine models and find success follows a
geometric law governed by a single per-step reliability parameter.

## Limitations

We only tested seven open-weight models, and our sample does not cover proprietary deployments.
`;

/* 记录路径受 discovery-evidence 的固定形状约束：只接受十六进制批号，
 * 这是真实落盘格式（randomUUID），所以测试也必须用它，否则规范化会丢掉 recordPath。 */
const RECORD = 'out/topic-research/0a1b2c3d-1111-2222-3333-444455556666.json';

function writeRecord(root, pages) {
  fs.writeFileSync(path.join(root, RECORD), JSON.stringify({ version: 1, pages }, null, 2), { mode: 0o600 });
  return RECORD;
}

test('摘录逐字取自原文，且优先带机制/数字/限定的段落', t => {
  const root = tempRoot(t);
  const rel = writeRecord(root, [{ url: 'https://example.test/paper', body: PAGE }]);
  const pack = researchPack(root, rel);
  assert.equal(pack.available, true);
  assert.ok(pack.items.length >= 1);
  const joined = pack.items.map(item => item.text).join(' ');
  assert.match(joined, /geometric law governed by a single per-step reliability parameter/);
  assert.equal(pack.chars, pack.items.reduce((sum, item) => sum + item.text.length, 0));
});

test('导航/分享条不会被当成正文', t => {
  const root = tempRoot(t);
  const chrome = [
    '- [Twitter](https://twitter.com/intent/tweet?url=https%3A%2F%2Fx&text=hi)',
    '- [LinkedIn](https://www.linkedin.com/shareArticle?mini=true&url=https%3A%2F%2Fx)',
    'Skip to content. Sign in. Cookie policy applies to all rights reserved.',
  ].join('\n');
  const rel = writeRecord(root, [{ url: 'https://example.test/nav', body: chrome + '\n\n' + PAGE }]);
  const pack = researchPack(root, rel);
  assert.equal(pack.available, true);
  for (const item of pack.items) {
    assert.ok(!/twitter\.com\/intent|linkedin\.com\/share/.test(item.text), item.text.slice(0, 60));
  }
});

test('疑似重复数字和排版残留原样保留，不替原文猜测数值', t => {
  const root = tempRoot(t);
  const body = `# X

## Results

Across the full dataset of 2,0502,050 memory entries, we find at least one ToM category in 52%52\\% of
memory entries from 97% of all participants, and the effect 0\\.69 holds after adjustment.
`;
  const rel = writeRecord(root, [{ url: 'https://example.test/math', body }]);
  const pack = researchPack(root, rel);
  const text = pack.items.map(i => i.text).join(' ');
  assert.ok(text.includes('2,0502,050 memory entries'));
  assert.ok(text.includes('52%52\\% of'));
  assert.ok(text.includes('0\\.69 holds'));
  const item = pack.items[0];
  assert.equal(body.slice(item.source.start, item.source.end), item.text);
});

test('数字、负号、区间、公式及关键否定原样逐字保留（77 与 10,664 回归）', t => {
  const root = tempRoot(t);
  const quote = 'We measure 77 tasks, 10,664 trajectories, 399 settings and 0.221 mean reward. '
    + 'The slope is −0.44 versus -0.69, p=3×10⁻⁶, with 13.7% in the intersection of not recovered, '
    + 'not detected, and continued acting. Only under independence, P = r^H, not r×H. '
    + 'The interval is [−0.69, −0.44], 95% CI; LaTeX \\frac{1}{77} and \\neg R \\cap D are evidence, not formatting to erase.';
  const body = '# Results\r\n\r\n' + quote;
  const rel = writeRecord(root, [{ url: 'https://example.test/numbers', body }]);
  const pack = researchPack(root, rel);
  assert.equal(pack.items[0].text, quote);
  assert.equal(body.slice(pack.items[0].source.start, pack.items[0].source.end), quote);
});

test('多空格、换行及 CRLF 不得拼接数字或移除公式上下文', t => {
  const root = tempRoot(t);
  const body = '# Results\r\n\r\nWe find 77 tasks, not 7, because 10,664 trajectories were measured.\r\n'
    + 'Only if each step is independent: P = r ^ H; the conditional probability is  13.7%, not a product of two horizons. These conditions must remain attached to the observed result.';
  const pack = researchPack(root, writeRecord(root, [{ url: 'https://example.test/space', body }]));
  assert.equal(pack.items[0].text, body.split('\r\n\r\n')[1]);
  assert.equal(body.slice(pack.items[0].source.start, pack.items[0].source.end), pack.items[0].text);
});

test('无安全句界或二进制污染时明确跳过，不在数字/公式中间截断', t => {
  const root = tempRoot(t);
  for (const body of ['We find ' + '77 '.repeat(600), 'We find 77 tasks because of the process\0' + ' x'.repeat(120)]) {
    const pack = researchPack(root, writeRecord(root, [{ url: 'https://example.test/unsafe', body }]));
    assert.equal(pack.available, false);
    assert.match(pack.reason, /安全逐字提取/);
  }
});

test('真实历史抓取记录的每个引文均为原始正文切片，77 不再成为 7', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const record = 'diagnostics/writing-exp-round2-20261112/frozen/research/topic-record.json';
  if (!fs.existsSync(path.join(root, record))) return; // portable unit suite without local diagnostics
  const data = JSON.parse(fs.readFileSync(path.join(root, record), 'utf8'));
  const pack = researchPack(root, record);
  for (const item of pack.items) {
    const page = data.pages[item.source.pageIndex];
    assert.equal(page.body.slice(item.source.start, item.source.end), item.text);
  }
  assert.ok(pack.items.some(item => item.text.includes('77 tasks across')));
  assert.ok(pack.items.some(item => item.text.includes('10,664')));
});

test('越界路径、缺失记录、只有搜索摘要都返回不可用而不是空手编造', t => {
  const root = tempRoot(t);
  assert.equal(researchPack(root, '../../etc/passwd').available, false);
  assert.equal(researchPack(root, 'out/topic-research/missing.json').available, false);
  const rel = writeRecord(root, []);
  assert.equal(researchPack(root, rel).available, false);
  assert.match(researchPack(root, rel).reason, /没有可读到的原文正文/);
  assert.equal(formatResearchPack({ available: false }), '');
});

test('字符预算生效：超预算时截断条目数并记录 dropped', t => {
  const root = tempRoot(t);
  /* 三篇的正文段落必须在开头就不同：去重键取归一化后的前 80 字，
   * 只有标题不同、正文相同的段落会被正确判成同一段（真实调研里同一论文的
   * HTML 版与 PDF 版就是这个情形，去重是必须的）。 */
  const pages = [1, 2, 3].map(n => ({
    url: `https://example.test/${n}`,
    body: PAGE.replace('Long-horizon agents remain unreliable',
      `Cohort ${n} finds long-horizon agents unreliable in deployment ${n} and reports ${n} separate audits of agents`),
  }));
  const rel = writeRecord(root, pages);
  assert.ok(researchPack(root, rel).items.length >= 3, '三篇应各保底一条');
  const small = researchPack(root, rel, { maxChars: 900 });
  assert.ok(small.chars <= 900);
  assert.ok(small.dropped > 0);
  const big = researchPack(root, rel, { maxChars: DEFAULT_PACK_CHARS });
  assert.ok(big.items.length >= small.items.length);
});

test('摘录段标注来源与用途，并明说不能代替核实', t => {
  const root = tempRoot(t);
  const rel = writeRecord(root, [{ url: 'https://example.test/paper', body: PAGE }]);
  const block = formatResearchPack(researchPack(root, rel), { caveats: ['样本只覆盖开源模型'] });
  assert.match(block, /原文逐字摘录/);
  assert.match(block, /https:\/\/example\.test\/paper/);
  assert.match(block, /不能代替核实/);
  assert.match(block, /编辑登记的材料限定/);
  assert.match(block, /样本只覆盖开源模型/);
});

test('topicBrief 默认不含摘录；只有显式传 root 才追加', t => {
  const root = tempRoot(t);
  const rel = writeRecord(root, [{ url: 'https://example.test/paper', body: PAGE }]);
  const item = {
    topic: '测试选题', coreQuestion: '为什么', sources: ['https://example.test/paper'],
    research: {
      version: 1, kind: 'news', checkedAt: 1, selectionReason: 'r', caveats: [],
      sources: [{ url: 'https://example.test/paper', title: 't', sourceType: 'primary', quote: 'q', supports: 's', publishedAt: null, eventDate: null, eventQuote: '' }],
      recordPath: rel,
    },
  };
  const plain = topicBrief(item);
  assert.ok(!plain.includes('原文逐字摘录'), '默认必须与旧简报一致');
  const withPack = topicBrief(item, { root });
  assert.ok(withPack.includes('原文逐字摘录'));
  assert.ok(withPack.includes('geometric law'));
  assert.ok(withPack.length > plain.length);
});

test('实验开关只认显式真值，默认关闭', () => {
  assert.equal(researchPackEnabled({}), false);
  assert.equal(researchPackEnabled({ VH_RESEARCH_PACK: '' }), false);
  assert.equal(researchPackEnabled({ VH_RESEARCH_PACK: '0' }), false);
  for (const on of ['1', 'on', 'true', 'yes', 'TRUE']) assert.equal(researchPackEnabled({ VH_RESEARCH_PACK: on }), true);
});
