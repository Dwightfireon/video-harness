/* 扫码登录：拿二维码 → 轮询结果 → 只保留两枚必要的 cookie。
 *
 * 为什么不用内嵌网页登录：
 *   - 网页登录要把整个创作中心装进窗口，还是得手动点上传、填表；
 *   - passport 有扫码接口，拿到 SESSDATA 后所有投稿接口都能直接用。
 * 采用 API 后，日常发布是“选项目 → 选分区 → 点提交”，不再打开网页。
 *
 * 凭据只写在本机 ~/.config/video-harness/bilibili.json（0600），
 * 不进项目目录、不进交付包、不打印。
 */
import fs from 'node:fs';
import path from 'node:path';
import { cookiesComplete, pickCookies, ensureDeviceCookies } from './bili.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const POLL_CODES = {
  0: 'ok',
  86101: 'waiting',
  86090: 'scanned',
  86038: 'expired',
};

export function credentialPath(home = process.env.HOME) {
  if (!home || !path.isAbsolute(home)) throw new Error('无法确定本机凭证目录');
  return path.join(home, '.config', 'video-harness', 'bilibili.json');
}

export function readBiliCredential(home = process.env.HOME) {
  const file = credentialPath(home);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const cookies = pickCookies(Object.entries(raw?.cookies || {}).map(([name, value]) => ({ name, value })));
  if (!cookiesComplete(cookies)) return null;
  return { cookies, savedAt: raw.savedAt || null, mid: raw.mid ?? null, name: raw.name ?? '' };
}

export function saveBiliCredential(cookies, { mid = null, name = '', home = process.env.HOME } = {}) {
  const picked = pickCookies(Object.entries(cookies || {}).map(([key, value]) => ({ name: key, value })));
  if (!cookiesComplete(picked)) throw new Error('登录信息不完整：缺少 SESSDATA 或 bili_jct');
  const file = credentialPath(home), dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, '.' + process.pid + '-' + Date.now() + '.tmp');
  try {
    fs.writeFileSync(temp, JSON.stringify({ version: 1, cookies: picked, mid, name, savedAt: new Date().toISOString() }, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return file;
}

export function clearBiliCredential(home = process.env.HOME) {
  const file = credentialPath(home);
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/* 从 passport 的 Set-Cookie 里取出登录凭据。接口返回的 URL 也带同样的参数。 */
export function cookiesFromSetCookie(list = []) {
  const out = {};
  for (const line of list) {
    const [pair] = String(line).split(';');
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim();
    if (['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5'].includes(name)) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function cookiesFromUrl(url) {
  const out = {};
  try {
    const parsed = new URL(String(url));
    for (const [key, value] of parsed.searchParams) {
      if (['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5'].includes(key)) out[key] = value;
    }
  } catch {}
  return out;
}

/* passport 有时只在 data.url 的查询串里给出凭据，Set-Cookie 为空；
 * 两边都没有时不要存半份凭据，否则后面每个请求都只会得到“账号未登录”。 */
export function mergeLoginCookies({ setCookie = [], url = '' } = {}) {
  return { ...cookiesFromUrl(url), ...cookiesFromSetCookie(setCookie) };
}

export function createQrLogin({ fetch: fetchImpl = globalThis.fetch, home = process.env.HOME, interval = 2000, timeout = 180000,
  ensureDevice = null } = {}) {
  const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/' };
  let key = null, stopped = false, timer = null;

  async function generate() {
    const response = await fetchImpl('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', { headers });
    const json = await response.json();
    if (json?.code !== 0 || !json.data?.url) throw new Error('获取登录二维码失败：' + (json?.message || '未知错误'));
    key = json.data.qrcode_key;
    return { url: json.data.url, key };
  }

  async function poll() {
    if (!key) throw new Error('还没有生成二维码');
    const response = await fetchImpl(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`, { headers });
    const json = await response.json();
    const code = json?.data?.code;
    const state = POLL_CODES[code] ?? 'unknown';
    if (state !== 'ok') return { state, code, message: json?.data?.message || json?.message || '' };
    // 成功后凭据在两处：Set-Cookie 和 data.url 的查询参数。合并取并集。
    const cookies = mergeLoginCookies({ setCookie: response.headers?.getSetCookie?.() || [], url: json.data.url });
    if (!cookiesComplete(cookies)) {
      return { state: 'incomplete', code, message: '扫码成功但没有拿到完整凭据（SESSDATA / bili_jct），请重试' };
    }
    // 补设备标识，否则投稿接口常被风控拦成 HTML 403。
    if (ensureDevice) await ensureDevice(cookies);
    const saved = saveBiliCredential(cookies, { home });
    return { state: 'ok', code, cookies, file: saved };
  }

  function watch(onEvent) {
    stopped = false;
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = async () => {
        if (stopped) return resolve({ state: 'cancelled' });
        try {
          const result = await poll();
          onEvent?.(result);
          if (result.state === 'ok') return resolve(result);
          if (['expired', 'incomplete'].includes(result.state)) return resolve(result);
          if (Date.now() - started > timeout) return resolve({ state: 'timeout' });
          timer = setTimeout(tick, interval);
        } catch (error) { reject(error); }
      };
      tick();
    });
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  }

  return { generate, poll, watch, stop };
}

/* 二维码内容转 data URL，界面直接 <img src>，不需要额外网络请求。 */
export async function qrDataUrl(text, toDataURL) {
  if (typeof toDataURL !== 'function') throw new Error('缺少二维码生成器');
  return toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 260 });
}
