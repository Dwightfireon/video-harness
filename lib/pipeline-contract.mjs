/* One contract supplies BOTH the advertised tools and the execution fence.
 * The provider's tool_choice is a hint, never local authorization. */
import path from 'node:path';
import { authorRevision } from './change-contract.mjs';
import { previewAuthorEdit } from './author-edits.mjs';

export const READ_TOOLS = new Set(['read_file', 'read_edit_file', 'read_scene', 'list_files', 'fetch_url', 'inspect_scene_drafts']);
export const WRITE_TOOLS = new Set(['patch_text', 'replace_scene', 'write_file', 'write_scene', 'assemble_scenes',
  'append_file', 'finish_draft', 'finish_repair', 'rebase_scene_drafts', 'review_content']);
export const MACHINE_STAGES = new Set(['build', 'measure', 'render', 'voice', 'validate']);
export const AUTHOR_STAGES = new Set(['author_edit', 'draft_plan', 'draft_script', 'draft_claims', 'draft_scenes', 'review_content']);
export const EDIT_TOOLS = ['read_file', 'read_edit_file', 'read_scene', 'patch_text', 'replace_scene', 'append_file', 'list_files', 'fetch_url'];
export const STAGE_TOOLS = Object.freeze({
  define_change: ['define_change', 'read_file', 'read_edit_file', 'list_files'],
  author_edit: EDIT_TOOLS,
  verify_change: ['verify_change', ...EDIT_TOOLS],
  draft_plan: ['append_file', 'patch_text', 'read_file', 'read_edit_file', 'finish_draft', 'fetch_url'],
  draft_script: ['append_file', 'patch_text', 'read_file', 'read_edit_file', 'finish_draft', 'fetch_url'],
  draft_claims: ['append_file', 'read_file', 'read_edit_file', 'patch_text', 'fetch_url'],
  review_content: ['review_content', 'read_file', 'read_edit_file', 'patch_text', 'fetch_url'],
  draft_scenes: ['write_scene', 'assemble_scenes', 'read_file', 'read_scene', 'read_edit_file', 'replace_scene', 'patch_text', 'list_files', 'inspect_scene_drafts', 'rebase_scene_drafts', 'recover_scene_transaction'],
  build: ['run_stage'], measure: ['run_stage'], render: ['run_stage'], voice: ['run_stage'], validate: ['run_stage'],
  publish: ['read_file', 'read_edit_file', 'write_file', 'patch_text', 'append_file', 'confirm_publish'],
});

export const newStageProgress = () => ({ idle: 0, reads: 0, staleReads: 0, violations: 0 });
// Called once per SETTLED batch, never once per tool or on a proposed tool name.
// `fresh` means a read returned information not already available in this
// attempt. New ranges during a real localization pass must not be counted as
// spinning; only repeated reads of already-seen content are.
export function advanceStageProgress(previous, { changed = false, read = false, fresh = false, violation = false } = {}) {
  const base = previous || newStageProgress();
  if (changed) return newStageProgress();
  return { idle: base.idle + 1, reads: base.reads + Number(read),
    staleReads: fresh ? 0 : (base.staleReads || 0) + 1,
    violations: violation ? (base.violations || 0) + 1 : (base.violations || 0) };
}

export function stageContract(work, { schemas, progress = newStageProgress(), scene = null, readOnly = false,
  uncertain = false, truncations = 0, blocker = false, project } = {}) {
  const known = schemas.map(schema => schema.function.name);
  const revision = project ? authorRevision(project) : null;
  let allowed = readOnly ? [...READ_TOOLS, 'run'] : work?.allowed || known;
  let directed;
  if (!readOnly && work) {
    if (MACHINE_STAGES.has(work.stage)) allowed = ['run_stage'];
    if (work.stage === 'draft_scenes') {
      if (!work.recovery) allowed = allowed.filter(name => name !== 'rebase_scene_drafts');
      if (work.tool !== 'assemble_scenes') allowed = allowed.filter(name => name !== 'assemble_scenes');
    }
    if (work.stage === 'draft_scenes' && scene && !uncertain && progress.idle >= 4) directed = 'write_scene';
    else if (!blocker && !uncertain && (progress.idle >= 2 || truncations > 0) && !AUTHOR_STAGES.has(work.stage)) directed = work.tool;
    else if (!blocker && !uncertain && work.required && work.stage !== 'draft_scenes' &&
      ((AUTHOR_STAGES.has(work.stage) ? progress.staleReads >= 2 : progress.idle >= 2) || truncations > 0)) directed = work.required;
    // Useful new evidence/ranges are not spinning. Only repeated/stale work
    // narrows tools; a cumulative read quota used to cut off real research.
    if (AUTHOR_STAGES.has(work.stage) && progress.staleReads >= 7) {
      allowed = allowed.filter(name => WRITE_TOOLS.has(name) || name === 'read_edit_file');
    }
    if (directed) allowed = [directed];
  }
  const names = new Set(allowed.filter(name => known.includes(name)));
  if (!names.size) throw new Error('阶段工具契约为空，已停止；不会回退到全部工具');
  const schemasForRequest = schemas.filter(schema => names.has(schema.function.name));
  const target = work?.path || ({ draft_plan: '方案.md', draft_script: '脚本.md', draft_claims: 'claims.json',
    draft_scenes: 'scenes.src.js', publish: '发布文案.md' })[work?.stage];
  const editScope = scene?.scene ?? (Number.isInteger(work?.scene) ? work.scene : null);
  const assertBaseline = relative => {
    if (!revision || !['脚本.md', 'scenes.src.js', 'engine.tpl.html'].includes(relative)) return;
    const current = authorRevision(project);
    if (['脚本.md', 'scenes.src.js', 'engine.tpl.html'].some(file => current[file] !== revision[file])) {
      throw new Error('请求期间脚本/场景/引擎基线已改变；未把旧内容写到新版本，先重新核对当前制作关口');
    }
  };
  const validate = call => {
    const name = call.function?.name;
    let args;
    try { args = JSON.parse(call.function?.arguments || '{}'); } catch { return '工具参数必须为合法 JSON 对象；整批未执行'; }
    if (!args || Array.isArray(args) || typeof args !== 'object') return '工具参数必须为 JSON 对象；整批未执行';
    if (name === 'run_stage' && !MACHINE_STAGES.has(args.stage)) return 'run_stage 的 stage 只接受 build|measure|render|voice|validate；查看文件用当前允许的读取工具';
    if (!names.has(name)) return `本轮阶段 ${work?.stage || '只读/通用任务'} 不允许 ${name || '未知工具'}；允许：${[...names].join(', ')}`;
    if (name === 'run_stage' && work && args.stage !== work.stage) return `当前只执行阶段 ${work.stage}，不能执行 ${args.stage}`;
    if (WRITE_TOOLS.has(name) && target) {
      const actual = ['write_scene', 'replace_scene', 'assemble_scenes', 'rebase_scene_drafts'].includes(name) ? 'scenes.src.js' :
        typeof args.path === 'string' ? project ? path.relative(project, path.resolve(project, args.path)) : path.posix.normalize(args.path.replaceAll('\\', '/')) : null;
      if (actual && actual !== target) return `当前只修改 ${target}，不能修改 ${actual}`;
    }
    if (work?.stage === 'review_content' && name === 'patch_text') {
      const actual = typeof args.path === 'string' ? project ? path.relative(project, path.resolve(project, args.path)) : args.path : null;
      if (!['方案.md', '脚本.md', 'claims.json'].includes(actual)) return '内容审稿阶段只修方案、脚本和依据；不能先改画面或审阅回执';
    }
    if (['write_scene', 'replace_scene'].includes(name) && editScope != null && args.scene !== editScope) return `当前任务是 S${editScope}，不能写 S${args.scene}`;
    // A hash-shaped placeholder is not a read receipt. Reject locally with the
    // one action that fixes it, rather than spending a retry on a definite error.
    if (['patch_text', 'replace_scene', 'finish_draft'].includes(name) &&
      typeof args.base_hash === 'string' && args.base_hash && !/^[a-f0-9]{64}$/.test(args.base_hash)) {
      return 'base_hash 必须是 read_edit_file/read_scene 返回的完整 64 位 SHA-256；先读取当前文件，不要自行编造或复用旧指纹';
    }
    if (WRITE_TOOLS.has(name)) {
      const actual = ['write_scene', 'replace_scene', 'assemble_scenes', 'rebase_scene_drafts'].includes(name) ? 'scenes.src.js' :
        typeof args.path === 'string' ? project ? path.relative(project, path.resolve(project, args.path)) : path.posix.normalize(args.path.replaceAll('\\', '/')) : null;
      try { assertBaseline(actual); } catch (error) { return error.message; }
      if (editScope != null && ['patch_text', 'replace_scene', 'append_file'].includes(name)) {
        if (!project) return '本场编辑缺少项目基线，无法核对范围；未执行';
        try {
          previewAuthorEdit(project, actual, { ...args, operation: name === 'append_file' ? 'append_file' : name }, { scene: editScope });
        } catch (error) { return error.message; }
      }
      if (editScope != null && ['write_file', 'assemble_scenes', 'rebase_scene_drafts'].includes(name)) return `当前任务是 S${editScope}，不能整份覆盖或组装其他场次`;
    }
    return null;
  };
  return { schemas: schemasForRequest, names, directed, validate, editScope, assertBaseline };
}
