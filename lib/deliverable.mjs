/* Completion and snapshot share one read-only artifact contract. A silent
 * render (even if newer) is never a full voiced-video deliverable. */
import { artifactStatus } from './artifact-status.mjs';
import { publishStatus } from './publish.mjs';
import { contentReviewStatus } from './content-review.mjs';
import { voiceTimingFromFile } from './timing-observation.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { parseScript } from './state.mjs';

export function deliverableState(project, { artifact } = {}) {
  const video = artifact || artifactStatus(project).deliverable, content = contentReviewStatus(project);
  if (!video.stale) {
    const voice = voiceTimingFromFile(project);
    if (!voice.ok) return { ...video, content, voice, stale: true, reason: '配音缓存身份已失效：' + voice.reason + '；先重测' };
  }
  if (!content.required) return video;
  return video.stale || content.ok ? { ...video, content }
    : { ...video, content, stale: true, reason: '内容审稿未通过：' + content.reason };
}

/* 视频凭证不受文案改动影响；全流程交付另加发布包门槛。 */
export function projectDeliveryState(project) {
  const video = deliverableState(project), publish = publishStatus(project);
  return video.stale || !publish.required || publish.ok ? { ...video, publish }
    : { ...video, stale: true, reason: '发布文案未通过：' + publish.errors.map(e => e.message).join('；'), publish };
}

/* Editing a script/copy/preview is not a request to render a whole video. */
export function taskDeliveryState(project, mode) {
  if (mode === 'edit-copy') {
    const publish = publishStatus(project);
    return { stale: !publish.ok, reason: publish.ok ? null : publish.errors.map(item => item.message).join('；'), kind: 'copy', publish };
  }
  if (mode === 'edit-script') {
    let text = '';
    try { text = fs.readFileSync(path.join(project, '脚本.md'), 'utf8'); } catch {}
    const scenes = parseScript(text);
    const ok = scenes.length > 0 && scenes.every((scene, i) => scene.n === i + 1 && scene.lines.length);
    return { stale: !ok, reason: ok ? null : '脚本缺少连续编号场景与实际编号旁白，未认定讲述修改完成', kind: 'script' };
  }
  if (mode === 'edit-visual') {
    const result = artifactStatus(project);
    return { stale: !!result.stale.scene, reason: result.stale.scene || null, kind: 'preview' };
  }
  return ['article', 'topic'].includes(mode) ? projectDeliveryState(project) : deliverableState(project);
}
