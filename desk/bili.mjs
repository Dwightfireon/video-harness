/* B 站投稿 API 客户端（纯 Node，不依赖 Electron）。
 *
 * 协议来源（2026-10 核对 biliup 1.3.4 的 Rust 实现）：
 *   1. GET  member.bilibili.com/preupload?r=probe…        → 拿 endpoint / auth / biz_id / chunk_size / upos_uri
 *   2. POST {endpoint}/{upos_uri}?uploads&output=json     → upload_id（头 X-Upos-Auth）
 *   3. PUT  {endpoint}/{upos_uri}?uploadId=…&chunk=…      → 分块上传
 *   4. POST {endpoint}/{upos_uri}?name=…&uploadId=…       → 提交 parts，拿 filename
 *   5. POST member.bilibili.com/x/vu/web/cover/up          → 封面上传，返回图片 URL
 *   6. POST member.bilibili.com/x/vu/web/add/v3?csrf=…     → 正式投稿
 *
 * 为什么不用网页填表：网页的输入框结构随版本改，且无法知道服务端是否真的收下。
 * API 有明确的 code/message，失败能说清原因；提交前也能把完整 payload 打出来复核。
 *
 * 边界：这个模块只负责“照给的参数执行”。要不要提交、提交什么，由调用方明确决定。
 */
import fs from 'node:fs';
import { flattenPartitions, flattenHumanPartitions, offlinePartitions, PARTITION_TAXONOMY, PARTITION_SOURCE,
  HUMAN_PARTITION_TAXONOMY, HUMAN_PARTITION_SOURCE } from './partitions.mjs';
import { buildPayload as buildSubmissionPayload } from './publish-contract.mjs';
// 保留旧导入入口；领域实现已移到独立模块。
export { FALLBACK_PARTITIONS, flattenPartitions } from './partitions.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
export const ORIGIN = 'https://member.bilibili.com';
export const API = 'https://api.bilibili.com';
const PREUPLOAD_LINE = 'zone=cs&upcdn=bldsa&probe_version=20221109';
/* 单块上限。服务端一般给 4~16MB；若它给了异常大的值，按 16MB 切不会更慢
   （总字节数不变），但能避免一次把上百 MB 读进内存。 */
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const MIN_CHUNK_BYTES = 256 * 1024;

export class BiliError extends Error {
  constructor(message, { code = null, step = '', payload = null, httpStatus = null, outcome = null } = {}) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
    this.step = step;
    this.payload = payload;
    this.httpStatus = httpStatus;
    this.outcome = outcome;
  }
}

/* 从登录态里取 cookie。
 *
 * 为什么不再只留 4 个：B 站上传接口有风控，除 SESSDATA/bili_jct 外还需要
 * buvid3 / buvid4 / b_nut 这类设备标识；只留两个时 preupload 常被 403 拦掉
 * （已实测：未带 cookie 的 preupload 直接返回 HTML 403）。biliup 也是整份保存。
 * 代价是文件里的信息更多，所以仍然只写本机 0600 文件、不进项目、不打印。
 */
export function pickCookies(list) {
  const out = {};
  for (const item of Array.isArray(list) ? list : []) {
    const name = item?.name;
    if (typeof name !== 'string' || !name || typeof item.value !== 'string' || !item.value) continue;
    // 只排除明显与投稿无关、且体积大的追踪项；白名单不足以通过风控。
    if (name === 'buvid_fp') continue;
    out[name] = item.value;
  }
  return out;
}

export function cookieHeader(cookies) {
  return Object.entries(cookies || {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
}

export function cookiesComplete(cookies) {
  return Boolean(cookies?.SESSDATA && cookies?.bili_jct);
}

/* 投稿权限体检：在真正上传前先问一句“这个账号能投稿吗”。
 * 真实痛点是上传 26MB 视频、传完封面上传，最后提交才被拒；这里提前暴露。
 * 只读接口，不创建草稿、不投稿。 */
export async function checkPublishReady(api, { fetch: fetchImpl = globalThis.fetch, ua = UA, origin = ORIGIN, probeUpload = true, whoamiResult = null } = {}) {
  const checks = [];
  const add = (name, ok, note) => checks.push({ name, ok, note: note || '' });

  const who = whoamiResult || await api.whoami();
  add('登录状态', who.loggedIn, who.loggedIn ? `${who.name || ''}（LV${who.level ?? '?'}）` : (who.message || '未登录'));

  // 分区接口能通，说明创作中心侧的登录态与设备标识都被接受。
  try {
    const result = await api.partitions();
    add('创作中心接口', Boolean(result.live && result.list?.length), result.live ? `${result.list.length} 个分区` : '未取得实时投稿分区，离线清单不能证明可投稿');
  } catch (error) {
    add('创作中心接口', false, error.message);
  }

  // 仅在显式需要探测上传线路时调用 preupload；日常浏览发布台不主动戳上传接口，避免触发 B 站 HTTP 406 限频。
  if (probeUpload) {
    try {
      const bucket = await api.preupload({ name: 'probe.mp4', size: 1024 });
      add('上传线路', Boolean(bucket?.endpoint), bucket?.endpoint ? '已获得上传线路' : '没有返回 endpoint');
    } catch (error) {
      add('上传线路', false, error.message);
    }
  }

  return { ok: checks.every(item => item.ok), checks };
}

/* 扫码登录后如果接口没给设备标识，补一次 buvid3：
 * 缺它时投稿接口容易直接被风控拦成 HTML 403，报错还看不出原因。 */
export async function ensureDeviceCookies(cookies, { fetch: fetchImpl = globalThis.fetch, ua = UA, origin = API } = {}) {
  if (cookies?.buvid3) return cookies;
  try {
    const response = await fetchImpl(`${origin}/x/frontend/finger/spi`, { headers: { 'user-agent': ua, referer: 'https://www.bilibili.com/' } });
    const json = await response.json();
    if (json?.data?.b_3) cookies.buvid3 = json.data.b_3;
    if (json?.data?.b_4) cookies.buvid4 = json.data.b_4;
  } catch { /* 拿不到就照常继续，失败时由投稿接口给出真实原因 */ }
  return cookies;
}

/* 单块大小：以服务端为准，但夹在合理区间。
 * 服务端给 0 或异常大的值时，用 4MB；返回实际采用的块大小，便于日志与测试。 */
export function resolveChunkSize(serverValue, forced = 0) {
  const clamp = value => Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, Math.floor(value)));
  if (Number.isFinite(forced) && forced > 0) return clamp(forced);
  if (Number.isFinite(serverValue) && serverValue > 0) return clamp(serverValue);
  return 4 * 1024 * 1024;
}
/* 按需读文件分块。整个上传过程只开一次 fd：大视频逐块 open/close 会拖慢不少。 */
function openVideo(file) {
  if (!fs.existsSync(file)) throw new BiliError('视频文件不存在：' + file, { step: 'video' });
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  return {
    size,
    read(start, end) {
      const length = end - start;
      const buffer = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const n = fs.readSync(fd, buffer, offset, length - offset, start + offset);
        if (!n) break;
        offset += n;
      }
      if (offset !== length) throw new BiliError('读取视频分块时提前结束：' + file, { step: 'read' });
      return buffer;
    },
    close() { try { fs.closeSync(fd); } catch {} },
  };
}

export function createBiliClient({ cookies = {}, fetch: fetchImpl = globalThis.fetch, ua = UA, origin = ORIGIN, api = API,
  timeout = 60000, onProgress = () => {} } = {}) {
  const headers = () => ({ 'user-agent': ua, cookie: cookieHeader(cookies), referer: `${origin}/platform/upload/video/frame` });

  async function request(url, options = {}, step = '', { tolerateHttpError = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response, text;
    try {
      response = await fetchImpl(url, { ...options, signal: controller.signal, headers: { ...headers(), ...(options.headers || {}) } });
      text = await response.text();
    } catch (error) {
      throw new BiliError(`网络请求失败（${step || 'request'}）：${controller.signal.aborted || error.name === 'AbortError' ? '超时' : error.message}`,
        { step, httpStatus: response?.status ?? null, outcome: step === '提交投稿' ? 'unknown' : null });
    } finally { clearTimeout(timer); }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (tolerateHttpError && json?.code != null && json.code !== 0) {
      throw new BiliError('投稿被拒绝：' + (json.message || '未知错误'),
        { code: json.code, step, payload: json, httpStatus: response.status, outcome: 'rejected' });
    }
    if (!response.ok) {
      // 风控拦截时 B 站返回的是整页 HTML，直接塞进消息会变成一屏乱码。
      const html = /^\s*</.test(text);
      const message = html
        ? '服务端返回了拦截页（可能是登录过期、请求过快或风控），不是接口数据'
        : (json?.message || json?.error || text.slice(0, 200));
      throw new BiliError(`${step || 'request'} 失败：HTTP ${response.status} ${message}`, {
        code: json?.code ?? response.status, step, payload: json, httpStatus: response.status,
        outcome: tolerateHttpError ? 'unknown' : null,
      });
    }
    if (tolerateHttpError && (json?.code !== 0 || (!json?.data?.bvid && !json?.data?.aid))) {
      throw new BiliError('提交投稿结果无法确认：服务端没有返回有效投稿回执，请先到稿件管理核对',
        { step, httpStatus: response.status, outcome: 'unknown' });
    }
    return json;
  }

  /* 未登录时返回 { loggedIn:false }，不抛错：未登录是常见状态，不是异常。 */
  async function whoami() {
    try {
      const data = await request(`${api}/x/web-interface/nav`, { method: 'GET' }, '查询登录态');
      const info = data?.data || {};
      return { loggedIn: Boolean(info.isLogin && data?.code === 0), mid: info.mid ?? null, name: info.uname ?? '',
        level: info.level_info?.current_level ?? null, code: data?.code ?? null, message: data?.message || '' };
    } catch (error) {
      return { loggedIn: false, code: error.code ?? null, message: error.message };
    }
  }

  async function partitions() {
    const data = await request(`${origin}/x/vupre/web/archive/pre`, { method: 'GET' }, '读取分区');
    if (data?.code !== 0) throw new BiliError('读取分区失败：' + (data?.message || '未知错误'), { code: data?.code, step: 'partitions', payload: data });
    const mode = Number(data.data?.type_mode ?? 0);
    // 官方客户端 type_mode===2 时用新列表，并以 human_type2 提交；旧 typelist 仍在不等于旧模式。
    if (mode === 2) {
      try {
        const human = await request(`${origin}${new URL(HUMAN_PARTITION_SOURCE).pathname}`, { method: 'GET' }, '读取新版分区');
        if (human?.code !== 0) throw new BiliError('读取新版分区失败：' + (human?.message || '未知错误'), { code: human?.code, step: 'partitions' });
        const list = flattenHumanPartitions(human.data);
        return list.length ? { list, live: true, taxonomy: HUMAN_PARTITION_TAXONOMY, typeMode: mode,
          source: HUMAN_PARTITION_SOURCE, checkedAt: new Date().toISOString() }
          : offlinePartitions('新版分区列表为空，不能提交；请刷新重试', HUMAN_PARTITION_TAXONOMY);
      } catch (error) {
        return offlinePartitions('读取新版投稿分区失败：' + error.message + '；不会自动退回旧分区', HUMAN_PARTITION_TAXONOMY);
      }
    }
    if (mode !== 0) return offlinePartitions('当前账号的分区模式暂不支持手选，请使用官方创作中心核对');
    const list = flattenPartitions(data.data);
    if (Number(data.data?.is_typeid_revision) === 1 || list.some(item => item.id >= 1000)) {
      return offlinePartitions('旧模式响应包含新版编号或未识别的修订标记，不能混用；请刷新分区核对');
    }
    return list.length ? { list, live: true, taxonomy: PARTITION_TAXONOMY, source: PARTITION_SOURCE,
      checkedAt: new Date().toISOString() } : offlinePartitions('接口没有返回可投稿的二级分区，暂不能提交');
  }

  async function promotionOptions() {
    const data = await request(`${origin}/x/vupre/web/archive/pre`, { method: 'GET' }, '读取商业推广选项');
    if (data?.code !== 0) throw new BiliError('读取商业推广选项失败：' + (data?.message || '未知错误'), { code: data?.code, step: 'promotion' });
    const options = list => (Array.isArray(list) ? list : []).filter(item => Number.isSafeInteger(Number(item?.id)) && Number(item.id) > 0 && typeof item.name === 'string')
      .map(item => ({ id: Number(item.id), name: item.name }));
    return { industries: options(data.data?.industry_list), showTypes: options(data.data?.showtype_list) };
  }

  async function preupload({ name, size, line = PREUPLOAD_LINE }) {
    const query = new URLSearchParams({ name, r: 'upos', profile: 'ugcupos/bup', ssl: '0', version: '2.14.0', build: '2140000', size: String(size) });
    const url = `${origin}/preupload?${line}&${query}`;
    const json = await request(url, { method: 'GET' }, '申请上传线路');
    const bucket = json?.data && json.data.endpoint ? json.data : json;
    if (!bucket?.endpoint || !bucket?.auth || !bucket?.upos_uri) {
      throw new BiliError('申请上传线路失败：返回里缺少 endpoint/auth/upos_uri', { code: json?.code ?? null, step: 'preupload', payload: json });
    }
    return { endpoint: bucket.endpoint, auth: bucket.auth, bizId: bucket.biz_id, chunkSize: Number(bucket.chunk_size) || 0, uposUri: bucket.upos_uri };
  }

  async function uploadVideo(file, { chunkSize: forced = 0 } = {}) {
    const chunks = openVideo(file);
    try {
      const fileName = file.split('/').pop();
      const bucket = await preupload({ name: fileName, size: chunks.size });
      const chunkSize = resolveChunkSize(bucket.chunkSize, forced);
      const base = 'https:' + bucket.endpoint + '/' + bucket.uposUri.replace(/^upos:\/\//, '');
      const authHeader = { 'x-upos-auth': bucket.auth };

      const started = await request(`${base}?uploads&output=json`, { method: 'POST', headers: authHeader }, '创建上传会话');
      const uploadId = started?.upload_id;
      if (!uploadId) throw new BiliError('创建上传会话失败：没有 upload_id', { step: 'upload', payload: started });

      const total = chunks.size, count = Math.ceil(total / chunkSize), parts = [];
      for (let index = 0; index < count; index++) {
        const start = index * chunkSize, end = Math.min(total, start + chunkSize), size = end - start;
        const body = chunks.read(start, end);
        const query = new URLSearchParams({ uploadId, chunks: String(count), total: String(total), chunk: String(index),
          size: String(size), partNumber: String(index + 1), start: String(start), end: String(end) });
        let attempt = 0;
        for (;;) {
          try {
            await request(`${base}?${query}`, { method: 'PUT', headers: { ...authHeader, 'content-length': String(size) }, body }, `上传第 ${index + 1}/${count} 块`);
            break;
          } catch (error) {
            attempt++;
            if (attempt >= 3 || error.code === 601) throw error;
            onProgress({ phase: 'retry', chunk: index + 1, attempt });
            await new Promise(resolve => setTimeout(resolve, 400 * attempt));
          }
        }
        parts.push({ partNumber: index + 1, eTag: 'etag' });
        onProgress({ phase: 'upload', chunk: index + 1, chunks: count, bytes: end, total });
      }

      const finalQuery = new URLSearchParams({ name: fileName, uploadId, biz_id: String(bucket.bizId ?? 0), output: 'json', profile: 'ugcupos/bup' });
      const finalized = await request(`${base}?${finalQuery}`, { method: 'POST', headers: { ...authHeader, 'content-type': 'application/json' },
        body: JSON.stringify({ parts }) }, '合并分块');
      if (Number(finalized?.OK) !== 1 && finalized?.OK !== true) {
        throw new BiliError('合并分块失败：' + JSON.stringify(finalized).slice(0, 200), { step: 'finalize', payload: finalized });
      }
      const filename = (bucket.uposUri.split('/').pop() || '').replace(/\.[^.]+$/, '');
      if (!filename) throw new BiliError('合并成功但拿不到文件名', { step: 'finalize', payload: finalized });
      onProgress({ phase: 'uploaded', filename, bytes: total });
      return { filename, bytes: total, chunks: count };
    } finally {
      chunks.close();
    }
  }

  async function uploadCover(file) {
    const bytes = fs.readFileSync(file);
    const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
    const form = new URLSearchParams({ cover: `data:${mime};base64,${bytes.toString('base64')}`, csrf: cookies.bili_jct || '' });
    const json = await request(`${origin}/x/vu/web/cover/up`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }, '上传封面');
    const url = json?.data?.url;
    if (!url) throw new BiliError('上传封面失败：' + (json?.message || '返回里没有 url'), { code: json?.code ?? null, step: 'cover', payload: json });
    return url;
  }

  /* 完整 payload 单独构造，提交和预览共用同一份，避免“预览一套、提交另一套”。 */
  function buildPayload(input) {
    try { return buildSubmissionPayload(input); }
    catch (error) { throw new BiliError(error.message, { step: 'payload' }); }
  }

  async function submit(payload) {
    if (!cookiesComplete(cookies)) throw new BiliError('缺少登录凭据（SESSDATA / bili_jct）', { step: 'submit' });
    const url = `${origin}/x/vu/web/add/v3?${new URLSearchParams({ t: String(Date.now()), csrf: cookies.bili_jct })}`;
    // 投稿失败时 B 站常用 HTTP 4xx + 业务 code，业务信息比状态码有用，所以自己解释。
    const json = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
      '提交投稿', { tolerateHttpError: true });
    if (json?.code !== 0) {
      throw new BiliError('投稿被拒绝：' + (json?.message || '未知错误'), { code: json?.code ?? null, step: 'submit', payload: json });
    }
    return { aid: json.data?.aid ?? null, bvid: json.data?.bvid ?? null, raw: json };
  }

  async function archives({ page = 1, size = 20 } = {}) {
    const status = 'is_pubing,pubed,not_pubed';
    const url = `${origin}/x/web/archives?${new URLSearchParams({ status, pn: String(page), ps: String(size), coop: '1', interactive: '1' })}`;
    const json = await request(url, { method: 'GET' }, '读取稿件列表');
    if (json?.code !== 0) throw new BiliError('读取稿件列表失败：' + (json?.message || '未知错误'), { code: json?.code ?? null, step: 'archives', payload: json });
    const list = (json.data?.arc_audits || []).map(item => {
      const a = item.Archive || item;
      return { bvid: a.bvid, aid: a.aid, title: a.title, state: a.state, stateDesc: a.state_desc || '',
        ptime: Number(a.ptime) || null, cover: a.cover || '' };
    });
    return { list, total: Number(json.data?.page?.count ?? list.length) };
  }

  /* 直接回读指定稿件的编辑资料；不依赖列表首页，不调用编辑/补报/重发接口。 */
  async function archiveDetail({ bvid, aid } = {}) {
    const query = new URLSearchParams();
    if (/^BV[0-9A-Za-z]{10}$/.test(String(bvid || ''))) query.set('bvid', bvid);
    else if (Number.isSafeInteger(Number(aid)) && Number(aid) > 0) query.set('aid', String(aid));
    else throw new BiliError('缺少有效稿件编号，无法回读声明', { step: 'declaration' });
    const json = await request(`${origin}/x/vupre/web/archive/view?${query}`, { method: 'GET' }, '回读创作者声明');
    const archive = json?.data?.archive;
    if (json?.code !== 0 || !archive || (query.has('bvid') ? archive.bvid !== bvid : Number(archive.aid) !== Number(aid))) {
      throw new BiliError('未取得对应稿件的声明资料', { code: json?.code ?? null, step: 'declaration' });
    }
    // 新网页同时兼容 creation_statement 和 creation_statement_id，不能拿旧 neutral_mark 当确认。
    const raw = archive.creation_statement !== undefined ? archive.creation_statement?.id : archive.creation_statement_id;
    return { bvid: archive.bvid, aid: archive.aid,
      creationStatementId: (typeof raw === 'number' || (typeof raw === 'string' && /^-?\d+$/.test(raw))) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null };
  }

  /* 按 BV 号查稿件是否已在「稿件管理」里出现，用于投稿后确认。 */
  async function findArchive(bvid) {
    const { list } = await archives();
    return list.find(item => item.bvid === bvid) || null;
  }

  return { whoami, partitions, promotionOptions, preupload, uploadVideo, uploadCover, buildPayload, submit, archives, archiveDetail, findArchive };
}
