# lablab.ai submission — Raabta Live

Copy-paste-ready content for the submission form, plus the deliverables checklist.

## Title
Raabta Live — real-time bilingual voice agent on AssemblyAI

## Short description (one line)
A real-time voice agent you can talk over — browser mic → AssemblyAI Universal-Streaming → LLM → streaming voice, with true barge-in and a live read-along transcript.

## Full description
**The problem.** Most “voice bots” feel robotic because they can’t be interrupted and they lag. You have
to wait for them to finish, and if you talk over them they either ignore you or break. For a bilingual
market like MENA, there’s also almost nothing that handles Arabic and English naturally in one call.

**The solution — Raabta Live.** A browser voice agent built on **AssemblyAI Universal-Streaming**. You
speak, your words appear on screen in real time, and the agent answers out loud — and you can **cut it off
mid-sentence** exactly like a real phone call. The reply streams sentence-by-sentence into text-to-speech
so you hear the first words in about a second, and the whole conversation is shown as a live read-along
transcript (which also proves the streaming STT is genuine, not scripted).

**How it works.** The browser captures mic audio in an AudioWorklet, downsamples to 16 kHz PCM, and streams
it over a single WebSocket to a Node backend. The backend bridges to AssemblyAI’s v3 realtime socket; its
semantic **end-of-turn detection** signals when the caller has finished, the final transcript goes to the
LLM (streamed), and each finished sentence is sent to TTS. When a fresh caller partial arrives while the
agent is speaking, the in-flight LLM + TTS are aborted and the browser flushes queued audio — instant
barge-in. A per-turn sequence number guarantees an interrupted turn can never resume over the new one.

**Bilingual.** The agent mirrors the caller’s language and speaks natural Gulf Arabic or English (the
transcript flips to RTL for Arabic). AssemblyAI streaming STT is English-first today, so live input is
English; Arabic input is available via AssemblyAI’s batch API and is on the streaming roadmap.

**Tech.** TypeScript, Node (`ws`, zero other runtime deps), Web Audio API (AudioWorklet), WebSocket,
AssemblyAI Universal-Streaming, OpenAI/Gemini, ElevenLabs/Cartesia. Provider-agnostic and MIT-licensed.

**What’s next.** Telephony (SIP) so it answers real phone numbers, multi-tenant config, and Arabic live
STT as AssemblyAI expands streaming language coverage. Built by Matrix AE, the team behind RaabtaAI.

## Technology tags
AssemblyAI, TypeScript, Node.js, WebSocket, Web Audio API, Speech-to-Text, Voice AI, OpenAI, ElevenLabs

---

## Deliverables checklist

| Deliverable | Status |
|---|---|
| Public GitHub repo (MIT, built during the hackathon, uses AssemblyAI) | ✅ done — this repo |
| Working code + README + architecture docs | ✅ done |
| Live end-to-end verification | ✅ done (`scripts/smoke.mjs`, unit tests) |
| Cover image (16:9) | ✅ done — `docs/cover.png` |
| **Deploy a live demo URL (HTTPS)** | ⬜ **you** — `render.yaml` provided; set keys in the dashboard |
| **Record the demo video (~2.5 min)** | ⬜ **you** — script in `docs/demo-script.md` |
| **Slide deck** | ⬜ **you** — use the sections in this file |
| **Submit the lablab.ai form before the deadline** | ⬜ **you** — Sep 30, 8:00 PM PKT |

## To deploy the demo (Render)
1. Push this repo to GitHub (done).
2. On Render: **New → Blueprint**, point at this repo (`render.yaml` is picked up).
3. Set `ASSEMBLYAI_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` in the dashboard.
4. Deploy → open the HTTPS URL → **Start call**. (HTTPS is required for the browser mic.)

## Run locally
```bash
npm install
cp .env.example .env   # add your keys
npm start              # http://localhost:8790
npm test               # 10 unit tests
```
