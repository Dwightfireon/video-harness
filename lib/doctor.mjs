/* lib/doctor.mjs —— 环境体检（vh doctor）
 * 一次看清：运行时、渲染依赖、TTS、项目完整性、产物状态。
 * 只报告，不自动修（避免"悄悄改了环境"）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { localChromeInfo, secureLaunchOptions } from './browser.mjs';

const COMMAND_TIMEOUT = 3000;

function playwrightInfo() {
  const req = createRequire(import.meta.url);
  return { path: req.resolve('playwright'), version: req('playwright/package.json').version };
}

/* 可选 deps 只用于隔离诊断边界；原来的 doctor(project) / report(res) 不变。 */
export async function doctor(project, deps = {}) {
  const io = deps.fs ?? fs;
  const HOME = deps.home ?? (process.env.HOME || os.homedir());
  const spawn = deps.spawnSync ?? spawnSync;
  const run = (cmd, args = ['--version']) => {
    let r;
    try {
      r = spawn(cmd, args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT, killSignal: 'SIGKILL', maxBuffer: 65536, shell: false });
    } catch { return { ok: false, note: '无法执行' }; }
    if (r.error) return { ok: false, note: r.error.code === 'ETIMEDOUT' ? '超时（3 秒）' : r.error.code === 'ENOENT' ? '未安装' : '无法执行' };
    // 不回显任意 stderr / 异常文本，避免诊断信息夹带凭证。
    const version = String(r.stdout || r.stderr || '').match(/^(?:Python|ffmpeg version|ffprobe version)\s+([nN]?\d[\w.+-]*)/);
    return { ok: r.status === 0, note: r.status === 0 ? (version ? version[0].slice(0, 60) : '可执行') : '命令失败' };
  };
  const checks = [];
  const add = (group, name, r, hint) => checks.push({ group, name, ok: !!r.ok, note: r.note || '', hint: r.ok ? '' : (hint || '') });

  /* 运行时 */
  add('运行时', 'node', { ok: true, note: process.version }, '');
  add('运行时', 'python3', run('python3'), '安装 Python 3.9+');
  add('运行时', 'ffmpeg', run('ffmpeg', ['-version']), 'brew install ffmpeg');
  add('运行时', 'ffprobe', run('ffprobe', ['-version']), '随 ffmpeg 一起装');

  /* Playwright */
  let pw = { ok: false, note: '未安装' };
  let chromium;
  try {
    ({ chromium } = await (deps.loadPlaywright ?? (() => import('playwright')))());
    if (typeof chromium?.executablePath === 'function') {
      pw = { ok: true, note: '运行时可解析' };
      // An injected loader must not accidentally report the host installation.
      try {
        const info = (deps.loadPlaywrightInfo ?? (deps.loadPlaywright ? null : playwrightInfo))?.();
        if (info && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(info.version) && typeof info.path === 'string' &&
          path.isAbsolute(info.path) && !/[\u0000-\u001f\u007f]/.test(info.path)) {
          const location = info.path.startsWith(HOME + path.sep) ? '~' + info.path.slice(HOME.length) : info.path;
          pw.note += ` · ${info.version} · ${location.slice(0, 240)}`;
        }
      } catch { /* Resolution metadata is optional, not proof of a kernel. */ }
    }
  } catch {}
  add('渲染', 'playwright', pw, '在本仓库运行 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts；不要下载自带 Chromium');

  /* 必须是实际内核文件且可执行；缓存目录名不能证明可以渲染。 */
  const executable = file => {
    try {
      if (!file || !io.statSync(file).isFile()) return false;
      io.accessSync(file, fs.constants.X_OK);
      return true;
    } catch { return false; }
  };
  let kernel = { ok: false, note: pw.ok ? '需更新可执行的本机 Chrome，最低 156.0.8078.73' : '需先安装 playwright' };
  if (pw.ok) {
    try {
      const info = (deps.loadChromeInfo ?? (() => localChromeInfo(io)))();
      secureLaunchOptions({}, info);
      if (executable(info.executablePath)) kernel = { ok: true, note: `本机 Chrome ${info.version} 可执行；启动策略：沙箱开启、临时用户目录（未启动验证）` };
    } catch { /* 不回显任意异常，也不回退缓存内核。 */ }
  }
  add('渲染', 'chromium', kernel, '更新 /Applications/Google Chrome.app；不会改用 Playwright 缓存内核');

  /* TTS */
  const ttsVenv = path.join(HOME, '.local', 'share', 'opencode', 'video-tts', 'venv');
  const hasTts = io.existsSync(ttsVenv);
  add('配音', 'TTS 环境', { ok: hasTts, note: hasTts ? ttsVenv.replace(HOME, '~') : '未初始化' }, 'bash <skill>/scripts/setup-tts.sh');

  /* 模型端点：与 agent 用同一处判定，避免"doctor 说没配置、实际能跑"这种自相矛盾。 */
  let keyOk = false, keyNote = '无 key';
  try {
    const { currentSelection, keySourceChain } = await (deps.loadProviderSettings ?? (() => import('./provider-settings.mjs')))();
    const selection = currentSelection();
    const from = keySourceChain(selection.provider);
    if (from.key) {
      keyOk = true;
      keyNote = selection.provider + '（' + from.source + '）';
    } else {
      keyNote = selection.provider + ' 无可用凭证';
    }
  } catch {}
  add('agent', '模型凭证', { ok: keyOk, note: keyNote }, '在工作台 /settings 填 key，或 node vh.mjs key --secure');

  /* 项目 */
  if (project) {
    const req = ['PROJECT.json', '脚本.md', 'scenes.src.js', 'scene.html'];
    const miss = req.filter(f => !io.existsSync(path.join(project, f)));
    add('项目', '必需文件', { ok: miss.length === 0, note: miss.length ? '缺 ' + miss.join('/') : '齐全' }, 'node vh.mjs build 或 vh new');
    const opt = ['方案.md', 'claims.json', '发布文案.md', '审查.md'];
    const miss2 = opt.filter(f => !io.existsSync(path.join(project, f)));
    add('项目', '推荐文件', { ok: miss2.length === 0, note: miss2.length ? '缺 ' + miss2.join('/') : '齐全' }, '按需补写（影响质量闸门）');
    const v = path.join(project, 'out', 'video-voice.mp4');
    const hasVideo = io.existsSync(v);
    add('项目', '成片', { ok: hasVideo, note: hasVideo ? (io.statSync(v).size / 1048576).toFixed(0) + 'MB' : '还没有' }, 'node vh.mjs go --srt');
  }

  /* 磁盘 */
  // 尚未创建的项目取最近现存父目录；不要误报 HOME 所在卷的空间。
  let target = path.resolve(project || (deps.cwd ?? process.cwd()));
  let stat;
  while (io.statfsSync) {
    try { stat = io.statfsSync(target); break; }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || path.dirname(target) === target) break;
      target = path.dirname(target);
    }
  }
  if (stat) {
    const freeGB = (Number(stat.bavail) * Number(stat.bsize)) / 1073741824;
    add('磁盘', '可用空间', { ok: freeGB > 5, note: freeGB.toFixed(0) + 'GB（' + (project ? '项目卷' : '工作目录卷') + '）' }, '清理：node vh.mjs prune --all');
  } else {
    add('磁盘', '可用空间', { ok: false, note: '无法读取目标卷空间' }, '检查项目目录所在卷');
  }

  const failed = checks.filter(c => !c.ok);
  return { checks, ok: failed.length === 0, failed };
}

export function report(res) {
  const lines = [`环境体检：${res.checks.length} 项，${res.failed.length} 项需处理`];
  let group = '';
  for (const c of res.checks) {
    if (c.group !== group) { group = c.group; lines.push(''); lines.push('【' + group + '】'); }
    lines.push(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(12)} ${c.note}`);
    if (!c.ok && c.hint) lines.push(`      → ${c.hint}`);
  }
  return lines.join('\n');
}
