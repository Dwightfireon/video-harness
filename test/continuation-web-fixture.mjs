import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { launchBrowser } from '../lib/browser.mjs';
import { chromium } from 'playwright';

// taskStatus captures HOME at module import, independently of server.options.home.
// Isolate the test/benchmark process before importing the server (workers inherit
// this HOME too). The API providers fixture never consults the repo's legacy key config.
const processHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-continuation-web-home-'));
process.env.HOME = processHome;
process.env.OPEN_DESIGN_API_KEY = '';
process.once('exit', () => fs.rmSync(processHome, { recursive: true, force: true }));
const { startServer } = await import('../lib/server.mjs');

export const endpoints = ['/_api/chat', '/_api/state', '/_api/format', '/_api/projects'];
export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Real startServer + HTTP, but never consult credentials or launch model/TTS work.
export async function webFixture({ www } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-continuation-web-'));
  const project = path.join(root, 'projects', 'fixture');
  fs.mkdirSync(path.join(project, 'out'), { recursive: true });
  fs.writeFileSync(path.join(project, 'PROJECT.json'), JSON.stringify({ name: 'polling fixture' }));
  fs.writeFileSync(path.join(project, '脚本.md'), '## S1 · fixture\n1. 测试旁白。\n');
  fs.writeFileSync(path.join(project, 'scenes.src.js'), '// fixture\n');
  fs.writeFileSync(path.join(project, 'scene.html'), '<!doctype html><script>const DURATION=10;const SUBS=[];window.renderAt=()=>{};</script>');
  const server = startServer(root, 0, { root, home: path.join(root, 'home'), providerInfo: () => [] });
  const handlers = server.listeners('request');
  server.removeAllListeners('request');
  const calls = [], controls = new Map();
  server.on('request', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const call = { path: url.pathname, method: req.method, start: Date.now(), end: null, bodyBytes: 0 };
    calls.push(call);
    const write = res.write.bind(res), end = res.end.bind(res);
    const size = chunk => chunk == null ? 0 : Buffer.byteLength(chunk);
    res.write = (chunk, ...args) => { call.bodyBytes += size(chunk); return write(chunk, ...args); };
    res.end = (chunk, ...args) => { call.bodyBytes += size(chunk); return end(chunk, ...args); };
    res.once('finish', () => { call.end = Date.now(); call.status = res.statusCode; });
    const control = controls.get(url.pathname);
    if (req.method === 'GET' && control?.delayMs) await wait(control.delayMs);
    // Any POST reaching the fixture is deliberately rejected: no tasks can start.
    if (req.method !== 'GET' || (control?.fail && req.method === 'GET')) {
      req.resume(); res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'fixture unavailable; not dispatched' })); return;
    }
    if (control?.value) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(control.value)); return;
    }
    if (url.pathname === '/_api/providers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ providers: [], current: { provider: 'fixture', model: 'none' } })); return;
    }
    if (www && (url.pathname === '/' || url.pathname.startsWith('/_vh/'))) {
      const name = url.pathname === '/' ? url.searchParams.has('p') ? 'player.html' : 'index.html' : url.pathname.slice(5);
      if (name === path.basename(name)) {
        try {
          const content = fs.readFileSync(path.join(www, name));
          res.writeHead(200, { 'content-type': /\.(mjs|js)$/.test(name) ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
          res.end(content); return;
        } catch { res.writeHead(404); res.end(); return; }
      }
    }
    for (const handler of handlers) handler(req, res);
  });
  await once(server, 'listening');
  let browser;
  try { browser = await launchBrowser(chromium); }
  catch (error) { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true }); throw error; }
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { root, project, origin, calls, controls, browser,
    async page(route, { hidden = false } = {}) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(initialHidden => {
        let hidden = initialHidden;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        window.setControlledHidden = value => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
      }, hidden);
      await page.goto(origin + route);
      return { page, errors };
    },
    async close() {
      await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
