const { app, BrowserWindow, session, dialog, ipcMain } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
require('./server.js');

// --- Incoming-file disk streaming (single active write stream) ---
// The renderer is sandboxed, so all fs access happens here. `write` resolves
// only when the OS accepts the chunk or 'drain' fires — that backpressure
// flows back through the renderer and WebRTC to the sender.
let writeStream = null;
let writeFailed = null;

let streamClosing = false;
let closePromise = null;
function closeStream() {
  if (closePromise) return closePromise;
  if (!writeStream) return Promise.resolve();
  streamClosing = true;
  const s = writeStream;
  writeStream = null;
  closePromise = new Promise(resolve => {
    const done = () => { streamClosing = false; closePromise = null; resolve(); };
    s.once('close', done);
    s.once('error', done);
    s.destroy();
    setTimeout(done, 5000);
  });
  return closePromise;
}

ipcMain.handle('pair:saveStart', async (_e, name) => {
  await closeStream();
  writeFailed = null;
  const result = await dialog.showSaveDialog({
    title: 'Save incoming file',
    defaultPath: name || 'incoming',
    buttonLabel: 'Save'
  });
  if (result.canceled || !result.filePath) return { ok: false };
  // A cancel may have arrived while the dialog was open (closeStream already ran
  // and nulled writeStream). If a stream was opened in the meantime by another
  // call, don't clobber it; if not, opening here is safe. Re-check to avoid
  // leaving an orphaned, never-closed write stream on disk.
  if (writeStream) {
    try { writeStream.destroy(); } catch {}
    writeStream = null;
  }
  writeStream = fs.createWriteStream(result.filePath);
  writeStream.on('error', err => { writeFailed = err; });
  return { ok: true, path: result.filePath };
});

// How much decrypted data we'll buffer in the Node stream before pausing the
// renderer. Large enough that the network never stalls waiting on a slow disk,
// small enough to bound memory for very large files.
const WRITE_HIGH_WATER = 256 * 1024 * 1024;

ipcMain.handle('pair:saveWrite', async (_e, buf) => {
  if (!writeStream) throw new Error('no open stream');
  if (writeFailed) throw writeFailed;
  // Write without awaiting each drain. Node's Writable buffers internally; we
  // only back-pressure the renderer when our own buffer exceeds WRITE_HIGH_WATER
  // (i.e. the disk genuinely can't keep up). This removes the per-chunk IPC
  // round-trip latency that otherwise caps receive throughput.
  const ok = writeStream.write(Buffer.from(buf));
  if (!ok && writeStream.writableLength > WRITE_HIGH_WATER) {
    await new Promise((resolve, reject) => {
      const s = writeStream;
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(wt);
        try { s.removeListener('drain', onDrain); } catch {}
        try { s.removeListener('error', onErr); } catch {}
        try { s.removeListener('close', onClose); } catch {}
      };
      const onDrain = () => { cleanup(); resolve(); };
      const onErr = err => { cleanup(); reject(err); };
      const onClose = () => { cleanup(); resolve(); };
      const wt = setTimeout(() => { cleanup(); resolve(); }, 30000);
      s.once('drain', onDrain);
      s.once('error', onErr);
      s.once('close', onClose);
    });
  }
  return true;
});

ipcMain.handle('pair:saveEnd', () => new Promise((resolve, reject) => {
  if (!writeStream) return resolve(false);
  const s = writeStream;
  writeStream = null;
  const to = setTimeout(() => { s.destroy(); resolve(false); }, 10000);
  s.once('finish', () => { clearTimeout(to); resolve(true); });
  s.once('error', err => { clearTimeout(to); reject(err); });
  s.end();
}));

ipcMain.handle('pair:saveCancel', () => closeStream().then(() => true));

// --- Settings persistence (sandboxed renderer can't rely on localStorage) ---
// Writes/reads a small JSON file in the app's userData directory so room code
// and signaling address survive restarts even in sandboxed Electron on file://.
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return {}; }
}
function writeSettings(obj) {
  try { fs.writeFileSync(settingsPath, JSON.stringify(obj), 'utf8'); } catch {}
}
ipcMain.handle('pair:getSetting', (_e, key) => (readSettings())[key]);
ipcMain.handle('pair:setSetting', (_e, key, value) => {
  const s = readSettings();
  if (value == null) delete s[key]; else s[key] = value;
  writeSettings(s);
});

// Auto-update: start the check loop and listen for the renderer's request to
// install a downloaded Windows update.
const { startAutoUpdater, performInstall } = require('./updater');
ipcMain.on('pair:installUpdate', () => performInstall());
// The renderer tells us the update feed (same host it uses for signaling). This
// lets auto-update work for a remote peer without manual config: they set the
// signaling server once, and updates use that same host. Start (or restart) the
// check loop with that feed as soon as we receive it.
ipcMain.on('pair:setFeed', (_e, url) => { startAutoUpdater(String(url).replace(/^ws:/,'http:')); });

app.on('window-all-closed', () => closeStream());

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 680,
    backgroundColor: '#f4f1eb',
    title: 'Pair — private P2P chat',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  // Needed for the browser File System Access API used to stream large downloads.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'notifications' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
  });
  createWindow();
  startAutoUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
