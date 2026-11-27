/* Shared topic data contract. No discovery policy, disk, network or processes. */
const clean = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : null;
}
function urlKey(value) {
  try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null; url.hash = ''; return url.href; }
  catch { return null; }
}
export function normalizeQuestion(raw) {
  if (!raw || raw.version !== 1) return null;
  const audience = clean(raw.audience, 500), value = clean(raw.value, 1000);
  const investigate = (Array.isArray(raw.investigate) ? raw.investigate : []).map(item => clean(item, 1000)).filter(Boolean);
  if (!audience || !value || investigate.length < 2 || investigate.length > 3 || !Array.isArray(raw.premises)) return null;
  return { version: 1, audience, value, investigate, premises: raw.premises.map(item => clean(item, 1000)).filter(Boolean).slice(0, 8) };
}
export function normalizeResearchAssessment(raw) {
  if (!raw || raw.version !== 1 || !['unresearched', 'leads', 'insufficient', 'reframe'].includes(raw.status)) return null;
  return { version: 1, status: raw.status, finding: clean(raw.finding, 2000),
    gaps: (Array.isArray(raw.gaps) ? raw.gaps : []).map(item => clean(item, 1000)).filter(Boolean).slice(0, 8),
    suggestedQuestion: clean(raw.suggestedQuestion, 2000) };
}
export const unresearchedAssessment = () => ({ version: 1, status: 'unresearched', finding: '', gaps: [], suggestedQuestion: '' });

/* Bounded data only. Matching evidence to actual tool returns is a separate step. */
export function normalizeTopicResearch(raw, sources = []) {
  if (!raw || raw.version !== 1 || !['news', 'evergreen', 'opinion'].includes(raw.kind)) return null;
  const allowed = new Set(sources.map(urlKey).filter(Boolean));
  const evidence = (Array.isArray(raw.sources) ? raw.sources : []).slice(0, 4).flatMap(item => {
    const url = urlKey(item?.url);
    if (!url || !allowed.has(url)) return [];
    return [{ url, title: clean(item.title, 300), sourceType: ['primary', 'reporting', 'analysis'].includes(item.sourceType) ? item.sourceType : 'unknown',
      quote: clean(item.quote, 2000), supports: clean(item.supports, 1000), publishedAt: dateOnly(item.publishedAt), eventDate: dateOnly(item.eventDate),
      publicationQuote: clean(item.publicationQuote, 600), eventQuote: clean(item.eventQuote, 600) }];
  });
  if (!evidence.length) return null;
  return { version: 1, kind: raw.kind, checkedAt: Number(raw.checkedAt) || 0, selectionReason: clean(raw.selectionReason, 1000),
    caveats: (Array.isArray(raw.caveats) ? raw.caveats : []).map(value => clean(value, 500)).filter(Boolean).slice(0, 6), sources: evidence,
    ...(['intel', 'science', 'opinion'].includes(raw.contentProfile) ? { contentProfile: raw.contentProfile } : {}),
    ...(typeof raw.recordPath === 'string' && /^(?:out\/topic-research\/[a-f0-9-]+|research\/[a-zA-Z0-9._-]+)\.json$/.test(raw.recordPath) && !raw.recordPath.includes('..') ? { recordPath: raw.recordPath } : {}) };
}
