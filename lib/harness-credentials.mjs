/* 本地凭证不放在工作台静态文件根目录；不打印或返回密钥。 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function credentialsPath(home = process.env.HOME) {
  if (!home || !path.isAbsolute(home)) throw new Error('无法确定本机凭证目录');
  return path.join(home, '.config', 'video-harness', 'credentials.json');
}

export function readHarnessCredentials(home = process.env.HOME) {
  try { return JSON.parse(fs.readFileSync(credentialsPath(home), 'utf8')); }
  catch { return {}; }
}

export function saveOpenDesignKey(value, home = process.env.HOME) {
  const key = String(value || '').trim();
  if (!key || /\s/.test(key)) throw new Error('密钥为空或含空白，请只输入 API key');
  const target = credentialsPath(home), dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cur = readHarnessCredentials(home);
  const temp = path.join(dir, '.' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temp, JSON.stringify({ ...cur, opendesignKey: key }) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, target);
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return target;
}
