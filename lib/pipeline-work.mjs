import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { snapshot, parseScript, parseChunks } from './state.mjs';
import { authorRevision, pendingChanges, PUBLIC_AUTHORS, replacementRemainder } from './change-contract.mjs';
import { publishStatus, PUBLISH_TASK } from './publish.mjs';
import { claimsDocumentState } from './claims.mjs';
import { authorDocumentState, sceneAuthoringState } from './author-readiness.mjs';
import { sceneDraftStatus, sceneAssemblyMatches, sceneDraftRecovery } from './scene-drafts.mjs';
import { STAGE_TOOLS } from './pipeline-contract.mjs';
export { EDIT_TOOLS } from './pipeline-contract.mjs';
import { EDIT_TOOLS } from './pipeline-contract.mjs';
import { contentReviewStatus, contentReviewInputs, reviewVersion } from './content-review.mjs';
import { verificationBudgetNote } from './research-attempts.mjs';
import { workflowPolicy } from './workflow-policy.mjs';
export { verificationBudgetNote } from './research-attempts.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
export function callPath(call) {
  try { return JSON.parse(call.function?.arguments || '{}').path || ''; } catch { return ''; }
}

/* 小步骤只暴露需要的工具，模型偏离时本地拒绝，而不是把无关动作一直执行到预算耗尽。 */

export function autoVerificationSummary(change) {
  if (change.scope === 'publish') return '程序只核验本次发布文案修改；视频、脚本和场景保持原样，内容语义仍须人工审阅。';
  return change.semantic
    ? '程序按登记范围机械检查公开作者文件；内容取舍的语义正确性仍须人工审阅。'
    : '程序机械检查公开脚本、全部场景和发布文案，已登记禁止词无残留；内部证据与最终画面仍须人工审阅。';
}

function verifyWork(project, change) {
  return { key: 'verify:' + change.id, changeId: change.id, stage: 'verify_change', tool: 'verify_change',
    required: 'verify_change', allowed: STAGE_TOOLS.verify_change, auto: true,
    note: `当前只核验指令 ${change.id}。公开发布文件已无登记词，执行器将直接做机械核验；不要重复登记清单或搜索内部证据文件。` };
}

export async function nextPipelineWork(project, mode, changes = []) {
  if (!['article', 'topic', 'edit-copy'].includes(mode)) return null;
  const authors = mode === 'edit-copy' ? ['发布文案.md'] : PUBLIC_AUTHORS;
  if (mode === 'edit-copy' && !fs.existsSync(path.join(project, '发布文案.md'))) return publishWork(project);
  const pending = pendingChanges(project, changes);
  if (pending.length) {
    const change = pending[0], revision = authorRevision(project);
    const terms = [...(change.forbidden || []), ...(change.rules || []).map(r => r.from)];
    if (change.kind === 'redact' && !terms.length) {
      const script = fs.readFileSync(path.join(project, mode === 'edit-copy' ? '发布文案.md' : '脚本.md'), 'utf8');
      return { key: 'define:' + change.id, stage: 'define_change', tool: 'define_change',
        required: 'define_change', allowed: STAGE_TOOLS.define_change, auto: false,
        note: `【当前小任务】先定义指令 ${change.id} 的待移除姓名和具体表述，只调用 define_change 输出短 JSON 清单，不重写任何文件、不输出长分析。尚未识别完时可用 read_edit_file 分段核对。\n当前脚本节选：\n${script.slice(0, 8000)}` };
    }
    let file = authors.find(f => {
      try {
        const text = fs.readFileSync(path.join(project, f), 'utf8');
        return (change.forbidden || []).some(term => text.includes(term)) || (change.rules || []).some(rule => replacementRemainder(text, rule).includes(rule.from));
      } catch { return false; }
    });
    if (!file && !terms.length) {
      if (change.kind === 'edit') {
        const changed = (mode === 'edit-copy' ? authors : Object.keys(revision)).some(f => revision[f] !== change.baseline[f]);
        if (changed) return verifyWork(project, change);
        file = mode === 'edit-copy' ? '发布文案.md' : /背景|字体|字号|颜色|配色/.test(change.text) && revision['engine.tpl.html'] ? 'engine.tpl.html' : '脚本.md';
      } else file = authors.find(f => revision[f] && revision[f] === change.baseline[f]);
    }
    if (!file) return verifyWork(project, change);
    const source = fs.readFileSync(path.join(project, file), 'utf8');
    const offset = Math.max(0, source.indexOf(terms.find(term => source.includes(term)) || ''));
    const lines = source.split('\n'), line = source.slice(0, offset).split('\n').length - 1;
    const start = Math.max(0, line - 3), excerpt = lines.slice(start, start + 65).join('\n');
    const sceneNumber = file === 'scenes.src.js' ? source.slice(0, offset).split(/^\/\/---\s*$/m).length : null;
    return { key: 'edit:' + change.id + ':' + file + ':' + hash(source), stage: 'author_edit',
      tool: change.semantic ? 'patch_text' : 'patch_text', required: change.semantic ? null : 'patch_text',
      allowed: STAGE_TOOLS.author_edit, auto: false,
      path: file, scene: sceneNumber,
      note: `【当前小任务】执行指令 ${change.id}，现在只修改 ${file} 中一处，不改其他文件。\n` +
        `文件 base_hash=${hash(source)}；下面为第 ${start} 行开始的节选（行号从0起）：\n${excerpt}\n` +
        (change.semantic
          ? '按用户要求删减/保留内容，只做必要的一处短替换；完成后执行器会记录。语义取舍仍需你说明。'
          : '使用 patch_text，以这个 base_hash 精确替换一个短片段；只是改人名/文案时不要重写整场。find 必须逐字匹配，重复项须明确 expected_count。') };
  }
  if (mode === 'edit-copy') return publishWork(project);
  /* 文件存在只说明第一批落盘，不能跳过尚未提交的后续批次。 */
  for (const [file, stage] of [['方案.md', 'draft_plan'], ['脚本.md', 'draft_script']]) {
    const document = authorDocumentState(project, file);
    if (document.ok) continue;
    return { key: stage + ':' + document.state + ':' + document.base_hash, stage, path: file,
      tool: 'append_file', required: document.state === 'missing' ? 'append_file' : null,
      allowed: STAGE_TOOLS[stage], auto: false,
      note: `【当前制作阶段】下一步用 append_file 分批写 ${file}；全文写完用 finish_draft 提交。${document.reason}。\n` +
        (file === '方案.md'
          ? '先弄清内容再定栏目：标明文章改编/自主调研/混合，目标受众知道与不知道什么，以及要回答的问题。先写可连续读懂的讲述底稿，按内容实际需要交代具体对象、背景、谁做了哪一步、结果与判断依据；再规划分场，不能只列结论和限制。原文保留在 research/原文.md 或原文.txt，调研资料保留在 research/；fetch_url 会为新项目自动保存完整抓取正文。关键出处在方案/脚本中注明原文位置，区分用户提供、外部事实、作者推断与计算；没有读到或独立核实就如实注明，不编造 verified。只读到了链接/摘要时明确缺口，不当作原文已读。必要解释与可删支线分开，范围装不下时说明取舍，不默认每条削薄。\n'
          : '先沿方案的连贯讲述写完整口播，再按自然语义编号和分场；编号行不是字幕字数上限，必要的主语、前提、过程和比较分母要说出口，不能靠标题/术语表/画面补足。资料不足可继续调研，不先写结论再找佐证。删改时保住形成理解所必需的解释；信息太多先缩支线，不删逻辑中段。\n') +
        `用 append_file 分批写 ${file}，每批不超过 3000 字符；第一批不带 base_hash，之后用上一批返回的 base_hash 继续追加。` +
        (document.base_hash ? `\n当前 base_hash=${document.base_hash}；保留已写内容，不从头覆盖。` : '') +
        (file === '脚本.md' ? (document.state === 'missing' ? '\n先写头部与 S1–S2，之后每批 2–3 场' : '\n从尚未写完的位置继续，每批补 2–3 场，不重写已有开场') +
          '，直到方案中的场次全部写完。主体字段用 **主体**：<讲解对象>；让观众在开场知道讲什么，不要求逐字重复主体字段，不为形式规则删掉比较对象。' : '') +
        '\n全文真正写完后，用 finish_draft({path:"' + file + '",base_hash:"最后一次写入返回的指纹"}) 提交；不提交就仍在本阶段。不要把第一批当成整稿，也不要再翻源码猜格式。' + verificationBudgetNote(project) };
  }
  const claimsState = workflowPolicy(project).claimsRequired ? claimsDocumentState(project) : null;
  if (claimsState && !claimsState.ok) {
    return { key: 'draft_claims:' + claimsState.state, stage: 'draft_claims', path: 'claims.json', tool: 'append_file', required: claimsState.state === 'missing' ? 'append_file' : null,
      allowed: STAGE_TOOLS.draft_claims, auto: false,
      note: '【当前制作阶段】证据表还没完整提交。用 append_file 分批写 claims.json（合法 JSON 数组，每批不超过 3000 字符）；第一批写 [ 与前半条目，最后一批收尾 ]。已有半稿先 read_edit_file 取 base_hash，再继续追加或 patch_text 修复，不得当作已完成跳过。不要整份一次输出。\n' +
        '【先定来源类型，再决定要不要查外部】用户已经给了文章/原文时，那篇文章就是本片的主要来源：把全文存进 research/原文.md，片子里沿用它的关键断言按 sourceType="user-provided" 登记（evidence 用项目内 path + 当前 sha256 + locator + 原文 quote + type + checkedAt），不标 verified、不强求 URL。不要在用户原文之外再做一轮全站核证，也不要为了把条目升级成 external 去反复搜索。只有原文没有、又要说出口的具体事实（日期、数字、机构名、政策名）才需要外部来源。\n' +
        '每条必需 id、assertion（旁白原句）、kind、scope、sourceType、evidence。\n' +
        '外部事实 sourceType="external"，有真实 url；evidence 含 url/quote/type/checkedAt，确实读到并核对后才用 status="verified"，抓取403/未读原文用 unverified，不用无关官方链接补缺。\n' +
        '作者建议/归纳用 sourceType="recommendation"，计算用 "calculation" 并另填 calculation（输入、算式与结果），用户提供的文章/资料用 "user-provided"。这些不是外部核证，不标 verified，也不强求 URL。\n' +
        '外部核证是有预算的：fetch_url 的 assertion 填要核证的具体原句；一条具体断言连续 2 次尝试仍取不到原文（搜索被拦、反爬、404），执行端会拒绝同一断言的继续抓取。就按 unverified 登记或从口播里删去该细节，然后继续写稿。不要为一条可删的背景细节换搜索引擎反复硬查；写稿与分镜才是本阶段之后真正耗时的工作。\n' +
        '本机或现场实测用 sourceType="measurement"，必须登记有当前 SHA-256 的本地原始记录；可另引外部标准说明方法，但不能用标准或自写说明冒充测量结果。\n' +
        '本地依据 evidence 填项目内 path、当前 sha256、章节/行段 locator、原文 quote、type、checkedAt；引用真实原稿/当前脚本的建议段/要求记录，不能编出处。\n' +
        'quote 只放对应来源的真实原文；自己的解释、推算或实测结果另行登记，不能为了消除数字警告拼进外部摘录。\n' +
        '外部事实示例：[{"id":"C1","assertion":"企业收入占比约 80%","url":"https://example.com/report","kind":"一手","scope":"2026 上半年","sourceType":"external","status":"unverified","evidence":[{"url":"https://example.com/report","quote":"待核资料中记载的原句","type":"待核","checkedAt":"2026-10-27"}]}]\n' +
        '用户提供原文示例：[{"id":"C1","assertion":"2026年人社部门组织的专项行动设置了行业专场。","kind":"用户提供原文","scope":"仅限用户提供的文章，未独立核证","sourceType":"user-provided","evidence":[{"path":"research/原文.md","sha256":"<该文件当前 SHA-256>","locator":"第三节第二段","quote":"与 assertion 逐字对应的原文句","type":"用户提供原文","checkedAt":"2026-11-05"}]}]\n' +
        verificationBudgetNote(project) + '\n' +
        '字段规范已在上方给全，不要再读 lib/ 下的源码去猜。' };
  }
  const review = contentReviewStatus(project);
  if (review.required && !review.ok) {
    const input = contentReviewInputs(project);
    // The isolated reviewer gets complete sources directly; do not resend the
    // entire research corpus to the author on every repair turn.
    const display = input.context ? { ...input, context: { materials: input.context.materials.map(({ path, sha256 }) => ({ path, sha256 })), omitted: input.context.omitted } } : input;
    return { key: 'review_content:' + input.signature + ':' + review.state, stage: 'review_content', tool: 'review_content', required: null,
      allowed: STAGE_TOOLS.review_content, auto: false,
      note: '【分镜前内容审稿】只读编号旁白能否理解，不用标题、画面或术语表补台阶。先质疑核心关联是否成立，不预设两个领域是同一结构。逐场核对人物/时空/信息交接，列出关键推断的依据→中间变化→结论及类比对应/差异；讲不通就返修或删关联，不只加过渡词。无固定句数或推断条数配额。\n' +
        (reviewVersion(project) >= 3
          ? '只用 review_content({signature}) 发起独立审稿，不提交作者自评和 pass 理由。复核使用隔离上下文：先只听旁白复原，再对照任务、原文/调研资料查遗漏与无效推断；语义复核不依赖 keyClaims 是否命中。缺资料不能编通过。返修先 patch_text 修改方案/脚本/claims，再重新审稿，不能先做画面。审稿仍不是观众测试、实际试听或人工发布通过。\n'
          : '用 review_content 提交当前 signature、question、answer、scope、scenes:[{scene,quote,takeaway,bridge}]、links:[{premise,middle,conclusion}]、analogies:[{claim,mapping,limit}]、findings:[{finding,reason}]、issues:[]、verdict:"pass"|"revise"。当前输入的 keyClaims 中每一个比较/推荐/行动结论，pass 时都必须由一条 links 覆盖；quote/推导/类比证据必须逐字来自编号旁白，middle 不能重复 premise 或 conclusion。未解决问题不能报 pass。返修可 patch_text 修改方案/脚本/claims 后重审，不能先做画面。记录不是观众理解测试或人工发布通过。\n') +
        '当前状态：' + review.state + (review.reason ? '；' + review.reason : '') + '\n当前纯旁白与机器线索（来源正文由独立审稿直接读取）：\n' + JSON.stringify(display) };
  }
  const sceneCount = parseScript(fs.readFileSync(path.join(project, '脚本.md'), 'utf8')).length;
  const sceneState = sceneAuthoringState(project), drafts = sceneDraftStatus(project);
  /* Existing author scenes are the source of truth once the project has really
   * produced something (a film, or draft state from earlier authoring). A bare
   * count mismatch during first-time authoring must still go through drafts;
   * otherwise a half-written script would jump straight to build. */
  const hasDeliverable = fs.existsSync(path.join(project, 'out/video.mp4')) || fs.existsSync(path.join(project, 'out/video-voice.mp4'));
  const editingExisting = sceneCount > 0 && parseChunks(path.join(project, 'scenes.src.js')).length > 0 &&
    !sceneState.needed && (!!drafts || hasDeliverable);
  if (!editingExisting && (sceneState.needed || sceneCount !== parseChunks(path.join(project, 'scenes.src.js')).length ||
    drafts && !drafts.stale && !sceneAssemblyMatches(project))) {
    const assemble = drafts && !drafts.stale && drafts.count === sceneCount && !drafts.missing.length;
    let recovery;
    if (drafts?.stale || drafts?.transaction?.pending) {
      try { recovery = sceneDraftRecovery(project); }
      catch (error) { recovery = { can_rebase: false, error: error.message }; }
    }
    return { key: 'draft_scenes:' + hash(JSON.stringify(authorRevision(project))) + ':' + JSON.stringify(drafts),
      stage: 'draft_scenes', tool: drafts?.transaction?.pending ? 'recover_scene_transaction' : drafts?.stale ? 'rebase_scene_drafts' : assemble ? 'assemble_scenes' : 'write_scene', required: null,
      recovery,
      allowed: STAGE_TOOLS.draft_scenes, auto: false,
      note: '【当前制作阶段】画面尚未完成：' + (sceneState.reason || '脚本与场景数量不一致或分场草稿尚未齐备') +
        (drafts?.transaction?.pending ? '。分场草稿事务有遗留门；执行器先只读核对死亡持有者与活动代，只有可证明才清理该门，不删除草稿或历史。'
          : drafts?.stale ? '。已有草稿基线已过期；执行器将核对后受控重开草稿，只复用身份未变的场次并归档旧稿。源码冲突不会覆盖，须先核对当前作者文件。'
          : assemble ? '。全部分场草稿已保存，现在调用 assemble_scenes 组装，再进行 build。'
            : `。按完整脚本的 ${sceneCount} 场逐场调用 write_scene 保存真实内容，全部齐备后 assemble_scenes。不要复制初始化示例，也不要因场数碰巧相等就直接 build。`) };
  }
  const state = await snapshot(project);
  if (state.stale.duration && !state.stale.scene && state.timing.state === 'valid') {
    /* 只说"超了、去删"是不够的：模型会反复跑 vh trim、读 timing.json 摸方案，
     * 而编辑阶段这些 run 会按"偏离"计，连续几轮就被暂停。
     * 真实事故：author_edit 连续 4 轮没有规定动作 → 暂停 → 用户点继续又立刻暂停。
     * 方案本来就能算出来，所以直接算好放进提示，让它照着改。 */
    let plan = '';
    try {
      const { trimPlan } = await import('./trim.mjs');
      const { durationLimit } = await import('./duration-limit.mjs');
      const p = trimPlan(project, { limit: durationLimit(project) || { maxSeconds: 240 } });
      if (p.ok) {
        const lines = [`实测总长 ${p.total}s，上限 ${p.max}s，需削减 ${p.over}s。各场实测：`];
        for (const s of p.scenes) {
          lines.push(`  S${s.n} · ${s.title} — ${s.dur}s，${s.chars} 字，被 ${s.refCount} 场依赖${s.structural ? '（结构位，不删）' : ''}`);
        }
        if (p.cuts.length) {
          lines.push('待评估整场删（仅表示无显式后续引用，不保证语义可删）：' +
            p.cuts.map(c => `S${c.n}（${c.dur}s）`).join('、') + `，合计省 ${p.saved}s。`);
        } else {
          lines.push('没有零引用整场候选；可缩小支线范围并同步重写后续，不必强行场内削薄。');
        }
        if (p.compressible?.length) {
          lines.push('时长复核候选（语速密度不是教学价值，不据此删句）：' +
            p.compressible.map(c => `S${c.n}（${c.dur}s，每秒 ${c.density.toFixed(1)} 字）`).join('、'));
        }
        if (!p.enough) lines.push(`⚠ 候选秒数仍不足；先缩支线/讨论拆集，仍冲突时由用户决定是否放宽 ${p.max}s 上限，不删必要解释。`);
        plan = '\n' + lines.join('\n');
      }
    } catch {}
    return { key: 'duration:' + hash(JSON.stringify(authorRevision(project))), stage: 'author_edit',
      tool: 'patch_text', required: null, allowed: EDIT_TOOLS, auto: false,
      note: '【时长超限，禁止继续渲染】' + state.stale.duration + plan +
        '\n先确认候选确实是可删支线，保护对象、前提、行动过程、判断依据和必要限定；用 patch_text 改脚本并同步对应场景。改稿后自查内容，再按关口 build → measure；不自动启用模型审稿。' +
        '上面只有时长是测量/估算，取舍不是实测结论；不要按密度盲删，不靠加速或裁尾过关。' };
  }
  const stage = state.stale.scene ? 'build' : state.timing.state !== 'valid' || state.stale.measure ? 'measure'
    : state.stale.render ? 'render' : state.stale.voice ? 'voice' : 'validate';
  if (stage === 'validate') {
    const work = publishWork(project);
    if (work && publishStatus(project).required) return work;
  }
  let engine = ''; try { engine = fs.readFileSync(path.join(project, 'engine.tpl.html'), 'utf8'); } catch {}
  return { key: stage + ':' + String(state.sceneM) + ':' + hash(JSON.stringify(authorRevision(project)) + engine),
    stage, tool: 'run_stage', required: 'run_stage', allowed: STAGE_TOOLS[stage],
    auto: stage === 'validate',
    note: stage === 'validate'
      ? '【当前制作阶段】validate。执行器将直接核对交付物；不通过时先补实际缺失的阶段，不要只汇报完成。'
      : `【当前制作阶段】${stage}。下一步用 run_stage({stage:"${stage}"})，由程序以固定参数执行和检查；不要再读 harness 源码，也不要把 shell 管道退出码当成阶段验收。` };
}

function publishWork(project) {
  const status = publishStatus(project);
  if (status.ok) return null;
  const file = path.join(project, '发布文案.md');
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return { key: 'publish:' + hash(source) + ':' + status.revision.sourceSignature, stage: 'publish', path: '发布文案.md', auto: false,
    tool: status.revision.state === 'stale' ? 'confirm_publish' : source ? 'patch_text' : 'write_file', required: null, allowed: STAGE_TOOLS.publish,
    note: '【当前制作阶段】publish。视频不需要重做，现在只补齐发布文案。\n' + PUBLISH_TASK +
      '\n机械检查缺项：' + status.errors.map(e => e.message).join('；') +
      '\n版本信息：' + JSON.stringify(status.revision) + '。已有文案若仍符合当前脚本，可先核对内容，再调用 confirm_publish 关联当前输入；不要为了改版本而强行改写用户标题。关联不是人工审阅通过。' +
      (source ? '\n已有文案必须先 read_edit_file，再用 patch_text 做短替换；不要覆盖整份。' : '\n用 write_file 创建发布文案.md。') };
}
