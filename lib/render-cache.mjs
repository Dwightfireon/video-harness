/* 增量渲染前只读核对实际分段缓存。目录非空不代表能复用；
 * go 清帧后若分段缺失或签名失效，提前退回整片，不等截图后才失败。
 * 保守要求完整分段与帧：旧 renderer 会重编 padding 触及的整个相邻段，
 * 只有 MP4 分段而无边界帧并不能保证成功；此时应整片，不等截图后才失败。
 */
import fs from 'node:fs';
import path from 'node:path';

export function sharedFingerprint(src) {
  const mark = src.indexOf('const scenes = [];');
  const head = mark > 0 ? src.slice(0, mark + 'const scenes = [];'.length) : src;
  let h = 0x811c9dc5;
  for (let i = 0; i < head.length; i++) { h ^= head.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

export function renderCacheState(project, { fps = 30, width = 1920, height = 1080,
  preset = 'medium', crf = '18', ext = 'jpg' } = {}) {
  const fail = reason => ({ canIncrementSafely: false, reason });
  let src, manifest;
  try {
    src = fs.readFileSync(path.join(project, 'scene.html'), 'utf8');
    manifest = JSON.parse(fs.readFileSync(path.join(project, 'out/seg/manifest.json'), 'utf8'));
  } catch { return fail('分段清单缺失或损坏'); }
  const duration = Number(src.match(/DURATION\s*=\s*([\d.]+)/)?.[1]);
  const total = Math.round(duration * fps);
  if (!Number.isFinite(total) || total <= 0) return fail('时间轴无效');
  const starts = [...src.matchAll(/addScene\(\s*([\d.]+)\s*,\s*([\d.]+)/g)]
    .map(m => Math.round(Number(m[1]) * fps)).filter(n => n > 0 && n < total);
  const cuts = [...new Set([0, ...starts, total])].sort((a, b) => a - b);
  const sig = `${fps}|${width}x${height}|${ext}|${preset}|${crf}`;
  if (manifest.sig !== sig) return fail('分段编码参数不符');
  if (manifest.shared !== sharedFingerprint(src)) return fail('分段共享指纹缺失或不符');
  if (manifest.duration !== duration || JSON.stringify(manifest.cuts) !== JSON.stringify(cuts))
    return fail('分段时长或切点不符');
  const files = cuts.slice(1).map((_, i) => `seg-${String(i).padStart(3, '0')}.mp4`);
  if (JSON.stringify(manifest.files) !== JSON.stringify(files)) return fail('分段清单不完整');
  for (const name of files) {
    try {
      const st = fs.statSync(path.join(project, 'out/seg', name));
      if (!st.isFile() || st.size === 0) return fail(`分段为空或不是文件：${name}`);
    } catch { return fail(`分段缺失：${name}`); }
  }
  const frames = path.join(project, 'out/frames');
  let names;
  try { names = new Set(fs.readdirSync(frames)); } catch { return fail('帧缓存已清除；旧 renderer 重编边界相邻段需要完整帧'); }
  // 暂不从多种 renderer 的源码猜测 padding；完整帧是可验证的安全前提。
  for (let i = 0; i < total; i++) {
    const name = String(i).padStart(5, '0') + '.' + ext;
    if (!names.has(name)) return fail('帧缓存不完整；旧 renderer 重编边界相邻段可能缺帧');
    try {
      const stat = fs.statSync(path.join(frames, name));
      if (!stat.isFile() || stat.size === 0) return fail('帧缓存为空或不是文件：' + name);
    } catch { return fail('帧缓存无法读取：' + name); }
  }
  return { canIncrementSafely: true, reason: '分段签名、切点及帧缓存完整' };
}
