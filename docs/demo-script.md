# Demo video script (~2.5 min)

A tight, screen-recorded walkthrough of the **platform**. Record at 1080p with clear audio and **talk to it
on camera** — the live transcript is what proves the STT is real.

**Prep:** deploy the Render URL (the browser mic needs HTTPS) or run locally; wear **headphones** so the
agent's own voice doesn't trip the barge-in; set `CARTESIA_API_KEY` for the snappiest first-audio.

---

**0:00 — Hook (talk to it immediately)**
> "This is Raabta Live — real-time voice agents built on AssemblyAI. Watch, I'll just talk to it."

Open `/`, tap the **orb**. Say:
> "Hi, I'd like to book an appointment for next week."

Point out: your words appear **as you speak**, and the agent answers out loud in about a second. Glance at the
**latency pill (top-right)** — it shows AssemblyAI's live time-to-first-word for the turn you just spoke.

**0:20 — The differentiator: barge-in**
> "Here's the part most voice bots get wrong — interrupting."

While the agent is still talking, cut in:
> "Actually — are you open on Saturdays?"

Call out that it **stopped instantly** and answered the new question — AssemblyAI's end-of-turn detection
plus our barge-in (the in-flight reply + audio are aborted the moment you speak). Do it twice if subtle.

**0:40 — It knows when it mis-heard (the AssemblyAI depth beat)**
Say a phone number and mumble a digit or two. Point out: the uncertain words are **shaded** in the
transcript (with a confidence badge on the turn), and the agent **reads the number back to confirm**.
> "That's AssemblyAI's word-level confidence driving the agent — it doesn't just transcribe, it knows when
> it wasn't sure and checks, instead of booking the wrong number."

**0:55 — Multilingual, live (switch languages on the fly)**
With a **Multilingual** agent selected, say a sentence in Spanish (or French/German/Italian/Portuguese):
> "Hola, quiero reservar una mesa para dos personas esta noche."

Point out: it transcribes the Spanish **live**, the caller turn is tagged **ES**, and the agent **replies in
Spanish** — one agent, six languages, detected per turn.
> "That's AssemblyAI's multilingual streaming model detecting the language on every turn — no config switch,
> no separate bot."

**1:00 — It's a platform, not a demo**
Go to `/dashboard`. The call you just made is already on the **Overview** (calls, avg duration,
**barge-in rate**, reply latency). Open **Embed & keys**, copy the one-line snippet, and click
**Preview on a demo site** — a plain business page with *your* agent's floating Talk button.
> "One line of HTML puts your agent on any website."

Talk to it there to show it works off a third-party page.

**1:20 — Real data**
Open **Calls**, click the call → the **read-along transcript replay**.
> "Every number on this dashboard is from real calls my agent handled — nothing seeded."

**1:45 — How it works (30s)**
Show `docs/architecture.md`:
> "The browser streams 16 kHz audio over one WebSocket to our Node backend, which bridges to
> **AssemblyAI Universal-Streaming**. Its semantic end-of-turn detection fires the final transcript to the
> LLM; each finished sentence streams to text-to-speech. When you speak over it, a fresh partial aborts
> everything and flushes playback. Every tenant's data is isolated by construction."

**2:10 — Business value + close**
> "For any business, this is a 24/7 bilingual receptionist you embed in one line — clinics, hotels, support
> lines. Built on AssemblyAI. Open-source and MIT-licensed. Thanks for watching."

---

### Tips
- Do the **barge-in twice** — it's the money shot.
- Headphones + `echoCancellation` (on by default) so the demo doesn't self-interrupt.
- Flash the DevTools **Network** tab for a second to show the live WebSocket frames — proves it's real.
- Live STT covers English + Spanish/French/German/Italian/Portuguese (the multilingual model). **Arabic**
  streaming STT isn't supported yet — if you do the Arabic beat, ask "Can you say that in Arabic?" so the
  *reply* comes back in Arabic (RTL transcript) and keep the framing honest: brain + voice are bilingual,
  live Arabic transcription is batch-only today.
