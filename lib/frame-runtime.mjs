/* 给旧 renderer 一个可 await 的 renderAt 返回值，不改用户的 render.mjs。
 * Playwright page.evaluate 会等待返回的 Promise；网页预览仍可直接调用。
 * 素材就绪不能异步 renderAt(0)，否则会把正在截图的镜头偷偷重置。 */
function frameRuntime() {
  let ready = false, request = 0;
  window.__ready = Promise.resolve().then(async () => {
    if (document.fonts) await document.fonts.ready;
    if (window.VH_UI?.assetsReady) await window.VH_UI.assetsReady({ timeout: 12000, strict: true });
    ready = true;
    return true;
  });
  function boot() {
    const original = window.renderAt;
    if (typeof original !== 'function' || original.__vhFrame) return;
    const render = function(t) {
      const id = ++request;
      const draw = () => {
        // 加载期间只画最新请求；较早的首帧回调不能覆盖用户拖到的位置。
        if (id !== request) return;
        const result = original.call(window, t);
        const pending = [...(window.__vhMediaPending || [])];
        return Promise.all([result, ...pending]);
      };
      const result = ready ? Promise.resolve(draw()) : window.__ready.then(draw);
      // 预览可能不 await，保留错误供 UI/诊断读取；原 Promise 仍向导出端拒绝。
      result.catch(error => { window.__vhFrameError = String(error?.message || error); });
      return result;
    };
    Object.assign(render, original);
    render.__vhFrame = true;
    window.renderAt = render;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

export const FRAME_RUNTIME = '/* vh:frame-runtime */\n(' + frameRuntime.toString() + ')();\n/* vh:frame-runtime-end */\n';

export function injectFrameRuntime(html) {
  html = html.replace(/\/\* vh:frame-runtime \*\/[\s\S]*?\/\* vh:frame-runtime-end \*\/\s*/g, '');
  // 移除已知旧版本首帧补画，不触碰作者自定义代码。
  html = html.replace(/\/\* vh:assets-gate \*\/\s*\(function\(\)\{[\s\S]*?\}\)\(\);\s*/g, '');
  const at = html.lastIndexOf('window.renderAt(0);');
  if (at < 0) throw new Error('没有找到生成器的首帧调用，未安装 frame runtime');
  return html.slice(0, at) + FRAME_RUNTIME + html.slice(at);
}
