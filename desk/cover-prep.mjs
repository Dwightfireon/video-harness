/* 封面预处理：B 站对封面有硬性门槛，不合规会在提交时整体失败。
 *
 * 已知要求（2026-10 核对创作中心提示与 biliup 行为）：
 *   - 尺寸不得低于 960×600，推荐 1146×717（16:9）；
 *   - 格式 jpg / png；
 *   - 接口用 base64 表单上传，体积越大越慢，超过 5MB 基本会被拒。
 *
 * 这里不做“悄悄改用户图”：先如实报告尺寸与体积；只有超限时才转码成
 * JPEG（1920 宽、质量 88），并返回转码后的临时文件与原因，调用方负责清理。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const COVER_MIN_WIDTH = 960;
export const COVER_MIN_HEIGHT = 600;
export const COVER_MAX_BYTES = 5 * 1024 * 1024;
const SAFE_BYTES = 3.5 * 1024 * 1024;

export function probeImage(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,codec_name', '-of', 'json', file], { encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) return null;
  try {
    const stream = JSON.parse(result.stdout)?.streams?.[0];
    const width = Number(stream?.width), height = Number(stream?.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
    return { width, height, codec: stream?.codec_name || '', bytes: fs.statSync(file).size };
  } catch { return null; }
}

export function coverIssues(info) {
  const issues = [];
  if (!info) return ['无法读取封面尺寸（文件可能损坏或不是图片）'];
  if (info.width < COVER_MIN_WIDTH || info.height < COVER_MIN_HEIGHT) {
    issues.push(`封面 ${info.width}×${info.height}，低于 B 站要求的 ${COVER_MIN_WIDTH}×${COVER_MIN_HEIGHT}`);
  }
  if (info.bytes > COVER_MAX_BYTES) issues.push(`封面 ${(info.bytes / 1048576).toFixed(1)}MB，超过 5MB 上限`);
  return issues;
}

/* 发布素材快照只报告阻断尺寸项；最终投稿仍执行完整 prepareCover。 */
export function prepareCoverIssues(file) {
  return coverIssues(probeImage(file)).filter(text => /低于 B 站要求/.test(text));
}

export function coverWarnings(info) {
  if (!info) return [];
  const warnings = [];
  const ratio = info.width / info.height;
  if (Math.abs(ratio - 16 / 9) > 0.06) warnings.push(`封面比例 ${ratio.toFixed(2)}:1 不是 16:9，B 站会裁掉两侧或上下`);
  if (info.bytes > SAFE_BYTES) warnings.push(`封面 ${(info.bytes / 1048576).toFixed(1)}MB，上传会比较慢，提交前会转码`);
  return warnings;
}

function reencode(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-cover-'));
  const out = path.join(dir, 'cover-bili.jpg');
  const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file,
    '-vf', 'scale=min(1920\\,iw):-2', '-q:v', '3', out], { encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0 || !fs.existsSync(out)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: '封面转码失败：' + String(result.stderr || '').slice(-160) };
  }
  return { ok: true, file: out, dir };
}

/* 返回 { ok, file, temp, info, issues, warnings, note }。
 * ok=false 时 issues 说明为什么不能提交（尺寸过小这类靠转码救不了）。 */
export function prepareCover(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, issues: ['没有封面文件'], warnings: [] };
  const info = probeImage(file);
  const issues = coverIssues(info);
  const warnings = coverWarnings(info);
  // 尺寸过小无法靠转码修好——放大只会更糊，要求重新生成。
  const blocking = issues.filter(text => /低于 B 站要求/.test(text));
  if (blocking.length) return { ok: false, file, info, issues, warnings };
  if (!issues.length && info.bytes <= SAFE_BYTES) return { ok: true, file, info, issues, warnings, temp: false, note: '' };
  const converted = reencode(file);
  if (!converted.ok) return { ok: false, file, info, issues: issues.concat(converted.error), warnings };
  const after = probeImage(converted.file);
  return { ok: true, file: converted.file, temp: true, tempDir: converted.dir, info: after || info, original: info,
    issues: [], warnings, note: `已转码为 ${after?.width || '?'}×${after?.height || '?'} JPEG` };
}

export function cleanupCover(prepared) {
  if (prepared?.tempDir) { try { fs.rmSync(prepared.tempDir, { recursive: true, force: true }); } catch {} }
}
