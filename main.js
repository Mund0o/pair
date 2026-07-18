const { app, BrowserWindow, session, dialog, ipcMain, desktopCapturer, screen } = require('electron');

let mainWin = null;
let pendingSourceId = null;

ipcMain.handle('pair:getSources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], fetchWindowIcons: false, thumbnailSize: { width: 240, height: 180 } });
  return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), display_id: s.display_id }));
});
ipcMain.on('pair:setPendingSource', (_e, id) => { pendingSourceId = id; });

// Enable hardware-accelerated video encode/decode for smoother screen sharing.
app.commandLine.appendSwitch('enable-accelerated-video-encode');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,VaapiVideoEncoder,VaapiIgnoreDriverChecks,Vulkan,DefaultANGLEVulkan,VulkanFromANGLE');
app.commandLine.appendSwitch('force-gpu-rasterization');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
const path = require('path');
const fs = require('fs');
require('./server.js');

// --- Incoming-file disk streaming (single active write stream) ---
// The renderer is sandboxed, so all fs access happens here. `write` resolves
// only when the OS accepts the chunk or 'drain' fires — that backpressure
// flows back through the renderer and WebRTC to the sender.
let writeStream = null;
let writeFailed = null;

let closePromise = null;
function closeStream() {
  if (closePromise) return closePromise;
  if (!writeStream) return Promise.resolve();
  const s = writeStream;
  writeStream = null;
  closePromise = new Promise(resolve => {
    const done = () => { closePromise = null; resolve(); };
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
// Defer app.getPath until first use (module-level call may throw before ready).
let _sp = null;
function sp() {
  if (!_sp) _sp = path.join(app.getPath('userData'), 'settings.json');
  return _sp;
}
function readSettings() {
  try { return JSON.parse(fs.readFileSync(sp(), 'utf8')); } catch { return {}; }
}
function writeSettings(obj) {
  try { fs.writeFileSync(sp(), JSON.stringify(obj), 'utf8'); } catch {}
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
ipcMain.on('pair:setFeed', (_e, url) => { if (typeof url === 'string') startAutoUpdater(url.replace(/^ws:/,'http:')); });
ipcMain.on('pair:toggleFullscreen', () => { if (mainWin) mainWin.setFullscreen(!mainWin.isFullscreen()); });

function createWindow() {
  mainWin = new BrowserWindow({
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

  mainWin.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  // Needed for the browser File System Access API used to stream large downloads.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'notifications' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
  });
  // Required for navigator.mediaDevices.getDisplayMedia() in Electron 28+.
  // Without this handler the API throws "Not supported".
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const useId = pendingSourceId;
    pendingSourceId = null;
    desktopCapturer.getSources({ types: ['screen', 'window'], fetchWindowIcons: false, thumbnailSize: { width: 320, height: 240 } })
      .then(sources => {
        if (!sources.length) { callback({}); return }
        const src = useId ? sources.find(s => s.id === useId) : null;
        if (!src) {
          const pd = screen.getPrimaryDisplay();
          callback({ video: sources.find(s => s.display_id === String(pd.id)) || sources.find(s => s.name === 'Entire Screen') || sources[0], audio: request.audioRequested ? 'loopback' : undefined });
        } else {
          callback({ video: src, audio: request.audioRequested ? 'loopback' : undefined });
        }
      })
      .catch(e => { console.error('Display media request error:', e); callback({}) });
  });
  createWindow();
  startAutoUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await closeStream();
  if (process.platform !== 'darwin') app.quit();
});
