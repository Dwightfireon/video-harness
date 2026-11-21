/* 只记录白名单错误码；TLS 另限于请求主机和一个 SHA-256 指纹，不记录 SAN 或异常正文。 */
import { isIP } from 'node:net';
import { API_ERROR_LABELS } from './api-error-diagnostics.mjs';

const certificateReasons = Object.freeze({
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书域名不匹配（证书不适用于请求主机）',
  CERT_HAS_EXPIRED: 'TLS 证书已过期',
  CERT_NOT_YET_VALID: 'TLS 证书尚未生效',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书为不受信任的自签名证书',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS 证书链含不受信任的自签名证书',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书链无法验证',
  UNABLE_TO_GET_ISSUER_CERT: 'TLS 证书签发者不可用',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'TLS 证书缺少本机信任的签发链',
  CERT_SIGNATURE_FAILURE: 'TLS 证书签名校验失败',
  CERT_REVOKED: 'TLS 证书已被吊销',
});
const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', ...Object.keys(certificateReasons), 'ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE']);
const temporary = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

function visitErrors(error, visitor) {
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 5 || seen.size >= 32) return;
    seen.add(node);
    visitor(node);
    visit(node.cause, depth + 1);
    if (Array.isArray(node.errors)) for (const child of node.errors.slice(0, 12)) visit(child, depth + 1);
  };
  visit(error, 0);
}

export function networkCodes(error) {
  const found = new Set();
  visitErrors(error, node => { if (codes.has(node.code)) found.add(node.code); });
  return [...found];
}

export function certificateFailureReason(list = []) {
  return list.map(code => Object.hasOwn(certificateReasons, code) ? certificateReasons[code] : null).find(Boolean) || '';
}

function safeHostname(value) {
  if (typeof value !== 'string' || value.length > 253 || !value.length) return null;
  if (isIP(value.replace(/^\[|\]$/g, ''))) return value.toLowerCase();
  return value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ? value.toLowerCase() : null;
}
function safeFingerprint(value) {
  if (typeof value !== 'string' || value.length > 95 || !/^(?:[a-f0-9]{64}|(?:[a-f0-9]{2}:){31}[a-f0-9]{2})$/i.test(value)) return null;
  return value.replace(/:/g, '').toUpperCase().match(/../g).join(':');
}

export function tlsDiagnostics(error, requestURL, secrets = []) {
  if (!certificateFailureReason(networkCodes(error))) return null;
  // 只从请求配置取预期主机，不信任异常中的 host/reason/SAN/subject/issuer。
  // 指纹仅标识校验失败时收到的证书，不能证明来源、代理路径或上游模型故障。
  const allowed = value => value && !secrets.some(secret => typeof secret === 'string' && secret.length &&
    (value.toLowerCase().includes(secret.toLowerCase()) || value.replace(/:/g, '').toLowerCase().includes(secret.replace(/:/g, '').toLowerCase())));
  const result = {};
  try {
    if (typeof requestURL === 'string' && requestURL.length <= 8192) {
      const url = new URL(requestURL);
      const hostname = ['https:', 'http:'].includes(url.protocol) ? safeHostname(url.hostname) : null;
      if (allowed(hostname)) result.expectedHostname = hostname;
    }
  } catch {}
  visitErrors(error, node => {
    if (result.fingerprint256 || !Object.hasOwn(certificateReasons, node.code)) return;
    const fingerprint = safeFingerprint(node.cert?.fingerprint256);
    if (allowed(fingerprint)) result.fingerprint256 = fingerprint;
  });
  return result;
}

export function canRetryRequest(_provider, error) {
  // 仅判断故障证据；渠道选择和全轮最多两次请求由 pool 保持，不执行回退。
  if (certificateFailureReason(error.diagnostics?.networkCodes)) return false;
  if (error.kind === 'timeout') return true;
  if (error.kind === 'server') return [500, 502, 503].includes(error.diagnostics?.apiStatus || error.status);
  const list = error.diagnostics?.networkCodes || [];
  return error.kind === 'network' && list.length > 0 && list.every(code => temporary.has(code));
}

export function diagnosticLabel(d) {
  if (!d) return '';
  return [d.source, d.phase, d.status ? 'HTTP ' + d.status : null, d.apiStatus ? 'API status ' + d.apiStatus : null,
    ...(d.networkCodes || []), Object.hasOwn(API_ERROR_LABELS, d.apiCode || '') ? '接口 ' + d.apiCode : null,
    d.parseCode && /^[a-z_]{1,40}$/.test(d.parseCode) ? '解析 ' + d.parseCode : null,
    ['length', 'stop', 'tool_calls'].includes(d.finishReason) ? '结束 ' + d.finishReason : null,
    Number.isInteger(d.toolCount) && d.toolCount >= 0 && d.toolCount <= 100 ? '工具片段 ' + d.toolCount : null,
    typeof d.streamComplete === 'boolean' ? '流结束 ' + d.streamComplete : null,
    Number.isFinite(d.elapsedMs) ? Math.round(d.elapsedMs) + 'ms' : null,
    Number.isFinite(d.receivedBytes) ? d.receivedBytes + 'B received' : null,
    safeHostname(d.tls?.expectedHostname) ? '请求主机 ' + safeHostname(d.tls.expectedHostname) + '（配置值）' : null,
    safeFingerprint(d.tls?.fingerprint256) ? '失败证书 SHA-256 ' + safeFingerprint(d.tls.fingerprint256) : null,
    d.tls ? '仅为证书校验证据，不能判定证书来源或上游模型故障' : null].filter(Boolean).join(' / ');
}
