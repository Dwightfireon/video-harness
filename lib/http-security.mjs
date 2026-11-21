/* The workbench is a loopback control origin, not a generic virtual host. */
export function hostError(req, port = req.socket?.localPort) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !/^(127\.0\.0\.1|localhost|\[::1\])(?::([1-9]\d{0,4}))?$/.test(host)) return '只接受本机访问：Host 不是允许的本机地址';
  const parsedPort = Number(host.match(/:(\d+)$/)?.[1] || 80);
  if (parsedPort > 65535 || (port != null && parsedPort !== port)) return '只接受本机访问：Host 端口不匹配';
  return null;
}

export function originError(req) {
  const badHost = hostError(req);
  if (badHost) return badHost;
  const origin = req.headers.origin;
  // Opaque previews also issue no-cors GETs (images, navigation, etc.). Those
  // must not turn read/legacy control endpoints into a side channel.
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && !['same-origin', 'none'].includes(site)) return '跨站控制请求已拒绝';
  if (origin === undefined) return null; // non-browser CLI clients remain usable
  let parsed;
  try { parsed = new URL(origin); } catch { return '来源无法识别，已拒绝控制请求'; }
  if (parsed.origin !== origin || origin !== 'http://' + req.headers.host) return '跨站写操作已拒绝：来源须精确匹配当前工作台地址与端口';
  return null;
}
