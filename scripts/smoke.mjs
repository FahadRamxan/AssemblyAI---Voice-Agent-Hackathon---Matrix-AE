/**
 * Live end-to-end smoke test.
 *
 * Drives the server exactly like the browser would: opens /ws, streams a raw
 * 16 kHz mono PCM16 clip in real-time 50 ms frames, and checks the full
 * pipeline round-trips — AssemblyAI final transcript -> LLM reply -> TTS audio.
 *
 *   node scripts/smoke.mjs [path-to-16k-mono.raw]
 *   SMOKE_PCM=/path/to/clip.raw node scripts/smoke.mjs
 *
 * Needs a running server (`npm start`) with real keys in .env.
 */
import WebSocket from "ws";
import { readFileSync } from "node:fs";

const WS_URL = process.env.SMOKE_WS ?? "ws://localhost:8790/ws";
const PCM_PATH = process.argv[2] ?? process.env.SMOKE_PCM;
const FRAME_BYTES = 1600; // 50 ms @ 16 kHz mono s16le
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!PCM_PATH) {
  console.error("usage: node scripts/smoke.mjs <clip-16k-mono.raw>  (or set SMOKE_PCM)");
  process.exit(2);
}

const pcm = readFileSync(PCM_PATH);
console.log(`clip: ${PCM_PATH} (${(pcm.length / 32000).toFixed(1)}s @16k)`);

const state = { ready: false, finals: [], agentAfterFinal: [], ttsBytes: 0, greetingBytes: 0 };
let sawFinal = false;

const ws = new WebSocket(WS_URL);
ws.binaryType = "nodebuffer";

ws.on("open", () => ws.send(JSON.stringify({ type: "start" })));

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    if (sawFinal) state.ttsBytes += data.length;
    else state.greetingBytes += data.length;
    return;
  }
  const m = JSON.parse(data.toString());
  if (m.type === "ready") {
    state.ready = true;
    console.log(`ready (sttLive=${m.sttLive}, ttsRate=${m.ttsSampleRate})`);
    void streamClip();
  } else if (m.type === "partial") {
    process.stdout.write(`\r  partial: ${m.text.slice(0, 70)}`.padEnd(84));
  } else if (m.type === "final") {
    sawFinal = true;
    state.finals.push(m.text);
    console.log(`\n  FINAL: ${m.text}`);
  } else if (m.type === "agent") {
    if (sawFinal) state.agentAfterFinal.push(m.text);
    console.log(`  agent: ${m.text}`);
  } else if (m.type === "error") {
    console.log(`  error: ${m.message}`);
  }
});

ws.on("close", () => finish());
ws.on("error", (err) => {
  console.error("ws error:", err.message);
  process.exit(1);
});

async function streamClip() {
  for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
    ws.send(pcm.subarray(off, off + FRAME_BYTES));
    await sleep(50); // pace ~real-time so end-of-turn detection works
  }
  // A real mic keeps streaming after you stop talking. The endpoint detector
  // measures silence on the AUDIO timeline, so we must keep sending silent
  // frames (not go dead-quiet) for it to fire end_of_turn.
  const silence = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < 100 && !sawFinal; i++) {
    ws.send(silence);
    await sleep(50);
  }
  // final arrived — keep a little silence flowing while the reply comes back
  for (let i = 0; i < 60; i++) {
    ws.send(silence);
    await sleep(50);
  }
  ws.send(JSON.stringify({ type: "stop" }));
  await sleep(300);
  ws.close();
}

function finish() {
  const reply = state.agentAfterFinal.join(" ").trim();
  console.log("\n=== result ===");
  console.log("STT finals   :", state.finals.length ? `"${state.finals.join(" ")}"` : "(none)");
  console.log("agent reply  :", reply ? `"${reply}"` : "(none)");
  console.log("greeting TTS :", state.greetingBytes, "bytes");
  console.log("reply TTS    :", state.ttsBytes, "bytes");
  const ok = state.finals.length > 0 && reply.length > 0 && state.ttsBytes > 0;
  console.log(ok ? "\nPASS — STT -> LLM -> TTS round-trip works." : "\nFAIL — pipeline incomplete.");
  process.exit(ok ? 0 : 1);
}
