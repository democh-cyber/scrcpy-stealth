const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scrcc', {
  getDevices: () => ipcRenderer.invoke('get-devices'),
  startScrcpy: (options) => ipcRenderer.invoke('start-scrcpy', options),
  stopScrcpy: () => ipcRenderer.invoke('stop-scrcpy'),
  getStatus: () => ipcRenderer.invoke('scrcpy-status'),
  toggleStealth: (enabled) => ipcRenderer.invoke('toggle-stealth', enabled),

  browseScrcpyPath: () => ipcRenderer.invoke('browse-scrcpy-path'),
  getScrcpyPath: () => ipcRenderer.invoke('get-scrcpy-path'),

  injectTap: (data) => ipcRenderer.send('inject-tap', data),
  injectSwipe: (data) => ipcRenderer.send('inject-swipe', data),
  injectKey: (data) => ipcRenderer.send('inject-key', data),
  injectText: (text) => ipcRenderer.send('inject-text', text),
  togglePassthrough: () => ipcRenderer.invoke('toggle-passthrough'),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('set-always-on-top', enabled),
  setOpacity: (value) => ipcRenderer.invoke('set-opacity', value),
  toggleFocusGuard: () => ipcRenderer.invoke('toggle-focusguard'),
  clipboardPull: () => ipcRenderer.invoke('clipboard-pull'),
  clipboardPush: () => ipcRenderer.invoke('clipboard-push'),
  adbConnect: (ip) => ipcRenderer.invoke('adb-connect', ip),
  toggleMiniMode: () => ipcRenderer.invoke('toggle-mini-mode'),
  setAutoReconnect: (enabled) => ipcRenderer.invoke('set-auto-reconnect', enabled),

  onLog: (callback) => ipcRenderer.on('scrcpy-log', (_e, msg) => callback(msg)),
  onStopped: (callback) => ipcRenderer.on('scrcpy-stopped', (_e, code) => callback(code)),
  onCaptureReady: (callback) => ipcRenderer.on('scrcpy-capture-ready', (_e, info) => callback(info)),
  onPassthroughChanged: (callback) => ipcRenderer.on('passthrough-changed', (_e, active) => callback(active)),
  onFocusGuardChanged: (callback) => ipcRenderer.on('focusguard-changed', (_e, active) => callback(active)),
  onPanic: (callback) => ipcRenderer.on('panic', () => callback()),
  onAutoReconnect: (callback) => ipcRenderer.on('auto-reconnect', () => callback()),

  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
});
