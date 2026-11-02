// Exposed only to trex://ui documents (pages in tabs get no preload).
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'trex:') {
  contextBridge.exposeInMainWorld('trexShell', {
    command: (name, args) => ipcRenderer.invoke('shell:command', name, args),
    state: () => ipcRenderer.invoke('shell:state'),
    onState: fn => { const h = (_e, s) => fn(s); ipcRenderer.on('shell:state', h); return () => ipcRenderer.off('shell:state', h); },
    onReveal: fn => ipcRenderer.on('shell:reveal', (_e, opts) => fn(opts)),
    onPageFocus: fn => ipcRenderer.on('shell:page-focus', () => fn()),
    onBackdrop: fn => ipcRenderer.on('shell:backdrop', (_e, data) => fn(data)),
    // Worker bridge: the worker calls these through CDP on the chrome document.
    worker: (name, args) => ipcRenderer.invoke('shell:worker', name, args),
    onWorkerEvent: fn => ipcRenderer.on('shell:to-worker', (_e, m) => fn(m)),
  });
}
