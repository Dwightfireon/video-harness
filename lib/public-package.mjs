/* Public delivery is an allowlist, never a copy of the working project.
 * Quality/review gates belong to the caller; force cannot weaken this contract.
 */
import fs from 'node:fs';
import path from 'node:path';
import { artifactStatus, currentArtifactInputs, mediaFingerprint, probeMedia, SOURCE_NAMES } from './artifact-status.mjs';
import { publishStatus } from './publish.mjs';
import { subtitleStatus } from './subtitle-export.mjs';
import { automationPolicy } from './automation.mjs';
import { productionQualityStatus } from './production-quality.mjs';
import { releaseReviewStatus } from './release-review.mjs';
import { coverStatus } from './cover.mjs';
import { assertContentReviewed } from './content-review.mjs';
import { assertVoiceTimingCurrent } from './timing-observation.mjs';
import { workflowPolicy } from './workflow-policy.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identity = s => ({ size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino, dev: s.dev });
const exists = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

function fingerprint(root, relative) {
  // Reject symlinked files AND parents; an allowlisted name must not escape the project.
  const parts = relative.split('/');
  let file = root;
  for (const [i, part] of parts.entries()) {
    file = path.join(file, part);
    let info;
    try { info = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw new Error('打包来源必须是普通文件且不得经过符号链接：' + relative);
    }
  }
  const before = identity(fs.lstatSync(file)), hash = mediaFingerprint(file), after = identity(fs.lstatSync(file));
  if (!hash || !same(before, after) || hash.size !== after.size) throw new Error('读取指纹期间来源发生变化：' + relative);
  return { ...after, sha256: hash.sha256 };
}

function observe(project, withStills) {
  const names = new Set([...SOURCE_NAMES, 'PROJECT.json', 'out/video.mp4', 'out/video-voice.mp4',
    'out/subtitles.srt', '发布文案.md', 'out/.vh-state.json', 'out/.vh-brief.json',
    'out/.vh-publish-revision.json', 'out/.vh-task.json', 'out/seg/manifest.json', 'out/.vh-production-quality.json',
    'claims.json', 'review.json', '审查.md', 'out/cover/manifest.json']);
  const fingerprints = {};
  for (const name of names) fingerprints[name] = fingerprint(project, name);
  const json = relative => fingerprints[relative] ? JSON.parse(fs.readFileSync(path.join(project, relative), 'utf8')) : {};
  const state = json('out/.vh-state.json'), task = json('out/.vh-task.json');
  if (/^[a-zA-Z0-9_-]+$/.test(task.id || '')) {
    const name = `out/.vh-tasks/${task.id}/checkpoint.json`;
    fingerprints[name] = fingerprint(project, name);
  }
  if (withStills && Array.isArray(state.lastStills?.files)) {
    for (const item of state.lastStills.files) if (/^s-\d+\.jpg$/.test(item?.file || '')) {
      const name = 'out/stills/' + item.file;
      fingerprints[name] = fingerprint(project, name);
    }
  }
  for (const file of coverStatus(project).files) {
    const name = 'out/cover/' + file.file;
    fingerprints[name] = fingerprint(project, name);
  }
  return { current: currentArtifactInputs(project), fingerprints, state };
}

function assertUnchanged(project, baseline, withStills) {
  const next = observe(project, withStills);
  if (!same(baseline, next)) throw new Error('打包期间来源、输入签名或版本回执发生变化；未发布交付包，请核对后重新打包');
}

function assertOutputAbsent(outDir, target) {
  if (!exists(outDir)) return;
  const detail = target === 'video' && exists(path.join(outDir, '发布文案.md'))
    ? '；仅视频目标目录已有发布文案.md，未删除或覆盖旧文案' : '';
  throw new Error('输出目录已存在，请另选新的输出目录；未修改已有文件' + detail);
}

function verifyMedia(file, timeline, voiced) {
  const media = probeMedia(file);
  if (!media?.video || voiced && !media.audio || !Number.isFinite(timeline) || timeline <= 0 ||
      [media.duration, Number(media.video.duration), ...(voiced ? [Number(media.audio?.duration)] : [])]
        .filter(n => Number.isFinite(n) && n > 0).some(n => Math.abs(n - timeline) > 0.5)) {
    throw new Error('无法核验当前视频/音轨或时长，拒绝打包：' + path.basename(file));
  }
  return media;
}

function listFiles(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) return listFiles(root, name);
    if (!entry.isFile()) throw new Error('暂存目录出现非普通文件：' + name);
    return [name];
  }).sort();
}

/** Narrow I/O injection for deterministic fault tests; all verification stays mandatory.
 * The returned writer has exactly the same public options as createPublicPackage.
 */
export function createPublicPackageWriter({ copyFileSync = fs.copyFileSync } = {}) {
  return function createPublicPackage(project, outDir, { target = 'publish-package', force = false, draft = false, release = false, withStills = false } = {}) {
    if (release && (force || draft)) throw new Error('发布验收不能与 force/draft 混用；待审包不是发布通过');
    if (!['video', 'publish-package'].includes(target)) throw new Error('交付目标只能是 video 或 publish-package');
    project = fs.realpathSync(path.resolve(project));
    const policy = workflowPolicy(project);
    const reviewRequired = release || policy.releaseReviewRequired;
    const enforceReview = reviewRequired && !force && !draft;
    assertContentReviewed(project);
    assertVoiceTimingCurrent(project);
    outDir = path.resolve(outDir);
    assertOutputAbsent(outDir, target);
    const baseline = observe(project, withStills);
    const status = artifactStatus(project, { state: baseline.state });
    if (status.deliverable.stale) throw new Error('不能打包未完成的视频：' + status.deliverable.reason + '；force 不跳过媒体核验');
    if (automationPolicy(project).enabled) {
      const quality = productionQualityStatus(project, { profile: policy.qualityProfile, phase: 'final' });
      if (!quality.ok) throw new Error('自动制作最终质量回执无效：' + quality.reason + '；先 vh quality，force 不能跳过');
    }
    const sourceMedia = verifyMedia(path.join(project, 'out/video-voice.mp4'), baseline.current.timelineDur, true);
    const pub = target === 'publish-package' ? publishStatus(project) : null;
    if (pub && !pub.ok) throw new Error('发布包不完整：' + pub.errors.map(e => e.message).join('；') + '；force 不跳过发布文案检查');
    const covers = coverStatus(project);
    const warnings = covers.ok ? ['封面已绑定当前文案与输入并核验指纹；生成不代表人工查看或审美通过。']
      : ['未携带封面：未绑定当前输入或文件指纹不符；请 vh cover 后重新打包。'];
    const review = releaseReviewStatus(project);
    if (enforceReview && !review.ok) throw new Error('发布验收未通过：' + review.issues.map(i => i.message).join('；') + '。可用 --draft 导出待审包；不得把未验证项标成通过');
    const packageStatus = enforceReview && review.ok ? 'release-review-recorded' : 'draft';
    const explicitDraft = force || draft;
    if (packageStatus === 'draft') warnings.push(reviewRequired || explicitDraft
      ? '待审包：未通过正式发布验收，不得将导出成功当作发布通过。'
      : '交付文件已就绪；人工审阅为可选项，未验证事项不标通过，导出不代表发布授权。');
    if (status.warnings?.length) warnings.push('视频存在待人工复核的语义要求；机械核验不代表人工验收。');
    for (const warning of pub?.warnings || []) warnings.push(warning.message);
    if (force) warnings.push('本次 force 仅表示调用方导出待审包，不覆盖原有质量门槛的失败结论；媒体、版本和文件指纹仍须有效，不代表人工看过或听过。');
    const plan = [
      { source: 'out/video-voice.mp4', file: 'video-voice.mp4', why: '当前带配音成片' },
      ...(baseline.fingerprints['out/video.mp4'] ? [{ source: 'out/video.mp4', file: 'video.mp4', why: '当前静音母版（可选）' }] : []),
      { source: '脚本.md', file: '脚本.md', why: '当前公开脚本' },
      ...(pub ? [{ source: '发布文案.md', file: '发布文案.md', why: '发布文案（机械检查，不代表人工审阅）' }] : []),
    ];
    for (const file of covers.files) plan.push({ source: 'out/cover/' + file.file, file: file.file, why: '绑定当前输入并核验指纹的独立比例封面（未自动审美验收）' });
    const subtitles = subtitleStatus(project);
    if (subtitles.ok) plan.push({ source: 'out/subtitles.srt', file: 'subtitles.srt', why: '与当前时间轴和文案一致的字幕' });
    else warnings.push('未携带字幕：字幕缺失、无效或已过期；请运行 vh subtitles 后重新打包。');
    if (withStills) {
      const receipt = baseline.state.lastStills;
      if (receipt?.sourceSignature !== baseline.current.sourceSignature || !Array.isArray(receipt.files) || !receipt.files.length) {
        throw new Error('withStills 缺少当前输入签名及文件指纹回执；请重新运行 vh stills');
      }
      const seen = new Set();
      for (const item of receipt.files) {
        if (!/^s-\d+\.jpg$/.test(item?.file || '') || seen.has(item.file) ||
            !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !Number.isSafeInteger(item.size) || item.size <= 0) {
          throw new Error('静帧回执格式无效或文件重复；请重新运行 vh stills');
        }
        seen.add(item.file);
        const source = 'out/stills/' + item.file, hash = baseline.fingerprints[source];
        if (!hash || hash.sha256 !== item.sha256 || hash.size !== item.size) throw new Error('静帧文件与当前回执指纹不符：' + item.file + '；请重新运行 vh stills');
        plan.push({ source, file: 'stills/' + item.file, why: '绑定当前输入并核验指纹的逐场静帧' });
      }
    }
    for (const item of plan) if (!baseline.fingerprints[item.source]) throw new Error('缺少必需的公开文件：' + item.file);
    assertUnchanged(project, baseline, withStills);

    // Same-parent staging guarantees a same-volume rename. Only this unique directory is ever removed.
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(outDir), '.' + path.basename(outDir) + '.partial-'));
    let published = false;
    try {
      const files = [], copied = [];
      for (const item of plan) {
        const destination = path.join(staging, item.file), expected = baseline.fingerprints[item.source];
        if (!same(fingerprint(project, item.source), expected)) throw new Error('复制前来源发生变化：' + item.file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(project, item.source), destination, fs.constants.COPYFILE_EXCL);
        const actual = fingerprint(staging, item.file);
        if (!same(fingerprint(project, item.source), expected) || actual?.sha256 !== expected.sha256 || actual?.size !== expected.size) {
          throw new Error('复制期间来源变化或目标 SHA/大小不匹配：' + item.file);
        }
        const entry = { file: item.file, why: item.why, bytes: actual.size };
        copied.push(entry); files.push({ ...entry, sha256: actual.sha256 });
      }
      assertUnchanged(project, baseline, withStills);
      verifyMedia(path.join(staging, 'video-voice.mp4'), baseline.current.timelineDur, true);
      if (plan.some(item => item.file === 'video.mp4')) verifyMedia(path.join(staging, 'video.mp4'), baseline.current.timelineDur, false);
      const createdAt = new Date().toISOString();
      const note = ['# 公开交付说明', '', `打包时间：${createdAt}`, `交付目标：${target}`,
        `当前输入签名：${baseline.current.sourceSignature}`, `有声视频时长：${sourceMedia.duration.toFixed(3)}s`, '',
        '本包仅含明确列出的公开交付文件，不含内部制作、证据、原文或审查资料。',
        '程序核验文件指纹、当前版本、媒体流及时间轴；不声称人工看过、听过或审阅通过。',
        `交付状态：${packageStatus !== 'draft' ? '发布审阅已登记（不是程序的语义质量保证）' : reviewRequired || explicitDraft ? '待审（不是发布通过）' : '已就绪（人工审阅可选，未代为验证）'}`,
        `工作流：${policy.profile}；机器质量范围：${policy.qualityProfile}；人工审阅：${reviewRequired ? '要求登记（draft/force 可导出待审包）' : '可选，不阻塞普通交付'}`,
        'force/draft 只导出待审包；不改变任何审阅结论，不跳过媒体与版本核验。', '',
        '| 文件 | 用途 | 字节数 |', '|---|---|---|', ...copied.map(c => `| ${c.file} | ${c.why} | ${c.bytes} |`), '',
        '## 提醒与待人工确认', ...warnings.map(w => '- ' + w),
        '- 事实、脱敏语义、画面、听感及发布口径未经打包程序人工确认。',
        '- manifest.json 记录所有载荷及本说明的 SHA-256；清单不包含自身指纹。', ''].join('\n');
      fs.writeFileSync(path.join(staging, '交付说明.md'), note, { flag: 'wx' });
      const noteHash = fingerprint(staging, '交付说明.md');
      files.push({ file: '交付说明.md', why: '机械核验范围与未验证事项', bytes: noteHash.size, sha256: noteHash.sha256 });
      const manifest = { version: 1, target, createdAt, status: packageStatus, deliveryReady: true, releaseReady: packageStatus === 'release-review-recorded',
        workflow: policy.profile, qualityProfile: policy.qualityProfile,
        review: { required: reviewRequired, state: review.state, statuses: review.statuses, issueCount: review.issues.length }, sourceSignature: baseline.current.sourceSignature,
        sourceHashes: baseline.current.sourceHashes, qualityGateOverride: Boolean(force), humanReview: 'not-verified-by-packager',
        media: { duration: sourceMedia.duration, video: Boolean(sourceMedia.video), audio: Boolean(sourceMedia.audio) },
        publish: pub ? { ok: pub.ok, revision: pub.revision.state, sourceSignature: pub.revision.sourceSignature, sha256: pub.revision.publishHash } : null,
        warnings, files, integrity: 'SHA-256 covers every file except manifest.json itself' };
      const manifestText = JSON.stringify(manifest, null, 2) + '\n';
      fs.writeFileSync(path.join(staging, 'manifest.json'), manifestText, { flag: 'wx' });
      if (!same(listFiles(staging), [...files.map(f => f.file), 'manifest.json'].sort())) throw new Error('暂存目录文件不符合公开白名单');
      for (const entry of files) {
        const actual = fingerprint(staging, entry.file);
        if (actual?.sha256 !== entry.sha256 || actual?.size !== entry.bytes) throw new Error('发布前目标 SHA/大小不匹配：' + entry.file);
      }
      if (fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8') !== manifestText) throw new Error('暂存清单发生变化');
      assertUnchanged(project, baseline, withStills);
      assertContentReviewed(project);
      assertVoiceTimingCurrent(project);
      if (enforceReview && !releaseReviewStatus(project).ok) throw new Error('打包期间审阅或依据发生变化；未发布交付包');
      assertOutputAbsent(outDir, target);
      fs.renameSync(staging, outDir);
      published = true;
      return { outDir, copied, warnings, deliveryReady: true, releaseReady: manifest.releaseReady,
        review: manifest.review, qualityProfile: policy.qualityProfile };
    } finally {
      if (!published) fs.rmSync(staging, { recursive: true, force: true });
    }
  };
}

export const createPublicPackage = createPublicPackageWriter();
