# Architecture

Raabta Live is a thin, honest voice-agent stack: a browser SPA, a Node orchestrator that holds every
secret, and three external services (STT / LLM / TTS). This doc explains how the pieces fit and the
non-obvious decisions behind them.

## The pipeline

```
mic → AudioWorklet (16 kHz PCM16) → WS(binary) → VoiceSession
        → AssemblyAI Universal-Streaming (partial/final + end-of-turn)
        → final → LLM (streamed) → SentenceAssembler
        → per sentence → TTS (streamed PCM) → WS(binary) → gapless playback
```

Everything is per-session: one browser WebSocket = one `VoiceSession` (`src/session.ts`) = one AssemblyAI
socket. The browser never talks to AssemblyAI/LLM/TTS directly, so API keys stay server-side.

## The WebSocket contract (`src/protocol.ts`)

One socket, two planes:

- **Binary frames = audio.** Client→server: mic PCM16 @ 16 kHz. Server→client: TTS PCM16 @ 24 kHz.
  Direction disambiguates them, so no per-frame tagging is needed.
- **Text frames = JSON control/transcript:** `ready`, `partial`, `final`, `agent`, `tts_start`,
  `tts_stop{reason}`, `status`, `error` (server→client); `start`, `stop`, `text` (client→server).

## AssemblyAI Universal-Streaming (`src/stt/assemblyai.ts`)

- **Connect:** `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le&format_turns=true`,
  API key in the `Authorization` header (**no `Bearer` prefix**). Server-side only — the browser never
  sees the key. (For a browser-direct client you’d mint a temp token at `/v3/token`; we don’t need to.)
- **Send:** raw PCM16 as **binary** frames, ~50 ms each (1600 bytes @ 16 kHz). Control messages
  (`Terminate`, `ForceEndpoint`) are the only things sent as **text**. Mixing these up is the #1
  integration bug.
- **Receive:** JSON `Turn` messages. `end_of_turn:false` = partial (live caption); `end_of_turn:true` =
  the caller finished.
- **The double-final gotcha:** with `format_turns=true`, AssemblyAI emits the final **twice** — first
  unformatted, then punctuated/cased. If you act on both you get double transcripts and double LLM calls.
  `interpretSttMessage()` gates the final on `turn_is_formatted` (and falls back to the plain
  `end_of_turn` when formatting is off). This is pure and unit-tested.
- **End-of-turn detection is on the audio timeline.** The detector measures silence from the frames you
  send — if you stop sending audio, the timer stalls. A real mic streams continuously; the smoke test
  therefore streams trailing *silence* frames so `end_of_turn` fires (rather than going dead-quiet).
- **Billing is by session wall-clock**, so we `Terminate` and close promptly when a call ends.

## Barge-in (`src/session.ts`)

The make-or-break feature. The session tracks `ttsActive`. While the agent is speaking, a fresh caller
**partial** (real words) triggers `bargeIn()`:

1. Abort the in-flight LLM stream (`AbortController`).
2. Abort the in-flight TTS stream (`AbortController`).
3. Send `tts_stop{reason:"barge_in"}` → the browser flushes all scheduled audio sources and resets its
   play clock, so sound stops immediately.

A per-turn **sequence number** (`turnSeq`) guards correctness: every turn captures its `seq`, and both the
LLM loop and the TTS loop bail the instant `seq !== turnSeq`. So an interrupted turn can never “resume”
over the new one — no overlapping voices, no stale audio.

`echoCancellation:true` on the mic keeps the agent’s own voice out of the caller audio, so playback
doesn’t self-trigger a barge-in.

## Browser audio (`public/`)

- **Capture** (`capture-processor.js`): an `AudioWorklet` (audio-render thread, no main-thread jank).
  The browser’s native rate (44.1/48 kHz) is downsampled to 16 kHz with a fractional read position
  carried across 128-sample blocks (no boundary clicks), converted Float32→Int16 LE, and posted as
  ~50 ms frames. We don’t trust `AudioContext({sampleRate:16000})` — Safari/Firefox ignore it.
- **Pre-roll:** frames captured before the session is `ready` are buffered and flushed, so the first
  word isn’t clipped.
- **Playback:** streamed 24 kHz PCM chunks become Float32 `AudioBuffer`s scheduled back-to-back on a
  running `playHead` (gapless). Odd trailing bytes are carried between chunks to keep Int16 aligned.
  The buffer is built at the **TTS’s** rate (24 kHz) — mismatching it makes the voice deep/slow, a
  classic easy-to-miss bug.

## Latency

- AssemblyAI partials: **sub-second**, visible as you speak.
- Sentence-streamed replies: the first sentence is synthesized while the LLM writes the rest, so
  time-to-first-audio is one-sentence, not one-whole-reply.
- Measured end-to-end (caller stops → first agent audio): ~2 s with gpt-4o + ElevenLabs; swapping in
  Cartesia (~260 ms first audio) and a faster model tightens it further.

## Provider abstraction (`src/config.ts`)

`loadConfig()` resolves each layer from whichever key is present (OpenAI→Gemini for LLM;
ElevenLabs→Cartesia for TTS) behind small typed configs. Adding a provider is a new branch in `llm.ts`
or `tts.ts` — the session and protocol don’t change.

## File map

| File | Responsibility |
|------|----------------|
| `src/config.ts` | env → typed provider configs; key-free startup banner |
| `src/stt/assemblyai.ts` | AssemblyAI v3 WS client + pure `interpretSttMessage` |
| `src/llm.ts` | streaming OpenAI-compatible Chat Completions |
| `src/tts.ts` | streaming ElevenLabs / Cartesia → 24 kHz PCM |
| `src/agent.ts` | persona, conversation memory, sentence assembler, `detectLang` |
| `src/session.ts` | the turn loop + barge-in |
| `src/server.ts` | http (static + /health + /api/config) + `/ws` upgrade |
| `public/capture-processor.js` | mic → 16 kHz PCM worklet |
| `public/app.js` | WS client, transcript UI, gapless playback, barge-in flush |
| `scripts/smoke.mjs` | live end-to-end verification |
