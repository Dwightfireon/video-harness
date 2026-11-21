#!/usr/bin/env node
/* GET-only CLI transport. Authentication/discovery belong to the existing
 * opencode CLI, not this program. Never print captured API bodies or stderr. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { analyzeSessionPerformance, sessionPerformanceReport, SessionAuditError } from '../lib/session-performance.mjs';

const fail = code => { throw new SessionAuditError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const HELP = 'node scripts/audit-opencode-session.mjs <sessionID> [--from <messageID> --to <messageID>] [--json]\nnode scripts/audit-opencode-session.mjs --input <JSON文件> [--from <messageID> --to <messageID>] [--json]';

export function parseArguments(args) {
  const options = {}; const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (['--input', '--from', '--to', '--json'].includes(arg)) {
      if (seen.has(arg)) fail('duplicate-option');
      seen.add(arg);
      if (arg === '--json') options.json = true;
      else {
        if (!args[i + 1] || args[i + 1].startsWith('-')) fail('missing-option-value');
        options[arg.slice(2)] = args[++i];
      }
    } else if (arg.startsWith('-') || options.sessionID) fail('invalid-arguments');
    else options.sessionID = arg;
  }
  if (options.help) return options;
  if (Boolean(options.input) === Boolean(options.sessionID)) fail('choose-session-or-input');
  if (options.sessionID && !/^ses_[A-Za-z0-9_-]+$/.test(options.sessionID)) fail('invalid-session-id');
  for (const key of ['from', 'to']) if (options[key] && !/^msg_[A-Za-z0-9_-]+$/.test(options[key])) fail('invalid-message-id');
  return options;
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch { fail('invalid-or-truncated-json'); }
}

/** stdout is a mode-0600 regular file rather than a pipe: some CLI versions
 * exit before flushing large pipe writes. Wait for close, not merely exit,
 * before reading/parsing. Cleanup is limited to this mkdtemp-owned directory. */
export async function readApiJSON(requestPath, { spawnImpl = spawn, tempBase = os.tmpdir(), executable = 'opencode' } = {}) {
  let directory, fd;
  try {
    directory = fs.mkdtempSync(path.join(tempBase, 'vh-session-audit-'));
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, 'stdout.json');
    fd = fs.openSync(file, 'wx', 0o600);
    const status = await new Promise(resolve => {
      let child, failed = false;
      try { child = spawnImpl(executable, ['api', 'get', requestPath], { stdio: ['ignore', fd, 'ignore'], shell: false }); }
      catch { resolve({ failed: true }); return; }
      child.once('error', () => { failed = true; });
      child.once('close', (code, signal) => resolve({ code, signal, failed }));
    });
    fs.closeSync(fd); fd = undefined;
    if (status.failed) fail('opencode-cli-unavailable');
    if (status.code !== 0 || status.signal) fail('opencode-api-failed');
    return parseJSON(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof SessionAuditError) throw error;
    fail('opencode-read-failed');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}

function validatePage(page) {
  if (!object(page) || !Array.isArray(page.data) || !object(page.cursor)) fail('invalid-api-page');
  for (const key of ['next', 'previous']) {
    const cursor = page.cursor[key];
    if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || !cursor.length || cursor.length > 65536 || /[\u0000-\u001f\u007f]/.test(cursor))) fail('invalid-cursor');
  }
  if (!page.data.length && page.cursor.next) fail('empty-continuing-page');
  return page;
}

/** Fail closed: never return accumulated records after a broken page. Opaque
 * cursors are URL-encoded unchanged; `order` is for the first request only. */
export async function readSessionMessages(sessionID, { fetchPage = readApiJSON } = {}) {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionID)) fail('invalid-session-id');
  const messages = [], cursors = new Set(); let cursor;
  for (let pageNumber = 0; ; pageNumber++) {
    if (pageNumber >= 10000) fail('pagination-limit-exceeded');
    const query = new URLSearchParams({ limit: '200' });
    if (cursor === undefined) query.set('order', 'asc'); else query.set('cursor', cursor);
    let page;
    try { page = validatePage(await fetchPage(`/api/session/${sessionID}/message?${query}`)); }
    catch (error) { if (error instanceof SessionAuditError) throw error; fail('pagination-failed'); }
    // V2 can return a previous anchor even for the first ascending page. The
    // initial request deliberately has no cursor; do not confuse an available
    // navigation token with proof that older records were skipped.
    messages.push(...page.data);
    if (page.cursor.next === undefined || page.cursor.next === null) return messages;
    cursor = page.cursor.next;
    if (cursors.has(cursor)) fail('repeated-cursor');
    cursors.add(cursor);
  }
}

export function offlineMessages(value) {
  if (Array.isArray(value)) return value;
  const page = validatePage(value);
  if (page.cursor.next || page.cursor.previous) fail('incomplete-offline-page');
  return page.data;
}

export async function main(args = process.argv.slice(2)) {
  const json = args.includes('--json');
  try {
    const options = parseArguments(args);
    if (options.help) { console.log(HELP); return 0; }
    let messages;
    if (options.input) {
      let text;
      try { text = fs.readFileSync(options.input, 'utf8'); } catch { fail('input-read-failed'); }
      messages = offlineMessages(parseJSON(text));
    } else messages = await readSessionMessages(options.sessionID);
    const result = analyzeSessionPerformance(messages, options);
    console.log(options.json ? JSON.stringify(result, null, 2) : sessionPerformanceReport(result));
    return 0;
  } catch (error) {
    const code = error instanceof SessionAuditError ? error.code : 'audit-failed';
    if (json) console.log(JSON.stringify({ ok: false, error: code }));
    else console.error('会话诊断失败：' + code + '（未输出部分统计）');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
