/* lib/lexicon.mjs —— 视觉语汇库（内容 → 手法映射）
 * 单一真相：references/lexicon.md 是给人看的版本，这张表是给程序用的版本。
 * 二者必须一致（test/lexicon.test.mjs 会校验条目数）。
 */
export const LEXICON = [
  { key: 'compare-bars', when: '两个量比大小', how: '条形对比', why: '长度判断比读数字快', need: ['track', 'bar', 'value'] },
  { key: 'steps', when: '有先后 / 有依赖', how: '步骤条 · 箭头链', why: '顺序本身是信息', need: ['step', 'arrow'] },
  { key: 'before-after', when: '同一对象的不同状态', how: '左右前后对照', why: '变化要并排才可比', need: ['two-columns'] },
  { key: 'window', when: '机器里发生的事', how: '窗口 mock + 代码行', why: '真实感带来可信度', need: ['windowMock', 'codeLine'] },
  { key: 'tree', when: '边界 / 谁负责哪块', how: '文件树 + 色块', why: '空间关系省认知', need: ['tree', 'color'] },
  { key: 'field', when: '很多 / 密集 / 流动', how: '字符场 · 粒子汇聚', why: '量感要用密度表达', need: ['glyphField'] },
  { key: 'shape', when: '规模 / 比例', how: '形 + 单位', why: '单一数字配形状', need: ['bar', 'percent'] },
  { key: 'statement', when: '结论 / 判据', how: '大字 + 一句', why: '一屏只留一句', need: ['hero'] },
  { key: 'one-take', when: '同一主体、多个层次', how: '一镜到底（镜头表 + 文案交接）', why: '不切镜＝像有人在用，不是一堆截图', need: ['oneTake', 'beats'] },
];

/* 具体对象类别（vh screen 用同一套口径） */
export const OBJECT_KINDS = [
  { key: 'number', label: '数字', test: /\d/ },
  { key: 'file', label: '文件/路径', test: /\.(js|ts|tsx|py|md|json|html|css)\b|\b(src|tests|dist)\// },
  { key: 'compare', label: '对比', test: /(对比|对照|vs|VS|前后|改前|改后)/ },
  { key: 'steps', label: '步骤', test: /(①|②|③|步骤|先|然后|最后)/ },
  { key: 'example', label: '例子', test: /(例如|比如|举例|走一遍)/ },
  { key: 'chart', label: '图表', test: /(track|bar|占比|环形|chart)/ },
  { key: 'window', label: '窗口/终端', test: /(windowMock|codeLine|终端|文件树|tree)/ },
];

/* 给 agent 的压缩版提示（太长会吃 token，这里只留映射） */
export function promptHint() {
  const lines = LEXICON.map(l => `· ${l.when} → ${l.how}（${l.why}）`);
  return [
    '【画面手法：按内容选，不按喜好选】',
    ...lines,
    '· 每场至少一个"具体对象"：数字/文件/对比/步骤/例子/图表/窗口。',
    '· 禁止：只有标题+一段文字；抄旁白原句；一屏三种以上强调色。',
  ].join('\n');
}
