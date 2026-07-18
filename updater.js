// Pair auto-updater. Checks a self-hosted latest.json manifest for a newer
// version and either installs it (Windows) or notifies the user (Linux).
//
// We intentionally do NOT use electron-updater: that requires Authenticode
// signatures, which this project doesn't have. Instead, on Windows we download
// the NSIS installer and launch it via shell.openPath, which works unsigned.
const { app, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

// Where the update manifest (latest.json) lives. We host it on GitHub — the
// installer + tarball are public release assets and latest.json always points
// at them, so updates work with zero reliance on a personal server. Override
// with PAIR_FEED env or ~/.pair-update-url if you ever self-host instead.
const DEFAULT_FEED = 'https://raw.githubusercontent.com/Mund0o/pair/master/public';
const CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes

function readFeedUrl() {
  if (process.env.PAIR_FEED) return process.env.PAIR_FEED.trim().replace(/\/$/, '');
  try {
    const file = path.join(os.homedir(), '.pair-update-url');
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim().replace(/\/$/, '');
  } catch {}
  return DEFAULT_FEED;
}

// Compare two semver-ish strings (e.g. "0.2.0" < "0.3.0"). Returns true if
// `remote` is strictly newer than `local`.
function isNewer(local, remote) {
  const a = String(local).split('.').map(n => parseInt(n, 10) || 0);
  const b = String(remote).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((b[i] || 0) > (a[i] || 0)) return true;
    if ((b[i] || 0) < (a[i] || 0)) return false;
  }
  return false;
}

// Fetch a URL as text or buffer. Uses http or https depending on the scheme.
// `depth` caps redirect-following to avoid an infinite redirect loop.
function fetchUrl(url, { binary = false } = {}, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('too many redirects'));
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchUrl(new URL(res.headers.location, url).toString(), { binary }, depth + 1));
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  }).then(buf => (binary ? buf : buf.toString('utf8')));
}

function downloadInstaller(url, dest) {
  return fetchUrl(url, { binary: true }).then(buf => {
    if (!buf || !buf.length) throw new Error('downloaded file is empty');
    return new Promise((resolve, reject) => {
      fs.writeFile(dest, buf, err => err ? reject(err) : resolve(dest));
    });
  });
}

// One check cycle. Resolves when done; never throws (logs errors instead).
async function checkOnce(feedUrl) {
  if (checking) return;
  if (!feedUrl) { console.log('[updater] no feed URL configured'); return; }
  checking = true;
  try { const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  let manifest;
  try {
    manifest = JSON.parse(await fetchUrl(feedUrl.replace(/\/$/, '') + '/latest.json'));
  } catch (e) {
    console.log('[updater] could not reach', feedUrl, e.message);
    return;
  }
  const current = app.getVersion();
  if (!isNewer(current, manifest.version)) return;

  console.log('[updater] update available:', manifest.version, '(have', current + ')');
  if (process.platform === 'win32') {
    if (!manifest.winUrl) return;
    try { if (win) win.webContents.send('update-available', {
      platform: 'win32', version: manifest.version, notes: manifest.notes || '', stage: 'downloading'
    }); } catch {}
    try {
      const dest = path.join(app.getPath('userData'), 'pair-update.exe');
      await downloadInstaller(manifest.winUrl, dest);
      try { if (win) win.webContents.send('update-available', {
        platform: 'win32', version: manifest.version, stage: 'ready'
      }); } catch {}
      // Track whether the user requests the restart; also install on quit.
      pendingInstall = { path: dest };
    } catch (e) {
      console.log('[updater] download failed:', e.message);
    }
  } else {
    // Linux (tar.gz): cannot self-install, just notify with a download link.
    try { if (win) win.webContents.send('update-available', {
      platform: 'linux', version: manifest.version, notes: manifest.notes || '',
      url: manifest.linuxUrl, stage: 'link'
    }); } catch {}
  }
} finally { checking = false; } }

let pendingInstall = null;
let timer = null;
let initialTimer = null;
let beforeQuitRegistered = false;
let checking = false;

// Called by the renderer (Windows) when the user clicks "Restart to update".
function performInstall() {
  if (!pendingInstall) return;
  const p = pendingInstall.path;
  pendingInstall = null;
  // Opening the NSIS installer while the app is still running causes file-in-use
  // errors, so quit first. NSIS then runs and replaces the app.
  shell.openPath(p).then(err => { if (!err) app.quit(); else pendingInstall = p; });
}

function startAutoUpdater(explicitFeed) {
  // Prefer an explicit feed (e.g. the same host the user already configured for
  // signaling), then env, then ~/.pair-update-url, then localhost.
  const feedUrl = explicitFeed || readFeedUrl();
  // Idempotent: this can be called on startup AND again whenever the renderer
  // sends a new feed (pair:setFeed). Clear any prior timer so we never stack
  // multiple 30-minute intervals (which would multiply downloads/installs) or
  // register duplicate before-quit listeners.
  if (initialTimer) clearTimeout(initialTimer);
  if (timer) clearInterval(timer);
  if (!beforeQuitRegistered) {
    app.on('before-quit', () => {
      if (pendingInstall) shell.openPath(pendingInstall.path);
      pendingInstall = null;
    });
    beforeQuitRegistered = true;
  }
  // First check shortly after boot (let the window finish loading), then repeat.
  initialTimer = setTimeout(() => checkOnce(feedUrl), 4000);
  timer = setInterval(() => checkOnce(feedUrl), CHECK_INTERVAL);
}

module.exports = { startAutoUpdater, performInstall };
