/* A declared review must bind current bytes. This does not prove a human watched.
 * Keep pending, stale and failed distinct from a recorded pass. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { selectVoiceScript } from './voice-script.mjs';
import { claimEvidenceStatus } from './claim-evidence.mjs';

const REQUIRED = ['scene.html', '脚本.md', 'claims.json', 'scenes.src.js', 'engine.tpl.html', 'timing.json', 'out/video-voice.mp4'];
function fileHash(project, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('证据须为项目内相对路径');
  let file = project;
  for (const part of relative.split('/')) {
    file = path.join(file, part);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('审阅文件不得经过符号链接');
  }
  const before = fs.statSync(file);
  if (!before.isFile()) throw new Error('审阅文件不是普通文件');
  const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); let n;
  try { while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  const hash = digest.digest('hex'), after = fs.statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw new Error('读取审阅文件期间发生变化');
  return hash;
}

export function releaseReviewStatus(project) {
  const issues = [], statuses = { content: 'pending', visual: 'pending', audio: 'pending' };
  const issue = (code, message) => issues.push({ code, message });
  let document;
  try { document = JSON.parse(fs.readFileSync(path.join(project, 'review.json'), 'utf8')); }
  catch { issue('review-missing', '缺少有效 review.json；用 vh review-init --snapshot 创建待审快照'); }
  if (document) {
    if (document.schemaVersion !== 1 || document.final !== 'out/video-voice.mp4' || !document.files || typeof document.files !== 'object' || Array.isArray(document.files)) {
      issue('review-format', '审阅快照格式或成片路径无效');
    } else {
      const valid = new Set();
      for (const name of REQUIRED) if (!Object.hasOwn(document.files, name)) issue('review-unbound', '审阅未绑定当前必需输入：' + name);
      for (const [name, expected] of Object.entries(document.files)) {
        try {
          if (!/^[a-f0-9]{64}$/.test(expected) || fileHash(project, name) !== expected) throw new Error('文件已变或指纹无效');
          valid.add(name);
        } catch { issue('review-stale', '审阅指纹无效、文件缺失或已过期：' + name); }
      }
      for (const category of Object.keys(statuses)) {
        const review = document.reviews?.[category];
        statuses[category] = ['pass', 'pending', 'needs_changes', 'failed'].includes(review?.status) ? review.status : 'pending';
        if (review?.status !== 'pass') issue('review-pending', category + ' 审阅未通过／未执行');
        else if (typeof review.notes !== 'string' || !review.notes.trim() || !Array.isArray(review.evidence) || !review.evidence.length ||
          review.evidence.some(name => !valid.has(name))) issue('review-evidence', category + ' 缺结论说明或当前版本的有效证据');
      }
      if (!Array.isArray(document.issues) || document.issues.length) issue('review-issues', '审阅问题清单缺失或仍有未解决项');
    }
  }
  const claims = claimEvidenceStatus(project, { release: true });
  issues.push(...claims.findings.map(f => ({ code: f.kind, message: f.msg })));
  return { ok: !issues.length, state: issues.length ? 'pending' : 'recorded', statuses, issues,
    scope: '只核对审阅声明、证据指纹与来源登记；不证明人工真正看过/听过，也不验证事实语义与审美。' };
}

export function initReviewSnapshot(project, { refresh = false } = {}) {
  const file = path.join(project, 'review.json');
  if (fs.existsSync(file)) {
    if (!refresh) throw new Error('review.json 已存在，未覆盖；需要新快照用 review-init --snapshot --force（旧记录将归档，所有项重置待审）');
    const archive = path.join(project, 'out/review-history'); fs.mkdirSync(archive, { recursive: true });
    fs.copyFileSync(file, path.join(archive, randomUUID() + '.json'), fs.constants.COPYFILE_EXCL);
  }
  const files = {};
  const voiceName = selectVoiceScript(project).name;
  for (const name of [...REQUIRED, '审查.md', 'gen.mjs', 'render.mjs', voiceName, 'entts.py'].filter(Boolean)) {
    if (fs.existsSync(path.join(project, name))) files[name] = fileHash(project, name);
  }
  const document = { schemaVersion: 1, final: 'out/video-voice.mp4', files, issues: [],
    reviews: Object.fromEntries(['content', 'visual', 'audio'].map(key => [key, { status: 'pending', notes: '', evidence: [] }])) };
  const temp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(document, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
  return document;
}
