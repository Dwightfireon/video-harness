/* 当前默认发布台的 B 站文案约束。纯模块，供文案生成/交付检查与投稿表单共用。
 * 长度沿用投稿表单的 String.length（UTF-16 码元），不截断或改写用户内容。 */
export const BILIBILI_LIMITS = Object.freeze({ title: 80, tags: 10, tag: 20, desc: 2000 });

// 输入为已解析/规范化的公开字段；必填、占位符及平台其他参数由各调用方检查。
export function publishLimitIssues({ title, tags, desc }) {
  const issues = [], limits = BILIBILI_LIMITS;
  const issue = (code, field, message) => issues.push({ code, field, message });
  if (title.length > limits.title) issue('length', 'title', `标题 ${title.length} 字，超过 ${limits.title} 字上限`);
  if (tags.length > limits.tags) issue('count', 'tags', `标签 ${tags.length} 个，超过 ${limits.tags} 个上限`);
  if (tags.some(tag => tag.length > limits.tag)) issue('length', 'tags', `有标签超过 ${limits.tag} 字`);
  if (desc.length > limits.desc) issue('length', 'desc', `简介 ${desc.length} 字，超过 ${limits.desc} 字上限`);
  return issues;
}
