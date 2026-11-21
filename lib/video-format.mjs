/* 项目级画幅：用户明确选择后保存为制作约束，而非临时播放器缩放。 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const VIDEO_FORMATS = Object.freeze({
  '16:9': Object.freeze({ aspectRatio: '16:9', orientation: 'landscape', width: 1920, height: 1080 }),
  '9:16': Object.freeze({ aspectRatio: '9:16', orientation: 'portrait', width: 1080, height: 1920 }),
});
const ORIENT = /\bconst\s+ORIENT\s*=\s*(['"])(landscape|portrait|square)\1\s*;/;
const metadata = project => JSON.parse(fs.readFileSync(path.join(project, 'PROJECT.json'), 'utf8'));
const atomic = (file, text) => {
  const temp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, text, { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
};
export function validAspectRatio(value) { return typeof value === 'string' && Object.hasOwn(VIDEO_FORMATS, value); }
export function selectedVideoFormat(project) {
  let info;
  try { info = metadata(project).videoFormat; } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (info == null) return null;
  if (!validAspectRatio(info.aspectRatio)) throw new Error('项目画幅配置无效，请在工作台重新选择 16:9 或 9:16');
  return VIDEO_FORMATS[info.aspectRatio];
}
function orientation(file) {
  try { return fs.readFileSync(file, 'utf8').match(ORIENT)?.[2] || null; } catch { return null; }
}
export function videoFormatState(project) {
  const selected = selectedVideoFormat(project);
  const templateOrientation = orientation(path.join(project, 'engine.tpl.html'));
  const actualOrientation = orientation(path.join(project, 'scene.html'));
  const inferred = Object.values(VIDEO_FORMATS).find(f => f.orientation === (templateOrientation || actualOrientation));
  const format = selected || inferred;
  let templateNewer = false;
  try { templateNewer = fs.statSync(path.join(project, 'engine.tpl.html')).mtimeMs > fs.statSync(path.join(project, 'scene.html')).mtimeMs; } catch {}
  return { aspectRatio: format?.aspectRatio || null, orientation: format?.orientation || templateOrientation,
    width: format?.width || null, height: format?.height || null, locked: !!selected, actualOrientation,
    pendingBuild: !actualOrientation || templateNewer || !!format && (actualOrientation !== format.orientation || templateOrientation !== format.orientation) };
}
export function enforceVideoFormat(project) {
  const selected = selectedVideoFormat(project);
  if (!selected) return false; // 旧项目不擅自改方向，直到用户明确选择。
  const file = path.join(project, 'engine.tpl.html'), before = fs.readFileSync(file, 'utf8');
  if (!ORIENT.test(before)) throw new Error('引擎没有可识别的 ORIENT 声明，未强行改写，请核对模板');
  const next = before.replace(ORIENT, `const ORIENT = '${selected.orientation}';`);
  if (before === next) return false;
  atomic(file, next); return true;
}
export function selectVideoFormat(project, aspectRatio) {
  if (!validAspectRatio(aspectRatio)) throw new Error('画幅只能选择 16:9 或 9:16');
  const config = metadata(project), tpl = path.join(project, 'engine.tpl.html');
  const before = fs.readFileSync(tpl, 'utf8');
  if (!ORIENT.test(before)) throw new Error('引擎没有可识别的 ORIENT 声明，未保存画幅');
  const selected = VIDEO_FORMATS[aspectRatio];
  const next = before.replace(ORIENT, `const ORIENT = '${selected.orientation}';`);
  if (config.videoFormat?.aspectRatio === aspectRatio && before === next) return videoFormatState(project);
  const dir = path.join(project, 'out', '.vh-format-backups', Date.now() + '-' + randomUUID().slice(0, 8));
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['PROJECT.json', 'engine.tpl.html', 'scene.html']) {
    const file = path.join(project, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, name));
  }
  // 先持久化用户选择；即使随后崩溃，下一次 build 仍会按选择纠正模板。
  atomic(path.join(project, 'PROJECT.json'), JSON.stringify({ ...config,
    videoFormat: { ...selected, selectedAt: new Date().toISOString() } }, null, 2) + '\n');
  if (before !== next) atomic(tpl, next);
  return videoFormatState(project);
}
export function assertVideoFormat(project) {
  const selected = selectedVideoFormat(project);
  if (!selected) return;
  const state = videoFormatState(project);
  if (state.pendingBuild || state.actualOrientation !== selected.orientation || orientation(path.join(project, 'engine.tpl.html')) !== selected.orientation) {
    throw new Error(`画幅与用户选择 ${selected.aspectRatio}（${selected.width}×${selected.height}）不一致；先运行 vh build，核对布局后整片重渲，不能拉伸旧视频`);
  }
}
export function videoMediaFormatError(project, file, observation) {
  const selected = selectedVideoFormat(project);
  if (!selected || !fs.existsSync(file)) return null;
  let stream;
  if (observation !== undefined) stream = observation?.video;
  else {
    const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], { encoding: 'utf8', timeout: 10000 });
    if (result.status === 0) { try { stream = JSON.parse(result.stdout).streams[0]; } catch {} }
  }
  if (!stream?.width || !stream?.height) return '无法核验成片画幅，不能当作用户所选画幅的成片交付';
  if (stream.width !== selected.width || stream.height !== selected.height) return `成片为 ${stream.width}×${stream.height}，用户选择的是 ${selected.aspectRatio}（${selected.width}×${selected.height}）；需要按所选画幅重新排版并整片渲染，不能拉伸旧视频`;
  return null;
}
export function videoFormatPrompt(project) {
  try {
    const selected = selectedVideoFormat(project);
    if (!selected) return '';
    return `【用户选定画幅】${selected.aspectRatio}，${selected.width}×${selected.height}，${selected.orientation}。这是项目保存的用户选择，不得自行改成另一方向或改 PROJECT.json 取消约束。用 window.W/window.H 按该尺寸排版，检查字幕和越界；若旧场景按另一方向制作，先修布局，再 build、整片 render 和 voice。改变画幅不要求重写原稿或重做已有有效配音测量。`;
  } catch { return '【画幅配置异常】先修复项目画幅配置，不能假定方向并交付。'; }
}
export function formatWriteRefusal(project, relative, content) {
  const selected = selectedVideoFormat(project);
  if (!selected) return null;
  if (relative === 'PROJECT.json') {
    try {
      const next = JSON.parse(content).videoFormat;
      if (!next || JSON.stringify(next) !== JSON.stringify(metadata(project).videoFormat)) return '拒绝：画幅是用户在工作台保存的选择，制作工具不能改写；请在画幅选项中修改';
    } catch { return '拒绝：不能破坏包含用户画幅选择的 PROJECT.json'; }
  }
  if (['engine.tpl.html', 'scene.html'].includes(relative) && (typeof content !== 'string' || content.match(ORIENT)?.[2] !== selected.orientation)) {
    return `拒绝：文件画幅必须保持用户选定的 ${selected.aspectRatio}，不能删除 ORIENT 或改成另一方向`;
  }
  return null;
}
