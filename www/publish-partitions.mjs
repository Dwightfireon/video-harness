/* 发布台分区筛选与说明（纯函数，无 DOM / 网络依赖）。
 * 只做展示辅助，不改动后端下发的分区编号、模式或校验规则。 */

function aliases(item) {
  if (item.name === '人工智能') return ['ai', 'agent', '智能体', 'llm', '大模型'];
  if (item.name === '知识') return ['计算机科学', '编程', '算法'];
  const text = `${item.name} ${item.description || ''}`;
  return /人工智能|计算机技术|计算机科学/.test(text)
    ? ['ai', 'agent', '智能体', '人工智能', '计算机科学', 'llm', '大模型'] : [];
}

export function filterPartitions(list, keyword = '') {
  const items = Array.isArray(list) ? list : [];
  const query = String(keyword || '').trim().toLowerCase();
  if (!query) return items;
  const tokens = query.split(/\s+/).filter(Boolean);
  return items.filter(item => {
    const haystack = [item.name, item.parent, item.description, item.id, ...aliases(item)].join(' ').toLowerCase();
    return tokens.every(token => haystack.includes(token));
  }).sort((a, b) => {
    const score = item => /^(ai|agent|智能体|人工智能|计算机科学|llm|大模型)$/.test(query) && aliases(item).length ? 1 : 0;
    return score(b) - score(a);
  });
}

export function partitionStatusHint(catalog) {
  if (!catalog) return '';
  const mode = catalog.human ? '新版分区' : '旧版分区';
  return catalog.live === false ? `离线参考（${mode}，请登录后刷新）` : `实时 · ${mode}`;
}

export function partitionGuidance(item, catalog) {
  const prefix = catalog?.live === false ? '当前为离线参考分区，提交前请先登录 B 站并点击右上角「刷新」。' : '';
  const join = text => prefix ? `${prefix} ${text}` : text;
  if (catalog?.human) {
    if (!item) return join('新版分区：AI / Agent / 大模型可选「人工智能」，通用教程/科普可选「知识」，软硬件产品可选「科技数码」。');
    if (item.name === '人工智能') return join('适合 AI / Agent、大模型原理、开发与行业解读。');
    if (item.name === '知识') return join('适合科普、课程、编程与方法论；若核心主题是 AI / Agent，可优先选「人工智能」。');
    if (item.name === '科技数码') return join('适合电脑、手机与数码硬件；若核心主题是 AI 技术，可优先选「人工智能」。');
    return join(item.description || '按视频核心内容选择对应的新版分区。');
  }
  if (!item) return join('旧版分区：AI / Agent / 编程通常选「科技 · 计算机技术」，软件使用选「科技 · 软件应用」，泛科普选「知识 · 科学科普」。');
  if (/计算机技术|计算机科学/.test(item.name)) return join(item.description || '适合 AI / Agent、大模型原理、编程与开发技术内容。');
  if (/AI影像|AI影视/.test(item.name)) return join('面向 AI 生成影视作品与创作流程；一般 AI / Agent 科普或技术讲解更适合「计算机技术」。');
  if (/AI音乐/.test(item.name)) return join('面向 AI 音乐作品创作，不适合一般技术或科普解说。');
  if (item.name === '软件应用') return join(item.description || '适合工具测评与操作教程；偏原理或开发可优先选「计算机技术」。');
  return join(item.description || '按视频核心主题选择分区，不按制作工具选择。');
}
