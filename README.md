# Pair

Pair is a two-person, no-account P2P chat prototype. It uses WebRTC data channels for transport and Web Crypto ECDH + AES-GCM for an application-level encryption layer on top of WebRTC's DTLS encryption.

## Run as a PC app

Install Node.js 20 or newer, then from this folder run:

```powershell
npm install
npm start
```

To build a Windows installer:

```powershell
npm run dist
```

The installer will be created in the `dist` folder.

## Run in a browser (optional)

The browser version remains available for testing. Serve this folder over localhost or HTTPS; Web Crypto and WebRTC are restricted in insecure contexts in many browsers.

```powershell
py -m http.server 5173
```

Open `http://localhost:5173` in two browser windows. For a real friend-to-friend connection, the prototype uses manual offer/answer exchange and `iceServers: []`, so it works when the peers can connect directly but may fail across NATs. Adding a TURN server is the next networking step, but the TURN server would relay encrypted bytes and still could not read the content.

## Pairing flow

1. Person A clicks **Create offer**, copies **Your signal** to Person B.
2. Person B pastes it into **Friend's signal**, clicks **Create answer**, and sends the generated answer back.
3. Person A pastes the answer and clicks **Apply signal**.

## Host signaling from your own PC

The installed Pair app now starts the signaling server automatically on port `8787`. You do not need Node.js or a separate terminal. For development, you can also run it manually:

```powershell
npm run signal
```

Forward TCP port `8787` from your router to this PC. The host uses `ws://localhost:8787`; your friend uses `ws://YOUR_PUBLIC_IP:8787`. Both enter the same room code. The host clicks **Host room** and the friend clicks **Join room**. This service only forwards WebRTC setup messages and stores no chat or file data.

If Windows Firewall asks whether Node.js can accept connections, allow it on the intended network. If your ISP uses CGNAT, port forwarding will not work; you would need a public VPS or a VPN overlay.

## Large files

Files are sliced into chunks, encrypted independently, and streamed with a large in-flight window (up to ~16 MB buffered) and a concurrent decrypt pool so the SCTP link stays saturated. The whole file is never loaded into memory during sending. Receiving very large files requires a Chromium browser with the File System Access API (or the Pair app's disk streaming); otherwise the fallback collects chunks in memory and is suitable only for smaller files. The 120 GB limit is enforced client-side.

This is an MVP, not a production security audit. Before relying on it for sensitive data, add authenticated device identity/fingerprint verification, replay protection, a robust signaling UX, TURN support, and audited cryptographic protocol implementations.
