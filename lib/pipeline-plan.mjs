/* 只读执行计划：只读作者数据与媒体探针，不 import/执行项目 timeline.mjs 或调用模型。 */
import fs from 'node:fs';
import path from 'node:path';
import { artifactStatus, currentArtifactInputs, hashFile } from './artifact-status.mjs';
import { videoFormatState } from './video-format.mjs';
import { subtitleStatus } from './subtitle-export.mjs';
import { renderSettings, renderBudget, diskObservation, budgetReport, renderRequestError } from './render-budget.mjs';
import { publishStatus } from './publish.mjs';
import { automationPolicy } from './automation.mjs';
import { timingObservation } from './timing-observation.mjs';
import { durationLimit, durationLimitError } from './duration-limit.mjs';
import { contentReviewStatus } from './content-review.mjs';
import { selectVoiceScript } from './voice-script.mjs';
export { timingObservation } from './timing-observation.mjs';

const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const json = file => { try { return JSON.parse(read(file)); } catch { return null; } };
export function pipelinePlan(project, options = {}, dependencies = {}) {
  const automation = automationPolicy(project, options.unattended ? true : undefined);
  const p = name => path.join(project, name), state = json(p('out/.vh-state.json')) || {};
  // artifactStatus already reads and hashes the current inputs. Reuse that
  // exact observation within this plan rather than hashing every asset twice;
  // this is not a cross-request cache and never replaces production checks.
  const observed = (dependencies.artifactStatus || artifactStatus)(project);
  const current = observed.current || (dependencies.currentArtifactInputs || currentArtifactInputs)(project);
  const timing = timingObservation(project, options), format = videoFormatState(project);
  const settings = renderSettings({ ...options, width: format.width || 1920, height: format.height || 1080 }, dependencies.machine);
  const disk = (dependencies.diskObservation || diskObservation)(project);
  const duration = timing.total || current.timelineDur;
  const resources = duration ? { ...renderBudget({ duration, settings, freeBytes: disk.freeBytes }), volume: disk.volume } : null;
  const voice = selectVoiceScript(project);
  const missing = ['PROJECT.json', '脚本.md', 'scenes.src.js', 'engine.tpl.html', 'gen.mjs'].filter(name => !fs.existsSync(p(name)));
  if (!voice.name) missing.push('配音脚本（需支持 --measure --apply）');
  const measure = timing.state !== 'valid' || state.lastMeasure?.scriptHash !== hashFile(p('脚本.md')) || !!options.remeasure || options.maxspeed !== undefined;
  const limit = durationLimit(project);
  const durationIssue = timing.state === 'valid' ? durationLimitError(limit, timing.total, '配音实测') : null;
  // A requested/required measurement may change the duration; do not prevent
  // it from running, but expose the current overshoot as a conditional warning.
  const warnings = durationIssue && measure ? [durationIssue + '；计划重测后须重新判断。'] : [];
  const content = contentReviewStatus(project);
  const blockers = [...(content.required && !content.ok ? ['内容审稿未通过：' + content.reason] : []),
    ...(missing.length ? ['缺少制作输入/程序：' + missing.join('、')] : []),
    ...(renderRequestError(options) ? [renderRequestError(options)] : []),
    ...(observed.stale.requirements ? [observed.stale.requirements] : []), ...(!resources?.ok && resources ? ['目标卷不足 512 MiB 渲染安全余量'] : []),
    ...(durationIssue && !measure ? [durationIssue] : [])];
  const steps = [], add = (id, label, status, reason) => steps.push({ id, label, status, reason });
  if (content.required) add('content-review', '分镜前内容审稿', content.ok ? 'reuse' : 'manual', content.reason || '当前旁白已登记审稿判断；不是观众理解或人工发布通过');
  const build = !!observed.stale.scene;
  const renderRequested = ['all', 'fps', 'crf', 'preset', 'hq', 'release', 'scenes', 'from', 'to', 'encodeOnly', 'force'].some(key => options[key] !== undefined && options[key] !== false);
  const mixRequested = ['voice', 'speed', 'bgm', 'sfx', 'bgmvol', 'sfxvol', 'noCache'].some(key => options[key] !== undefined && options[key] !== false);
  add('build', '构建预览', build ? 'run' : 'reuse', observed.stale.scene || '当前构建输入未变');
  add('measure', '实测配音', measure ? 'run' : 'reuse', measure ? timing.state !== 'valid' ? timing.reason : '缺测量基线或明确要求重测' : timing.reason);
  add('render', '渲染静音视频', observed.stale.render || renderRequested ? 'run' : build || measure ? 'conditional' : 'reuse',
    observed.stale.render || (renderRequested ? '明确指定渲染参数；执行前核对复用条件' : build || measure ? '上游执行后按新输入重新判定，不预先重渲' : '当前媒体凭证有效'));
  if (automation.enabled) add('quality-pre', '严格前置机器质检', 'conditional', '实际渲染前验证结构/时间轴/素材与画面；检查失败不能跳过');
  const upstream = steps.some(s => s.status === 'run' || s.status === 'conditional');
  add('voice', '配音混流', observed.stale.voice || mixRequested ? 'run' : upstream ? 'conditional' : 'reuse',
    observed.stale.voice || (mixRequested ? '明确指定混流/音色参数' : upstream ? '上游执行后再核验，不提前重混' : '当前带声媒体凭证有效'));
  const { expected, ...subtitles } = subtitleStatus(project);
  add('subtitles', '导出 SRT', options.srt ? upstream ? 'conditional' : subtitles.ok ? 'reuse' : 'run' : 'not-requested', options.srt ? subtitles.reason : '未要求 SRT；独立导出不启动 TTS/混流');
  const publish = publishStatus(project);
  add('publish', '发布文案', !publish.required ? 'not-requested' : publish.ok ? 'reuse' : 'manual', !publish.required ? '仅视频交付' : publish.ok ? '发布文案机械检查通过' : 'go 不调用模型，须另行补齐/核对文案');
  add('review', '连续视听审阅', 'manual', '机器计划不代表看过画面、听过声音或同意发布');
  if (automation.enabled) add('quality-final', '最终自动机器质检', 'run', '验证实际媒体、字幕、完整解码及有限音频指标；不冒充人工审片或发布授权');
  return { version: 1, readOnly: true, ok: blockers.length === 0, blockers, warnings, steps, timing, resources, settings, subtitles, automation, content,
    next: blockers[0] || steps.find(s => s.status === 'run' || s.status === 'conditional')?.label || '人工核对成片与发布内容',
    note: '这是基于当前文件的计划，不执行项目 JS、模型、TTS、浏览器渲染或写入；上游变化后重新判定。非耗时/费用保证，非完整安装诊断（另见 vh doctor）' };
}

export function planReport(plan) {
  const labels = { run: '需执行', reuse: '复用', conditional: '待上游后核对', 'not-requested': '未要求', manual: '人工/单独处理' };
  return ['制作计划（只读，不启动模型或制作）', ...plan.blockers.map(x => '✗ ' + x), ...(plan.warnings || []).map(x => '⚠ ' + x),
    ...plan.steps.map(s => `  ${s.label}：${labels[s.status]} — ${s.reason}`), '',
    ...(plan.resources ? [budgetReport(plan.resources)] : ['时长未定，暂不估算帧数和空间']), '', '下一步：' + plan.next, plan.note].join('\n');
}
