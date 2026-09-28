/**
 * Raabta Live — browser client.
 *
 * Captures the mic via an AudioWorklet (16 kHz PCM16), streams it to the
 * backend over one WebSocket (binary = audio, text = JSON), and renders the
 * live read-along transcript (partials + finals + the agent's replies).
 *
 * TTS playback + barge-in flush are layered on in app-playback code.
 */
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

const els = {
  transcript: document.getElementById("transcript"),
  interim: document.getElementById("interim"),
  hint: document.getElementById("hint"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  meterFill: document.getElementById("meterFill"),
  textForm: document.getElementById("textForm"),
  textInput: document.getElementById("textInput"),
};

let ws = null;
let audioCtx = null;
let workletNode = null;
let micStream = null;
let micLive = false; // gate frames until the server says "ready"
let preroll = []; // frames captured before ready — flushed so the first word isn't lost
let currentAgentBubble = null;

const isArabic = (t) => (t.match(/[؀-ۿ]/g) || []).length > (t.match(/[A-Za-z]/g) || []).length;

// --------------------------------------------------------------------------
// transcript rendering
// --------------------------------------------------------------------------
function addBubble(role, text) {
  const el = document.createElement("div");
  el.className = `bubble ${role}${isArabic(text) ? " rtl" : ""}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "caller" ? "You" : "Raabta";
  const body = document.createElement("span");
  body.textContent = text;
  el.append(who, body);
  els.transcript.appendChild(el);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return body;
}

function appendAgent(text) {
  if (!currentAgentBubble) currentAgentBubble = addBubble("agent", text);
  else {
    currentAgentBubble.textContent += " " + text;
    const bubble = currentAgentBubble.parentElement;
    if (bubble) bubble.classList.toggle("rtl", isArabic(currentAgentBubble.textContent));
  }
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function setInterim(text) {
  if (!text) {
    els.interim.hidden = true;
    return;
  }
  els.interim.hidden = false;
  els.interim.textContent = text;
  els.interim.classList.toggle("rtl", isArabic(text));
}

function setStatus(state, text) {
  els.statusDot.className = `dot ${state}`;
  els.statusText.textContent = text ?? state;
}

// --------------------------------------------------------------------------
// server messages
// --------------------------------------------------------------------------
function handleServerMessage(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  switch (m.type) {
    case "ready":
      micLive = true;
      for (const f of preroll) ws?.send(f);
      preroll = [];
      setStatus("listening", m.sttLive ? "listening" : "type to chat");
      els.hint.hidden = true;
      break;
    case "partial":
      setStatus("listening", "listening");
      setInterim(m.text);
      break;
    case "final":
      setInterim("");
      addBubble("caller", m.text);
      currentAgentBubble = null; // next agent text starts a fresh bubble
      break;
    case "agent":
      appendAgent(m.text);
      break;
    case "tts_start":
      setStatus("speaking", "speaking");
      break;
    case "tts_stop":
      if (m.reason === "barge_in") flushPlayback(); // caller cut in — drop queued audio now
      setStatus("listening", "listening");
      break;
    case "status":
      if (m.text === "thinking") setStatus("thinking", "thinking");
      break;
    case "error":
      addBubble("agent", `⚠ ${m.message}`);
      setStatus("error", "error");
      break;
  }
}

// --------------------------------------------------------------------------
// TTS playback — gapless scheduling of streamed 24 kHz PCM, with barge-in flush
// --------------------------------------------------------------------------
const TTS_RATE = 24000;
let playCtx = null;
let playHead = 0; // next scheduled start time on the playback clock
let sources = new Set(); // live buffer sources, so barge-in can stop them
let leftoverByte = null; // odd trailing byte carried between chunks

function playbackCtx() {
  // Reuse the mic context if we have one; otherwise make a dedicated one.
  if (audioCtx) return audioCtx;
  if (!playCtx) playCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (playCtx.state === "suspended") void playCtx.resume();
  return playCtx;
}

function onTtsAudio(arrayBuffer) {
  const incoming = new Uint8Array(arrayBuffer);
  // Stitch any odd byte carried from the previous chunk so Int16 stays aligned.
  let bytes = incoming;
  if (leftoverByte) {
    bytes = new Uint8Array(leftoverByte.length + incoming.length);
    bytes.set(leftoverByte, 0);
    bytes.set(incoming, leftoverByte.length);
    leftoverByte = null;
  }
  const usable = bytes.length - (bytes.length % 2);
  if (usable < bytes.length) leftoverByte = bytes.slice(usable);
  if (usable === 0) return;

  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2);
  const ctx = playbackCtx();
  const buf = ctx.createBuffer(1, pcm.length, TTS_RATE);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const startAt = Math.max(ctx.currentTime, playHead);
  src.start(startAt);
  playHead = startAt + buf.duration;
  sources.add(src);
  src.onended = () => sources.delete(src);
}

/** Stop everything currently scheduled — used on barge-in and on hang-up. */
function flushPlayback() {
  for (const src of sources) {
    try {
      src.onended = null;
      src.stop();
      src.disconnect();
    } catch {
      /* already stopped */
    }
  }
  sources.clear();
  leftoverByte = null;
  playHead = 0;
}

// --------------------------------------------------------------------------
// microphone
// --------------------------------------------------------------------------
async function startCall() {
  els.startBtn.disabled = true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true, // don't let the mic hear the agent (prevents false barge-ins + feedback)
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume(); // must happen inside the click gesture
    await audioCtx.audioWorklet.addModule("/capture-processor.js");
    const source = audioCtx.createMediaStreamSource(micStream);
    workletNode = new AudioWorkletNode(audioCtx, "capture-processor");
    workletNode.port.onmessage = (ev) => onMicFrame(ev.data);
    source.connect(workletNode);
    // no need to connect to destination — we don't want to hear ourselves
    openSocket();
    els.stopBtn.disabled = false;
    setStatus("thinking", "connecting…");
  } catch (err) {
    setStatus("error", "mic blocked");
    addBubble("agent", `⚠ Microphone unavailable: ${err instanceof Error ? err.message : err}. You can still type below.`);
    els.startBtn.disabled = false;
    openSocket(); // still allow typed testing
    els.stopBtn.disabled = false;
  }
}

function onMicFrame(buf) {
  // meter (rough RMS of the Int16 frame)
  const pcm = new Int16Array(buf);
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  const rms = Math.sqrt(sum / pcm.length) / 32768;
  els.meterFill.style.width = Math.min(100, rms * 320) + "%";
  // uplink (buffer until the session is ready)
  if (micLive && ws && ws.readyState === WebSocket.OPEN) ws.send(buf);
  else if (!micLive) preroll.push(buf);
}

// --------------------------------------------------------------------------
// socket lifecycle
// --------------------------------------------------------------------------
function openSocket() {
  ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => ws.send(JSON.stringify({ type: "start" }));
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") handleServerMessage(ev.data);
    else onTtsAudio(ev.data);
  };
  ws.onclose = () => {
    setStatus("idle", "idle");
    micLive = false;
  };
  ws.onerror = () => setStatus("error", "connection error");
}

function endCall() {
  try {
    ws?.send(JSON.stringify({ type: "stop" }));
  } catch {
    /* ignore */
  }
  micLive = false;
  flushPlayback();
  workletNode?.disconnect();
  micStream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  ws?.close();
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.meterFill.style.width = "0%";
  setStatus("idle", "idle");
}

// --------------------------------------------------------------------------
// wire up
// --------------------------------------------------------------------------
els.startBtn.addEventListener("click", startCall);
els.stopBtn.addEventListener("click", endCall);
els.textForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.textInput.value.trim();
  if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) openSocket();
  const send = () => ws.send(JSON.stringify({ type: "text", text }));
  if (ws.readyState === WebSocket.OPEN) send();
  else ws.addEventListener("open", send, { once: true });
  addBubble("caller", text);
  currentAgentBubble = null;
  els.textInput.value = "";
});
