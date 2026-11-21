/* 创作者营销声明和商业报备是不同字段；porder 不能代替播放页内容标注。 */
export const MARKETING_STATEMENT_ID = 3;
export const PROMOTION_PROTOCOL_VERSION = 2;

export function marketingStatement(input) {
  return input?.enabled === true ? { id: MARKETING_STATEMENT_ID } : null;
}

// 只核对平台保存的声明，不声称观众端已经显示、审核通过或取得发布授权。
export function verifyMarketingStatement(archive) {
  const raw = archive?.creationStatementId;
  const actualId = Number.isSafeInteger(raw) ? raw : null;
  const state = actualId === null ? 'unverified' : actualId === MARKETING_STATEMENT_ID ? 'confirmed' : 'mismatch';
  return { state, expectedId: MARKETING_STATEMENT_ID, actualId, checkedAt: new Date().toISOString(),
    message: state === 'confirmed' ? '平台资料已确认「内容含营销信息」；不代表观众端已显示或审核通过。'
      : state === 'mismatch' ? '平台返回的创作者声明不是「内容含营销信息」。稿件已收下，请到创作中心人工核对，不要重发。'
        : '营销声明尚未确认：未取得有效的声明资料。稿件已收下，请到创作中心人工核对，不要重发。' };
}
export function normalizePromotion(input = {}) {
  return { enabled: input?.enabled === true,
    brandName: typeof input?.brandName === 'string' ? input.brandName.trim() : '',
    industryId: input?.industryId == null || input.industryId === '' ? null : Number(input.industryId),
    showTypes: Array.isArray(input?.showTypes) ? [...new Set(input.showTypes.map(Number))] : [] };
}

export function promotionProblems(input) {
  if (input === undefined) return [];
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean') return ['商业推广声明须为 enabled 布尔值及选填资料'];
  if (!input.enabled) return [];
  const form = normalizePromotion(input), problems = [];
  if (input.brandName != null && typeof input.brandName !== 'string') problems.push('推广品牌/网站名称须为文字');
  if (form.brandName.length > 80) problems.push('推广品牌/网站名称最多 80 字');
  if (form.industryId !== null && (!Number.isSafeInteger(form.industryId) || form.industryId <= 0)) problems.push('推广行业编号无效');
  if (input.showTypes != null && (!Array.isArray(input.showTypes) || input.showTypes.length > 50)) problems.push('推广形式须为列表（最多 50 项）');
  if (form.showTypes.some(id => !Number.isSafeInteger(id) || id <= 0)) problems.push('推广形式编号无效');
  return problems;
}

export function promotionPayload(input) {
  const form = normalizePromotion(input);
  if (!form.enabled) return null;
  // official=0 是普通推广，不冒充认证品牌，也不创建/绑定花火订单。
  const porder = { flow_id: 1, official: 0 };
  if (form.brandName) porder.brand_name = form.brandName;
  if (form.industryId !== null) porder.industry_id = form.industryId;
  if (form.showTypes.length) porder.show_type = form.showTypes.join(',');
  return porder;
}
