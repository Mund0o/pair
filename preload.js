const { contextBridge, ipcRenderer } = require('electron');
const os = require('os');

// Minimal, audited bridge for streaming an incoming file to disk.
// The renderer is sandboxed, so it cannot touch `fs` directly — only these
// four methods are exposed, and each round-trips to main.js over IPC.
contextBridge.exposeInMainWorld('pairSave', {
  // Pops a Save As dialog, opens the write stream. Resolves { ok, path } or { ok: false } on cancel.
  start: name => ipcRenderer.invoke('pair:saveStart', name),
  // Writes one chunk; resolves only once the OS accepts it (or 'drain' fires).
  write: buf => ipcRenderer.invoke('pair:saveWrite', buf),
  // Flushes and closes the stream; resolves on 'finish'.
  end: () => ipcRenderer.invoke('pair:saveEnd'),
  // Aborts and discards the current stream.
  cancel: () => ipcRenderer.invoke('pair:saveCancel')
});

// Settings persistence bridge for the sandboxed renderer. Falls through to
// localStorage automatically when running in a browser (no IPC available).
contextBridge.exposeInMainWorld('pairSettings', {
  get: key => ipcRenderer.invoke('pair:getSetting', key),
  set: (key, value) => ipcRenderer.invoke('pair:setSetting', key, value)
});

// Read-only environment info + auto-update surface. `platform` lets the
// renderer branch its update UX (Win = auto-install, Linux = download link).
contextBridge.exposeInMainWorld('pairEnv', {
  platform: os.platform(),
  isApp: true,
  toggleFullscreen: () => ipcRenderer.send('pair:toggleFullscreen'),
  getSources: () => ipcRenderer.invoke('pair:getSources'),
  setPendingSource: id => ipcRenderer.send('pair:setPendingSource', id),
  // Called once with a callback that fires when an update is available.
  onUpdate: cb => {
    if (typeof cb !== 'function') { console.warn('onUpdate requires a function'); return () => {}; }
    const listener = (_e, info) => cb(info);
    ipcRenderer.on('update-available', listener);
    return () => ipcRenderer.removeListener('update-available', listener);
  },
  // Windows: relaunch the downloaded installer and quit.
  restartForUpdate: () => ipcRenderer.send('pair:installUpdate'),
  // Tell main the update feed URL (same host as the signaling server). Lets
  // auto-update work for a remote peer without separate manual config.
  setFeed: url => ipcRenderer.send('pair:setFeed', url)
});

// Native WASAPI loopback capture with echo cancellation bridge.
// The renderer sends reference audio (Pair's voice) and receives clean audio.
// Only available when the native addon is built and loaded.
contextBridge.exposeInMainWorld('pairCapture', {
  start: () => ipcRenderer.send('pair:startCapture'),
  stop: () => ipcRenderer.send('pair:stopCapture'),
  // Send reference audio samples (Float32Array) to the native addon for cancellation.
  pushReference: buf => ipcRenderer.send('pair:captureRef', buf),
  // Register for clean audio data from the native addon.
  onCleanAudio: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, buf, frames) => cb(buf, frames);
    ipcRenderer.on('pair:cleanAudio', listener);
    return () => ipcRenderer.removeListener('pair:cleanAudio', listener);
  },
  // Register for capture errors.
  onError: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('pair:captureError', listener);
    return () => ipcRenderer.removeListener('pair:captureError', listener);
  },
  // Register for capture format info.
  onFormat: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, fmt) => cb(fmt);
    ipcRenderer.on('pair:captureFormat', listener);
    return () => ipcRenderer.removeListener('pair:captureFormat', listener);
  }
});
