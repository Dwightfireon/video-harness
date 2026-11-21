/* macOS 隐藏输入：密钥只在子进程管道与本进程内存流转，不进入聊天或 argv。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { saveHarnessKey } from '../lib/agent.mjs';

if (process.platform !== 'darwin') {
  console.error('本隐藏输入窗口仅支持 macOS；未更改配置。');
  process.exit(1);
}
const configFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vh.config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') { console.error('本地配置无法读取，未更改凭证。'); process.exit(1); }
}
const script = `
set responseDialog to display dialog "请粘贴 OpenDesign API key。\\n\\n输入会隐藏，直接保存到本机私有凭证文件；不会发到聊天，不会在终端回显。\\n本次只保存配置，不调用付费模型。" with title "视频工作台 · OpenDesign" default answer "" with hidden answer buttons {"取消", "保存"} default button "保存" cancel button "取消" giving up after 300
if gave up of responseDialog then error number -128
return text returned of responseDialog
`;
const result = spawnSync('/usr/bin/osascript', ['-e', script], {
  stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 310000, maxBuffer: 65536,
});
if (result.status !== 0) {
  // 不回显系统错误正文，以免包含用户输入。
  console.log('未保存：窗口已取消、超时或不可用。原配置未更改。');
  process.exit(1);
}
try {
  // 与工作台设置页写同一个位置：否则两处互相遮挡，用户换了 key 却仍用旧的。
  const saved = saveHarnessKey(result.stdout);
  config.preferredProvider = 'opendesign';
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  console.log('已保存 OpenDesign 凭证（文件权限 600），设为首选渠道。');
  console.log('指纹 ' + saved.fingerprint + '：工作台设置页会显示同一个指纹，可用来核对换对了。');
  console.log('模型：deepseek-v4.1-flash。凭证文件：' + saved.target);
  console.log('未调用模型，未重跑制作任务。');
} catch {
  console.error('配置未完成。未打印密钥，请检查本机文件权限后重试。');
  process.exitCode = 1;
} finally { result.stdout = ''; result.stderr = ''; }
