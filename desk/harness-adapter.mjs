/* harness 适配层：把 vh 项目里“文案 / 成片 / 封面”的读取集中在一处。
 *
 * 为什么要这一层：发布台的其余部分（草稿组装、投稿编排、界面）不应该知道
 * lib/publish.mjs 的字段名、artifactStatus 的过期判定、封面 manifest 的结构。
 * 将来这些内部结构变了，只改这个文件；换掉 harness 也能只替换这一层。
 *
 * 约定（发布台唯一的项目接口）：
 *   readCopy(dir)     → { title, alts, desc, comment, tags, coverMain, coverSub } | null
 *   readCopyStatus(dir) → { ok, errors: string[], warnings: string[] }
 *   readVideo(dir)    → { file, path, kind, bytes, duration } | null
 *   readVideoState(dir) → { stale, reason }
 *   readMedia(dir)     → { video, videoState }（一次快照，优先使用）
 *   readCover(dir)    → { ok, file, path, bytes, thumb } | { ok:false, reason }
 *   readReview(dir)   → 当前审阅声明、指纹和依据核验结果（不证明真人已审）
 */
import fs from 'node:fs';
import path from 'node:path';

const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return '' }; };
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false } };
const sizeOf = file => { try { return fs.statSync(file).size; } catch { return 0 } };

async function harness() {
  const publish = await import('../lib/publish.mjs');
  const artifacts = await import('../lib/artifact-status.mjs');
  const cover = await import('../lib/cover.mjs');
  const review = await import('../lib/release-review.mjs');
  const deliverable = await import('../lib/deliverable.mjs');
  return { publish, artifacts, cover, review, deliverable };
}

export function createHarnessAdapter({ loadHarness = harness } = {}) {
  let loaded = null;
  const lib = () => (loaded ||= loadHarness());

  async function readMedia(dir, { metadataOnly = false } = {}) {
    const candidates = [{ file: 'out/video-voice.mp4', kind: '带配音成片', statusKey: 'voice' },
      { file: 'out/video.mp4', kind: '静音母版', statusKey: 'render' }];
    const selected = candidates.find(item => isFile(path.join(dir, item.file)));
    if (!selected) return { video: null, videoState: { stale: false, reason: null } };
    const { file, kind, statusKey } = selected;
    const full = path.join(dir, file);
    const video = { file, kind, path: full, bytes: sizeOf(full), duration: null };
    if (metadataOnly) return { video, videoState: { stale: true, reason: '项目制作中，尚未核验目录中遗留的成片' } };
    try {
      // 仅在本次请求内共用；不跨请求缓存媒体/指纹，避免源文件改变后错误复用。
      const loaded = await lib();
      const status = loaded.artifacts.artifactStatus(dir);
      video.duration = status[statusKey]?.media?.duration ?? null;
      video.fingerprint = status[statusKey]?.fingerprint?.sha256 || null;
      // 与工作台共用完整成片合同，额外保留配音身份及历史必审合同；复用本轮媒体核验，不重复整片哈希。
      const delivery = loaded.deliverable ? loaded.deliverable.deliverableState(dir, { artifact: status.deliverable }) : status.deliverable;
      const reason = delivery?.reason || (statusKey === 'render' ? '只有静音母版，请先生成带配音成片（vh voice --srt）' : null);
      return { video, videoState: { stale: Boolean(delivery?.stale || reason), reason } };
    } catch (error) { return { video, videoState: { stale: true, reason: '无法核验成片：' + error.message } }; }
  }

  return {
    async readProduction(dir, options) { return (await import('../lib/project-state.mjs')).observeProjectTask(dir, options); },
    async readCopy(dir) {
      const { publish } = await lib();
      const copy = publish.parsePublish(read(path.join(dir, '发布文案.md')));
      if (!copy) return null;
      return { title: copy.main, alts: copy.alts || [], desc: copy.desc || '', comment: copy.comment || '',
        tags: copy.tags || [], coverMain: '', coverSub: '', cover: copy.cover || '' };
    },

    async readCopyStatus(dir) {
      const { publish } = await lib();
      const status = publish.publishStatus(dir);
      return { ok: Boolean(status.ok), state: status.state, revision: status.revision?.state ?? null,
        errors: (status.errors || []).map(item => item.message), warnings: (status.warnings || []).map(item => item.message) };
    },

    readMedia,
    async readVideo(dir) { return (await readMedia(dir)).video; },
    async readVideoState(dir) { return (await readMedia(dir)).videoState; },

    async readCover(dir) {
      const cover = (await lib()).cover.coverStatus(dir);
      if (!cover.ok) return { ok: false, code: cover.code || 'invalid', reason: cover.reason || '封面未绑定当前输入' };
      const wide = cover.files.find(item => item.file === 'cover-16x9.png') || cover.files[0];
      const full = path.join(dir, 'out/cover', wide.file);
      if (!isFile(full)) return { ok: false, reason: '封面文件缺失' };
      const thumb = path.join(dir, 'out/cover', wide.file.replace(/^cover-/, 'thumb-'));
      return { ok: true, file: wide.file, path: full, bytes: sizeOf(full), thumb: isFile(thumb) ? thumb : null };
    },

    async readReview(dir) {
      try { return (await lib()).review.releaseReviewStatus(dir); }
      catch (error) { return { ok: false, state: 'unavailable', statuses: {}, issues: [{ message: '无法核验审阅：' + error.message }] }; }
    },
  };
}
