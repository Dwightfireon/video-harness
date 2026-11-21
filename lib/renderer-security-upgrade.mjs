/* Only exact, known templates receive an embedded browser policy. Unknown
 * custom scripts remain untouched; never edit the shared article-video skill. */
import { createHash } from 'node:crypto';
import { localChromeInfo, secureLaunchOptions } from './browser.mjs';
import { KNOWN_RENDERER_HASHES } from './renderer-performance-upgrade.mjs';

export const SECURITY_MARK = 'vh:local-chrome-sandbox-v1';
const rendererHashes = new Set([...KNOWN_RENDERER_HASHES,
  'a8f717e7020c3d80b8f73850ce4c98c6287c9ec89ff4fc371214be9b91761528']);

export function secureRendererSource(source) {
  if (!rendererHashes.has(createHash('sha256').update(source).digest('hex'))) return null;
  const policy = `\n/* ${SECURITY_MARK} */\n${localChromeInfo.toString()}\n${secureLaunchOptions.toString()}\n`;
  let next = source.replace("import fs from 'node:fs';", "import fs from 'node:fs';" + policy);
  for (const launch of [
    '{ args: launchArgs }',
    '{ args: launchArgs, executablePath: localBrowser }',
    '{ ...launchArgs, executablePath: localBrowser }',
  ]) {
    // The old fallback is unreachable in normal operation; if attempted it
    // must obey the same path, version and sandbox rules, never weaken them.
    const options = launch.replace('...launchArgs,', 'args: launchArgs,');
    next = next.replaceAll(`chromium.launch(${launch})`, `chromium.launch(secureLaunchOptions(${options}))`);
  }
  return next;
}
