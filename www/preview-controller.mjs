/* Only data crosses the opaque iframe boundary. No scene globals/DOM/eval. */
export function attachPreview(frame, { ready = () => {}, frameError = () => {} } = {}) {
  let channel = '', time = 0;
  const send = message => frame.contentWindow?.postMessage({ ...message, channel }, '*');
  const receive = event => {
    const msg = event.data;
    if (event.source !== frame.contentWindow || event.origin !== 'null' || !msg || msg.channel !== channel) return;
    if (msg.type === 'vh-preview:frame-status') {
      if (msg.error === null || typeof msg.error === 'string') frameError(msg.error?.slice(0, 350) ?? null);
      return;
    }
    if (msg.type !== 'vh-preview:ready') return;
    const width = Number(msg.width), height = Number(msg.height);
    const valid = value => Number.isFinite(value) && value >= 1 && value <= 16384;
    ready(valid(width) && valid(height) ? { w: width, h: height } : null);
    send({ type: 'vh-preview:render', time });
  };
  window.addEventListener('message', receive);
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.onload = () => send({ type: 'vh-preview:init' });
  return {
    load(url, keepTime = 0) { channel = crypto.randomUUID(); time = Math.max(0, keepTime); frameError(null); frame.src = url; },
    render(at) { if (!Number.isFinite(at) || at < 0) return; time = at; send({ type: 'vh-preview:render', time }); },
    close() { window.removeEventListener('message', receive); },
  };
}
