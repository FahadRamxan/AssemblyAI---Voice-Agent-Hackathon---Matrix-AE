/**
 * Raabta Live — browser client.
 *
 * Captures the mic via an AudioWorklet (16 kHz PCM16), streams it to the
 * backend over one WebSocket (binary = audio, text = JSON), and renders the
 * live read-along transcript (partials + finals + the agent's replies).
 *
 * TTS playback + barge-in flush are layered on in app-playback code.
 */
// The widget authenticates with a publishable embed key. The built-in demo page
// fetches the demo agent's key from /api/config; a real embed passes its own via
// ?key= or a data-attribute. No key -> the server refuses the /ws upgrade.
const WS_BASE = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
let embedKey =
  new URLSearchParams(location.search).get("key") ||
  document.currentScript?.dataset.agentKey ||
  "";

async function ensureConfig() {
  if (embedKey) return;
  try {
    const cfg = await (await fetch("/api/config")).json();
    embedKey = cfg.embedKey || "";
  } catch {
    /* server will refuse the upgrade if the key is missing */
  }
}

function wsUrl() {
  return embedKey ? `${WS_BASE}?key=${encodeURIComponent(embedKey)}` : WS_BASE;
}

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
  orb: document.getElementById("orb"),
  hud: document.getElementById("latencyHud"),
  ttfwVal: document.getElementById("ttfwVal"),
  ttfwBest: document.getElementById("ttfwBest"),
};

let ws = null;
let audioCtx = null;
let workletNode = null;
let micStream = null;
let micLive = false; // gate frames until the server says "ready"
let preroll = []; // frames captured before ready — flushed so the first word isn't lost
let currentAgentBubble = null;

// --- latency HUD: AssemblyAI time-to-first-word (mic speech-start -> first partial) ---
const SPEECH_RMS = 0.02; // mic level that counts as "the caller started speaking"
let speechStartAt = 0; // performance.now() when the current turn's speech began (0 = not yet)
let ttfwMeasured = false; // one measurement per turn
let bestTtfw = Infinity;

function showTtfw(ms) {
  if (!els.hud || !els.ttfwVal) return;
  els.hud.hidden = false;
  els.ttfwVal.textContent = String(ms);
  if (ms < bestTtfw) {
    bestTtfw = ms;
    if (els.ttfwBest) els.ttfwBest.textContent = `best ${ms}`;
  }
  els.hud.classList.remove("pop");
  void els.hud.offsetWidth; // restart the pop animation
  els.hud.classList.add("pop");
}

function resetTurnLatency() {
  speechStartAt = 0;
  ttfwMeasured = false;
}

const isArabic = (t) => (t.match(/[؀-ۿ]/g) || []).length > (t.match(/[A-Za-z]/g) || []).length;
const LOWCONF = 0.55; // words below this are shaded (mirrors the server's confidence threshold)

// AssemblyAI multilingual streaming detects one of these per finalized turn.
const LANG_LABELS = { en: "EN", es: "ES", fr: "FR", de: "DE", it: "IT", pt: "PT" };
const langLabel = (code) => LANG_LABELS[code] || (code ? code.toUpperCase().slice(0, 2) : "");

// Render text as confidence-shaded word spans (from AssemblyAI's word-level confidence).
function fillWords(el, text, words) {
  el.textContent = "";
  if (words && words.length) {
    for (const w of words) {
      const s = document.createElement("span");
      s.textContent = w.text + " ";
      if (w.confidence < LOWCONF) s.className = "lowconf";
      s.title = `${Math.round(w.confidence * 100)}% confident`;
      el.appendChild(s);
    }
  } else {
    el.textContent = text;
  }
}

// --------------------------------------------------------------------------
// transcript rendering
// --------------------------------------------------------------------------
function addBubble(role, text, words, confidence, language) {
  const el = document.createElement("div");
  el.className = `bubble ${role}${isArabic(text) ? " rtl" : ""}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "caller" ? "You" : "Raabta";
  // Detected-language tag (caller turns only) — from AssemblyAI multilingual streaming.
  if (role === "caller" && language) {
    const l = document.createElement("span");
    l.className = "lang";
    l.textContent = langLabel(language);
    l.title = `AssemblyAI detected ${langLabel(language)}`;
    who.appendChild(l);
  }
  // Per-turn confidence badge (caller turns only) — from AssemblyAI.
  if (role === "caller" && typeof confidence === "number") {
    const c = document.createElement("span");
    c.className = "conf" + (confidence < LOWCONF ? " low" : "");
    c.textContent = `${Math.round(confidence * 100)}%`;
    who.appendChild(c);
  }
  const body = document.createElement("span");
  fillWords(body, text, role === "caller" ? words : null); // shade caller words by confidence
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

function setInterim(text, words) {
  if (!text) {
    els.interim.hidden = true;
    return;
  }
  els.interim.hidden = false;
  fillWords(els.interim, text, words); // live confidence shading as you speak
  els.interim.classList.toggle("rtl", isArabic(text));
}

function setStatus(state, text) {
  els.statusDot.className = `dot ${state}`;
  els.statusText.textContent = text ?? state;
  document.body.dataset.state = state; // drives the orb visualizer (see styles.css)
  if (state !== "listening") document.documentElement.style.setProperty("--level", "0");
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
      resetTurnLatency();
      setStatus("listening", m.sttLive ? "listening" : "type to chat");
      els.hint.hidden = true;
      break;
    case "partial":
      setStatus("listening", "listening");
      // First transcribed word of this turn -> AssemblyAI time-to-first-word.
      if (speechStartAt && !ttfwMeasured) {
        ttfwMeasured = true;
        showTtfw(Math.round(performance.now() - speechStartAt));
      }
      setInterim(m.text, m.words);
      break;
    case "final":
      setInterim("");
      addBubble("caller", m.text, m.words, m.confidence, m.language);
      currentAgentBubble = null; // next agent text starts a fresh bubble
      resetTurnLatency(); // next utterance measures a fresh time-to-first-word
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
    case "ended":
      addBubble(
        "agent",
        m.reason === "idle"
          ? "📞 Call ended — no activity for a while."
          : m.reason === "timeout"
            ? "📞 Call ended — reached the time limit."
            : "📞 Call ended.",
      );
      endCall(); // tear down mic/playback/UI (idempotent — the server already closed the socket)
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
  await ensureConfig(); // resolve the embed key before opening the socket
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
  document.documentElement.style.setProperty("--level", Math.min(0.5, rms * 3).toFixed(3)); // orb reacts to voice
  // Mark when the caller starts talking — the clock for AssemblyAI's time-to-first-word.
  if (micLive && rms > SPEECH_RMS && speechStartAt === 0) speechStartAt = performance.now();
  // uplink (buffer until the session is ready)
  if (micLive && ws && ws.readyState === WebSocket.OPEN) ws.send(buf);
  else if (!micLive) preroll.push(buf);
}

// --------------------------------------------------------------------------
// socket lifecycle
// --------------------------------------------------------------------------
function openSocket() {
  ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";
  ws.onopen = () => ws.send(JSON.stringify({ type: "start" }));
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") handleServerMessage(ev.data);
    else onTtsAudio(ev.data);
  };
  ws.onclose = () => {
    micLive = false;
    endCall(); // abnormal close (server hang-up, refused upgrade, network drop) -> tear down the mic
  };
  ws.onerror = () => setStatus("error", "connection error");
}

// Idempotent: reachable from the Hang-up click, the server "ended" message, AND ws.onclose,
// so it must survive being called more than once for a single shutdown (it nulls the resources
// it tears down, so a second call is a no-op).
function endCall() {
  micLive = false;
  resetTurnLatency();
  flushPlayback();
  try {
    ws?.send(JSON.stringify({ type: "stop" }));
  } catch {
    /* socket already closing/closed */
  }
  try {
    workletNode?.disconnect();
  } catch {
    /* already disconnected */
  }
  workletNode = null;
  try {
    micStream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* already stopped */
  }
  micStream = null;
  if (audioCtx) {
    const ctx = audioCtx;
    audioCtx = null;
    ctx.close().catch(() => {}); // rejects if already closed — ignore (a 2nd endCall must not throw)
  }
  try {
    ws?.close();
  } catch {
    /* already closed */
  }
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
els.orb?.addEventListener("click", () => {
  if (!micLive && !els.startBtn.disabled) startCall(); // tap the orb to start
});
els.textForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.textInput.value.trim();
  if (!text) return;
  await ensureConfig();
  if (!ws || ws.readyState !== WebSocket.OPEN) openSocket();
  const send = () => ws.send(JSON.stringify({ type: "text", text }));
  if (ws.readyState === WebSocket.OPEN) send();
  else ws.addEventListener("open", send, { once: true });
  // No optimistic echo — the server replies with a `final` for typed input too,
  // so the caller bubble renders from that (one source of truth, same as the mic path).
  els.textInput.value = "";
});
