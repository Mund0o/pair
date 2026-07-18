/* Pair: manual-signaling, two-person P2P chat with application-level E2EE. */
const $=s=>document.querySelector(s);const signalOut=$('#signalOut'),signalIn=$('#signalIn'),statusText=$('#statusText'),messages=$('#messages'),messageForm=$('#messageForm'),messageInput=$('#messageInput'),fileInput=$('#fileInput'),chooseFiles=$('#chooseFiles'),transfers=$('#transfers'),pairHint=$('#pairHint'),participantYou=$('#participantYou'),participantFriend=$('#participantFriend'),voiceLog=$('#voiceLog'),screenBtn=$('#screenBtn'),screenPreset=$('#screenPreset'),screenStatus=$('#screenStatus'),screenPreview=$('#screenPreview'),remoteScreen=$('#remoteScreen');
let pc,chat,files,role,sharedKey,sendQueue=Promise.resolve(),receiveQueue=Promise.resolve();let CHUNK=1024*1024;const MAX=120*1024**3;
const SCREEN_PRESETS={'480p30':{width:{ideal:854,max:854},height:{ideal:480,max:480},frameRate:{ideal:30,max:30}},'720p30':{width:{ideal:1280,max:1280},height:{ideal:720,max:720},frameRate:{ideal:30,max:30}},'720p60':{width:{ideal:1280,max:1280},height:{ideal:720,max:720},frameRate:{ideal:60,max:60}},'1080p30':{width:{ideal:1920,max:1920},height:{ideal:1080,max:1080},frameRate:{ideal:30,max:30}},'1080p60':{width:{ideal:1920,max:1920},height:{ideal:1080,max:1080},frameRate:{ideal:60,max:60}},'1440p60':{width:{ideal:2560,max:2560},height:{ideal:1440,max:1440},frameRate:{ideal:60,max:60}},'4k60':{width:{ideal:3840,max:3840},height:{ideal:2160,max:2160},frameRate:{ideal:60,max:60}}};
// Voice: a live two-way WebRTC audio call on the SAME peer connection. Media is
// encrypted by WebRTC's built-in DTLS-SRTP, so it reuses the existing E2EE link.
let localStream=null,micMuted=false,callActive=false,callStart=0,callTimerId=null,callStarting=false,callGen=0;
// Direct handle to the audio transceiver created in setupPeer, so startCall can
// always reuse it (never add a second m-line). Nulled on disconnect/teardown.
let audioTransceiver=null;
// Per-connection sound flags so the chimes don't double/triple: chat+files both
// report "connected", and connection-loss/voice-leave can each fire a leave tone.
let connectSoundDone=false,friendLeftNotified=false;
let screenTransceiver=null,screenActive=false,screenStream=null,screenGen=0;
const callBtn=$('#callBtn'),muteBtn=$('#muteBtn'),volumeSlider=$('#volumeSlider'),callStatus=$('#callStatus'),callTimerEl=$('#callTimer'),remoteAudio=$('#remoteAudio');
// Lightweight synth sound effects via Web Audio (no asset files needed). Each
// call lazily creates/resumes the AudioContext so it works after a user gesture
// and stays quiet until then.
let audioCtx=null;
function sfxCtx(){if(!audioCtx){try{audioCtx=new (window.AudioContext||window.webkitAudioContext)()}catch{return null}}if(audioCtx.state==='suspended'){try{audioCtx.resume()}catch{}}return audioCtx}
// Browsers keep a freshly created AudioContext 'suspended' until a user gesture.
// The connect chime fires from async channel-open callbacks (outside a gesture),
// so pre-warm/resume the context on the first interaction anywhere on the page.
function warmAudio(){const c=sfxCtx();if(c&&c.state==='suspended'){try{c.resume()}catch{}}}
document.addEventListener('pointerdown',warmAudio,{once:true});
document.addEventListener('keydown',warmAudio,{once:true});
function tone(ctx,freq,start,dur,type='sine',gain=0.18){const o=ctx.createOscillator(),g=ctx.createGain();o.type=type;o.frequency.setValueAtTime(freq,ctx.currentTime+start);g.gain.setValueAtTime(0,ctx.currentTime+start);g.gain.linearRampToValueAtTime(gain,ctx.currentTime+start+0.02);g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+start+dur);o.connect(g).connect(ctx.destination);o.start(ctx.currentTime+start);o.stop(ctx.currentTime+start+dur+0.02)}
function setParticipant(el,on){const dot=el.querySelector('.indicator');if(dot)dot.classList.toggle('on',on)}
function logCallEvent(text){const e=document.createElement('div');e.className='log-entry';e.innerHTML='<span class="log-time">'+new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})+'</span>'+text;voiceLog.append(e)}
function playSound(kind){
  const ctx=sfxCtx();if(!ctx)return;
  if(kind==='connect'){tone(ctx,659.25,0,0.16,'sine',0.16);tone(ctx,987.77,0.12,0.22,'sine',0.16)}
  else if(kind==='leave'){tone(ctx,523.25,0,0.18,'sine',0.15);tone(ctx,392.00,0.14,0.30,'sine',0.15)}
  else if(kind==='ring'){tone(ctx,440,0,0.18,'triangle',0.14);tone(ctx,587.33,0.2,0.18,'triangle',0.14);tone(ctx,440,0.4,0.18,'triangle',0.14)}
}
function setupPermanentAudioSink(){
  try{
    const ctx=sfxCtx();const st=remoteAudio.srcObject;
    if(!ctx||!st||!st.getAudioTracks().length)return;
    if(ctx.state==='suspended'){
      // Guard against stacking listeners: only register one resume retry at a
      // time. Without this, every ontrack/call-ring before the first user
      // gesture would add another statechange listener + resume call.
      if(ctx._pairSinkArmed)return;
      ctx._pairSinkArmed=true;
      ctx.addEventListener('statechange',function h(){if(ctx.state==='running'){ctx.removeEventListener('statechange',h);ctx._pairSinkArmed=false;setupPermanentAudioSink()}});
      try{ctx.resume()}catch{}
      return
    }
    if(ctx._pairSinkArmed)ctx._pairSinkArmed=false;
    if(ctx.audioSink){try{ctx.audioSink.disconnect()}catch{}}
    try{const src=ctx.createMediaStreamSource(st);src.connect(ctx.destination);ctx.audioSink=src}catch{}
  }catch{}
}
// Separate WebSocket used to relay file bytes (E2EE) between peers. Reuses the
// same signaling host/room, so no extra port forwarding. Binary frames are
// relayed verbatim; this saturates a LAN far better than WebRTC SCTP.
let streamWs=null,streamRoom=null,streamServer=null;
// Keep a large amount of data in flight so the SCTP pipe stays saturated.
// The sender only waits when bufferedAmount exceeds this; the low-threshold
// is set below it so we refill before the buffer fully drains.
const SEND_WINDOW=32*1024*1024;
async function awaitDrain(){const f=files;if(!f||f.readyState!=='open'||f.bufferedAmount<=f.bufferedAmountLowThreshold)return;for(let i=0;i<500;i++){if(!files||files.readyState!=='open')return;if(files.bufferedAmount<=files.bufferedAmountLowThreshold)return;await new Promise(r=>setTimeout(r,20))}}
// Send a JSON control message over the WebRTC chat channel. If the channel is
// closed mid-send we throw a typed error the caller can treat as "aborted"
// rather than letting an unhandled rejection break the send chain.
async function safeSend(data){const f=files;if(!f||f.readyState!=='open')throw new Error('disconnected');for(let i=0;i<3;i++){try{f.send(data);return}catch(e){const m=String(e?.message||'').toLowerCase();if(m.includes('invalid state')||m.includes('closed')||m.includes('not connected'))throw new Error('disconnected');await awaitDrain()}}throw new Error('send failed after retries')}
// Send over whichever file bus is active, applying backpressure so we don't
// overflow the socket's send buffer. The relay socket uses bufferedAmount; the
// WebRTC channel uses bufferedAmount + the bufferedamountlow event.
const busDrains=new Map();function awaitBusDrain(bus){if(!bus||bus!==fileBus())return Promise.resolve();if(bus.bufferedAmount<=SEND_WINDOW*0.75)return Promise.resolve();let waiters=busDrains.get(bus);if(!waiters){waiters=new Set();busDrains.set(bus,waiters)}return new Promise(r=>{let done=false;  const cleanup=()=>{if(done)return;done=true;clearInterval(timer);clearTimeout(timeout);try{bus.removeEventListener('bufferedamountlow',h)}catch{};waiters.delete(h)};const h=()=>{if(bus.bufferedAmount<=SEND_WINDOW*0.75||bus!==fileBus()){cleanup();r()}};const timer=setInterval(h,50);const timeout=setTimeout(()=>{cleanup();r()},30000);try{bus.addEventListener('bufferedamountlow',h)}catch{};waiters.add(h)})}
async function busSafeSend(data){let retries=0;for(;;){const bus=fileBus();if(!bus)throw new Error('no file channel');
  // Proactively wait if the socket's send buffer is already near the window, so
  // we never overflow it (which would throw and abort the whole transfer).
  if(bus.bufferedAmount>SEND_WINDOW){await awaitBusDrain(bus);continue}
  try{bus.send(data);return}catch(e){const m=String(e?.message||'').toLowerCase();if(m.includes('send queue is full')||m.includes('buffered')||m.includes('invalid state')){retries++;if(retries>100)throw new Error('send failed after excessive retries');await awaitBusDrain(bus);continue}throw e}}}
let sendAbort=new Map(),fileSeq=0;
// Pack metadata+iv+ciphertext into one binary frame: [4B json len][json][iv 12B][ct].
// One send() per chunk (no separate control frame). JSON carries seq/last flags.
function packChunk(seq,offset,ivBuf,ctBuf,last){const hdr=JSON.stringify({t:'c',s:seq,o:offset,l:last?1:0});const h=enc.encode(hdr);const frame=new ArrayBuffer(4+h.length+12+ctBuf.byteLength);const v=new DataView(frame);v.setUint32(0,h.length);new Uint8Array(frame,4,h.length).set(h);new Uint8Array(frame,4+h.length,12).set(ivBuf);new Uint8Array(frame,4+h.length+12).set(ctBuf);return frame}
const enc=new TextEncoder(),dec=new TextDecoder();
function setStatus(text,on=false){statusText.textContent=text;$('.connection').classList.toggle('connected',on);  if(on){const negotiated=pc?.sctp?.maxMessageSize||16*1024*1024;CHUNK=Math.min(1024*1024,Math.max(16*1024,negotiated-4096));[messageInput,chooseFiles].forEach(x=>x.disabled=false);messageForm.querySelector('button').disabled=false;fileInput.disabled=false;$('#leaveRoom').hidden=false;$('#hostRoom').hidden=true;$('#joinRoom').hidden=true;callBtn.disabled=false;if(!connectSoundDone){playSound('connect');connectSoundDone=true}}else{[messageInput,chooseFiles].forEach(x=>x.disabled=true);messageForm.querySelector('button').disabled=true;fileInput.disabled=true;callBtn.disabled=true;endCall(true)}}
function cleanSignal(s){return JSON.parse(atob(s.trim()))}function makeSignal(o){return btoa(JSON.stringify(o))}
async function keyPair(){return crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits'])}async function exportPub(k){return crypto.subtle.exportKey('jwk',k)}async function importPub(j){return crypto.subtle.importKey('jwk',j,{name:'ECDH',namedCurve:'P-256'},false,[])}
let deriveGen=0;async function derive(local,remote){const gen=++deriveGen;const bits=await crypto.subtle.deriveBits({name:'ECDH',public:await importPub(remote)},local.privateKey,256);const fp=await crypto.subtle.digest('SHA-256',bits);$('#fingerprint').textContent='Session key fingerprint: '+[...new Uint8Array(fp)].slice(0,4).map(b=>b.toString(16).padStart(2,'0')).join('');if(gen!==deriveGen)return;const key=await crypto.subtle.importKey('raw',bits,{name:'AES-GCM'},false,['encrypt','decrypt']);if(gen===deriveGen)sharedKey=key;}
async function seal(value){const iv=crypto.getRandomValues(new Uint8Array(12));const data=typeof value==='string'?enc.encode(value):value;const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},sharedKey,data);return {iv:[...iv],data:[...new Uint8Array(ct)]}}async function sealBytes(value){const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},sharedKey,value);return {iv:[...iv],data}}
async function open(o){return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(o.iv)},sharedKey,new Uint8Array(o.data)))}
async function openBytes(iv,data){return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(iv)},sharedKey,data))}
function send(o){if(chat?.readyState==='open')chat.send(JSON.stringify(o))}function addMessage(text,mine=false){$('.empty')?.remove();const el=document.createElement('div');el.className='message '+(mine?'mine':'');el.innerHTML='<div class="bubble"></div><div class="meta">'+(mine?'You':'Friend')+' · '+new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+'</div>';el.querySelector('.bubble').textContent=text;messages.append(el);messages.scrollTop=messages.scrollHeight}
function setupChannels(){chat=pc.createDataChannel('chat');files=pc.createDataChannel('files');wire()}function wire(){if(chat){chat.onopen=()=>setStatus('Connected directly',true);chat.onmessage=async e=>{try{const o=JSON.parse(e.data);if(o.t==='msg')addMessage(dec.decode(await open(o.v)));      else if(o.t==='call-ring'){// Reset the leave-chime flag when the friend rings again, so a second
        // call→leave cycle still plays the leave tone instead of going silent.
        friendLeftNotified=false;setParticipant(participantFriend,true);logCallEvent('Friend joined the call');playSound('ring');setupPermanentAudioSink();}else if(o.t==='call-end'){setParticipant(participantFriend,false);if(!friendLeftNotified){friendLeftNotified=true;playSound('leave')}logCallEvent('Friend left the call');callStatus.textContent='Friend left the call';callStatus.className='call-status';endCall(true)}else if(o.t==='screen-start'){logCallEvent('Friend started screen sharing');remoteScreen.hidden=false;screenStatus.textContent='Friend sharing';}else if(o.t==='screen-end'){logCallEvent('Friend stopped screen sharing');remoteScreen.srcObject=null;remoteScreen.hidden=true;screenStatus.textContent='Not sharing';}}catch{}}}if(files){files.binaryType='arraybuffer';files.bufferedAmountLowThreshold=Math.max(1*1024*1024,SEND_WINDOW-4*1024*1024);   files.onmessage=e=>{receiveQueue=receiveQueue.then(()=>onFileFrame(e)).catch(()=>{})};files.onopen=()=>setStatus('Connected directly',true)}if(streamWs){streamWs.binaryType='arraybuffer';try{streamWs.bufferedAmountLowThreshold=SEND_WINDOW*0.75}catch{};streamWs.onmessage=e=>onStreamFrame(e);}}
// Pick the fast relay socket if available, otherwise the WebRTC data channel.
function fileBus(){return (streamWs&&streamWs.readyState===WebSocket.OPEN)?streamWs:(files&&files.readyState==='open'?files:null)}

// ICE servers: STUN for LAN/direct, plus the self-hosted coturn TURN relay so
// two peers on DIFFERENT networks (different NATs) can still connect. Without
// TURN, WebRTC often can't traverse NAT and the connection hangs forever on
// "Connecting…".
//
// Default points at the host's own coturn. Both UDP and TCP transports are
// listed because some networks block UDP entirely; the TCP variant lets those
// peers still relay. Set PAIR_TURN env (JSON array) to override these defaults
// with your own TURN server, e.g.:
//   set PAIR_TURN=[{"urls":"turn:YOUR_PUBLIC_IP:3481","username":"pair","credential":"YOUR_SECRET"}]
// External TURN port is 3481 on the WAN side (forwarded to coturn's standard
// 3478 internally) because port 3478 was already in use by another device on
// this router. coturn still listens on 3478 inside the container; the router
// rule remaps 3481 -> 3478.
const SELF_TURN={username:'pair',credential:'cbb325a9723628e480bb2190014d531c'};
function defaultTurnServers(){try{const pubIp='YOUR_PUBLIC_IP';return[
  {urls:'stun:stun.l.google.com:19302'},
  {urls:'stun:stun1.l.google.com:19302'},
  {urls:'turn:'+pubIp+':3481?transport=udp',...SELF_TURN},
  {urls:'turn:'+pubIp+':3481?transport=tcp',...SELF_TURN}
]}catch{return[]}}
const ICE_SERVERS=(()=>{try{const e=process.env.PAIR_TURN;if(e)return JSON.parse(e)}catch{}return defaultTurnServers()})();
function setupPeer(){pc=new RTCPeerConnection({iceServers:ICE_SERVERS});pc.onicecandidate=()=>{};  let wasEverConnected=false;
  pc.onconnectionstatechange=()=>{if(!pc)return;if(pc.connectionState==='connected'){screenBtn.disabled=false;screenPreset.disabled=false;if(pc._connectTimer){clearTimeout(pc._connectTimer);pc._connectTimer=connectTimer=null}    if(!wasEverConnected){wasEverConnected=true}else{setStatus('Connected directly',true);friendLeftNotified=false}}if(['failed','disconnected','closed'].includes(pc.connectionState)){screenBtn.disabled=true;screenPreset.disabled=true;if(pc._connectTimer){clearTimeout(pc._connectTimer);pc._connectTimer=connectTimer=null}setStatus(pc.connectionState);if(!friendLeftNotified){friendLeftNotified=true;playSound('leave')}};if(pc.connectionState==='connecting'){pairHint.textContent='Negotiating peer connection (ICE '+ (pc.iceConnectionState||'') +')…';armConnectTimeout()}};pc.oniceconnectionstatechange=()=>{if(pc.iceConnectionState==='failed'){pairHint.textContent='Peer connection failed (ICE '+(pc.iceConnectionState||'')+'). NAT/network blocks a direct link and the TURN relay could not be reached. Both must be on v1.0.0+, and your network must allow the TURN relay.'}else if(pc.iceConnectionState==='checking'||pc.iceConnectionState==='connected'){pairHint.textContent='Negotiating peer connection (ICE '+(pc.iceConnectionState||'')+' )…'}};pc.ondatachannel=e=>{if(e.channel.label==='chat')chat=e.channel;else files=e.channel;wire()};
  // If WebRTC can't establish within ~25s (e.g. TURN unreachable / blocked
  // network), surface a clear message instead of hanging on "Connecting…" forever.
  let connectTimer=null;pc._connectTimer=null;function armConnectTimeout(){if(connectTimer||pc.connectionState==='connected')return;connectTimer=setTimeout(()=>{pc._connectTimer=null;if(pc&&pc.connectionState!=='connected'&&pc.connectionState!=='failed'&&pc.connectionState!=='closed'){pairHint.textContent='Still connecting… if this persists, one of you is behind a strict NAT/firewall that blocks the peer connection. Try a different network or add a TURN server.'}},25000);pc._connectTimer=connectTimer}
  // Negotiate a bidirectional audio transceiver up front so voice works without
  // a renegotiation round-trip once the call starts. No track is attached until
  // the user clicks Start voice, keeping the mic off until then. Keep a direct
  // reference so startCall always reuses THIS transceiver (never addTransceiver),
  // even after endCall nulls its track and the receiver track is momentarily
  // unavailable — which would otherwise fall through to a second m-line.
  // Create a silent audio track to establish a bidirectional audio transceiver
  // via addTrack (which matches by sender.track.kind) instead of addTransceiver
  // (whose receiver-based kind matching fails for createAnswer in Chrome).
  try{
    const silentCtx=new (window.AudioContext||window.webkitAudioContext)({sampleRate:48000});
    const silentDst=silentCtx.createMediaStreamDestination();
    silentDst.channelCount=1;
    audioTransceiver=pc.addTrack(silentDst.stream.getAudioTracks()[0],silentDst.stream);
    // Keep a reference so we can close the AudioContext on disconnect
    pc._silentAudioCtx=silentCtx;
  }catch(e){console.warn('Silent audio track failed, using addTransceiver:',e);try{audioTransceiver=pc.addTransceiver('audio',{direction:'sendrecv'})}catch(e2){console.warn('addTransceiver also failed:',e2);audioTransceiver=null}}
  logCallEvent('Diag: setupPeer transceivers='+pc.getTransceivers().length+' audioTr='+(audioTransceiver?'ok:mid='+audioTransceiver.mid:'null'));
  let gestureGuard=false;
  pc.ontrack=e=>{logCallEvent('Diag: ontrack kind='+e.track.kind);try{if(e.track.kind==='audio'){logCallEvent('Audio track received from friend');if(remoteAudio.srcObject){try{remoteAudio.srcObject.getAudioTracks().forEach(t=>t.onended=null)}catch{}}const stream=e.streams[0]||new MediaStream([e.track]);remoteAudio.srcObject=stream;remoteAudio.muted=false;remoteAudio.volume=0.5;setParticipant(participantFriend,true);e.track.onended=()=>{setParticipant(participantFriend,false);if(!friendLeftNotified){friendLeftNotified=true;playSound('leave')}logCallEvent('Friend left the call');callStatus.textContent='Friend left the call';callStatus.className='call-status'};const playNow=()=>{const p=remoteAudio.play();if(p&&p.catch)p.catch(()=>{})};playNow();setupPermanentAudioSink();if(!gestureGuard){gestureGuard=true;document.addEventListener('pointerdown',()=>{playNow();setupPermanentAudioSink()},{once:true});document.addEventListener('keydown',()=>{playNow();setupPermanentAudioSink()},{once:true})}}else if(e.track.kind==='video'){remoteScreen.hidden=false;try{remoteScreen.srcObject=e.streams[0]||new MediaStream([e.track]);remoteScreen.play()}catch{};e.track.onended=()=>{remoteScreen.srcObject=null;remoteScreen.hidden=true;}}}catch{}};
}
async function waitIce(){if(pc.iceGatheringState==='complete')return;await new Promise(resolve=>{const f=()=>{if(pc.iceGatheringState==='complete'){pc.removeEventListener('icegatheringstatechange',f);resolve()}};pc.addEventListener('icegatheringstatechange',f);setTimeout(resolve,5000)})}
function patchOpusSdp(sdp){return sdp.replace(/a=fmtp:111[^\r\n]*/g,m=>{if(!m.includes('maxaveragebitrate'))m+='; maxaveragebitrate=510000';else m=m.replace(/maxaveragebitrate=\d+/,'maxaveragebitrate=510000');if(!m.includes('maxplaybackrate'))m+='; maxplaybackrate=48000';if(!m.includes('useinbandfec'))m+='; useinbandfec=1';if(!m.includes('stereo'))m+='; stereo=0';if(!m.includes('sprop-stereo'))m+='; sprop-stereo=0';return m})}
$('#createOffer').onclick=async()=>{if(pc)pc.close();role='offer';setupPeer();const kp=await keyPair();pc._kp=kp;setupChannels();const o=await pc.createOffer();await pc.setLocalDescription({type:'offer',sdp:patchOpusSdp(o.sdp)});await waitIce();signalOut.value=makeSignal({type:'offer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)});pairHint.textContent='Send this signal to your friend. Paste their answer into Friend’s signal, then click Apply signal.'};
$('#createAnswer').onclick=async()=>{try{if(pc)pc.close();role='answer';const remote=cleanSignal(signalIn.value);setupPeer();const kp=await keyPair();pc._kp=kp;await pc.setRemoteDescription({type:'offer',sdp:remote.sdp});await derive(kp,remote.pub);const a=await pc.createAnswer();await pc.setLocalDescription({type:'answer',sdp:patchOpusSdp(a.sdp)});await waitIce();signalOut.value=makeSignal({type:'answer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)});pairHint.textContent='Send this answer back to the person who made the offer.'}catch(e){pairHint.textContent='Could not create answer: '+e.message}};
$('#applySignal').onclick=async()=>{try{const remote=cleanSignal(signalIn.value);if(role==='offer'){await pc.setRemoteDescription({type:'answer',sdp:remote.sdp});await derive(pc._kp,remote.pub);pairHint.textContent='Connecting…'}else if(!role)pairHint.textContent='First paste an offer, then click Create answer.'}catch(e){pairHint.textContent='Could not apply signal: '+e.message}};$('#copySignal').onclick=()=>navigator.clipboard?.writeText(signalOut.value);
messageForm.onsubmit=async e=>{e.preventDefault();const v=messageInput.value.trim();if(!v||!sharedKey)return;send({t:'msg',v:await seal(v)});addMessage(v,true);messageInput.value=''};
chooseFiles.onclick=()=>fileInput.click();fileInput.onchange=()=>{const files=[...fileInput.files];fileInput.value='';files.forEach(sendFile);};
function transfer(name,size,dir){const el=document.createElement('div');el.className='transfer';el.innerHTML='<div class="transfer-top"><span class="transfer-name"></span><span class="transfer-status"></span></div><div class="bar"><i></i></div><div class="transfer-stats"><span class="transfer-speed"></span><span class="transfer-eta"></span></div><div class="transfer-peer"></div><div class="transfer-btns"><button class="cancel-btn text-button" hidden>Cancel</button><button class="retry-btn primary" hidden>Retry</button></div>';el.querySelector('.transfer-name').textContent=name+' · '+format(size);transfers.prepend(el);return el}function format(n){return n<1e9?(n/1e6).toFixed(1)+' MB':(n/1e9).toFixed(2)+' GB'}function formatSpeed(bps){if(bps<1e3)return(bps).toFixed(0)+' B/s';if(bps<1e6)return(bps/1e3).toFixed(1)+' KB/s';if(bps<1e9)return(bps/1e6).toFixed(1)+' MB/s';return(bps/1e9).toFixed(2)+' GB/s'}function formatEta(sec){if(!isFinite(sec)||sec<0)return'';sec=Math.round(sec);if(sec<60)return sec+'s';const m=Math.floor(sec/60),s=sec%60;if(m<60)return m+'m '+s+'s';const h=Math.floor(m/60);return h+'h '+(m%60)+'m'}function updateStats(el,done,total,startTime){const elapsed=(performance.now()-startTime)/1000;if(elapsed<0.5)return;const speed=done/elapsed;const remaining=(total-done)/speed;el.querySelector('.transfer-speed').textContent=formatSpeed(speed);el.querySelector('.transfer-eta').textContent=formatEta(remaining)}
// Resolvers for sender-side "peer accepted/rejected" signals, keyed by seq.
const acceptWait=new Map();
async function sendFile(file,retryId){try{if(file.size>MAX)return alert('This file is larger than 120 GB.');if(!fileBus())return alert('Connect first, then send a file.');const el=transfer(file.name,file.size,'out');const cancelBtn=el.querySelector('.cancel-btn'),retryBtn=el.querySelector('.retry-btn');cancelBtn.hidden=false;retryBtn.hidden=true;const seq=retryId||++fileSeq;const ctrl={abort:false};sendAbort.set(seq,ctrl);outTransfers.set(seq,el);cancelBtn.onclick=()=>{const aw=acceptWait.get(seq);if(aw){acceptWait.delete(seq);aw.reject(new Error('Cancelled'))}ctrl.abort=true;cancelBtn.hidden=true;try{if(files&&files.readyState==='open')files.send(JSON.stringify({t:'cancel',seq}))}catch{}};const meta=await seal(JSON.stringify({name:file.name,size:file.size,type:file.type,seq}));sendQueue=sendQueue.then(async()=>{  const t0=performance.now();try{await safeSend(JSON.stringify({t:'start',v:meta}));
  // If the user already cancelled (during safeSend(start) above), bail immediately
  // rather than setting up an accept wait that would hang forever.
  if(ctrl.abort)throw new Error('Cancelled');
  // Wait for the friend to accept before streaming any bytes, so we don't push
  // a whole file into the relay before they've agreed to receive it. Time out
  // so we never hang if the peer never responds.
  await new Promise((resolve,reject)=>{const to=setTimeout(()=>{if(acceptWait.has(seq)){acceptWait.delete(seq);reject(new Error('No answer'))}},60000);acceptWait.set(seq,{resolve:()=>{clearTimeout(to);resolve()},reject:e=>{clearTimeout(to);reject(e)}});});
  if(ctrl.abort)throw new Error('Cancelled');
  // Pipeline: keep reading+encrypting ahead of what's actually on the wire so
  // crypto never gates the network. We wait only when the bus send buffer is
  // near SEND_WINDOW, and refill as soon as it drains. Over the relay socket
  // this saturates a LAN; over WebRTC it falls back to SCTP.
  let inflight=0;const pending=[];let lastPeerSent=0,lastPctSent=-1;
  // Overlap read+encrypt of the NEXT chunk with the send of the CURRENT chunk so
  // that the CPU-bound encryption doesn't stall the pipeline on fast networks.
  // Pre-read the first chunk before the loop; each iteration reads one ahead.
  let preloadedStart=0;
  let preloadedEnd=Math.min(CHUNK,file.size);
  let preloaded=file.size>0?file.slice(preloadedStart,preloadedEnd).arrayBuffer():null;
  let nextOfs=preloadedEnd;  // byte offset of the NEXT unread chunk
    const emitPct=(done,pct)=>{el.querySelector('i').style.width=Math.min(100,done/file.size*100)+'%';el.querySelector('.transfer-status').textContent=pct+'%';updateStats(el,done,file.size,t0);const now=Date.now();if((pct!==lastPctSent&&now-lastPeerSent>250)||now-lastPeerSent>500){lastPctSent=pct;lastPeerSent=now;safeSend(JSON.stringify({t:'progress',seq,p:pct})).catch(()=>{})}};
  const pump=async()=>{while(preloaded){const bus=fileBus();if(!bus)throw new Error('disconnected');while(inflight>=SEND_WINDOW){await awaitBusDrain(bus);if(ctrl.abort)throw new Error('Cancelled')}
    // Start reading the NEXT chunk now, in parallel with encrypt+send of this one.
    const readStart=nextOfs;
    const readEnd=Math.min(readStart+CHUNK,file.size);
    const nextRead=readStart<file.size?file.slice(readStart,readEnd).arrayBuffer():null;
    nextOfs=readEnd;
    // Encrypt+pack+send the PREVIOUSLY pre-loaded chunk.
    const raw=await preloaded;if(ctrl.abort)throw new Error('Cancelled');
    const {iv,data}=await sealBytes(new Uint8Array(raw));
    const frame=packChunk(seq,preloadedStart,new Uint8Array(iv),new Uint8Array(data),preloadedEnd>=file.size);
    inflight+=frame.byteLength;
    const p=busSafeSend(frame).finally(()=>{inflight-=frame.byteLength});
    p.then(()=>{},()=>{});
    pending.push(p);
    const done=preloadedEnd;const pct=Math.round(done/file.size*100);emitPct(done,pct);
    // Advance the preload to the chunk we just started reading.
    preloaded=nextRead;
    preloadedStart=readStart;
    preloadedEnd=readEnd;
    if(pending.length%32===0)await Promise.race(pending.slice(-32).map(p=>p.catch(()=>{})))}}
  await pump();
  await Promise.all(pending);
    if(!ctrl.abort){await safeSend(JSON.stringify({t:'end',seq}));el.querySelector('.transfer-status').textContent='Sent';el.querySelector('.transfer-speed').textContent='';el.querySelector('.transfer-eta').textContent='';setPeerPct(el,100);cancelBtn.hidden=true}sendAbort.delete(seq);}catch(e){const aw=acceptWait.get(seq);if(aw){acceptWait.delete(seq);if(!ctrl.abort)aw.reject(e)}sendAbort.delete(seq);if(ctrl.abort||(e&&e.message==='Cleared')||(e&&e.message==='disconnected')){el.querySelector('.transfer-status').textContent='Cancelled'}else if(e&&e.message==='rejected'){const s=el.querySelector('.transfer-status');s.textContent='Declined by friend';s.classList.add('declined')}else{const s=el.querySelector('.transfer-status');s.textContent='Failed: '+(e?.message||e);s.classList.add('failed')}el.querySelector('.transfer-speed').textContent='';el.querySelector('.transfer-eta').textContent='';cancelBtn.hidden=true;retryBtn.hidden=false;retryBtn.onclick=()=>{el.remove();sendFile(file);};try{await safeSend(JSON.stringify({t:'end',seq,cancelled:true}))}catch{}}outTransfers.delete(seq);}).catch(()=>{});}catch{}}
// Active incoming transfers, keyed by their seq (so multiple files in flight
// are kept separate). Chunks carry seq in their frame header and route here.
const activeTransfers=new Map();
// Outgoing transfers, keyed by seq, so we can show the peer's reported progress.
const outTransfers=new Map();
// Renders the peer's mirrored progress under a transfer card.
function setPeerPct(el,pct){const p=el.querySelector('.transfer-peer');if(!p)return;p.textContent='Friend: '+pct+'%';p.style.display='';}
// Chunks that arrive on the relay before the matching 'start' is processed,
// held per-seq so nothing is dropped or misrouted.
const pendingFrames=new Map();
const acceptCards=new Map();
function showAcceptCard(meta,seq){const card=document.createElement('div');card.className='transfer accept-card';card.innerHTML='<div class="accept-top"><strong class="accept-name"></strong><span class="accept-size"></span></div><p class="accept-hint">Your friend wants to send you a file.</p><div class="accept-btns"><button class="accept-yes primary">Accept</button><button class="accept-no">Decline</button></div>';card.querySelector('.accept-name').textContent=meta.name;card.querySelector('.accept-size').textContent=' · '+format(meta.size);const yes=card.querySelector('.accept-yes'),no=card.querySelector('.accept-no');  const resolve=new Promise(r=>{const done=v=>{if(acceptCards.get(seq)!==done)return;clearTimeout(acceptTimer);acceptCards.delete(seq);pendingFrames.delete(seq);card.remove();r(v)};const acceptTimer=setTimeout(()=>done(false),60000);acceptCards.set(seq,done);yes.onclick=()=>done(true);no.onclick=()=>done(false)});transfers.prepend(card);return resolve}
// Per-incoming-file ordered write queue so decrypted chunks hit disk in order
// even though decryption runs concurrently in a pool.
function makeWriteQueue(t){let tail=Promise.resolve();return fn=>{tail=tail.then(fn).catch(e=>{t.writeError=e});return tail}}
// Enqueue one received binary chunk frame, routed to its transfer by seq. If
// that transfer hasn't started yet (control rides the WebRTC channel and may
// arrive after relay chunks), buffer per-seq so nothing is dropped/misrouted.
// Runs synchronously and never awaits.
function enqueueChunk(buf){
  try{
  const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);const len=dv.getUint32(0);
  // Guard against corrupt/truncated frames so one bad chunk can't throw inside
  // the socket onmessage handler (which would drop the message loop frame).
  if(!(len>0&&4+len+12<=buf.byteLength))return;
  const hdr=JSON.parse(dec.decode(buf.subarray(4,4+len)));
  if(hdr.t!=='c')return;
  const seq=hdr.s||0;
  const frame={iv:buf.subarray(4+len,4+len+12),ct:buf.subarray(4+len+12),last:!!hdr.l};
  const t=activeTransfers.get(seq);
  if(t&&!t.abort){t.frames.push(frame);t.wire+=buf.byteLength;if(hdr.l)t.lastSeen=true}
  else{(pendingFrames.get(seq)||pendingFrames.set(seq,[]).get(seq)).push({frame,len:buf.byteLength,last:!!hdr.l})}
  }catch{}
}
// Dedicated handler for the relay socket. Processes chunk frames immediately
// and independently of the WebRTC control channel, so the Accept-card click or
// any control handling can never block bulk reception.
function onStreamFrame(e){
  if(!(e.data instanceof ArrayBuffer))return;
  enqueueChunk(new Uint8Array(e.data));
}
// Control + (fallback) chunk handler for the WebRTC data channel.
async function onFileFrame(e){
  if(e.data instanceof ArrayBuffer){enqueueChunk(new Uint8Array(e.data));return;}
  let o;try{o=JSON.parse(e.data)}catch{return;}
  try{
  if(o.t==='start'){let meta;try{meta=JSON.parse(dec.decode(await open(o.v)))}catch{try{await safeSend(JSON.stringify({t:'reject',seq:0}))}catch{};return}const seq=meta.seq||0;const accepted=await showAcceptCard(meta,seq);if(!accepted){await safeSend(JSON.stringify({t:'reject',seq}));return}const t={...meta,seq,received:0,wire:0,el:transfer(meta.name,meta.size,'in'),startTime:performance.now(),frames:[],parts:[],lastSeen:false,abort:false,done:Promise.resolve(),writeError:null,saveMode:'mem',writer:null,stuck:null};t.writeQueue=makeWriteQueue(t);activeTransfers.set(seq,t);if(window.pairSave){try{const r=await window.pairSave.start(meta.name);if(r&&r.ok){t.saveMode='pair'}}catch{t.saveMode='mem'}}else if(window.showSaveFilePicker){try{const handle=await showSaveFilePicker({suggestedName:meta.name});t.writer=await handle.createWritable();t.saveMode='fileAccess'}catch{t.saveMode='mem'}}if(t.saveMode==='mem'&&meta.size>4*1024*1024*1024)alert('No disk streaming available. This large file will be held in memory and may fail. Use the Pair app for large transfers.');
  // Tell the sender we accepted, so it begins streaming.
  await safeSend(JSON.stringify({t:'accept',seq}));
  // Drain any chunk frames that arrived on the relay before this 'start'.
  const held=pendingFrames.get(seq);if(held){for(const p of held){t.frames.push(p.frame);t.wire+=p.len;if(p.last)t.lastSeen=true}pendingFrames.delete(seq)}
           t.done=processIncoming(t);t.done.catch(e=>{if(t.el){const s=t.el.querySelector('.transfer-status');if(s&&!s.classList.contains('failed')&&!s.classList.contains('declined')){s.textContent='Failed: '+(e?.message||e);s.classList.add('failed')}}});}else if(o.t==='cancel'){const ac=acceptCards.get(o.seq);if(ac)try{ac(false)}catch{};acceptCards.delete(o.seq);pendingFrames.delete(o.seq);}else if(o.t==='progress'){const el=outTransfers.get(o.seq)||(activeTransfers.get(o.seq)&&activeTransfers.get(o.seq).el);if(el)setPeerPct(el,o.p|0);return}else if(o.t==='reject'){const t=activeTransfers.get(o.seq);const aw=acceptWait.get(o.seq);if(aw){acceptWait.delete(o.seq);aw.reject(new Error('rejected'))}if(t){t.abort=true;if(t.saveMode==='pair')try{await window.pairSave.cancel()}catch{}if(t.writer)try{await t.writer.abort()}catch{}const s=t.el.querySelector('.transfer-status');s.textContent='Declined';s.classList.add('declined');activeTransfers.delete(o.seq)}}else if(o.t==='accept'){const aw=acceptWait.get(o.seq);if(aw){acceptWait.delete(o.seq);aw.resolve()}}else if(o.t==='end'){const t=activeTransfers.get(o.seq);if(!t){const ac=acceptCards.get(o.seq);if(ac)try{ac(false)}catch{};return}acceptWait.delete(o.seq);if(o.cancelled||t.abort){const senderCancelled=!!o.cancelled&&!t.abort;t.abort=true;if(t.saveMode==='pair')try{await window.pairSave.cancel()}catch{}if(t.writer)try{await t.writer.abort()}catch{}if(senderCancelled){const s=t.el.querySelector('.transfer-status');s.textContent='Sender cancelled';s.classList.add('declined');activeTransfers.delete(o.seq)}return}try{await t.done;if(t.saveMode==='fileAccess')await t.writer.close();else if(t.saveMode==='pair')await window.pairSave.end();else{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(t.parts||[],{type:t.type}));a.download=t.name;a.click()}t.el.querySelector('.transfer-status').textContent='Received';t.el.querySelector('.transfer-speed').textContent='';t.el.querySelector('.transfer-eta').textContent='';setPeerPct(t.el,100)}catch(e){if(t.saveMode==='pair')try{await window.pairSave.cancel()}catch{}if(t.writer)try{await t.writer.abort()}catch{}const s=t.el.querySelector('.transfer-status');s.textContent='Save failed: '+(e?.message||e);s.classList.add('failed')}finally{activeTransfers.delete(o.seq)}}
  }catch{}}
// Decrypt + write one transfer's frames concurrently (bounded pool) but commit
// bytes to disk / memory in arrival order. Updates progress + ETA for EVERY
// save mode (disk streaming on Linux included). Disk writes are batched to cut
// per-chunk IPC overhead.
const WRITE_BATCH=8*1024*1024;
// If no progress happens for this long (ms) the transfer is considered stuck and
// we surface exactly which phase it was stuck on so the user isn't left guessing.
const STALL_TIMEOUT=15000;
async function processIncoming(t){const POOL=8;const queue=t.writeQueue;let active=0;  const slot=()=>new Promise(r=>{if(active<POOL)r();else{const h=()=>{active--;if(active<POOL)r();else setTimeout(h,0)};pendingSlots.push(h)}});const pendingSlots=[];const release=()=>{const h=pendingSlots.shift();if(h)h();else active--};
  // Order-preserving reassembly: the decrypt pool resolves chunks out of arrival
  // order, so we buffer each decrypted chunk by its arrival index and only ever
  // commit a CONTIGUOUS run starting at `expected`. This guarantees bytes hit
  // disk/memory in the exact order they were sent, regardless of pool reordering.
  const buffer=new Map();let expected=0;let nextIdx=0;let batch=[];let batchLen=0;
  const emit=bytes=>{batch.push(bytes);batchLen+=bytes.length;t.received+=bytes.length;touch();const frac=t.size>0?Math.min(100,t.received/t.size*100):100;const pct=Math.round(frac);t.el.querySelector('i').style.width=frac+'%';t.el.querySelector('.transfer-status').textContent=pct+'%';updateStats(t.el,t.received,t.size,t.startTime);sendPeerProgress(pct)};
  const flushBatch=async()=>{if(!batch.length)return;const all=batch;batch=[];batchLen=0;
    if(t.saveMode==='discard')return;
    if(t.saveMode==='fileAccess'){for(const b of all)await t.writer.write(b);return}
    if(t.saveMode==='pair'){for(const b of all)await window.pairSave.write(b);return}
    for(const b of all)t.parts.push(b)};
  const drainBuffer=async()=>{while(buffer.has(expected)){const bytes=buffer.get(expected);buffer.delete(expected);expected++;emit(bytes);if(batchLen>=WRITE_BATCH||t.lastSeen)await flushBatch()}};
  if(t.size===0)t.lastSeen=true;
  let phase=t.received>0?'waiting for the final chunk':'waiting for the first chunk';
  let lastProgress=Date.now();let lastPeerSent=0,lastPctSent=-1;
  const watchdog=setInterval(()=>{if(Date.now()-lastProgress>STALL_TIMEOUT){const where=active>0?'draining decrypted chunks':'waiting for the next chunk ('+phase+')';t.stuck=new Error('Transfer stalled — stuck '+where+'. Received '+format(t.received)+' of '+format(t.size)+'. The connection may have dropped; try resending.')}},STALL_TIMEOUT/3);
  const touch=()=>{lastProgress=Date.now()};
  const sendPeerProgress=pct=>{const now=Date.now();if((pct!==lastPctSent&&now-lastPeerSent>250)||now-lastPeerSent>500){lastPctSent=pct;lastPeerSent=now;safeSend(JSON.stringify({t:'progress',seq:t.seq,p:pct})).catch(()=>{})}};
  try{
  while(!(t.lastSeen&&t.frames.length===0)){
    if(t.abort)return;
    phase=t.received>0?'waiting for the final chunk':'waiting for the first chunk';
    while(t.frames.length){
      if(t.stuck)throw t.stuck;
      if(t.abort)return;
      await slot();active++;touch();
      const idx=nextIdx++;const f=t.frames.shift();
      openBytes(f.iv,f.ct).then(bytes=>queue(async()=>{if(t.saveMode==='discard')return;buffer.set(idx,bytes);await drainBuffer()})).catch(e=>{t.writeError=e||new Error('decrypt failed');t.abort=true}).finally(release);
    }
    if(t.stuck)throw t.stuck;
    if(!t.lastSeen)await new Promise(r=>setTimeout(r,4));
  }
  while(active>0)await new Promise(r=>setTimeout(r,4));
  if(t.stuck)throw t.stuck;
  if(t.writeError)throw t.writeError;
  await flushBatch();
  }finally{clearInterval(watchdog);try{await flushBatch()}catch{}}
}
setStatus('Not connected');

(async()=>{async function ss(key){if(window.pairSettings){try{return await window.pairSettings.get(key)}catch{}}try{return localStorage.getItem('pair.'+key)}catch{}}async function ssSet(key,val){if(window.pairSettings){try{await window.pairSettings.set(key,val);return}catch{}}try{localStorage.setItem('pair.'+key,val)}catch{}}const savedServer=await ss('signalServer');const savedRoom=await ss('roomCode');if(savedServer)$('#signalServer').value=savedServer;if(savedRoom)$('#roomCode').value=savedRoom;['signalServer','roomCode'].forEach(id=>$('#'+id).addEventListener('input',()=>ssSet(id==='signalServer'?'signalServer':'roomCode',$('#'+id).value.trim())));})();
  // Auto-update pulls latest.json directly from GitHub (configured in updater.js),
  // independent of the signaling server. No action needed here.

let signaling;
async function automaticPair(kind){
  // Tear down any prior session so a second Host/Join click (or host→leave→host)
  // doesn't leak an old pc/signaling whose handlers fire stale signals.
  if(pc||signaling)disconnectRoom();
  role=kind; const address=$('#signalServer').value.trim(); const room=$('#roomCode').value.trim();
  if(!address||!room)return pairHint.textContent='Enter a signaling address and room code.';
  pairHint.textContent='Connecting to signaling server…'; signaling=new WebSocket(address);
  signaling.onopen=()=>{try{signaling.send(JSON.stringify({type:'join',room}))}catch{}pairHint.textContent='Waiting for your friend in room '+room.toUpperCase()+'…'};
  signaling.onerror=()=>pairHint.textContent='Could not reach the signaling server. Check the address and firewall.';
  signaling.onmessage=async event=>{try{const message=JSON.parse(event.data);
    if(message.type==='full'){pairHint.textContent='That room already has two people.';return}
    if(message.type==='peer-ready'&&role==='host'){
      setupPeer();const kp=await keyPair();if(!pc)return;pc._kp=kp;setupChannels();
      const offer=await pc.createOffer();if(!pc)return;await pc.setLocalDescription({type:'offer',sdp:patchOpusSdp(offer.sdp)});if(!pc)return;await waitIce();if(!signaling)return;
      logCallEvent('Diag: offer has m=audio=' + (pc.localDescription.sdp.includes('m=audio')?'yes':'NO'));
      signaling.send(JSON.stringify({type:'signal',payload:{kind:'offer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}}));
      openStreamRelay(address,room);pairHint.textContent='Offer sent. Connecting…';
      // If the friend never answers (wrong role, different room, or an old build
      // without TURN), don't hang silently — tell them what to check.
      setTimeout(()=>{if(pc&&pc.connectionState!=='connected'){pairHint.textContent='No answer from your friend after 20s. Make sure exactly ONE of you clicked Host and the other clicked Join, you are in the SAME room code, and both are on the latest version (v1.0.0+ with TURN).'}},20000)
    }
    if(message.type==='signal'){const remote=message.payload;
      // Both clicked Host: each receives the other's offer but role==='host', so
      // neither branch matches. Surface it instead of hanging.
      if(remote.kind==='offer'&&role==='host'){pairHint.textContent='Both of you clicked Host. One of you must click Leave, then that person clicks Join instead.';return}
      if(remote.kind==='offer'&&role==='join'){
        setupPeer();const kp=await keyPair();if(!pc)return;pc._kp=kp;
        await pc.setRemoteDescription({type:'offer',sdp:remote.sdp});if(!pc)return;await derive(kp,remote.pub);if(!pc)return;
        // Ensure the audio transceiver's direction is sendrecv so the answer
        // includes a sender — the browser may have created a recvonly transceiver
        // for the offer's audio m-line when no local sender track was attached yet.
        // Force audio transceiver direction to sendrecv so the answer includes a
        // sender. Also update audioTransceiver to the MATCHED transceiver (with
        // non-null mid) so startCall uses it — the one from addTransceiver in
        // setupPeer has mid=null and would send on an un-negotiated path.
        pc.getTransceivers().filter(t=>t.receiver.track?.kind==='audio').forEach(t=>{try{if(t.direction!=='sendrecv'){t.setDirection('sendrecv');logCallEvent('Diag: set audioTr direction to sendrecv (was '+t.direction+')')}}catch(e){logCallEvent('Diag: setDirection error: '+e.message)}});
        const matched=pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio'&&t.mid);if(matched)audioTransceiver=matched;
        logCallEvent('Diag: before createAnswer transceivers='+pc.getTransceivers().length+' audioTr='+(pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio')?'ok:dir='+(pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio').direction):'null'));
        const a=await pc.createAnswer();if(!pc)return;await pc.setLocalDescription({type:'answer',sdp:patchOpusSdp(a.sdp)});if(!pc)return;await waitIce();if(!signaling)return;
        logCallEvent('Diag: answer has m=audio=' + (pc.localDescription.sdp.includes('m=audio')?'yes':'NO'));
        signaling.send(JSON.stringify({type:'signal',payload:{kind:'answer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}}));
        openStreamRelay(address,room);pairHint.textContent='Answer sent. Connecting…'
      }else if(remote.kind==='answer'&&role==='host'){
        logCallEvent('Diag: before setRD(answer) transceivers='+pc.getTransceivers().length+' audioTr='+(pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio')?'ok:dir='+(pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio').direction):'null'));
        await pc.setRemoteDescription({type:'answer',sdp:remote.sdp});if(!pc)return;await derive(pc._kp,remote.pub);
        logCallEvent('Diag: after setRD(answer)');
        const matched=pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio'&&t.mid);if(matched)audioTransceiver=matched;
        const cd=matched?matched.currentDirection:'none';
        logCallEvent('Diag: audio currentDir='+cd);
        // If the friend's answer didn't include an audio sender, startCall will
        // add a transceiver and renegotiate instead of relying on the unmatched one.
        openStreamRelay(address,room);pairHint.textContent='Secure connection established.'
      }else if(remote.kind==='reneg-offer'){
        // Either peer can initiate screen share, so both roles must be able to
        // answer a reneg-offer.
        // Glare handling: if we have our own reneg pending, the joiner defers
        // (supersede its offer and answer the host's instead). role is always
        // opposite across the two peers, so this is a deterministic tiebreak.
        if(renegPending&&role==='join'){renegotiating++;renegPending=false}
        try{if(!pc)return;await pc.setRemoteDescription({type:'offer',sdp:remote.sdp});if(!pc)return;const a=await pc.createAnswer();if(!pc)return;await pc.setLocalDescription({type:'answer',sdp:patchOpusSdp(a.sdp)});if(!pc)return;await waitIce();if(signaling)signaling.send(JSON.stringify({type:'signal',payload:{kind:'reneg-answer',sdp:pc.localDescription.sdp}}))}catch(e){console.warn('reneg-offer error',e)}
      }else if(remote.kind==='reneg-answer'){
        try{if(!pc)return;await pc.setRemoteDescription({type:'answer',sdp:remote.sdp})}catch(e){console.warn('reneg-answer error',e)}
      }
    }
  }catch(e){console.warn('signaling message error',e);pairHint.textContent='Connection setup failed: '+(e&&e.message||e)}};
}
// Open the separate relay socket used to move file bytes. Same host + room as
// the signaling socket; the server relays binary frames to the other peer.
function openStreamRelay(address,room){streamServer=address;streamRoom=room;try{if(streamWs){try{streamWs.onopen=null;streamWs.onerror=null;streamWs.onmessage=null;streamWs.close()}catch{}}streamWs=new WebSocket(address);streamWs.onopen=()=>{try{streamWs.send(JSON.stringify({type:'join',room:room+':stream'}))}catch{};wire()};streamWs.onerror=()=>{if(!pc||pc.connectionState!=='connected')pairHint.textContent='Stream relay failed — transfers will use WebRTC';};streamWs.onclose=()=>{};}catch{streamWs=null;if(!pc||pc.connectionState!=='connected')pairHint.textContent='Could not open stream relay — transfers will use WebRTC'}}
$('#hostRoom').onclick=()=>automaticPair('host'); $('#joinRoom').onclick=()=>automaticPair('join');
function disconnectRoom(){if(pc&&pc._connectTimer){clearTimeout(pc._connectTimer);pc._connectTimer=null}try{if(chat){chat.onmessage=null;chat.close()}}catch{}try{if(files){files.onmessage=null;files.close()}}catch{}try{if(pc)pc.close()}catch{}if(pc&&pc._silentAudioCtx)try{pc._silentAudioCtx.close()}catch{}pc=chat=files=null;if(signaling){try{signaling.onopen=null;signaling.onerror=null;signaling.onmessage=null;signaling.close()}catch{}signaling=null}if(streamWs){try{streamWs.onopen=null;streamWs.onerror=null;streamWs.onmessage=null;streamWs.onclose=null;streamWs.close()}catch{}streamWs=null}streamServer=streamRoom=null;sharedKey=null;try{remoteAudio.srcObject=null}catch{};try{if(audioCtx&&audioCtx.audioSink){audioCtx.audioSink.disconnect();delete audioCtx.audioSink}}catch{};try{remoteScreen.srcObject=null}catch{};remoteScreen.hidden=true;screenActive=false;screenStream=null;
  // Release any pending backpressure waiters so in-flight sends don't hang
  // forever after the bus is closed. They'll re-check fileBus(), find it gone,
  // and the send loop will abort cleanly.
  busDrains.forEach(set=>set.forEach(h=>{try{h()}catch{}}));busDrains.clear();
  sendAbort.forEach(c=>c.abort=true);sendAbort.clear();acceptWait.forEach(w=>{try{w.reject(new Error('Disconnected'))}catch{}});acceptWait.clear();
  acceptCards.forEach(done=>{try{done(false)}catch{}});acceptCards.clear();  activeTransfers.forEach(t=>t.abort=true);activeTransfers.clear();pendingFrames.clear();outTransfers.clear();sendQueue=Promise.resolve();receiveQueue=Promise.resolve();connectSoundDone=false;friendLeftNotified=false;role=null;audioTransceiver=null;deriveGen++;setParticipant(participantYou,false);setParticipant(participantFriend,false);voiceLog.innerHTML='';setStatus('Not connected');$('#leaveRoom').hidden=true;$('#hostRoom').hidden=false;$('#joinRoom').hidden=false;pairHint.textContent='Disconnected from room.'}
$('#leaveRoom').onclick=()=>disconnectRoom();
// Clear-list button: tears down any in-flight transfers and empties the list.
const clearBtn=$('#clearTransfers');
function refreshClearBtn(){const has=transfers.querySelector('.transfer,.accept-card');clearBtn.hidden=!has;}
function clearTransfers(){
  // Abort anything still in flight so it doesn't resurrect a card.
  sendAbort.forEach(c=>c.abort=true);sendAbort.clear();
  acceptWait.forEach(w=>{try{w.reject(new Error('Cleared'))}catch{}});acceptWait.clear();
  acceptCards.forEach(done=>{try{done(false)}catch{}});acceptCards.clear();
  activeTransfers.forEach(t=>{t.abort=true;if(t.saveMode==='pair')try{window.pairSave.cancel()}catch{}if(t.writer)try{t.writer.abort()}catch{}});activeTransfers.clear();
  pendingFrames.clear();outTransfers.clear();
  transfers.innerHTML='<p class="muted small">No transfers yet.</p>';
  refreshClearBtn();
}
clearBtn.onclick=clearTransfers;
// Reveal the Clear button whenever a transfer/accept card is added.
const _origPrepend=transfers.prepend.bind(transfers);
transfers.prepend=el=>{_origPrepend(el);refreshClearBtn();return el;};
refreshClearBtn();

// --- Voice call ---------------------------------------------------------------
// Start/stop a two-way audio call over the existing peer connection. The audio
// transceiver was negotiated during setup, so we only attach the mic here.
async function startCall(){
  // Guard against re-entry: a second click during getUserMedia or replaceTrack
  // would leak a MediaStream and drive concurrent instances through the state
  // machine. The flag is cleared in the finally block below.
  if(callActive||!pc||callStarting)return;
  callStarting=true;
  friendLeftNotified=false;
  const gen=callGen;
  try{
    callStatus.textContent='Requesting mic…';callStatus.className='call-status ringing';
    localStream=await navigator.mediaDevices.getUserMedia({audio:{sampleRate:48000,channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(!pc){localStream.getTracks().forEach(t=>t.stop());localStream=null;return}
    const track=localStream.getAudioTracks()[0];
    const allTransceivers=pc.getTransceivers();
    const tr=audioTransceiver||allTransceivers.find(t=>t.receiver.track?.kind==='audio'&&t.mid)||allTransceivers.find(t=>t.receiver.track?.kind==='audio')||(function(){try{return pc.addTransceiver('audio',{direction:'sendrecv'})}catch{return null}})();
    const sender=tr?tr.sender:null;
    logCallEvent('Diag: startCall transceivers='+allTransceivers.length+' audioTr='+(tr?'ok:mid='+tr.mid+' dir='+tr.direction:'null')+' sender='+(sender?'ok':'null'));
    if(!sender){try{send({t:'call-end'})}catch{};endCall(true);callStatus.textContent='No audio sender available';callStatus.className='call-status';return}
    try{await sender.replaceTrack(track)}catch(e){try{send({t:'call-end'})}catch{};endCall(true);callStatus.textContent='Failed to attach mic: '+(e?.message||e);callStatus.className='call-status';return}
    // Configure Opus for maximum quality — 510 kbps (spec limit), 48 kHz, FEC
    try{const p=sender.getParameters();if(p&&p.codecs){p.codecs.forEach(c=>{if(c.mimeType.toLowerCase()==='audio/opus'){c.maxptime=120;c.ptime=20;if(c.parameters){c.parameters.maxaveragebitrate=510000;c.parameters.maxplaybackrate=48000;c.parameters.useinbandfec=1;c.parameters.stereo=0;c.parameters.spropmaxcapturerate=48000}}});await sender.setParameters(p)}}catch(e){console.warn('opus params:',e)}
    // endCall may have run while we were awaiting getUserMedia or replaceTrack
    // (e.g. user clicked Stop Voice or the connection dropped). The generation
    // counter callGen is incremented by every endCall call. If it changed, bail.
    if(gen!==callGen||!pc){try{sender.replaceTrack(null)}catch{};if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}return}
    try{remoteAudio.muted=false;remoteAudio.play()}catch{}
    setupPermanentAudioSink();
    // endCall/disconnectRoom may have run during a nested await; if pc is gone bail.
    if(!pc){try{sender.replaceTrack(null)}catch{};if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}return}
    callActive=true;callStart=Date.now();callBtn.textContent='⏹ Stop voice';callBtn.disabled=false;muteBtn.hidden=false;micMuted=false;muteBtn.textContent='🔇 Mute mic';
    try{remoteAudio.volume=0.5}catch{};volumeSlider.value=50;volumeSlider.hidden=false;
    setParticipant(participantYou,true);logCallEvent('You joined the call');
    playSound('ring');try{send({t:'call-ring'})}catch{}
    callStatus.textContent='Voice live';callStatus.className='call-status live';
    callTimerId=setInterval(()=>{const s=Math.floor((Date.now()-callStart)/1000);const m=Math.floor(s/60),sec=s%60;callTimerEl.textContent=m+':'+String(sec).padStart(2,'0')},1000);
  }catch(e){try{send({t:'call-end'})}catch{};endCall(true);const m=String(e?.message||e||'');if(/not\s*found/i.test(m))callStatus.textContent='No mic found — check your microphone connection';else if(/permission|denied|not\s*allowed/i.test(m))callStatus.textContent='Mic access blocked — allow microphone in browser/app settings';else callStatus.textContent='Mic error — '+(e?.message||e);callStatus.className='call-status';
  }finally{callStarting=false}
}
// Tear down the call and release the mic. `silent` skips UI churn when called
// from a disconnect.
function endCall(silent){
  if(!silent){setParticipant(participantYou,false);logCallEvent('You left the call')}
  if(screenActive)stopScreenShare(true);
  callGen++;
  if(callTimerId){clearInterval(callTimerId);callTimerId=null}
  callTimerEl.textContent='';
  // Stopping the local track silences our outgoing audio WITHOUT touching the
  // negotiated transceiver, so no renegotiation is triggered (the app doesn't
  // handle mid-call renegotiation). The peer's receiver just gets silence.
  if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}
  // Drop our sender's track so a stopped track doesn't linger on the transceiver
  // (which would otherwise keep matching in startCall and complicate reconnects).
  if(pc){try{pc.getSenders().forEach(s=>{if(s.track&&s.track.kind==='audio'){try{s.replaceTrack(null)}catch{}}})}catch{}}
  // Only clear the remote audio element's source when the room is left
  // (disconnectRoom), NOT on endCall. A temporary ICE drop would otherwise
  // null the srcObject and ontrack never fires again for the same transceiver,
  // permanently killing audio for the session.
  callActive=false;micMuted=false;
  callBtn.textContent='🎙 Start voice';muteBtn.hidden=true;volumeSlider.hidden=true;callStatus.textContent='Voice off';callStatus.className='call-status';
  if(!silent){callBtn.disabled=!pc;try{send({t:'call-end'})}catch{}}
}
function toggleMute(){
  if(!localStream)return;
  micMuted=!micMuted;
  localStream.getAudioTracks().forEach(t=>t.enabled=!micMuted);
  muteBtn.textContent=micMuted?'🎙 Unmute mic':'🔇 Mute mic';
}
callBtn.onclick=()=>{if(callActive)endCall(false);else{try{remoteAudio.muted=false;remoteAudio.play()}catch{};setupPermanentAudioSink();startCall()}};
muteBtn.onclick=toggleMute;
volumeSlider.oninput=()=>{const v=parseInt(volumeSlider.value)/100;try{remoteAudio.volume=v}catch{}};

// --- Screen share -------------------------------------------------------------
// Either peer can start/stop screen share, so either peer can drive a
// renegotiation. `renegotiating` is a generation counter: each call increments
// it and only the most-recent call is allowed to send its offer. That way a
// quick stop→start (or a preset change) supersedes any in-flight reneg.
let renegotiating=0;
// Glare guard: if we receive the peer's reneg-offer while we have one pending,
// we resolve it by role. The joiner defers (answers the host's offer instead of
// insisting on its own); the host wins. role is deterministic across peers.
let renegPending=false;
async function renegotiate(){
  if(!signaling||!pc)return;
  const myId=++renegotiating;
  renegPending=true;
  try{
    const offer=await pc.createOffer({iceRestart:false});
    if(!pc||myId!==renegotiating){renegPending=false;return}
    await pc.setLocalDescription({type:'offer',sdp:patchOpusSdp(offer.sdp)});
    if(!pc||myId!==renegotiating){renegPending=false;return}
    await waitIce();
    if(!signaling||myId!==renegotiating){renegPending=false;return}
    signaling.send(JSON.stringify({type:'signal',payload:{kind:'reneg-offer',sdp:pc.localDescription.sdp}}));
  }catch(e){console.warn('renegotiate error',e)}
  renegPending=false;
}
async function startScreenShare(){
  if(screenActive||!pc)return;
  const gen=++screenGen;
  try{
    const preset=SCREEN_PRESETS[screenPreset.value];
    const constraints=preset?{video:{...preset}}:{video:true};
    constraints.video.cursor='always';
    const stream=await navigator.mediaDevices.getDisplayMedia(constraints);
    if(gen!==screenGen||!pc){stream.getTracks().forEach(t=>t.stop());return}
    screenStream=stream;
    const track=stream.getVideoTracks()[0];
    if(!track){stream.getTracks().forEach(t=>t.stop());return}
    // Add the track dynamically — creates a new video transceiver
    let sender;
    try{sender=pc.addTrack(track,stream)}catch{stream.getTracks().forEach(t=>t.stop());return}
    // Prefer AV1 then VP9 then VP8 codec order
    try{const tr=pc.getTransceivers().find(t=>t.sender===sender);if(tr){const caps=RTCRtpSender.getCapabilities('video');if(caps){const cs=[];['video/AV1','video/VP9','video/VP8','video/H264','video/H265'].forEach(mt=>{const c=caps.codecs.find(c=>c.mimeType===mt);if(c)cs.push(c)});if(cs.length)tr.setCodecPreferences(cs)}}}catch{}
    if(gen!==screenGen||!pc){try{pc.removeTrack(sender)}catch{};stream.getTracks().forEach(t=>t.stop());return}
    screenActive=true;
    screenPreview.srcObject=stream;screenPreview.hidden=false;try{screenPreview.play()}catch{}
    screenBtn.textContent='⏹ Stop Sharing';screenStatus.textContent='Sharing';
    try{send({t:'screen-start'})}catch{};
    logCallEvent('You started screen sharing');
    track.onended=()=>{if(screenActive)stopScreenShare()};
    await renegotiate();if(gen!==screenGen)return;
  }catch(e){screenStatus.textContent='Share failed: '+(e.message||e);logCallEvent('Screen share error: '+e.message)}
}
async function stopScreenShare(fromEnd){
  if(!screenActive&&!fromEnd)return;
  screenGen++;
  screenActive=false;
  if(screenStream){screenStream.getTracks().forEach(t=>t.stop());screenStream=null}
  if(pc){
    const senders=pc.getTransceivers().filter(t=>t.sender&&t.sender.track&&t.sender.track.kind==='video').map(t=>t.sender);
    senders.forEach(s=>{try{pc.removeTrack(s)}catch{}});
    // Await so a rapid Share→preset-change→Share can't start a second reneg
    // before the removal reneg has been signaled (which would otherwise race
    // two offers and leave a dangling localDescription).
    await renegotiate();
  }
  screenPreview.srcObject=null;screenPreview.hidden=true;
  screenBtn.textContent='🖥 Share Screen';screenBtn.disabled=!pc;
  if(!fromEnd){screenStatus.textContent='Not sharing';try{send({t:'screen-end'})}catch{};logCallEvent('You stopped screen sharing')}
}
screenBtn.onclick=()=>{if(screenActive)stopScreenShare();else startScreenShare()};
screenPreset.onchange=()=>{if(screenActive){stopScreenShare();startScreenShare()}};

// Auto-update banner. Only wires up when running inside the Pair app
// (window.pairEnv is exposed by preload.js). Browsers ignore this block.
if(window.pairEnv&&window.pairEnv.onUpdate){const banner=$('#updateBanner'),title=$('#updateTitle'),notes=$('#updateNotes'),link=$('#updateLink'),restart=$('#updateRestart');$('#updateDismiss').onclick=()=>{banner.hidden=true};window.pairEnv.onUpdate(info=>{banner.hidden=false;title.textContent='Update available — version '+info.version;if(info.notes)notes.textContent=info.notes;else notes.textContent='';if(info.stage==='link'){link.hidden=false;link.href=info.url;link.target='_blank'}else link.hidden=true;if(info.stage==='ready'){restart.hidden=false;restart.onclick=()=>window.pairEnv.restartForUpdate()}else restart.hidden=true})}
