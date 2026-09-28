# Raabta Live — walkthrough (how it works + how to use it)

A guided tour of the running product: how to get in, what each screen does, and what happens
under the hood at every step.

## 0. Start it

```bash
npm install
cp .env.example .env     # add your keys (ASSEMBLYAI_API_KEY + one LLM + one TTS)
npm start                # -> http://localhost:8790
```

Two ways in:

| URL | Who it's for |
|---|---|
| `http://localhost:8790/` | **Visitor** — talk to the built-in demo agent right away |
| `http://localhost:8790/dashboard` | **Owner** — sign in / create a workspace and build your own agent |

There is **no global username/password**. It's a multi-tenant SaaS — each owner creates their own
workspace (email + password of their choosing) on the dashboard. Sign-in uses a scrypt-hashed
password and a revocable server-side session cookie; publishable `pk_live_` keys (safe in a browser)
are what the embedded widget uses — never the password.

## 1. Create a workspace (or sign in)

1. Open `/dashboard` → **"Create a workspace"**.
2. Enter a **business name**, an **email**, and a **password** — these are *your* login.
3. You're dropped into the dashboard with a starter agent already created for your business.

Under the hood: one atomic transaction creates the tenant + owner user (scrypt password hash) + a
default agent + a publishable embed key, and issues a session.

## 2. Overview — live analytics

Every tile is computed from calls your agent actually handled (nothing seeded):

- **Total calls**, **calls last 7 days**, **avg duration**, **avg turns/call**
- **Barge-in rate** — how often callers interrupted the agent
- **Reply latency p50 / p95** — first-token-to-first-audio speed
- **Calls (last 14 days)** sparkline and a **language split**

## 3. Agents — the brain

Each agent has its own:

- **Name**, **Active** toggle
- **Language** — `auto` (English STT) · `English` · `Arabic (brain + voice)` ·
  **`Multilingual live (EN/ES/FR/DE/IT/PT)`**. Multilingual flips AssemblyAI to the
  `universal-streaming-multilingual` model and detects the spoken language on every finalized turn.
- **Greeting** — the first line the agent speaks
- **Keyterms** — brand/name boosts for recognition (e.g. your business name)
- **Voice ID** — optional; overrides the platform default TTS voice
- **Persona / system prompt** — voice-shaped: one or two short sentences, no markdown, mirror the
  caller's language, confirm what it wasn't sure it heard, never invent facts.

Edit, **Save changes**, or **+ New agent** for a second use case.

## 4. Talk to your agent — try it live

The **"Talk to your agent"** tab embeds the exact widget your visitors get.

- Click the **orb** (or **Start call**) and allow the mic — speak naturally.
- **Interrupt it mid-sentence** — the in-flight reply + audio abort instantly (true barge-in).
- **No mic?** Type in the box to test the brain (same path, minus speech-to-text).
- Watch the **latency HUD** (top-right): AssemblyAI's live time-to-first-word for each turn.
- Speak Spanish / French / German / Italian / Portuguese on a **Multilingual** agent — the caller
  turn is tagged with the detected language and the agent replies in kind.

What happens per turn: browser streams 16 kHz PCM over one WebSocket → AssemblyAI Universal-Streaming
returns partials (live caption) then a final on end-of-turn → the final goes to the LLM → each finished
sentence streams to TTS → PCM plays back gaplessly. A fresh caller partial while the agent is speaking
triggers barge-in.

## 5. Embed & keys — put it on any website

- **Your embed snippet** — one line of HTML:
  ```html
  <script src="https://YOUR-HOST/embed.js" data-agent-key="pk_live_..." async></script>
  ```
  Drop it on any site and a floating **Talk** button appears wired to your agent.
- **Preview on a demo site** — opens a plain business page with your agent's button, to prove it works
  off a third-party page.
- **Create a key** per agent (with a label), and **Revoke** any key. A publishable key can *only* start
  a voice call for its agent — it can't touch the dashboard or another tenant.

## 6. Calls — every conversation, replayable

The **Calls** list shows each handled call (time, duration, turns, barge-ins, language, status). Click one
to read the **speaker-attributed transcript** with per-reply latencies — the same conversation your agent had.

## Security model (why it's safe to embed)

- **Two auth planes:** owner (password + session cookie, full dashboard) vs. embed (publishable
  `pk_live_` key, can only start a call for its agent).
- The embed key is resolved to a tenant **before** the WebSocket upgrade — a bad/revoked key is rejected
  at the handshake, so there's no keyless spend hole.
- **Tenant isolation by construction:** every query is scoped by `tenant_id`; a build-failing test proves
  one tenant can never read another's data.
- Per-tenant concurrency + session wall-clock caps bound provider spend on public keys.

## Honest notes

- **Arabic** live speech-to-text is not supported by AssemblyAI streaming yet (batch only). The agent's
  **brain and voice are bilingual** — it replies in Arabic — but the live transcript for Arabic speech
  isn't real, so we don't fake it. Live STT covers English + Spanish/French/German/Italian/Portuguese.
- Typed test turns show a **100%** confidence badge and **no language tag** — per-word confidence and
  language detection are speech-to-text signals, so they appear on **spoken** turns.
