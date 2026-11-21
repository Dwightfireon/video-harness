/* HTTP 适配器：面板只调用用例，不拼接端点、请求头或序列化请求。 */
const TOPICS = '/_api/schedule/discover/topics';
const DISCOVER = '/_api/schedule/discover';

export function createDiscoveryAPI(request) {
  const post = (url, body) => request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return {
    topics: view => request(TOPICS + '?' + new URLSearchParams(Object.entries(view)), { cache: 'no-store' }),
    update: (body, view) => post(TOPICS, { ...body, view }),
    job: () => request(DISCOVER, { cache: 'no-store' }),
    search: body => post(DISCOVER, body),
  };
}
