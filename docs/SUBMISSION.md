# lablab.ai submission — Raabta Live

Copy-paste-ready content for the submission form, plus the deliverables checklist.

## Submission Title (5–50 chars)

Raabta Live: voice agents on AssemblyAI

## Short Description (50–255 chars)

A multi-tenant SaaS for real-time voice agents on AssemblyAI. Build an agent, embed it on any site in one
line, and watch live calls + analytics. True barge-in, live multilingual transcription (6 languages,
detected per turn), and confidence-aware confirmations — talk over it like a real phone call.

## Long Description (100+ words)

Most "voice bots" are a single demo on one page, and they feel robotic because you can't interrupt them.
Raabta Live is the whole product around a real-time voice agent, built on AssemblyAI Universal-Streaming.

It's a multi-tenant SaaS. Sign up and you instantly get a workspace with your own agent and a publishable
embed key. Customise the agent's persona, greeting, voice, keyterms and language in a dashboard, then drop
it on any website with one line of HTML — a floating "Talk" button appears and your visitors have a
real-time voice conversation. Every call is recorded as a speaker-attributed transcript with live
analytics: calls, average duration, turns, reply latency, language split, and — uniquely — a barge-in rate.

Under the hood, the browser streams 16 kHz audio over a WebSocket to a Node backend that bridges to
AssemblyAI's v3 realtime socket. Its semantic end-of-turn detection decides when the caller has finished;
the final transcript streams to an LLM, and each finished sentence goes to text-to-speech, so the first
words come back in about a second. When you start talking over the agent, the in-flight LLM and TTS abort
instantly and the browser flushes queued audio — true barge-in, the hardest part of a voice agent to get right.

It goes beyond the transcript text in two ways that use AssemblyAI's signal, not just its words. First,
**per-word confidence**: uncertain words are shaded live and, when an important value (a number, a name)
comes through with low confidence, the agent reads it back to confirm instead of booking the wrong thing.
Second, a **live latency HUD** times each turn from speech onset to AssemblyAI's first transcribed word —
real telemetry on screen, so the "immediate" claim is measurable, not marketing.

It's genuinely multilingual. Flip an agent to Multilingual and AssemblyAI's universal-streaming-multilingual
model transcribes English, Spanish, French, German, Italian and Portuguese live, detecting the spoken
language on every finalized turn; the transcript tags each caller turn and the agent replies in that
language — one agent, six languages, no config switch. (Verified live: a Spanish clip came back transcribed
word-for-word with language_code "es" at 0.92 confidence.)

It's multi-tenant by construction: every record is tenant-scoped and a build-failing test proves one
customer can never see another's data. The agent's brain and voice are also bilingual in Arabic and English;
AssemblyAI streaming STT does not support Arabic yet (batch only), which we state honestly rather than fake.

Stack: TypeScript, Node.js, AssemblyAI Universal-Streaming (+ multilingual model), WebSocket, Web Audio API,
SQLite, OpenAI/Gemini, ElevenLabs/Cartesia. MIT-licensed and self-contained. Built by Matrix AE.

## Categories

Pick the closest the form offers, in priority order:
Voice AI / Conversational AI · Developer Tools · SaaS / Productivity · Customer Support

## Technologies Used

AssemblyAI Universal-Streaming (incl. universal-streaming-multilingual + word-level confidence),
TypeScript, Node.js, WebSocket, Web Audio API (AudioWorklet), SQLite (better-sqlite3), OpenAI, Google Gemini,
ElevenLabs, Cartesia

---

## Deliverables checklist

| Deliverable | Status |
|---|---|
| Public GitHub repo (MIT, built during the hackathon, uses AssemblyAI) | ✅ done — this repo |
| Working multi-tenant SaaS + README + architecture docs | ✅ done |
| Live end-to-end verification | ✅ done (`scripts/smoke.mjs`, 37 unit tests; multilingual STT verified live on a Spanish clip → `language_code: es`) |
| Cover image (16:9) | ✅ done — `docs/cover.png` |
| **Deploy a live demo URL (HTTPS)** | ⬜ **you** — `render.yaml` provided; set keys in the dashboard |
| **Record the demo video (~2.5 min)** | ⬜ **you** — shot list in `docs/demo-script.md` |
| **Slide deck** | ⬜ **you** — use the Long Description sections |
| **Submit the lablab.ai form before the deadline** | ⬜ **you** — Sep 30, 8:00 PM PKT |

## To deploy the demo (Render)

1. Push this repo to GitHub (done).
2. On Render: **New → Blueprint**, point at this repo (`render.yaml` is picked up).
3. Set `ASSEMBLYAI_API_KEY`, `OPENAI_API_KEY` (or `GEMINI_API_KEY`), `ELEVENLABS_API_KEY` (or `CARTESIA_API_KEY`),
   and `IP_HASH_SALT` in the dashboard. (The SQLite DB is ephemeral on the free plan — fine for a live demo;
   attach a persistent disk at `/data` for durability.)
4. Deploy → open the HTTPS URL → `/dashboard` to create a workspace, or `/` to talk to the demo agent.
   (HTTPS is required for the browser mic.)

## Run locally

```bash
npm install
cp .env.example .env   # add your keys
npm start              # http://localhost:8790  (/ = demo, /dashboard = owner app)
npm test               # 37 unit tests
```
