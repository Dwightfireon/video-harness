/* 受限编辑模式不执行解释器/任意 shell 写入；这不是完整 OS 沙箱。 */
import fs from 'node:fs';
import path from 'node:path';

function words(command) {
  const groups = [[]]; let word = '', quote = null, active = false;
  const push = () => { if (active) groups.at(-1).push(word); word = ''; active = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") { if (c === "'") quote = null; else word += c; active = true; continue; }
    if (c === '$' || c === '`' || c === '\n' || c === '\r') return null;
    if (c === '\\') { if (++i >= command.length || /[\r\n]/.test(command[i])) return null; word += command[i]; active = true; continue; }
    if (quote === '"') { if (c === '"') quote = null; else word += c; active = true; continue; }
    if (c === '"' || c === "'") { quote = c; active = true; continue; }
    if (';&<>()'.includes(c)) return null;
    if (c === '|') { push(); if (!groups.at(-1).length) return null; groups.push([]); continue; }
    if (/\s/.test(c)) push(); else { word += c; active = true; }
  }
  if (quote) return null; push();
  return groups.every(g => g.length) ? groups : null;
}
export function safeRestrictedRead(command, project, vh) {
  if (typeof command !== 'string') return false;
  const groups = words(command); if (!groups) return false;
  const allowed = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'pwd', 'du', 'stat', 'shasum']);
  const root = fs.realpathSync(project);
  return groups.every(argv => {
    const executable = argv[0], name = path.basename(executable);
    if (name === 'node') {
      // status 会加载目标工程的 timeline.mjs；不能把任意 --dir 工程当成只读数据。
      // 受限模式不通过 shell 启动 Node；固定制作阶段只走 run_stage。
      return false;
    }
    if (executable !== name && !['/bin/' + name, '/usr/bin/' + name].includes(executable)) return false;
    if (name === 'sed') {
      if (argv[1] !== '-n' || !/^\d+(?:,\d+)?p$/.test(argv[2] || '') || argv.length < 4) return false;
    } else if (!allowed.has(name)) return false;
    if (argv.some(a => /^(?:--output(?:=|$)|--pre(?:=|$)|--pre-glob(?:=|$)|--hostname-bin(?:=|$))/.test(a))) return false;
    return argv.slice(name === 'sed' ? 3 : 1).every(arg => {
      if (arg.startsWith('-')) return true;
      const target = path.resolve(project, arg);
      if (!fs.existsSync(target)) return true;
      const real = fs.realpathSync(target);
      return real === root || real.startsWith(root + path.sep);
    });
  });
}
