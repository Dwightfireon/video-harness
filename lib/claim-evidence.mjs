/* Provenance/consistency only. A URL or a hash cannot prove a claim is true. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const text = value => typeof value === 'string' ? value.trim() : '';
const sha = value => createHash('sha256').update(value).digest('hex');
const compact = value => value.replace(/\s+/gu, '');
const webURL = value => { try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; } };
const measured = value => /本机实测|本地实测|本机测量|现场观测|measurement/i.test(value);
export function normalizeClaim(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const evidence = Array.isArray(c.evidence) ? c.evidence.filter(e => e && typeof e === 'object' && !Array.isArray(e)) : [];
  const kind = text(c.kind) || text(evidence[0]?.type);
  const sourceType = text(c.sourceType) || (/作者建议|作者归纳|recommendation/.test(kind) ? 'recommendation'
    : /作者计算|推导|假设算例|calculation/.test(kind) ? 'calculation'
      : /用户提供|user-provided/.test(kind) ? 'user-provided'
        : measured(kind) ? 'measurement' : 'external');
  return { ...c, assertion: text(c.assertion) || text(c.statement), kind, sourceType,
    scope: text(c.scope), url: text(c.url) || text(evidence[0]?.url), evidence };
}

export function validateClaimEvidence(project, rawClaims, { release = false } = {}) {
  const findings = [], warnings = [], claims = [];
  const add = (c, kind, msg) => findings.push({ kind, id: c.id, msg: `claims ${c.id || '?'}：${msg}` });
  const seen = new Set();
  for (const raw of rawClaims) {
    const c = normalizeClaim(raw); claims.push(c);
    const local = ['recommendation', 'calculation', 'user-provided', 'measurement'].includes(c.sourceType);
    const missing = ['id', 'assertion', 'kind', 'scope', ...(!local ? ['url'] : [])].filter(k => !text(c[k]));
    if (missing.length) add(c, 'claim-field', '缺字段：' + missing.join(' / '));
    if (!['external', 'recommendation', 'calculation', 'user-provided', 'measurement'].includes(c.sourceType)) add(c, 'claim-source-type', '未知 sourceType');
    if (measured(c.kind) && c.sourceType !== 'measurement') add(c, 'claim-source-type', '本机/现场观测应使用 measurement 并登记本地原始记录，外部链接不能代替实测证据');
    if (seen.has(c.id)) add(c, 'claim-id', 'id 重复'); seen.add(c.id);
    if (!c.evidence.length) { add(c, 'claim-evidence', '缺结构化 evidence；不能用链接或“测量”两字代替依据'); continue; }
    if (!local && !webURL(c.url)) add(c, 'claim-url', '外部事实需要有效 http/https 来源 URL');
    if (local && c.sourceType !== 'measurement' && c.status === 'verified') add(c, 'claim-status', '作者建议/计算/用户提供不是外部事实核证；请使用 authored/derived/provided 或不填 status');
    if (c.sourceType === 'calculation' && !text(c.calculation)) add(c, 'claim-calculation', '作者计算需登记 calculation（算式、输入与结果）；不执行任意代码');
    let usable = 0, localUsable = 0;
    for (const e of c.evidence) {
      const unavailable = e.available === false || Number(e.httpStatus) >= 400 ||
        /本次.{0,12}(?:403|未取得原文|未读到原文)|未直接(?:核到|读到)原文|本次抓取\s*403/u.test(text(e.quote) + ' ' + text(e.type));
      if (c.status === 'verified' && unavailable) add(c, 'claim-unread-verified', '来源明确未取得，却标为 verified；标为 unverified/pending 或补实际读到的证据，不要替换成无关 URL');
      if (!text(e.quote) || !text(e.type) || !/^\d{4}-\d{2}-\d{2}$/.test(text(e.checkedAt))) {
        add(c, 'claim-evidence', '每份依据须有 quote/type/checkedAt'); continue;
      }
      if ((local && c.sourceType !== 'measurement') || e.path != null) {
        const relative = text(e.path);
        try {
          if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('必须填写项目内相对 path');
          let file = project;
          for (const part of relative.split('/')) {
            file = path.join(file, part);
            const s = fs.lstatSync(file); if (s.isSymbolicLink()) throw new Error('本地依据不能经过符号链接');
          }
          if (!fs.statSync(file).isFile()) throw new Error('本地依据不是普通文件');
          const bytes = fs.readFileSync(file);
          if (e.sha256 !== sha(bytes)) throw new Error('本地依据缺少当前 SHA-256 或已改变');
          if (!text(e.locator)) throw new Error('本地依据缺章节/行段 locator');
          if (!compact(bytes.toString('utf8')).includes(compact(e.quote))) throw new Error('quote 在本地依据中找不到');
          usable++; localUsable++;
        } catch (error) { add(c, 'claim-local-evidence', error.message); }
      } else if (webURL(text(e.url) || c.url) && !unavailable) usable++;
    }
    if (c.sourceType === 'measurement' && !localUsable) add(c, 'claim-measurement-evidence', '实测须有可核对的本地原始记录、路径、SHA-256、位置与原文摘录；外部标准或自写说明不能代替');
    if ((!local || c.sourceType === 'measurement') && c.status !== 'verified') {
      const msg = c.sourceType === 'measurement' ? '实测仍标为待核，不能冒充已核证' : '外部事实尚未核实；转述/待核不能冒充已核证';
      if (release) add(c, 'claim-pending', msg);
      else warnings.push({ kind: 'claim-pending', id: c.id, msg: `claims ${c.id || '?'}：${msg}` });
    }
    if (!usable && (local || release || c.status === 'verified')) add(c, 'claim-no-evidence', '没有可用依据；保留待核或补真实材料，不能用无关官方链接凑检查');
  }
  return { ok: !findings.length, findings, warnings, claims,
    scope: '仅核对来源类型、必需字段、本地摘录/指纹及已声明的核证状态矛盾；不验证 URL 内容与断言的语义关系，也不证明事实为真。' };
}

export function claimEvidenceStatus(project, options = {}) {
  try {
    const document = JSON.parse(fs.readFileSync(path.join(project, 'claims.json'), 'utf8'));
    const claims = Array.isArray(document) ? document : document?.claims;
    if (!Array.isArray(claims)) throw new Error('claims.json 须为数组或含 claims 数组的对象');
    return validateClaimEvidence(project, claims, options);
  } catch (error) { return { ok: false, claims: [], warnings: [], findings: [{ kind: 'claim-document', msg: '证据表缺失或无效：' + error.message }] }; }
}
