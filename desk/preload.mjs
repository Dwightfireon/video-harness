/* 渲染进程预加载：只暴露白名单方法，渲染层拿不到 node / ipcRenderer 本体。 */
import { contextBridge, ipcRenderer } from 'electron';

const on = channel => handler => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('vh', {
  init: () => ipcRenderer.invoke('desk:init'),
  projects: () => ipcRenderer.invoke('desk:projects'),
  draft: id => ipcRenderer.invoke('desk:draft', id),
  partitions: () => ipcRenderer.invoke('partitions:load'),
  plan: input => ipcRenderer.invoke('publish:plan', input),
  submit: input => ipcRenderer.invoke('publish:submit', input),
  batch: input => ipcRenderer.invoke('publish:batch', input),
  batchCancel: () => ipcRenderer.invoke('publish:batch-cancel'),
  batchState: () => ipcRenderer.invoke('publish:batch-state'),
  onBatchStep: on('batch:step'),
  verify: bvid => ipcRenderer.invoke('publish:verify', bvid),
  prepare: id => ipcRenderer.invoke('desk:prepare', id),
  onPrepareLog: on('prepare:log'),
  qr: () => ipcRenderer.invoke('auth:qr'),
  poll: () => ipcRenderer.invoke('auth:poll'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  check: () => ipcRenderer.invoke('auth:check'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  copy: text => ipcRenderer.invoke('clipboard:copy', text),
  openExternal: url => ipcRenderer.invoke('shell:open', url),
  openCredential: () => ipcRenderer.invoke('desk:openCredential'),
  onProgress: on('publish:progress'),
  onStep: on('publish:step'),
});
