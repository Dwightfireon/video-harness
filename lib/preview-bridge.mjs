/* Injected only into untrusted HTML, still confined by the response CSP sandbox.
 * Parent never evaluates preview code or accepts privileged commands from it. */
export const previewBridge = `<script>(() => {
  let channel = null, request = 0, lastError = null;
  const metadata = async () => {
    try { await document.fonts.ready; } catch {}
    const width = typeof W === 'number' ? W : window.W;
    const height = typeof H === 'number' ? H : window.H;
    parent.postMessage({type:'vh-preview:ready', channel, width, height}, '*');
  };
  addEventListener('message', event => {
    if (event.source !== parent || !event.data || typeof event.data.channel !== 'string') return;
    const msg = event.data;
    if (msg.type === 'vh-preview:init') { channel = msg.channel; request++; lastError = null; metadata(); }
    if (msg.channel !== channel) return;
    if (msg.type === 'vh-preview:render' && Number.isFinite(msg.time) && msg.time >= 0) {
      const id = ++request;
      const report = (error) => {
        if (id !== request || msg.channel !== channel || lastError === error) return;
        lastError = error;
        parent.postMessage({type:'vh-preview:frame-status', channel, error}, '*');
      };
      try {
        if (typeof window.renderAt !== 'function') throw new Error('缺少画面渲染入口');
        Promise.resolve(window.renderAt(msg.time)).then(() => report(null), error => report(String(error?.message || error).slice(0, 350)));
      } catch (error) { report(String(error?.message || error).slice(0, 350)); }
    }
  });
})();</script>`;

export const previewCSP = "sandbox allow-scripts; form-action 'none'; object-src 'none'; frame-ancestors 'self'";
