/* 只在隔离测试中模拟 CLI 工具事件；不联网，也不把真实模型输出伪装成已验证。 */
import { sourceURLs } from '../../lib/schedule.mjs';

export function discoveryFixtureEvents(candidates) {
  const today = new Date().toISOString().slice(0, 10);
  const quote = '这是一份仅供自动测试使用的原文材料，完整描述了具体任务、实际处理过程、观察到的结果，以及证据适用的条件和限制，不代表任何真实新闻。';
  const enriched = (Array.isArray(candidates) ? candidates : []).map(item => ({ ...item,
    kind: item.kind || 'evergreen', selectionReason: item.selectionReason || '材料提供具体任务和过程，适合解释使用场景中的取舍，而不是重复产品公告。',
    why: item.why?.length >= 12 ? item.why : (item.why || '') + '通过具体过程解释实际问题和适用范围。',
    outline: item.outline?.length >= 12 ? item.outline : '先讨论实际任务，再根据原始材料解释过程和证据范围。',
    evidence: item.evidence || sourceURLs(item.sources).map(url => ({ url, title: '测试原文', sourceType: 'primary', quote,
      supports: '这段材料提供讨论实际过程与适用边界的依据。', publishedAt: today, publicationQuote: `Published: ${today}`, eventDate: null, eventQuote: '' })),
  }));
  const event = (tool, input, output) => ({ type: 'tool_use', part: { tool, state: { status: 'completed', input, output } } });
  return [event('websearch', { query: '测试近期进展' }, '模拟近期检索结果'), event('websearch', { query: '测试深度材料' }, '模拟深度检索结果'),
    ...[...new Set(enriched.flatMap(item => sourceURLs(item.sources)))].map(url => event('webfetch', { url }, `# 测试原文\nPublished: ${today}\n${quote}`)),
    { type: 'text', part: { text: JSON.stringify(enriched) } }];
}
