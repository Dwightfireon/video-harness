#!/usr/bin/env node
/* 测试运行器：每轮使用独立临时根目录，结束后只清理本轮创建的目录。
 * 不批量扫描或删除历史 vh-* 目录；不使用 shell 拼接，避免误删用户文件。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PREFIX = 'vh-test-run-';
const MARKER = '.vh-test-run.json';

const realOrNull = dir => { try { return fs.realpathSync(dir); } catch { return null; } };

export function createTestRoot(base = os.tmpdir()) {
  const root = fs.mkdtempSync(path.join(base, PREFIX));
  const file = path.join(root, MARKER);
  fs.writeFileSync(file, JSON.stringify({ version: 1, pid: process.pid, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  return root;
}

/* 只接受“系统临时目录下一层、带本轮标记”的目录；符号链接、根目录、用户目录一律拒绝。 */
export function cleanupTestRoot(root, base = os.tmpdir()) {
  const resolved = realOrNull(root), parent = realOrNull(base);
  if (!resolved || !parent || path.dirname(resolved) !== parent || !path.basename(resolved).startsWith(PREFIX)) return false;
  let marker;
  try { marker = JSON.parse(fs.readFileSync(path.join(resolved, MARKER), 'utf8')); } catch { return false; }
  if (marker?.version !== 1) return false;
  try { fs.rmSync(resolved, { recursive: true, force: true }); return !fs.existsSync(resolved); } catch { return false; }
}

export function testFiles(root = ROOT) {
  return fs.readdirSync(path.join(root, 'test'))
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => path.join(root, 'test', name));
}

export function runTests({ files = testFiles(), base = os.tmpdir(), stdio = 'inherit', env = process.env, onRoot,
  concurrency = Number(env.VH_TEST_CONCURRENCY || 2) } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('VH_TEST_CONCURRENCY 必须为 1–16 的整数');
  const root = createTestRoot(base);
  onRoot?.(root);
  /* 在测试内部再启动测试时，继承 NODE_TEST_CONTEXT 会让子进程按“同名测试子进程”
   * 协议运行，失败被吞掉、退出码为 0。只对子进程去掉这个内部变量。 */
  const childEnv = { ...env, TMPDIR: root, TMP: root, TEMP: root };
  delete childEnv.NODE_TEST_CONTEXT;
  // Many suites start actual Chromium/ffmpeg/process trees. CPU-count default
  // concurrency can exhaust a desktop before a useful test result is emitted.
  const child = spawn(process.execPath, ['--test', '--test-concurrency=' + concurrency, ...files], {
    cwd: ROOT,
    stdio,
    env: childEnv,
  });
  let settled = false;
  return new Promise(resolve => {
    const finish = (code, signal) => {
      if (settled) return; settled = true;
      const cleaned = cleanupTestRoot(root, base);
      resolve({ code: code ?? 1, signal, root, cleaned });
    };
    child.on('error', () => finish(1, null));
    child.on('exit', finish);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.once(signal, () => { try { child.kill(signal); } catch {} });
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const files = args.length && !args[0].startsWith('-') ? args.map(file => path.resolve(file)) : testFiles();
  const result = await runTests({ files });
  if (!result.cleaned) console.error('⚠ 本轮测试临时目录未能清理：' + result.root);
  process.exitCode = result.signal ? 1 : result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
