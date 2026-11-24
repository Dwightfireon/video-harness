/* 发布文案的只读解析与机械校验；不生成内容，不替用户登记人工审阅。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJSON } from './checkpoint.mjs';
import { projectPendingChanges } from './change-contract.mjs';
import { splitTags } from './tags.mjs';
import { BILIBILI_LIMITS, publishLimitIssues } from './publish-limits.mjs';
import { audienceIssues } from './publish-audience.mjs';

const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const REVISION = project => path.join(project, 'out/.vh-publish-revision.json');

export function publishInputs(project) {
  const script = read(path.join(project, '脚本.md'));
  const brief = read(path.join(project, 'out/.vh-brief.json'));
  let requirements = null;
  try {
    const data = JSON.parse(brief || '{}');
    requirements = { must: data.must || [], mustNot: data.mustNot || [], facts: data.facts || [], urls: data.urls || [] };
  } catch { requirements = { invalid: digest(brief) }; }
  const sourceHashes = { script: script.trim() ? digest(script) : null, requirements: digest(requirements) };
  return { sourceHashes, sourceSignature: digest(sourceHashes) };
}

export function publishRevision(project) {
  const current = publishInputs(project), md = read(path.join(project, '发布文案.md'));
  let receipt = null;
  try { receipt = JSON.parse(read(REVISION(project))); } catch {}
  const valid = receipt?.version === 1 && receipt.sourceHashes && receipt.sourceSignature === digest(receipt.sourceHashes) && typeof receipt.publishHash === 'string';
  const publishHash = md ? digest(md) : null;
  const state = !md ? 'missing' : !valid ? 'untracked'
    : receipt.sourceSignature !== current.sourceSignature ? 'stale'
      : receipt.publishHash !== publishHash ? 'edited' : 'current';
  return { state, ...current, publishHash, recordedAt: valid ? receipt.recordedAt : null,
    confirmedBy: valid ? (['user', 'agent', 'system'].includes(receipt.by) ? receipt.by : 'user') : null };
}

/* 回执只关联输入和文案字节，不声称机器懂语义，更不表示用户审阅过成片。
 * by 区分是谁确认的：user 手动核对、agent 执行器写稿、system 程序补参考链接。
 * 三者都不等于人工审看，界面按各自口径展示，不互相冒充。 */
export function confirmPublishRevision(project, { sourceSignature, publishHash, by = 'user' } = {}) {
  const current = publishRevision(project), md = read(path.join(project, '发布文案.md'));
  if (!sourceSignature || !publishHash || sourceSignature !== current.sourceSignature || publishHash !== current.publishHash) {
    throw new Error('脚本、要求或文案在核对期间已改变；未关联旧版本，请刷新后重新核对');
  }
  if (!current.sourceHashes.script) throw new Error('缺少有效脚本，不能将文案关联到当前稿');
  const checked = checkPublish(md);
  if (!checked.ok) throw new Error('文案尚不完整：' + checked.errors.map(e => e.message).join('；'));
  atomicJSON(REVISION(project), { version: 1, sourceHashes: current.sourceHashes, sourceSignature,
    publishHash, by: ['agent', 'system'].includes(by) ? by : 'user', recordedAt: new Date().toISOString() });
  return publishRevision(project);
}
/* 执行器收尾时登记文案版本。
 *
 * 用于 opencode 这类"运行在独立进程、不经过受控写入钩子"的执行器：
 * 本轮开始前记下 baseline，结束后若文案字节变了、脚本/要求没变、机械检查通过，
 * 就按 agent 关联当前稿。条件不满足只返回原因，绝不硬关联旧稿或冒充人工核对。
 * 本地执行器仍在写入钩子里即时登记，不用这个函数。 */
export function settlePublishWrite(project, { baseline } = {}) {
  const md = read(path.join(project, '发布文案.md'));
  if (!md.trim()) return { recorded: false, reason: 'missing-copy' };
  const current = publishRevision(project);
  if (current.state === 'current') return { recorded: false, reason: 'already-current' };
  if (baseline && baseline.sourceSignature && baseline.sourceSignature !== current.sourceSignature) {
    return { recorded: false, reason: 'inputs-changed' };
  }
  if (baseline && baseline.publishHash && baseline.publishHash === current.publishHash) {
    return { recorded: false, reason: 'unchanged' };
  }
  if (!current.sourceHashes.script) return { recorded: false, reason: 'no-script' };
  if (!checkPublish(md).ok) return { recorded: false, reason: 'incomplete' };
  confirmPublishRevision(project, { sourceSignature: current.sourceSignature, publishHash: current.publishHash, by: 'agent' });
  return { recorded: true, reason: 'recorded' };
}

export const DELIVERY_TARGETS = ['video', 'publish-package'];
export function deliveryTarget(project) {
  const raw = read(path.join(project, 'PROJECT.json'));
  const target = JSON.parse(raw || '{}').deliveryTarget ?? 'publish-package';
  if (!DELIVERY_TARGETS.includes(target)) throw new Error('deliveryTarget 只能是 video 或 publish-package');
  return target;
}
export function setDeliveryTarget(project, target) {
  if (!DELIVERY_TARGETS.includes(target)) throw new Error('交付目标只能是 video 或 publish-package');
  const file = path.join(project, 'PROJECT.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  atomicJSON(file, { ...config, deliveryTarget: target });
  return target;
}

export function parsePublish(md) {
  if (!md) return null;
  const blocks = {};
  let cur = null;
  for (const raw of md.split('\n')) {
    const h = raw.match(/^##\s*(.+?)\s*$/);
    if (h) { cur = h[1]; blocks[cur] = []; continue; }
    if (cur) blocks[cur].push(raw);
  }
  const sec = kw => {
    const key = Object.keys(blocks).find(k => k.includes(kw));
    return key ? blocks[key].join('\n').trim() : '';
  };
  const clean = t => t.replace(/^>\s?.*$/gm, '').replace(/^[-*]\s*/gm, '').trim();
  const tlines = sec('标题').split('\n').map(x => x.trim()).filter(l => l && !/^>/.test(l));
  /* 作者常写「主标题：XXX」。前缀是标记不是正文，去掉再用；
   * 否则标题会原样带着「主标题：」发到平台。 */
  const stripLabel = text => text.replace(/^\s*(?:主标题|标题|主|副标题|副)\s*[：:]\s*/, '').trim();
  /* 备选标题既可能写成 `- xxx`，也可能写成 `1. xxx`。
   * 两种都是作者的自然写法，不能只认一种——否则备选全丢，
   * 界面只剩一个主标题，用户以为丢了内容。 */
  const isAlt = line => /^[-*•]/.test(line) || /^\d+[.、)]\s+/.test(line);
  const isNumbered = line => /^\d+[.、)]\s+/.test(line);
  const altText = line => stripLabel(line.replace(/^[-*•]\s*/, '').replace(/^\d+[.、)]\s+/, ''));
  /* 小标题行（「备选：」「副标题：」）不是标题正文，直接跳过；
   * 否则会被当成主标题或备选。 */
  const isCaption = line => /^(?:备选|备用|副标题|一句话简介|推荐|说明)/.test(line) || /[：:]$/.test(line);
  const plainMain = stripLabel((tlines.find(l => !isCaption(l) && !isAlt(l)) || '')
    .replace(/^[“"「]+|[”"」]+$/g, '').trim());
  let alts = tlines.filter(isAlt).map(altText).filter(Boolean);
  /* 只有编号、没有普通标题行时，把第一条提升为主标题。
   * 作者写「1. 甲 / 2. 乙」通常就是这个意思；如果让主标题留空，
   * 后面会报「缺少标题」，反而逼人重新排版。checkPublish 会给可修正提示。 */
  let main = plainMain;
  if (!main && alts.length && tlines.some(isNumbered)) { main = alts[0]; alts = alts.slice(1); }
  const tags = sec('标签').split('\n').map(l => l.trim())
    .map(l => l.replace(/^[-*•]\s*/, '').trim())
    .filter(l => l && !/^主标签|^备选|^>/.test(l))
    .flatMap(l => splitTags(l)).map(l => l.replace(/^#/, '').trim()).filter(Boolean);
  return { main, alts, tags, desc: clean(sec('简介')), comment: clean(sec('置顶评论')),
    cover: clean(sec('封面文案')), checklist: sec('检查清单'), raw: md };
}

export function checkPublish(md) {
  const copy = parsePublish(md), errors = [], warnings = [];
  const issue = (code, field, message) => ({ code, field, message });
  if (!md?.trim()) errors.push(issue('missing', 'file', '还没有发布文案.md'));
  else {
    // 标题写成编号列表是最常见的写法错误：解析器只取第一行，标题会带上 "1. "，
    // 其余备选被当成备选标题，用户看到的是"标题里有个 1."，却不知道为什么。
    const titleSection = (() => {
      const blocks = {}; let cur = null;
      for (const raw of md.split('\n')) {
        const h = raw.match(/^##\s*(.+?)\s*$/);
        if (h) { cur = h[1]; blocks[cur] = []; continue; }
        if (cur) blocks[cur].push(raw);
      }
      const key = Object.keys(blocks).find(k => k.includes('标题'));
      return key ? blocks[key].join('\n') : '';
    })();
    if (/^\s*\d+[.、)]\s+\S/m.test(titleSection)) {
      warnings.push(issue('title-numbered', 'main',
        '标题小节里有「1. 2. 3.」编号行：已按备选标题读取；编号会让平台标题带上序号，建议备用 - 列表'));
    }
    for (const [field, label] of [['main', '标题'], ['desc', '简介'], ['comment', '置顶评论'], ['cover', '封面文案']]) {
      const text = copy[field];
      if (!text || /^(?:无|暂无|待补|待填写|（还没写）|[-—]+)$/.test(text)) errors.push(issue('required', field, `缺少${label}`));
    }
    if (copy.cover && /^(?:主[：:]\s*(?:\n|$)|主[：:]\s*副[：:])/m.test(copy.cover)) {
      errors.push(issue('required', 'cover', '封面主文案不能为空'));
    }
    // 只扫描真正会被复制发布的字段，不把内部来源表、模板说明或检查清单当发布内容。
    for (const field of ['main', 'desc', 'comment', 'cover', 'alts', 'tags']) {
      const text = Array.isArray(copy[field]) ? copy[field].join('\n') : copy[field];
      const placeholder = text.match(/<[^>\n]*(?:链接|文案|标题|待填|待补|URL)[^>\n]*>|[【\[]\s*(?:待填|待补|请填|占位)[^\]】\n]*[\]】]|^(?:TODO|TBD)(?:\s*[：:].*|\s*)$|(?:待填写|待补充|请替换)(?:链接|文案|标题)?/im);
      if (placeholder) errors.push(issue('placeholder', field, `${field === 'comment' ? '置顶评论' : ({ main: '标题', desc: '简介', cover: '封面文案', alts: '备选标题', tags: '标签' }[field])}仍有占位内容：${placeholder[0]}`));
    }
    if (!copy.tags.length || copy.tags.every(tag => /^(?:无|暂无|待补|待填写|[-—]+)$/.test(tag))) {
      errors.push(issue('tags', 'tags', '缺少标签；请从当前内容中选取并填写'));
    }
    // 标签被写成 "A · B · C" 时，中点会连成一整个标签，或者被拆出孤立的 "·"。
    // 这类格式错误不报错的话，会上传成一个奇怪的长标签。
    const junk = copy.tags.filter(tag => /^[·・|｜/／,，、;；-]+$/.test(tag));
    if (junk.length) warnings.push(issue('tags-separator', 'tags',
      `标签里出现分隔符碎片「${[...new Set(junk)].join(' ')}」：用 · | / 之类符号分隔不会被识别，请一行一个，或用空格、逗号、顿号`));
    else if (copy.tags.some(tag => /[·・]/.test(tag))) warnings.push(issue('tags-separator', 'tags',
      '有标签内部含「·」：如果这是分隔符，请改成一 行一个或空格/逗号分隔，否则它会作为一个整体标签上传'));
    // 默认交付到现有 B 站发布台；与表单使用同一套硬限制，不等到上传前才发现。
    errors.push(...publishLimitIssues({ title: copy.main, tags: copy.tags, desc: copy.desc })
      .map(problem => ({ ...problem, field: problem.field === 'title' ? 'main' : problem.field })));
    /* 公开字段会原样出现在平台上。取材、抓取失败、核证状态是项目内部记录，
     * 写进简介或置顶评论属于泄露制作过程，观众也不需要看。 */
    const audience = audienceIssues(copy);
    errors.push(...audience.errors);
    warnings.push(...audience.warnings);
  }
  const unchecked = (copy?.checklist.match(/^[ \t]*[-*]\s+\[ \]/gm) || []).length;
  if (unchecked) warnings.push(issue('review', 'checklist', `发布前检查清单有 ${unchecked} 项未勾选；须人工审阅，不自动勾选`));
  return { ok: !errors.length, state: !md?.trim() ? 'missing' : errors.length ? 'blocked' : 'checked', errors, warnings, unchecked };
}

export function publishStatus(project) {
  const result = checkPublish(read(path.join(project, '发布文案.md')));
  const revision = publishRevision(project);
  if (revision.state === 'stale') result.errors.push({ code: 'stale', field: 'file', message: '脚本或明确要求已改变；发布文案仍关联旧稿，请核对并更新后再确认版本' });
  if (revision.state === 'untracked') result.warnings.push({ code: 'untracked', field: 'file', message: '历史文案尚未关联脚本版本；请人工核对后关联当前稿，不将文件存在当作最新版' });
  if (revision.state === 'edited') result.warnings.push({ code: 'edited', field: 'file', message: revision.confirmedBy === 'system'
    ? '程序补充过参考链接并重新关联；正文措辞仍需人工核对，关联不等于人工审阅通过'
    : '文案有手动修改；修改已保留，请核对并重新关联当前稿' });
  for (const change of projectPendingChanges(project).filter(c => c.scope === 'publish')) {
    result.errors.push({ code: 'requirement', field: 'file', message: '文案修改要求尚未核验：' + change.text.slice(0, 120) });
  }
  if (result.errors.length) { result.ok = false; if (result.state !== 'missing') result.state = 'blocked'; }
  return { ...result, revision, required: deliveryTarget(project) === 'publish-package' };
}

export function publishWriteRefusal(project, relative, content) {
  if (relative === 'PROJECT.json') {
    try {
      if ((JSON.parse(content).deliveryTarget ?? 'publish-package') !== deliveryTarget(project)) return '拒绝：制作 Agent 不能自行切换交付目标来跳过发布包；请由用户在页面或 delivery-target 命令中选择';
    } catch { return '拒绝：项目交付目标配置无效，未写入'; }
  }
  if (relative !== '发布文案.md') return null;
  const checked = md => parsePublish(md)?.checklist.match(/^[ \t]*[-*]\s+\[[xX]\].*$/gm) || [];
  const before = new Set(checked(read(path.join(project, relative))));
  if (checked(content).some(line => !before.has(line))) return '拒绝：制作 Agent 不能新增人工审阅勾选；请保留未勾选状态，由用户实际审阅后手动登记';
  return null;
}

export function reviewStatus(project) {
  const publish = parsePublish(read(path.join(project, '发布文案.md')));
  const review = read(path.join(project, '审查.md'));
  const checks = [publish?.checklist || '', review].map(md => ({
    total: (md.match(/^[ \t]*[-*]\s+\[[ xX]\]/gm) || []).length,
    unchecked: (md.match(/^[ \t]*[-*]\s+\[ \]/gm) || []).length,
  }));
  const recorded = checks.every(c => c.total > 0 && c.unchecked === 0);
  return { state: recorded ? 'recorded' : 'pending', unchecked: checks.reduce((n, c) => n + c.unchecked, 0),
    message: recorded ? '人工审阅已登记（勾选记录，不是程序的质量保证）' : '内容、画面与发布口径仍须人工审阅；程序不会自动勾选' };
}

export const PUBLISH_TASK = '只处理发布文案.md，不改脚本、场景、方案、推广事实或任何媒体。先读当前脚本、已有发布文案及用户要求；保留用户已有标题和无关修改，已有文案用短补丁修复，缺失时才新建。' +
  '\n使用这些二级标题：## 标题、## 简介、## 置顶评论、## 标签、## 封面文案、## 发布前检查清单。标题正文首行写主标题，备选标题用列表；标签一行一个；封面用“主：…”“副：…”。' +
  `\n当前默认发布台为 B 站：主标题最多 ${BILIBILI_LIMITS.title} 字，简介最多 ${BILIBILI_LIMITS.desc} 字，标签最多 ${BILIBILI_LIMITS.tags} 个、每个最多 ${BILIBILI_LIMITS.tag} 字（长度按 String.length 计算）。超限须修正文案，不能仅作提醒或自动截断用户文案。` +
  /* 这条不是风格偏好，是发布边界：标题/简介/置顶评论/标签/封面会原样出现在公开页面。 */
  '\n【写给观众，不是写给项目】标题、简介、置顶评论、标签、封面文案会原样公开。只写观众需要的：这期讲什么、能带走什么、想继续看什么。以下内容一个字都不要出现在这些字段：取材与检索过程（抓了什么、没抓到什么、被什么拦住）、来源的采用与弃用、核证状态、证据强弱、待人工审阅或待补充提醒、模型/工具/执行器名称、本地文件与目录路径、本机环境或个人隐私信息（如用户主目录路径、用户名、主机名、本地端口、密钥、TTS 音色、个人设备信息）、制作幕后形态（如「口播稿转成的视频」「由脚本/AI 自动生成」「工作台/发布台/自动巡航」等）、内部字段名、批次或任务编号。写不出可公开的内容就留空并说明缺项，不要用内部记录填满字数；这些记录属于项目文件，不属于发布文案。' +
  '\n必须写出标题、简介、置顶评论、标签和封面文案；标签只从当前内容选取。只依据当前脚本与已明确给定的信息，不编链接、优惠码或实测结果，不保留占位符。广告逐项对照用户口径，不擅自增加风险提示、劝诫或评价；若已知重要限制或法律、平台要求与用户口径冲突，单独说明并确认，不隐瞒也不擅自改写。没有推广信息就不写推广，必要信息只能用户提供时明确说明缺项并暂停，不猜测补齐。不自动勾选人工检查清单。';
