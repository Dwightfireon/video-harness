import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseCoverCopy,
  stripEmphasis,
  isWeakEmphasis,
  formatCoverTitle,
  formatCoverSub,
  darkenAccentForPaper,
  liftAccentForDark,
  pickCoverPalette,
  buildHtml,
} from '../lib/cover.mjs';

test('parseCoverCopy：兼容旧版主/副字段，并支持可选的强调与角标', () => {
  const legacy = parseCoverCopy('## 封面文案\n主：本地素材\n副：说明一句\n');
  assert.deepEqual(legacy, { main: '本地素材', sub: '说明一句' });

  const rich = parseCoverCopy('## 封面文案\n角标：事实核查\n主：7万星工具 / 陷**隐私争议**\n副：读登录文件 · 默认遥测 · 证据边界\n强调：隐私争议\n');
  assert.equal(rich.kicker, '事实核查');
  assert.equal(rich.main, '7万星工具 / 陷**隐私争议**');
  assert.equal(rich.sub, '读登录文件 · 默认遥测 · 证据边界');
  assert.equal(rich.emphasis, '隐私争议');
  assert.equal(stripEmphasis(rich.main), '7万星工具 / 陷隐私争议');
});

test('formatCoverTitle：优先按作者显式 **重点词** 高亮并建立两行主次字阶，不残留星号', () => {
  const res = formatCoverTitle('7万星工具 / 陷**隐私争议**');
  assert.equal(res.mode, 'explicit-inline');
  assert.deepEqual(res.highlights, ['隐私争议']);
  assert.equal(res.plain, '7万星工具\n陷隐私争议');
  assert.doesNotMatch(res.html, /\*\*/);
  assert.match(res.html, /<span class="line line-setup">7万星工具<\/span><span class="line line-hero">陷<em class="hl">隐私争议<\/em><\/span>/);

  // 第 1 行带焦点时，第 1 行为主行、第 2 行为承接
  const topFocus = formatCoverTitle('**7万星**工具 / 陷入隐私争议');
  assert.match(topFocus.html, /<span class="line line-hero"><em class="hl">7万星<\/em>工具<\/span><span class="line line-setup">陷入隐私争议<\/span>/);
});

test('formatCoverTitle：过滤虚词与整句过度标粗，避免强调错对象', () => {
  assert.equal(isWeakEmphasis('为什么'), true);
  assert.equal(isWeakEmphasis('其实'), true);
  assert.equal(isWeakEmphasis('隐私争议'), false);

  const weak = formatCoverTitle('**为什么**钱包感觉没跟上');
  assert.notEqual(weak.mode, 'explicit-inline');
  assert.deepEqual(weak.highlights, []);
  assert.doesNotMatch(weak.html, /<em class="hl">为什么<\/em>/);

  const over = formatCoverTitle('**数据说日子在变好但钱包没跟上**');
  assert.equal(over.mode, 'balanced');
  assert.deepEqual(over.highlights, []);
});

test('formatCoverTitle：支持独立「强调：」字段与克制的高置信度数字/引号兜底', () => {
  const byField = formatCoverTitle('数据说变好 / 钱包没跟上', { emphasis: '钱包没跟上' });
  assert.equal(byField.mode, 'explicit-field');
  assert.match(byField.html, /<em class="hl">钱包没跟上<\/em>/);

  const byNum = formatCoverTitle('7万星工具陷隐私争议');
  assert.equal(byNum.mode, 'auto-signal');
  assert.deepEqual(byNum.highlights, ['7万星']);
  assert.match(byNum.html, /<em class="hl">7万星<\/em>/);

  const byQuote = formatCoverTitle('拆开「暗箱」看真实账单');
  assert.equal(byQuote.mode, 'auto-signal');
  assert.deepEqual(byQuote.highlights, ['暗箱']);

  const plain = formatCoverTitle('数据说日子变好钱包没跟上');
  assert.equal(plain.mode, 'balanced');
  assert.deepEqual(plain.highlights, []);
  assert.doesNotMatch(plain.html, /<em class="hl">/);
});

test('formatCoverSub：中点分隔短词渲染为标签胶囊，完整句子渲染为竖线副标', () => {
  const chips = formatCoverSub('读登录文件 · 默认遥测 · 证据边界');
  assert.equal(chips.isChips, true);
  assert.equal((chips.html.match(/class="sub-chip"/g) || []).length, 3);

  const line = formatCoverSub('清单外访问，后三个变量一并作废');
  assert.equal(line.isChips, false);
  assert.match(line.html, /class="sub sub-line"/);
});

test('darkenAccentForPaper 与 liftAccentForDark：纸底压深亮色、深底提亮暗色', () => {
  const darkened = darkenAccentForPaper('#7BE3A4');
  assert.notEqual(darkened, '#7BE3A4');
  assert.match(darkened, /^#[0-9A-F]{6}$/);
  assert.equal(darkenAccentForPaper('#147A3A'), '#147A3A');

  const lifted = liftAccentForDark('#147A3A');
  assert.notEqual(lifted, '#147A3A');
  assert.match(lifted, /^#[0-9A-F]{6}$/);
  assert.equal(liftAccentForDark('#7BE3A4'), '#7BE3A4');
});

test('formatCoverTitle：单行含中文停顿标点的长标题自动择中拆成两行，避免断词尴尬', () => {
  const res = formatCoverTitle('软件越更越胖？**真变重了**');
  assert.equal(res.plain, '软件越更越胖？\n真变重了');
  assert.match(res.html, /<span class="line line-setup">软件越更越胖？<\/span><span class="line line-hero"><em class="hl">真变重了<\/em><\/span>/);

  const shortSingle = formatCoverTitle('证明变短了');
  assert.equal(shortSingle.plain, '证明变短了');
  assert.match(shortSingle.html, /<span class="line line-hero">证明变短了<\/span>/);
});

test('buildHtml：editorial 遵守无 bg/品牌水印契约，无 em.hl 左缩进，且正确防 XSS 转义', () => {
  const html = buildHtml({
    ratio: '16x9',
    main: '数据都在变好 / **钱包却没跟上**',
    sub: '平均数 · 固定开销 · 预期收缩',
    kicker: '机制拆解',
    accent: '#147A3A',
  });
  assert.doesNotMatch(html, /VH · 视频|class="bg"/);
  assert.match(html, /class="kicker".*机制拆解/);
  assert.match(html, /<span class="line line-setup">数据都在变好<\/span><span class="line line-hero"><em class="hl">钱包却没跟上<\/em><\/span>/);
  assert.match(html, /class="sub-chip">平均数<\/span>/);
  assert.doesNotMatch(html, /em\.hl\{[^}]*padding:/);

  const frameHtml = buildHtml({
    ratio: '16x9',
    style: 'frame',
    bg: 'file:///tmp/bg.jpg',
    main: '算力贵了 **3倍**',
    kicker: '深度拆解',
  });
  assert.match(frameHtml, /class="bg"/);
  assert.match(frameHtml, /<em class="hl">3倍<\/em>/);

  const safeHtml = buildHtml({
    ratio: '4x3',
    main: '<script>alert(1)</script>**安全**',
    kicker: '<b>tag</b>',
  });
  assert.doesNotMatch(safeHtml, /<script>/);
  assert.match(safeHtml, /&lt;script&gt;/);
  assert.match(safeHtml, /&lt;b&gt;tag&lt;\/b&gt;/);
});

test('pickCoverPalette 与精装书封排版：全系暖书纸居中对称、粗宋体、无圆角UI卡片与冗余装饰图', () => {
  const alertPal = pickCoverPalette({ main: 'AI点网页 / **卡死在付款**', kicker: '避坑实测' });
  assert.equal(alertPal.key, 'burgundy-paper');
  assert.match(alertPal.bg1, /^#FA/);

  const aiPal = pickCoverPalette({ main: '大模型记忆 / 为啥越聊越笨', kicker: 'AI拆解' });
  assert.equal(aiPal.key, 'prussian-paper');

  const mathPal = pickCoverPalette({ main: '黎曼猜想 / **3步**看懂证明思路', kicker: '硬核原理' });
  assert.equal(mathPal.key, 'cinnabar-paper');

  const html = buildHtml({
    ratio: '16x9',
    main: '**先存后解**，不是吓唬',
    sub: '量子机还没来 · 密钥先换 · 硬件最难迁',
    kicker: '原理拆解',
  });
  assert.match(html, /Songti SC/);
  assert.match(html, /class="book-frame"/);
  assert.match(html, /text-align:center/);
  assert.match(html, /class="sub-sep"/);
  assert.doesNotMatch(html, /class="deco-art"|class="side-panel"|class="focal-card"/, '保持居中精装书封纯净构图');
});
