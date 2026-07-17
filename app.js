/* Pair: manual-signaling, two-person P2P chat with application-level E2EE. */
const $=s=>document.querySelector(s);const signalOut=$('#signalOut'),signalIn=$('#signalIn'),statusText=$('#statusText'),statusDot=$('#statusDot'),messages=$('#messages'),messageForm=$('#messageForm'),messageInput=$('#messageInput'),fileInput=$('#fileInput'),chooseFiles=$('#chooseFiles'),transfers=$('#transfers'),pairHint=$('#pairHint');
let pc,chat,files,role,sharedKey,sendQueue=Promise.resolve(),receiveQueue=Promise.resolve();let CHUNK=1024*1024;const MAX=120*1024**3;
// Voice: a live two-way WebRTC audio call on the SAME peer connection. Media is
// encrypted by WebRTC's built-in DTLS-SRTP, so it reuses the existing E2EE link.
let localStream=null,micMuted=false,callActive=false,callStart=0,callTimerId=null;
const callBtn=$('#callBtn'),muteBtn=$('#muteBtn'),callStatus=$('#callStatus'),callTimerEl=$('#callTimer'),remoteAudio=$('#remoteAudio');
// Separate WebSocket used to relay file bytes (E2EE) between peers. Reuses the
// same signaling host/room, so no extra port forwarding. Binary frames are
// relayed verbatim; this saturates a LAN far better than WebRTC SCTP.
let streamWs=null,streamRoom=null,streamServer=null;
// Keep a large amount of data in flight so the SCTP pipe stays saturated.
// The sender only waits when bufferedAmount exceeds this; the low-threshold
// is set below it so we refill before the buffer fully drains.
const SEND_WINDOW=16*1024*1024;
let drainWait=null;function awaitDrain(){if(files.bufferedAmount<=files.bufferedAmountLowThreshold)return Promise.resolve();if(!drainWait)drainWait=new Promise(r=>{const h=()=>{files.removeEventListener('bufferedamountlow',h);drainWait=null;r()};files.addEventListener('bufferedamountlow',h)});return drainWait}
// Send a JSON control message over the WebRTC chat channel. If the channel is
// closed mid-send we throw a typed error the caller can treat as "aborted"
// rather than letting an unhandled rejection break the send chain.
async function safeSend(data){for(;;){try{files.send(data);return}catch(e){const m=String(e?.message||'').toLowerCase();if(m.includes('send queue is full')||m.includes('buffered')){await awaitDrain();continue}if(m.includes('invalid state')||m.includes('closed')||m.includes('not connected'))throw new Error('disconnected');throw e}}}
// Send over whichever file bus is active, applying backpressure so we don't
// overflow the socket's send buffer. The relay socket uses bufferedAmount; the
// WebRTC channel uses bufferedAmount + the bufferedamountlow event.
const busDrains=new Map();function awaitBusDrain(bus){if(bus.bufferedAmount<=SEND_WINDOW*0.75)return Promise.resolve();if(!bus||bus!==fileBus())return Promise.resolve();let waiters=busDrains.get(bus);if(!waiters){waiters=new Set();busDrains.set(bus,waiters)}return new Promise(r=>{const h=()=>{bus.removeEventListener('bufferedamountlow',h);waiters.delete(h);r()};waiters.add(h);bus.addEventListener('bufferedamountlow',h)})}
async function busSafeSend(data){for(;;){const bus=fileBus();if(!bus)throw new Error('no file channel');
  // Proactively wait if the socket's send buffer is already near the window, so
  // we never overflow it (which would throw and abort the whole transfer).
  if(bus.bufferedAmount>SEND_WINDOW){await awaitBusDrain(bus);continue}
  try{bus.send(data);return}catch(e){const m=String(e?.message||'').toLowerCase();if(m.includes('send queue is full')||m.includes('buffered')||m.includes('invalid state')){await awaitBusDrain(bus);continue}throw e}}}
let sendAbort=new Map(),fileSeq=0;
// Pack metadata+iv+ciphertext into one binary frame: [4B json len][json][iv 12B][ct].
// One send() per chunk (no separate control frame). JSON carries seq/last flags.
function packChunk(seq,offset,ivBuf,ctBuf,last){const hdr=JSON.stringify({t:'c',s:seq,o:offset,l:last?1:0});const h=enc.encode(hdr);const frame=new ArrayBuffer(4+h.length+12+ctBuf.byteLength);const v=new DataView(frame);v.setUint32(0,h.length);new Uint8Array(frame,4,h.length).set(h);new Uint8Array(frame,4+h.length,12).set(ivBuf);new Uint8Array(frame,4+h.length+12).set(ctBuf);return frame}
const enc=new TextEncoder(),dec=new TextDecoder();
function setStatus(text,on=false){statusText.textContent=text;$('.connection').classList.toggle('connected',on);if(on){const negotiated=pc?.sctp?.maxMessageSize||16*1024*1024;CHUNK=Math.min(1024*1024,Math.max(16*1024,negotiated-4096));[messageInput,chooseFiles].forEach(x=>x.disabled=false);messageForm.querySelector('button').disabled=false;fileInput.disabled=false;$('#leaveRoom').hidden=false;$('#hostRoom').hidden=true;$('#joinRoom').hidden=true;callBtn.disabled=false}else{[messageInput,chooseFiles].forEach(x=>x.disabled=true);messageForm.querySelector('button').disabled=true;fileInput.disabled=true;callBtn.disabled=true;endCall(true)}}
function cleanSignal(s){return JSON.parse(atob(s.trim()))}function makeSignal(o){return btoa(JSON.stringify(o))}
async function keyPair(){return crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveKey'])}async function exportPub(k){return crypto.subtle.exportKey('jwk',k)}async function importPub(j){return crypto.subtle.importKey('jwk',j,{name:'ECDH',namedCurve:'P-256'},false,[])}
async function derive(local,remote){const bits=await crypto.subtle.deriveBits({name:'ECDH',public:await importPub(remote)},local.privateKey,256);const fp=await crypto.subtle.digest('SHA-256',bits);$('#fingerprint').textContent='Session key fingerprint: '+[...new Uint8Array(fp)].slice(0,4).map(b=>b.toString(16).padStart(2,'0')).join('');sharedKey=await crypto.subtle.importKey('raw',bits,{name:'AES-GCM'},false,['encrypt','decrypt']);}
async function seal(value){const iv=crypto.getRandomValues(new Uint8Array(12));const data=typeof value==='string'?enc.encode(value):value;const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},sharedKey,data);return {iv:[...iv],data:[...new Uint8Array(ct)]}}async function sealBytes(value){const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},sharedKey,value);return {iv:[...iv],data}}
async function open(o){return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(o.iv)},sharedKey,new Uint8Array(o.data)))}
async function openBytes(iv,data){return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(iv)},sharedKey,data))}
function send(o){if(chat?.readyState==='open')chat.send(JSON.stringify(o))}function addMessage(text,mine=false){$('.empty')?.remove();const el=document.createElement('div');el.className='message '+(mine?'mine':'');el.innerHTML='<div class="bubble"></div><div class="meta">'+(mine?'You':'Friend')+' · '+new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+'</div>';el.querySelector('.bubble').textContent=text;messages.append(el);messages.scrollTop=messages.scrollHeight}
function setupChannels(){chat=pc.createDataChannel('chat');files=pc.createDataChannel('files');wire()}function wire(){if(chat){chat.onopen=()=>setStatus('Connected directly',true);chat.onmessage=async e=>{try{const o=JSON.parse(e.data);if(o.t==='msg')addMessage(dec.decode(await open(o.v)))}catch{}}}if(files){files.binaryType='arraybuffer';files.bufferedAmountLowThreshold=Math.max(1*1024*1024,SEND_WINDOW-4*1024*1024);files.onmessage=e=>{receiveQueue=receiveQueue.then(()=>onFileFrame(e))};files.onopen=()=>setStatus('Connected directly',true)}if(streamWs){streamWs.binaryType='arraybuffer';try{streamWs.bufferedAmountLowThreshold=SEND_WINDOW*0.75}catch{};streamWs.onmessage=e=>onStreamFrame(e);}}
// Pick the fast relay socket if available, otherwise the WebRTC data channel.
function fileBus(){return (streamWs&&streamWs.readyState===WebSocket.OPEN)?streamWs:(files&&files.readyState==='open'?files:null)}
async function busSend(data){const bus=fileBus();if(!bus)throw new Error('no file channel');if(typeof data==='string')bus.send(data);else bus.send(data)}
function setupPeer(){pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});pc.onicecandidate=()=>{};pc.onconnectionstatechange=()=>{if(['failed','disconnected','closed'].includes(pc.connectionState))setStatus(pc.connectionState)};pc.ondatachannel=e=>{if(e.channel.label==='chat')chat=e.channel;else files=e.channel;wire()};
  // Negotiate a bidirectional audio transceiver up front so voice works without
  // a renegotiation round-trip once the call starts. No track is attached until
  // the user clicks Start voice, keeping the mic off until then.
  try{const t=pc.addTransceiver('audio',{direction:'sendrecv'});t.setDirection('sendrecv')}catch{}
  pc.ontrack=e=>{if(e.track.kind==='audio'){remoteAudio.srcObject=e.streams[0]||new MediaStream([e.track]);try{remoteAudio.play().catch(()=>{})}catch{}}};
}
async function waitIce(){if(pc.iceGatheringState==='complete')return;await new Promise(resolve=>{const f=()=>{if(pc.iceGatheringState==='complete'){pc.removeEventListener('icegatheringstatechange',f);resolve()}};pc.addEventListener('icegatheringstatechange',f);setTimeout(resolve,5000)})}
$('#createOffer').onclick=async()=>{if(pc)pc.close();role='offer';setupPeer();const kp=await keyPair();pc._kp=kp;setupChannels();await pc.setLocalDescription(await pc.createOffer());await waitIce();signalOut.value=makeSignal({type:'offer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)});pairHint.textContent='Send this signal to your friend. Paste their answer into Friend’s signal, then click Apply signal.'};
$('#createAnswer').onclick=async()=>{try{if(pc)pc.close();role='answer';const remote=cleanSignal(signalIn.value);setupPeer();const kp=await keyPair();pc._kp=kp;await pc.setRemoteDescription({type:'offer',sdp:remote.sdp});await derive(kp,remote.pub);await pc.setLocalDescription(await pc.createAnswer());await waitIce();signalOut.value=makeSignal({type:'answer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)});pairHint.textContent='Send this answer back to the person who made the offer.'}catch(e){pairHint.textContent='Could not create answer: '+e.message}};
$('#applySignal').onclick=async()=>{try{const remote=cleanSignal(signalIn.value);if(role==='offer'){await pc.setRemoteDescription({type:'answer',sdp:remote.sdp});await derive(pc._kp,remote.pub);pairHint.textContent='Connecting…'}else if(!role)pairHint.textContent='First paste an offer, then click Create answer.'}catch(e){pairHint.textContent='Could not apply signal: '+e.message}};$('#copySignal').onclick=()=>navigator.clipboard?.writeText(signalOut.value);
messageForm.onsubmit=async e=>{e.preventDefault();const v=messageInput.value.trim();if(!v||!sharedKey)return;send({t:'msg',v:await seal(v)});addMessage(v,true);messageInput.value=''};
chooseFiles.onclick=()=>fileInput.click();fileInput.onchange=()=>{const files=[...fileInput.files];fileInput.value='';files.forEach(sendFile);};
function transfer(name,size,dir){const el=document.createElement('div');el.className='transfer';el.innerHTML='<div class="transfer-top"><span class="transfer-name"></span><span class="transfer-status"></span></div><div class="bar"><i></i></div><div class="transfer-stats"><span class="transfer-speed"></span><span class="transfer-eta"></span></div><div class="transfer-peer"></div><div class="transfer-btns"><button class="cancel-btn text-button" hidden>Cancel</button><button class="retry-btn primary" hidden>Retry</button></div>';el.querySelector('.transfer-name').textContent=name+' · '+format(size);transfers.prepend(el);return el}function format(n){return n<1e9?(n/1e6).toFixed(1)+' MB':(n/1e9).toFixed(2)+' GB'}function formatSpeed(bps){if(bps<1e3)return(bps).toFixed(0)+' B/s';if(bps<1e6)return(bps/1e3).toFixed(1)+' KB/s';if(bps<1e9)return(bps/1e6).toFixed(1)+' MB/s';return(bps/1e9).toFixed(2)+' GB/s'}function formatEta(sec){if(!isFinite(sec)||sec<0)return'';sec=Math.round(sec);if(sec<60)return sec+'s';const m=Math.floor(sec/60),s=sec%60;if(m<60)return m+'m '+s+'s';const h=Math.floor(m/60);return h+'h '+(m%60)+'m'}function updateStats(el,done,total,startTime){const elapsed=(performance.now()-startTime)/1000;if(elapsed<0.5)return;const speed=done/elapsed;const remaining=(total-done)/speed;el.querySelector('.transfer-speed').textContent=formatSpeed(speed);el.querySelector('.transfer-eta').textContent=formatEta(remaining)}
// Resolvers for sender-side "peer accepted/rejected" signals, keyed by seq.
const acceptWait=new Map();
async function sendFile(file,retryId){if(file.size>MAX)return alert('This file is larger than 120 GB.');if(!fileBus())return alert('Connect first, then send a file.');const el=transfer(file.name,file.size,'out');const cancelBtn=el.querySelector('.cancel-btn'),retryBtn=el.querySelector('.retry-btn');cancelBtn.hidden=false;retryBtn.hidden=true;const seq=retryId||++fileSeq;const ctrl={abort:false};sendAbort.set(seq,ctrl);outTransfers.set(seq,el);const meta=await seal(JSON.stringify({name:file.name,size:file.size,type:file.type,seq}));sendQueue=sendQueue.then(async()=>{  const t0=performance.now();try{await safeSend(JSON.stringify({t:'start',v:meta}));
  // Wait for the friend to accept before streaming any bytes, so we don't push
  // a whole file into the relay before they've agreed to receive it. Time out
  // so we never hang if the peer never responds.
  await new Promise((resolve,reject)=>{const to=setTimeout(()=>{if(acceptWait.has(seq)){acceptWait.delete(seq);reject(new Error('No answer'))}},60000);acceptWait.set(seq,{resolve:()=>{clearTimeout(to);resolve()},reject:e=>{clearTimeout(to);reject(e)}});});
  if(ctrl.abort)throw new Error('Cancelled');
  // Pipeline: keep reading+encrypting ahead of what's actually on the wire so
  // crypto never gates the network. We wait only when the bus send buffer is
  // near SEND_WINDOW, and refill as soon as it drains. Over the relay socket
  // this saturates a LAN; over WebRTC it falls back to SCTP.
  let offset=0,inflight=0;const pending=[];let lastPeerSent=0,lastPctSent=-1;
  const pump=async()=>{while(offset<file.size&&!ctrl.abort){const bus=fileBus();if(!bus)throw new Error('disconnected');while(inflight>=SEND_WINDOW){await awaitBusDrain(bus);if(ctrl.abort)return}
    const start=offset,end=Math.min(offset+CHUNK,file.size);offset=end;
    const raw=await file.slice(start,end).arrayBuffer();
    const {iv,data}=await sealBytes(new Uint8Array(raw));
    const frame=packChunk(seq,start,new Uint8Array(iv),new Uint8Array(data),end>=file.size);
    inflight+=frame.byteLength;
    const p=busSafeSend(frame).then(()=>{inflight-=frame.byteLength});
    pending.push(p);
    const done=end;const pct=Math.round(done/file.size*100);el.querySelector('i').style.width=Math.min(100,done/file.size*100)+'%';el.querySelector('.transfer-status').textContent=pct+'%';updateStats(el,done,file.size,t0);
    // Mirror our progress to the peer (throttled to ~2/sec and on whole-% change).
    const now=Date.now();if((pct!==lastPctSent&&now-lastPeerSent>250)||now-lastPeerSent>500){lastPctSent=pct;lastPeerSent=now;try{safeSend(JSON.stringify({t:'progress',seq,p:pct}))}catch{}}
    // Light yield so the progress UI and other messages stay responsive.
    if(pending.length%16===0)await Promise.race(pending)}}
  await pump();
  await Promise.all(pending);
  if(!ctrl.abort){await safeSend(JSON.stringify({t:'end',seq}));el.querySelector('.transfer-status').textContent='Sent';el.querySelector('.transfer-speed').textContent='';el.querySelector('.transfer-eta').textContent='';setPeerPct(el,100);cancelBtn.hidden=true}  }catch(e){const aw=acceptWait.get(seq);if(aw){acceptWait.delete(seq);if(!ctrl.abort)aw.reject(e)}  if(ctrl.abort||(e&&e.message==='Cleared')||(e&&e.message==='disconnected')){el.querySelector('.transfer-status').textContent='Cancelled'}else if(e&&e.message==='rejected'){const s=el.querySelector('.transfer-status');s.textContent='Declined by friend';s.classList.add('declined')}else{const s=el.querySelector('.transfer-status');s.textContent='Failed: '+(e?.message||e);s.classList.add('failed')}el.querySelector('.transfer-speed').textContent='';el.querySelector('.transfer-eta').textContent='';cancelBtn.hidden=true;retryBtn.hidden=false;retryBtn.onclick=()=>{el.remove();sendFile(file,seq);};try{await busSafeSend(JSON.stringify({t:'end',seq,cancelled:true}))}catch{}}outTransfers.delete(seq);});cancelBtn.onclick=()=>{const aw=acceptWait.get(seq);if(aw){acceptWait.delete(seq);aw.reject(new Error('Cancelled'))}ctrl.abort=true;cancelBtn.hidden=true}}
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
function showAcceptCard(meta,seq){const card=document.createElement('div');card.className='transfer accept-card';card.innerHTML='<div class="accept-top"><strong class="accept-name"></strong><span class="accept-size"></span></div><p class="accept-hint">Your friend wants to send you a file.</p><div class="accept-btns"><button class="accept-yes primary">Accept</button><button class="accept-no">Decline</button></div>';card.querySelector('.accept-name').textContent=meta.name;card.querySelector('.accept-size').textContent=' · '+format(meta.size);const yes=card.querySelector('.accept-yes'),no=card.querySelector('.accept-no');const resolve=new Promise(r=>{const done=v=>{acceptCards.delete(seq);pendingFrames.delete(seq);card.remove();r(v)};acceptCards.set(seq,done);yes.onclick=()=>done(true);no.onclick=()=>done(false)});transfers.prepend(card);return resolve}
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
  if(o.t==='start'){const meta=JSON.parse(dec.decode(await open(o.v)));const seq=meta.seq||0;const accepted=await showAcceptCard(meta,seq);if(!accepted){await safeSend(JSON.stringify({t:'reject',seq}));return}const t={...meta,seq,received:0,wire:0,el:transfer(meta.name,meta.size,'in'),startTime:performance.now(),frames:[],parts:[],lastSeen:false,abort:false,done:Promise.resolve(),writeError:null,saveMode:'mem',writer:null,stuck:null};t.writeQueue=makeWriteQueue(t);activeTransfers.set(seq,t);if(window.pairSave){try{const r=await window.pairSave.start(meta.name);if(r&&r.ok){t.saveMode='pair'}}catch{t.saveMode='mem'}}else if(window.showSaveFilePicker){try{const handle=await showSaveFilePicker({suggestedName:meta.name});t.writer=await handle.createWritable();t.saveMode='fileAccess'}catch{t.saveMode='mem'}}if(t.saveMode==='mem'&&meta.size>4*1024*1024*1024)alert('No disk streaming available. This large file will be held in memory and may fail. Use the Pair app for large transfers.');
  // Tell the sender we accepted, so it begins streaming.
  await safeSend(JSON.stringify({t:'accept',seq}));
  // Drain any chunk frames that arrived on the relay before this 'start'.
  const held=pendingFrames.get(seq);if(held){for(const p of held){t.frames.push(p.frame);t.wire+=p.len;if(p.last)t.lastSeen=true}pendingFrames.delete(seq)}
  t.done=processIncoming(t);t.done.catch(()=>{});}else if(o.t==='progress'){const el=outTransfers.get(o.seq)||(activeTransfers.get(o.seq)&&activeTransfers.get(o.seq).el);if(el)setPeerPct(el,o.p|0);return}else if(o.t==='reject'){const t=activeTransfers.get(o.seq);const aw=acceptWait.get(o.seq);if(aw){acceptWait.delete(o.seq);aw.reject(new Error('rejected'))}if(t){t.abort=true;if(t.saveMode==='pair')try{await window.pairSave.cancel()}catch{}if(t.writer)try{await t.writer.abort()}catch{}const s=t.el.querySelector('.transfer-status');s.textContent='Declined';s.classList.add('declined');activeTransfers.delete(o.seq)}}else if(o.t==='accept'){const aw=acceptWait.get(o.seq);if(aw){acceptWait.delete(o.seq);aw.resolve()}}else if(o.t==='end'){const t=activeTransfers.get(o.seq);if(!t){const ac=acceptCards.get(o.seq);if(ac)try{ac(false)}catch{};return}acceptWait.delete(o.seq);if(o.cancelled||t.abort){const senderCancelled=!!o.cancelled&&!t.abort;t.abort=true;if(t.saveMode==='pair')try{await window.pairSave.cancel()}catch{}if(t.writer)try{await t.writer.abort()}catch{}if(senderCancelled){const s=t.el.querySelector('.transfer-status');s.textContent='Sender cancelled';s.classList.add('declined');activeTransfers.delete(o.seq)}return}try{await t.done;if(t.saveMode==='fileAccess')await t.writer.close();else if(t.saveMode==='pair')await window.pairSave.end();else{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(t.parts||[],{type:t.type}));a.download=t.name;a.click()}t.el.querySelector('.transfer-status').textContent='Received';t.el.querySelector('.transfer-speed').textContent='';t.el.querySelector('.transfer-eta').textContent='';setPeerPct(t.el,100)}catch(e){if(t.saveMode==='pair')try{await window.pairSave.cancel()}catch{}if(t.writer)try{await t.writer.abort()}catch{}const s=t.el.querySelector('.transfer-status');s.textContent='Save failed: '+(e?.message||e);s.classList.add('failed')}finally{activeTransfers.delete(o.seq)}}
  }catch{}}
// Decrypt + write one transfer's frames concurrently (bounded pool) but commit
// bytes to disk / memory in arrival order. Updates progress + ETA for EVERY
// save mode (disk streaming on Linux included). Disk writes are batched to cut
// per-chunk IPC overhead.
const WRITE_BATCH=8*1024*1024;
// If no progress happens for this long (ms) the transfer is considered stuck and
// we surface exactly which phase it was stuck on so the user isn't left guessing.
const STALL_TIMEOUT=15000;
async function processIncoming(t){const POOL=8;const queue=t.writeQueue;let active=0;const slot=()=>new Promise(r=>{if(active<POOL)r();else{const h=()=>{active--;if(active<POOL)r();else setTimeout(h,0)};pendingSlots.push(h)}});const pendingSlots=[];const release=()=>{const h=pendingSlots.shift();if(h)h()};
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
  const sendPeerProgress=pct=>{const now=Date.now();if((pct!==lastPctSent&&now-lastPeerSent>250)||now-lastPeerSent>500){lastPctSent=pct;lastPeerSent=now;try{safeSend(JSON.stringify({t:'progress',seq:t.seq,p:pct}))}catch{}}};
  try{
  while(!(t.lastSeen&&t.frames.length===0)){
    if(t.abort)return;
    phase=t.received>0?'waiting for the final chunk':'waiting for the first chunk';
    while(t.frames.length){
      if(t.stuck)throw t.stuck;
      if(t.abort)return;
      await slot();active++;touch();
      const idx=nextIdx++;const f=t.frames.shift();
      openBytes(f.iv,f.ct).then(bytes=>queue(async()=>{if(t.saveMode==='discard')return;buffer.set(idx,bytes);await drainBuffer()})).catch(e=>{t.writeError=e||new Error('decrypt failed');}).finally(release);
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

const savedServer=localStorage.getItem('pair.signalServer');const savedRoom=localStorage.getItem('pair.roomCode');if(savedServer)$('#signalServer').value=savedServer;if(savedRoom)$('#roomCode').value=savedRoom;['signalServer','roomCode'].forEach(id=>$('#'+id).addEventListener('input',()=>localStorage.setItem('pair.'+(id==='signalServer'?'signalServer':'roomCode'),$('#'+id).value.trim())));
// Point auto-update at the SAME host the user configured for signaling (the feed
// lives on that host's :8787). Convert ws:// -> http:// so the HTTP manifest
// fetch works. This makes remote updates work with zero extra setup.
if(window.pairEnv&&window.pairEnv.setFeed){try{let s=localStorage.getItem('pair.signalServer')||'';s=s.trim();if(s){s=s.replace(/^wss?:\/\//i,'http://');if(!/\/$/.test(s))s+='/';window.pairEnv.setFeed(s.replace(/\/$/,'')+'');}}catch{}}

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
  signaling.onmessage=async event=>{try{const message=JSON.parse(event.data);if(message.type==='full'){pairHint.textContent='That room already has two people.';return}if(message.type==='peer-ready'&&role==='host'){setupPeer();const kp=await keyPair();pc._kp=kp;setupChannels();await pc.setLocalDescription(await pc.createOffer());await waitIce();signaling.send(JSON.stringify({type:'signal',payload:{kind:'offer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}}));openStreamRelay(address,room);pairHint.textContent='Offer sent. Connecting…'}if(message.type==='signal'){const remote=message.payload;if(remote.kind==='offer'&&role==='join'){setupPeer();const kp=await keyPair();pc._kp=kp;await pc.setRemoteDescription({type:'offer',sdp:remote.sdp});await derive(kp,remote.pub);await pc.setLocalDescription(await pc.createAnswer());await waitIce();signaling.send(JSON.stringify({type:'signal',payload:{kind:'answer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}}));openStreamRelay(address,room);pairHint.textContent='Answer sent. Connecting…'}else if(remote.kind==='answer'&&role==='host'){await pc.setRemoteDescription({type:'answer',sdp:remote.sdp});await derive(pc._kp,remote.pub);openStreamRelay(address,room);pairHint.textContent='Secure connection established.'}}}catch(e){console.warn('signaling message error',e)}};
}
// Open the separate relay socket used to move file bytes. Same host + room as
// the signaling socket; the server relays binary frames to the other peer.
function openStreamRelay(address,room){streamServer=address;streamRoom=room;try{if(streamWs){try{streamWs.close()}catch{}}streamWs=new WebSocket(address);streamWs.onopen=()=>{try{streamWs.send(JSON.stringify({type:'join',room:room+':stream'}))}catch{};wire()};streamWs.onerror=()=>{};streamWs.onclose=()=>{};}catch{streamWs=null}}
$('#hostRoom').onclick=()=>automaticPair('host'); $('#joinRoom').onclick=()=>automaticPair('join');
function disconnectRoom(){if(chat)chat.onmessage=null,chat.close();if(files)files.onmessage=null,files.close();if(pc)pc.close();pc=chat=files=null;if(signaling){try{signaling.onmessage=null;signaling.close()}catch{}signaling=null}if(streamWs){try{streamWs.onmessage=null;streamWs.close()}catch{}streamWs=null}streamServer=streamRoom=null;sharedKey=null;
  // Release any pending backpressure waiters so in-flight sends don't hang
  // forever after the bus is closed. They'll re-check fileBus(), find it gone,
  // and the send loop will abort cleanly.
  if(drainWait){const r=drainWait;drainWait=null;try{r()}catch{}}
  busDrains.forEach(set=>set.forEach(h=>{try{h()}catch{}}));busDrains.clear();
  endCall(true);sendAbort.forEach(c=>c.abort=true);sendAbort.clear();acceptWait.forEach(w=>{try{w.reject(new Error('Disconnected'))}catch{}});acceptWait.clear();
  acceptCards.forEach(done=>{try{done(false)}catch{}});acceptCards.clear();activeTransfers.forEach(t=>t.abort=true);activeTransfers.clear();pendingFrames.clear();outTransfers.clear();sendQueue=Promise.resolve();receiveQueue=Promise.resolve();setStatus('Not connected');$('#leaveRoom').hidden=true;$('#hostRoom').hidden=false;$('#joinRoom').hidden=false;pairHint.textContent='Disconnected from room.'}
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
  // Only start once connected. Starting before the peer connection is stable
  // could addTrack/renegotiate and create a second audio m-line the app can't
  // handle.
  if(callActive||!pc||pc.connectionState!=='connected')return;
  try{
    callStatus.textContent='Requesting mic…';callStatus.className='call-status ringing';
    localStream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
    // The audio transceiver was already negotiated as sendrecv during connect.
    // Reuse its existing sender via replaceTrack so we DON'T add a second m-line
    // (which would require an unhandled renegotiation). If no sender exists yet,
    // attach the track normally.
    const track=localStream.getAudioTracks()[0];
    // The audio transceiver was negotiated as sendrecv during connect, so it
    // always has a sender. Reuse it via replaceTrack (even if its previous track
    // was stopped). Never addTrack — that would create a second m-line and an
    // unhandled renegotiation.
    const sender=pc.getSenders().find(s=>s.track&&s.track.kind==='audio');
    if(sender){try{sender.replaceTrack(track)}catch{}}else{const t=pc.addTransceiver('audio',{direction:'sendrecv'});try{t.sender.replaceTrack(track)}catch{}}
    callActive=true;callStart=Date.now();callBtn.textContent='⏹ Stop voice';callBtn.disabled=false;muteBtn.hidden=false;micMuted=false;muteBtn.textContent='🔇 Mute mic';
    callStatus.textContent='Voice live';callStatus.className='call-status live';
    callTimerId=setInterval(()=>{const s=Math.floor((Date.now()-callStart)/1000);const m=Math.floor(s/60),sec=s%60;callTimerEl.textContent=m+':'+String(sec).padStart(2,'0')},1000);
  }catch(e){endCall(true);callStatus.textContent='Mic denied — check permissions';callStatus.className='call-status';}
}
// Tear down the call and release the mic. `silent` skips UI churn when called
// from a disconnect.
function endCall(silent){
  if(callTimerId){clearInterval(callTimerId);callTimerId=null}
  callTimerEl.textContent='';
  // Stopping the local track silences our outgoing audio WITHOUT touching the
  // negotiated transceiver, so no renegotiation is triggered (the app doesn't
  // handle mid-call renegotiation). The peer's receiver just gets silence.
  if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}
  // Drop our sender's track so a stopped track doesn't linger on the transceiver
  // (which would otherwise keep matching in startCall and complicate reconnects).
  if(pc){try{pc.getSenders().forEach(s=>{if(s.track&&s.track.kind==='audio'){try{s.replaceTrack(null)}catch{}}})}catch{}}
  // Drop the remote audio element's source so a stale stream can't keep playing
  // after the call ends or the room is left.
  try{remoteAudio.srcObject=null}catch{}
  callActive=false;micMuted=false;
  callBtn.textContent='🎙 Start voice';muteBtn.hidden=true;callStatus.textContent='Voice off';callStatus.className='call-status';
  if(!silent){callBtn.disabled=!pc;}
}
function toggleMute(){
  if(!localStream)return;
  micMuted=!micMuted;
  localStream.getAudioTracks().forEach(t=>t.enabled=!micMuted);
  muteBtn.textContent=micMuted?'🎙 Unmute mic':'🔇 Mute mic';
}
callBtn.onclick=()=>{if(callActive)endCall(false);else startCall()};
muteBtn.onclick=toggleMute;

// Auto-update banner. Only wires up when running inside the Pair app
// (window.pairEnv is exposed by preload.js). Browsers ignore this block.
if(window.pairEnv&&window.pairEnv.onUpdate){const banner=$('#updateBanner'),title=$('#updateTitle'),notes=$('#updateNotes'),link=$('#updateLink'),restart=$('#updateRestart');$('#updateDismiss').onclick=()=>{banner.hidden=true};window.pairEnv.onUpdate(info=>{banner.hidden=false;title.textContent='Update available — version '+info.version;if(info.notes)notes.textContent=info.notes;else notes.textContent='';if(info.stage==='link'){link.hidden=false;link.href=info.url;link.target='_blank'}else link.hidden=true;if(info.stage==='ready'){restart.hidden=false;restart.onclick=()=>window.pairEnv.restartForUpdate()}else restart.hidden=true})}
