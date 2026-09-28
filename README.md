<div align="center">

# ◉ Raabta Live

### A real-time voice agent you can talk over — built on AssemblyAI Universal-Streaming

**Talk to it. Interrupt it. Read along.** Browser mic → AssemblyAI realtime STT → LLM → streaming TTS,
with true barge-in and a live read-along transcript.

`AssemblyAI Universal-Streaming` · `TypeScript` · `Node.js` · `Web Audio API` · `WebSocket`

_Submission for the lablab.ai × AssemblyAI “Build voice AI agents on AssemblyAI” hackathon — by **Matrix AE**._

</div>

---

## What it is

Raabta Live is a browser voice agent. You click **Start call**, speak naturally, and the agent answers
out loud — and crucially, **you can talk over it to cut it off**, just like a real phone call. The whole
conversation streams onto the screen as it happens (interim words in grey, finalized turns as bubbles),
so anyone watching can *see* the speech recognition working in real time.

It’s built on **[AssemblyAI Universal-Streaming](https://www.assemblyai.com/docs/speech-to-text/universal-streaming)**
(the Path-2 challenge track): caller audio is streamed to AssemblyAI over a WebSocket and comes back as
partial-then-final transcripts, with AssemblyAI’s semantic **end-of-turn detection** deciding the moment
the caller has finished speaking. That signal is what makes the turn-taking feel human.

## Why it’s different

- **Barge-in that actually works.** The moment you start speaking over the agent, the in-flight LLM and
  TTS are aborted and the browser flushes queued audio — the agent goes quiet instantly. This is the
  single hardest thing to get right in a voice agent, and it’s the headline here.
- **Read-along transcript.** Partials stream in as you talk; finals commit as bubbles; the agent’s reply
  streams in sentence-by-sentence. The UI makes the realtime STT legible — no faked demo.
- **Sentence-streamed replies → low latency.** The LLM reply is cut into sentences and sent to TTS the
  moment each one completes, so you hear the first sentence while the model is still writing the rest.
- **Bilingual brain & voice (Arabic ⇄ English).** The agent mirrors the caller’s language and speaks
  natural Gulf Arabic or English; the transcript flips to RTL for Arabic. (See the honest note below on
  where Arabic lives in the pipeline today.)
- **Provider-agnostic.** OpenAI **or** Gemini for the brain; ElevenLabs **or** Cartesia for the voice —
  chosen automatically from whichever key is present.

## Verified working (live)

The full pipeline is proven end-to-end against the real APIs by [`scripts/smoke.mjs`](scripts/smoke.mjs),
which streams a real 16 kHz clip through the server exactly like the browser does:

```
FINAL: Can you book me a flight from New York to Boston?
agent: I am sorry, but I cannot book flights.
agent: I can help you schedule an appointment or take a message for a callback.
reply TTS: 103249 bytes
PASS — STT -> LLM -> TTS round-trip works.
```

AssemblyAI partials appear **as you speak** (~sub-second), and a spoken reply comes back in ~2 seconds.

## Architecture

```
 Browser (public/)                         Node backend (src/)                 External APIs
 ┌───────────────────┐   one WebSocket    ┌────────────────────┐
 │ mic → AudioWorklet │ ── binary PCM16 ─▶ │  VoiceSession      │ ── PCM ─▶ ◎ AssemblyAI Universal-Streaming
 │  (16 kHz downsamp) │                    │   ├ STT bridge     │ ◀ Turn ── (partial / final + end-of-turn)
 │                    │ ◀── JSON  ──────── │   ├ LLM (stream)   │ ──────▶  ◎ OpenAI / Gemini
 │ read-along UI      │   partial/final/   │   └ TTS (stream)   │ ──────▶  ◎ ElevenLabs / Cartesia
 │ gapless playback   │ ◀── binary PCM ─── │  barge-in control  │
 └───────────────────┘   agent audio      └────────────────────┘
```

One socket carries two planes: **binary frames = audio**, **text frames = JSON** (`ready`, `partial`,
`final`, `agent`, `tts_start`, `tts_stop`, `error`). Direction disambiguates the audio. Full detail in
[`docs/architecture.md`](docs/architecture.md).

## Quickstart

```bash
git clone https://github.com/FahadRamxan/AssemblyAI---Voice-Agent-Hackathon---Matrix-AE.git
cd AssemblyAI---Voice-Agent-Hackathon---Matrix-AE
npm install
cp .env.example .env      # then add your keys (see below)
npm start                 # -> http://localhost:8790
```

Open **http://localhost:8790**, click **Start call**, allow the mic, and talk. No mic? Type in the box to
test the brain + voice.

**Keys** (in `.env`): `ASSEMBLYAI_API_KEY` (required for live STT), one LLM key
(`OPENAI_API_KEY` or `GEMINI_API_KEY`), and one TTS key (`ELEVENLABS_API_KEY` or `CARTESIA_API_KEY`).
The server boots without keys and tells you exactly what’s wired — but you need all three for the full
voice loop.

## Testing

```bash
npm run typecheck   # strict TS, clean
npm test            # 10 hermetic unit tests (no keys/network)
node scripts/smoke.mjs path/to/clip-16k-mono.raw   # live end-to-end (server running + keys set)
```

The unit tests cover the tricky bits in isolation — the STT message interpreter (partial vs final, and
the **double-final dedupe** when `format_turns` is on), the sentence assembler (English + Arabic
sentence enders), language detection, and conversation memory.

## An honest note on Arabic

AssemblyAI’s **streaming** model is English-first (its multilingual streaming model adds Spanish, French,
German, Italian, Portuguese). So the **live speech-to-text** here is English. The **agent’s brain and
voice are fully bilingual** — ask it to reply in Arabic and you get natural Gulf Arabic (the LLM + TTS
handle it, and the transcript renders RTL). Arabic *speech-to-text* is available today via AssemblyAI’s
batch API, and our broader **RaabtaAI** platform benchmarks Arabic STT across engines. We’d rather ship
the true capability than fake a live Arabic demo.

## Tech stack

TypeScript · Node.js (`ws`, zero other runtime deps) · Web Audio API (AudioWorklet) · WebSocket ·
AssemblyAI Universal-Streaming (STT) · OpenAI / Gemini (LLM) · ElevenLabs / Cartesia (TTS).

## Team & disclosure

Built by **Matrix AE**, the team behind **RaabtaAI** — a production bilingual voice-agent platform for
the MENA market. RaabtaAI is a pre-existing product; **this repository is an original, self-contained
build created for this hackathon** to showcase AssemblyAI Universal-Streaming as the realtime STT
foundation. MIT licensed.

## License

[MIT](LICENSE) © 2026 Matrix AE
