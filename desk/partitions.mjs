/* 投稿分区的唯一领域入口。纯数据/函数，可供 Node 和渲染层共同使用。
 * legacy-tid 是投稿接口的旧编号，不是首页频道的 tid_v2。
 * 搜索别名只帮助查找，不重命名官方分区、不推测两套编号的映射。 */
export const PARTITION_TAXONOMY = 'legacy-tid';
export const HUMAN_PARTITION_TAXONOMY = 'human-type2';
export const PARTITION_SOURCE = 'https://member.bilibili.com/x/vupre/web/archive/pre';
export const HUMAN_PARTITION_SOURCE = 'https://member.bilibili.com/x/vupre/web/archive/human/type2/list';
// 官方客户端在 type_mode 启用且没有旧 tid 时填 21。它是协议兼容值，不是新版分区映射。
export const HUMAN_COMPAT_TID = 21;
export const PARTITION_CHECKED_AT = '2026-10-28';
export const AI_CHANNEL_URL = 'https://www.bilibili.com/c/ai/';

// 2026-10-28 从上述投稿接口核对的常用叶子分区。仅供离线浏览，提交必须核对实时列表。
export const FALLBACK_PARTITIONS = Object.freeze([
  { id: 231, name: '计算机技术', parent: '科技', description: '软硬件开发/人工智能/大数据/深度学习/IT运维等' },
  { id: 230, name: '软件应用', parent: '科技', description: '围绕各类系统软件、应用软件、网站的相关视频' },
  { id: 95, name: '数码', parent: '科技', description: '手机/电脑/相机/影音智能设备等' },
  { id: 201, name: '科学科普', parent: '知识', description: '以自然科学或基于自然科学思维展开的知识视频' },
  { id: 207, name: '财经商业', parent: '知识', description: '财经/商业/经济金融/互联网等' },
  { id: 208, name: '校园学习', parent: '知识', description: '学习方法及经验、课程教学、校园干货分享等' },
  { id: 182, name: '影视杂谈', parent: '影视', description: '影视评论、解说、吐槽、科普、配音等' },
  { id: 183, name: '影视剪辑', parent: '影视', description: '对影视素材进行剪辑再创作的视频' },
  { id: 259, name: 'AI影像', parent: '影视', description: '分享AI制作的影像作品、创作历程、技术风向' },
  { id: 265, name: 'AI音乐', parent: '音乐', description: '以AI合成技术为基础，运用各类工具进行创作的AI音乐' },
  { id: 17, name: '单机游戏', parent: '游戏', description: '以单机或其联机模式为主要内容的相关视频' },
  { id: 171, name: '电子竞技', parent: '游戏', description: '电子竞技游戏项目为主要内容的相关视频' },
].map(Object.freeze));

export const FALLBACK_HUMAN_PARTITIONS = Object.freeze([
  { id: 1011, name: '人工智能', parent: '', description: '' },
  { id: 1010, name: '知识', parent: '', description: '' },
  { id: 1012, name: '科技数码', parent: '', description: '' },
  { id: 1029, name: 'vlog', parent: '', description: '' },
].map(Object.freeze));

export function offlinePartitions(reason = '当前显示离线参考清单；提交前须取得实时分区', taxonomy = PARTITION_TAXONOMY) {
  const human = taxonomy === HUMAN_PARTITION_TAXONOMY;
  return { list: (human ? FALLBACK_HUMAN_PARTITIONS : FALLBACK_PARTITIONS).map(item => ({ ...item })), live: false,
    taxonomy, source: human ? HUMAN_PARTITION_SOURCE : PARTITION_SOURCE, checkedAt: PARTITION_CHECKED_AT, reason };
}

// 新版是独立的单层列表，不交给旧版“父级→叶子”解析器，不伪造子分类或旧新版映射。
export function flattenHumanPartitions(data) {
  const list = data?.type_list;
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.flatMap(item => {
    const id = Number(item?.id), name = String(item?.name || '').trim();
    if (partitionIdProblems(id, HUMAN_PARTITION_TAXONOMY).length || !name || item.show === false || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name, parent: '', description: String(item.description || '').trim() }];
  });
}

export function flattenPartitions(data) {
  const out = [], seen = new Set();
  const childrenOf = node => node?.children ?? node?.sub ?? node?.child ?? node?.list ?? node?.subs;
  const walk = (nodes, parentName = '') => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== 'object' || node.show === false) continue;
      const children = childrenOf(node);
      const id = Number(node.id ?? node.tid);
      const name = String(node.name ?? node.title ?? '').trim();
      // 空 children 可出现在真正的二级叶子上；顶级空容器则不可投稿。
      if (Array.isArray(children) && children.length) { walk(children, id === 0 ? parentName : name || parentName); continue; }
      if (Array.isArray(children) && !parentName && !(Number(node.parent) > 0)) continue;
      if (!Number.isInteger(id) || id <= 0 || !name || seen.has(id)) continue;
      // 显式 parent=0 的顶级分类不属于二级投稿分区；缺 parent 的旧扁平响应保持兼容。
      if (!parentName && node.parent != null && Number(node.parent) === 0) continue;
      seen.add(id);
      out.push({ id, name, parent: parentName || String(node.parent_name || '').trim(),
        description: String(node.description || node.desc || '').trim() });
    }
  };
  walk(Array.isArray(data) ? data : data?.typelist ?? data?.list ?? data?.data?.typelist ?? []);
  return out;
}

export function partitionLabel(item) {
  return item ? `${item.parent ? item.parent + ' · ' : ''}${item.name}（${item.id}）` : '未选择';
}

function aliases(item) {
  // 检索提示，不是官方分区映射；不把 AI音乐、AI影像误当 Agent 技术分区。
  if (item.name === '人工智能') return ['ai', 'agent', '智能体', 'llm', '大模型'];
  if (item.name === '知识') return ['计算机科学', '编程', '算法'];
  const text = `${item.name} ${item.description || ''}`;
  return /人工智能|计算机技术|计算机科学/.test(text)
    ? ['ai', 'agent', '智能体', '人工智能', '计算机科学', 'llm', '大模型'] : [];
}

export function searchPartitions(list, keyword = '') {
  const query = String(keyword).trim().toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  return list.filter(item => {
    const haystack = [item.name, item.parent, item.description, item.id, ...aliases(item)].join(' ').toLowerCase();
    return tokens.every(token => haystack.includes(token));
  }).sort((a, b) => {
    // 搜 AI/Agent 时先给技术分区，仍保留其他含 AI 的真实分区。
    const score = item => /^(ai|agent|智能体|人工智能|计算机科学|llm|大模型)$/.test(query) && aliases(item).length ? 1 : 0;
    return score(b) - score(a);
  });
}

export function partitionIdProblems(tid, taxonomy = PARTITION_TAXONOMY) {
  const id = Number(tid);
  if (!Number.isInteger(id) || id <= 0) return ['没有选择分区'];
  if (taxonomy === HUMAN_PARTITION_TAXONOMY) return id < 1000 ? ['旧投稿 tid 不能作为新版 human_type2，请刷新并重新选择分区'] : [];
  if (taxonomy !== PARTITION_TAXONOMY) return ['无法识别投稿分区模式，请刷新分区'];
  if (id >= 1000) return ['新版分区编号应填写 human_type2，不能作为旧投稿 tid；请刷新并重新选择分区'];
  return [];
}

export function validatePartition(tid, catalog) {
  const problems = partitionIdProblems(tid, catalog?.taxonomy);
  if (problems.length) return problems;
  const id = Number(tid);
  if (!catalog?.live) return ['尚未取得实时投稿分区，请登录并刷新分区后再提交'];
  if (!catalog.list?.some(item => item.id === id)) return ['所选分区不在当前账号的实时投稿列表中，请重新选择'];
  return [];
}

export function formPartition(input) {
  const taxonomy = input?.partitionTaxonomy ?? PARTITION_TAXONOMY;
  return { taxonomy, id: taxonomy === HUMAN_PARTITION_TAXONOMY ? input?.humanType2 : input?.tid };
}

export function validateSelection(input, catalog) {
  const { taxonomy, id } = formPartition(input);
  if (catalog?.live && taxonomy !== catalog.taxonomy) return ['账号的分区模式已变化，请刷新分区并重新选择，不会自动转换编号'];
  return validatePartition(id, catalog);
}

export function partitionAdvice(item, taxonomy = PARTITION_TAXONOMY) {
  if (taxonomy === HUMAN_PARTITION_TAXONOMY) {
    if (!item) return '新版投稿分区：AI／Agent、智能体、大模型讲解与开发可选「人工智能」。分类来自当前账号接口，不需要再选旧版计算机技术。';
    if (item.name === '人工智能') return '适合 AI／Agent、智能体、大模型的学习、原理、开发与资讯。将以 human_type2 提交「人工智能」，不会把 1011 填入旧 tid。';
    if (item.name === '知识') return '一般编程、算法或计算机课程等知识内容可考虑这里；主要讲 AI／Agent 时优先考虑「人工智能」。';
    if (item.name === '科技数码') return '以电脑、手机等科技数码产品为主可考虑这里；AI／Agent 技术主题优先考虑「人工智能」。';
    return '按视频的主要内容选择。这里是新版投稿分区，不是旧版二级分区。';
  }
  if (!item) return '讲 AI／Agent 原理、开发、工具使用：当前旧投稿列表通常选「科技 · 计算机技术」。新版首页另有「人工智能」频道，两套编号不可混用。';
  if (/计算机技术|计算机科学/.test(item.name)) return '适合 Agent、智能体、大模型原理与开发。这里是旧投稿分区；不能据此保证新版首页频道的归属。';
  if (/AI影像|AI影视/.test(item.name)) return '面向 AI 影像作品、创作历程与相关技术；讲 Agent／大模型的一般技术视频更适合计算机技术，不要只因用了 AI 制作就选这里。';
  if (/AI音乐/.test(item.name)) return '面向 AI 音乐创作，不适合一般 Agent 技术解说。';
  if (item.name === '软件应用') return '适合软件使用、操作教程与测评；以 Agent 原理或开发为主可优先考虑计算机技术。';
  return item.description || '按视频的主要内容选择，不按制作时用了什么工具选择。';
}
