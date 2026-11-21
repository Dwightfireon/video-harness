/* 仅使用已修补的本机 Chrome；不使用 Playwright 浏览器缓存，不降级关闭沙箱。
 * launch() 自动创建临时用户目录，不连接日常 Chrome 或复用其登录数据。
 * 两个策略函数保持自包含，已知的独立渲染器可嵌入相同代码。 */
import fs from 'node:fs';

export function localChromeInfo(io = fs) {
  const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!io.statSync(executablePath).isFile()) throw new Error('缺少可执行的本机 Google Chrome');
  io.accessSync(executablePath, fs.constants.X_OK);
  const plist = io.readFileSync('/Applications/Google Chrome.app/Contents/Info.plist', 'utf8');
  const version = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+\.\d+\.\d+\.\d+)<\/string>/)?.[1];
  if (!version) throw new Error('无法确认本机 Chrome 版本；请更新 Google Chrome');
  return { executablePath, version };
}

export function secureLaunchOptions(options = {}, info = localChromeInfo()) {
  // 这是本次四个 CVE 的修复下限，不是对所有未来漏洞的安全保证。
  const minimum = [156, 0, 8078, 73];
  const parts = /^\d+\.\d+\.\d+\.\d+$/.test(info.version || '') ? info.version.split('.').map(Number) : [];
  const first = minimum.findIndex((value, i) => parts[i] !== value);
  if (parts.length !== 4 || (first >= 0 && parts[first] < minimum[first])) {
    throw new Error('本机 Chrome 必须更新到 156.0.8078.73 或更新版本；不会回退到旧 Chromium');
  }
  if (info.executablePath !== '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') {
    throw new Error('仅允许使用本机 Google Chrome，不接受其他浏览器路径');
  }
  if (options.chromiumSandbox === false || (options.channel && options.channel !== 'chrome') ||
      (options.executablePath && options.executablePath !== info.executablePath)) {
    throw new Error('不允许关闭 Chromium 沙箱或改用其他浏览器');
  }
  const args = options.args ?? [];
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' ||
      /^--(?:no-sandbox|disable-[\w-]*sandbox|single-process|user-data-dir|profile-directory)(?:=|$)/.test(arg))) {
    throw new Error('启动参数不允许禁用沙箱或复用浏览器用户目录');
  }
  return { ...options, args, executablePath: info.executablePath, channel: undefined, chromiumSandbox: true };
}

const ownedBrowsers = new Set();
function track(browser) {
  ownedBrowsers.add(browser);
  browser.on?.('disconnected', () => ownedBrowsers.delete(browser));
  return browser;
}
export async function closeLaunchedBrowsers() {
  await Promise.allSettled([...ownedBrowsers].map(browser => browser.close()));
}

export function localChromePath() {
  try { return localChromeInfo().executablePath; } catch { return null; }
}

export async function launchBrowser(chromium, options = {}) {
  return track(await chromium.launch(secureLaunchOptions(options)));
}
