# Demo video script (~2.5 min)

A tight, screen-recorded walkthrough. Record at 1080p with clear audio; show the browser and *talk to it*
on camera — the live transcript on screen is what proves the STT is real.

---

**0:00 — Hook (talk to it immediately)**
> “This is Raabta Live — a real-time voice agent built on AssemblyAI. Watch, I’ll just talk to it.”

Click **Start call**. Say:
> “Hi, I’d like to book an appointment for next week.”

Point at the screen: the words appear **as you speak** (grey interim → solid bubble), the agent answers
out loud, and the reply streams in sentence by sentence.

**0:25 — The differentiator: barge-in**
> “Here’s the part most voice bots get wrong — interrupting.”

While the agent is still talking, cut in:
> “Actually — do you open on Saturdays?”

Call out that the agent **stopped instantly** and answered the new question. That’s AssemblyAI’s
end-of-turn detection + our barge-in: the in-flight reply and audio are aborted the moment you speak.

**0:50 — Bilingual**
> “It’s built for a bilingual market, so —”

Say:
> “Can you say that in Arabic?”

Show the agent reply in Arabic, transcript flipping right-to-left.

**1:10 — How it works (30s, show the diagram / a little code)**
> “Under the hood: the browser streams 16 kHz audio over one WebSocket to our Node backend, which bridges
> to **AssemblyAI Universal-Streaming**. Partials drive the live caption; the final transcript goes to the
> LLM; each sentence of the reply is streamed to text-to-speech so you hear the first words fast. When you
> speak over it, a fresh partial aborts everything and flushes playback.”

Optionally show `docs/architecture.md` diagram and the `src/session.ts` barge-in.

**1:45 — Business value**
> “For the MENA market, this is a 24/7 bilingual receptionist — clinics, hotels, support lines — that
> answers instantly and hands off naturally. It’s built by Matrix AE, the team behind RaabtaAI.”

**2:10 — Close**
> “Real-time, interruptible, bilingual voice AI on AssemblyAI. Code’s open-source and MIT-licensed. Thanks
> for watching.”

---

### Tips
- Do the barge-in twice if the first is subtle — it’s the money shot.
- Use a decent mic and `echoCancellation` (on by default) so the demo doesn’t self-interrupt.
- If you want the snappiest latency on camera, set `CARTESIA_API_KEY` (first audio ~260 ms) and a fast LLM.
- Keep the browser dev-tools Network tab open for a second to show the live WebSocket frames — proves it’s real.
