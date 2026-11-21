import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const CATALOGS = Object.freeze({
  'opencode-go': 'https://opencode.ai/inference/go/v1/models',
  opencode: 'https://opencode.ai/inference/v1/models',
});
const ttl = 12 * 60 * 60 * 1000;
const inFlight = new Map();
const fileFor = (home, provider) => path.join(home, '.config', 'video-harness', `${provider}-models-v2.json`);

export function readCatalog(home, provider) {
  try {
    const { at, models } = JSON.parse(fs.readFileSync(fileFor(home, provider), 'utf8'));
    if (Number.isFinite(at) && Array.isArray(models) && models.length) return { at, models, stale: Date.now() - at >= ttl };
  } catch {}
  return { at: null, models: [], stale: false };
}

function parseCatalog(doc) {
  const models = new Map();
  for (const m of Array.isArray(doc?.data) ? doc.data : []) {
    if (m?.type !== 'chat' || typeof m.id !== 'string' || !/^[\w.][\w./-]{0,199}$/.test(m.id)) continue;
    const { input, output } = m.cost?.text || {};
    models.set(m.id, { id: m.id, free: input?.price === 0 && output?.price === 0 });
  }
  if (!models.size) throw new Error('官方目录没有返回可识别的聊天模型');
  return [...models.values()];
}

export async function refreshCatalog(home, provider, { force = false, fetchImpl = globalThis.fetch } = {}) {
  const cached = readCatalog(home, provider);
  if (!force && cached.at && !cached.stale) return null;
  const file = fileFor(home, provider);
  if (!inFlight.has(file)) {
    const job = (async () => {
      try {
        const response = await fetchImpl(CATALOGS[provider], { signal: AbortSignal.timeout(6500), redirect: 'error' });
        if (!response.ok) throw new Error(`官方目录 HTTP ${response.status}`);
        const models = parseCatalog(await response.json());
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temp, JSON.stringify({ at: Date.now(), models }), { flag: 'wx', mode: 0o600 });
          fs.renameSync(temp, file);
        } finally { try { fs.unlinkSync(temp); } catch {} }
        return null;
      } catch { return '无法更新官方模型目录'; }
    })().finally(() => inFlight.delete(file));
    inFlight.set(file, job);
  }
  return inFlight.get(file);
}
