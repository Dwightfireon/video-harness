/* 纯请求规则：不读磁盘、不启动进程、不依赖 HTTP 或模型。 */
function invalid(message) { throw Object.assign(new Error(message), { statusCode: 400 }); }

export function resolveDiscoveryScope(input, history) {
  const operation = input.operation || 'questions';
  if (!['questions', 'research'].includes(operation)) invalid('选题操作只能是 questions 或 research');
  if (operation === 'research') {
    if (input.followupId != null || input.followup != null) invalid('调查与继续探索不能同时执行');
    const target = typeof input.topicId === 'string' ? history.find(item => item.id === input.topicId) : null;
    if (!target) invalid('待调查的选题不存在');
    return { operation, topicId: target.id, query: target.query || target.subject || target.topic, count: 1, mode: input.mode || 'focused', base: target };
  }
  if (input.topicId != null) invalid('topicId 只用于调查');
  if (input.followupId == null) {
    if (input.followup != null) invalid('继续探索需指定原题');
    return { operation, query: input.query, count: input.count, mode: input.mode, base: null };
  }
  const base = typeof input.followupId === 'string' ? history.find(item => item.id === input.followupId) : null;
  if (!base) invalid('继续探索的选题不存在');
  if (!['deeper', 'different'].includes(input.followup)) invalid('继续探索方式无效');
  return { operation, query: base.query || base.subject || base.topic, count: 1, mode: input.mode || 'focused', base };
}

export function prepareDiscoveryRequest(input, config = {}, history = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('搜索参数必须是对象');
  if (input.query != null && (typeof input.query !== 'string' || input.query.length > 1000)) invalid('检索方向最多 1000 字');
  if (input.mode != null && !['focused', 'explore'].includes(input.mode)) invalid('探索模式无效');
  if (input.count != null && (!Number.isInteger(input.count) || input.count < 1 || input.count > 10)) invalid('每批候选数需为 1–10');
  const scope = resolveDiscoveryScope({ ...input,
    query: input.query || config.query || null, count: input.count || config.count || null,
    mode: input.mode || (input.followupId != null ? 'focused' : config.mode) || 'focused',
  }, history);
  return { operation: scope.operation, topicId: scope.topicId, query: scope.query, count: scope.count, mode: scope.mode,
    model: config.model || null, agent: config.agent || null, timeoutMs: config.timeoutMs || null,
    followupId: input.followupId, followup: input.followup };
}
