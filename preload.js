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

// Read-only environment info + auto-update surface. `platform` lets the
// renderer branch its update UX (Win = auto-install, Linux = download link).
contextBridge.exposeInMainWorld('pairEnv', {
  platform: os.platform(),
  isApp: true,
  // Called once with a callback that fires when an update is available.
  onUpdate: cb => {
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
