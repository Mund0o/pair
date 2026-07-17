const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT || 8787);
const rooms = new Map();

// --- HTTP static server (update feed) ----------------------------------------
// Serves ./public on the SAME port as the WebSocket signaling server, so a
// single forwarded port (8787) handles both. Clients fetch /latest.json and the
// installers (.exe / .tar.gz) from here. Everything outside ./public is blocked.
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.json': 'application/json', '.exe': 'application/octet-stream', '.gz': 'application/gzip', '.blockmap': 'application/octet-stream', '.txt': 'text/plain', '.yaml': 'text/plain', '.yml': 'text/plain' };
// Pick the right installer for the visitor's OS from the latest.json manifest,
// based on the User-Agent string. Used by /download (redirect) and the landing
// page so users never have to pick Windows vs Linux manually.
function platformForRequest(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (/windows nt/.test(ua)) return 'win';
  if (/android/.test(ua)) return 'win'; // no mobile build; fall back to Windows installer
  if (/linux|x11/.test(ua)) return 'linux';
  if (/macintosh|mac os x|darwin/.test(ua)) return 'linux'; // no macOS build; fall back to Linux tarball
  return 'win';
}

// Read the current update manifest (latest.json) if present.
function readManifest() {
  try {
    const file = path.join(PUBLIC_DIR, 'latest.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

// Render the landing page. Highlights the installer that matches the visitor's
// OS (best guess from User-Agent); the page also re-checks client-side via
// navigator.platform so the right button is pre-selected even on ambiguous UAs.
function buildLandingPage(manifest) {
  const version = manifest && manifest.version ? manifest.version : '—';
  const notes = manifest && manifest.notes ? manifest.notes : '';
  const winUrl = manifest && manifest.winUrl ? manifest.winUrl : '';
  const linuxUrl = manifest && manifest.linuxUrl ? manifest.linuxUrl : '';
  const initial = platformForRequest({ headers: {} }) === 'linux' ? 'linux' : 'win';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair — download</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;background:#f4f1eb;color:#2a2a2a;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;border:1px solid #e3ddd0;border-radius:14px;padding:34px 38px;max-width:460px;width:100%;box-shadow:0 6px 24px rgba(0,0,0,.06)}
  h1{margin:0 0 4px;font-size:22px}
  .ver{color:#8a8a8a;font-size:13px;margin-bottom:18px}
  .notes{background:#f7f4ec;border-radius:8px;padding:10px 12px;font-size:13px;color:#5a554a;margin-bottom:18px}
  .btn{display:block;width:100%;box-sizing:border-box;text-align:center;text-decoration:none;font-weight:600;font-size:15px;padding:13px 16px;border-radius:9px;margin:8px 0;color:#fff;background:#4f46e5;transition:transform .05s ease,opacity .15s ease}
  .btn:hover{opacity:.92}
  .btn:active{transform:translateY(1px)}
  .btn.alt{background:#2f3136}
  .btn[hidden]{display:none}
  .muted{color:#9a958a;font-size:12px;text-align:center;margin-top:14px}
  .other{text-align:center;margin-top:10px;font-size:12px}
  .other a{color:#4f46e5}
</style>
</head>
<body>
  <div class="card">
    <h1>Pair — private P2P chat</h1>
    <div class="ver">Latest version: ${version}</div>
    ${notes ? `<div class="notes">${escapeHtml(notes)}</div>` : ''}
    <a class="btn" id="win" href="${winUrl || '#'}" download>Download for Windows</a>
    <a class="btn alt" id="linux" href="${linuxUrl || '#'}" download>Download for Linux</a>
    <div class="other" id="other"></div>
    <div class="muted">Your system was detected automatically. Pick the other link if that's wrong.</div>
  </div>
  <script>
    (function(){
      var isLinux = /linux|x11/i.test(navigator.platform) || /linux/i.test(navigator.userAgent);
      var win = document.getElementById('win');
      var linux = document.getElementById('linux');
      var other = document.getElementById('other');
      if (isLinux) {
        win.hidden = true;
        other.innerHTML = 'Not on Linux? <a href="' + (win.getAttribute('href')||'#') + '" download>Get Windows instead</a>.';
      } else {
        linux.hidden = true;
        other.innerHTML = 'Not on Windows? <a href="' + (linux.getAttribute('href')||'#') + '" download>Get Linux instead</a>.';
      }
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const httpServer = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/' || urlPath === '/index.html') {
      const manifest = readManifest();
      // Human-facing landing page: lists both installers and auto-highlights the
      // one matching the visitor's OS (the page also re-checks client-side).
      const page = buildLandingPage(manifest);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (urlPath === '/download') {
      const manifest = readManifest();
      const ua = (req.headers['user-agent'] || '').toLowerCase();
      const isLinux = /linux|x11/.test(ua);
      const url = manifest ? (isLinux ? manifest.linuxUrl : manifest.winUrl) : null;
      if (!url) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('No update published yet.');
        return;
      }
      res.writeHead(302, { 'Location': url });
      res.end();
      return;
    }
    const rel = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error');
  }
});

const wss = new WebSocket.Server({ server: httpServer, host: '0.0.0.0' });

function leave(socket) {
  if (!socket.room) return;
  const peers = rooms.get(socket.room) || [];
  const remaining = peers.filter(peer => peer !== socket);
  if (remaining.length) rooms.set(socket.room, remaining);
  else rooms.delete(socket.room);
  socket.room = null;
}

wss.on('connection', socket => {
  socket.on('message', (raw, isBinary) => {
    // Binary frames are file-stream chunks; relay them verbatim to the peer.
    if (isBinary) {
      if (!socket.room) return;
      for (const peer of rooms.get(socket.room) || []) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN) peer.send(raw);
      }
      return;
    }
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'join' && typeof message.room === 'string') {
      leave(socket);
      const room = message.room.trim().toUpperCase().slice(0, 32);
      const peers = rooms.get(room) || [];
      if (peers.length >= 2) { socket.send(JSON.stringify({ type: 'full' })); return; }
      socket.room = room;
      peers.push(socket);
      rooms.set(room, peers);
      socket.send(JSON.stringify({ type: 'joined', count: peers.length }));
      if (peers.length === 2) peers.forEach(peer => peer.send(JSON.stringify({ type: 'peer-ready' })));
      return;
    }
    if (socket.room) {
      // Relay signaling + any other JSON control messages to the peer.
      for (const peer of rooms.get(socket.room) || []) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(message));
      }
    }
  });
  socket.on('close', () => leave(socket));
  socket.on('error', () => leave(socket));
});

httpServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`Port ${port} is already in use — another Pair server or process is listening. Signaling will rely on that instance; this app will not start its own.`);
    return;
  }
  // Any other listen error is logged, not thrown, so it can't crash the whole
  // Electron app (server.js is required by main.js). The app still runs; it
  // just won't serve signaling/update files on this port.
  console.error(`Pair server failed to start on port ${port}:`, err.message);
});

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Pair server listening on http://0.0.0.0:${port} (signaling + update feed)`);
});
console.log(`Pair signaling server listening on ws://0.0.0.0:${port}`);
