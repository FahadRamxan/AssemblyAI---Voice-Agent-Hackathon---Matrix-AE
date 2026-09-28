/**
 * VoiceSession — one live call. Bridges a browser WebSocket to the three
 * layers and runs the turn loop with barge-in:
 *
 *   browser mic PCM ──> AssemblyAI STT ──partial──> live caption
 *                                        └─final──> LLM (stream) ──sentence──> TTS ──PCM──> browser
 *
 * Barge-in: while the agent is speaking, a fresh caller partial aborts the
 * in-flight LLM + TTS and tells the browser to flush playback — so you can
 * cut the agent off mid-sentence, like a real conversation.
 */
import type { WebSocket } from "ws";
import type { Config } from "./config.js";
import { AssemblyAiStt } from "./stt/assemblyai.js";
import { streamLlm } from "./llm.js";
import { synthesize, TTS_SAMPLE_RATE } from "./tts.js";
import { Conversation, SentenceAssembler, detectLang } from "./agent.js";
import { MIC_SAMPLE_RATE, type ServerMessage } from "./protocol.js";
import { log } from "./logger.js";

export class VoiceSession {
  private stt: AssemblyAiStt;
  private convo = new Conversation();
  private llmAbort: AbortController | null = null;
  private ttsAbort: AbortController | null = null;
  private ttsActive = false;
  private turnSeq = 0; // increments each turn so a stale turn can't resume after barge-in
  private closed = false;

  constructor(
    private readonly browser: WebSocket,
    private readonly cfg: Config,
  ) {
    this.stt = new AssemblyAiStt({
      apiKey: cfg.assemblyAiKey,
      sampleRate: MIC_SAMPLE_RATE,
      formatTurns: true,
      keyterms: ["Raabta", "Matrix AE"],
    });
  }

  start(): void {
    this.send({
      type: "ready",
      micSampleRate: MIC_SAMPLE_RATE,
      ttsSampleRate: TTS_SAMPLE_RATE,
      sttLive: Boolean(this.cfg.assemblyAiKey),
    });

    if (this.cfg.assemblyAiKey) {
      this.stt.connect({
        onReady: () => log.info("stt session ready"),
        onPartial: (text) => this.onPartial(text),
        onFinal: (text) => this.onFinal(text),
        onError: (err) => {
          log.error("stt error", { err: err.message });
          this.send({ type: "error", message: `Speech-to-text error: ${err.message}` });
        },
        onClose: () => log.debug("stt closed"),
      });
    } else {
      this.send({ type: "error", message: "ASSEMBLYAI_API_KEY not set — type to test the brain instead." });
    }

    // Agent speaks first.
    if (this.cfg.greeting) {
      this.convo.addAssistant(this.cfg.greeting);
      void this.speak(this.cfg.greeting, ++this.turnSeq);
    }
  }

  /** Raw mic PCM16 from the browser. */
  onMicAudio(pcm: Uint8Array): void {
    this.stt.sendAudio(pcm);
  }

  /** Typed input — treat exactly like a finalized spoken turn (great for testing). */
  onText(text: string): void {
    const clean = text.trim();
    if (clean) this.onFinal(clean);
  }

  private onPartial(text: string): void {
    this.send({ type: "partial", text });
    // Caller started talking while the agent was speaking -> barge-in.
    if (this.ttsActive) this.bargeIn();
  }

  private onFinal(text: string): void {
    this.send({ type: "final", text });
    void this.handleTurn(text);
  }

  /** Run one caller turn: LLM (stream) -> sentences -> TTS -> audio. */
  private async handleTurn(userText: string): Promise<void> {
    if (this.closed) return;
    if (!this.cfg.llm) {
      this.send({ type: "error", message: "No LLM configured (set OPENAI_API_KEY or GEMINI_API_KEY)." });
      return;
    }
    // Any earlier turn is now stale.
    this.abortInflight();
    const seq = ++this.turnSeq;
    this.convo.addUser(userText);

    this.llmAbort = new AbortController();
    const assembler = new SentenceAssembler();
    let full = "";
    this.send({ type: "status", text: "thinking" });

    try {
      for await (const delta of streamLlm(this.cfg.llm, this.convo.messages(), this.llmAbort.signal)) {
        if (seq !== this.turnSeq) return; // superseded by barge-in / newer turn
        full += delta;
        for (const sentence of assembler.push(delta)) {
          await this.speak(sentence, seq);
          if (seq !== this.turnSeq) return;
        }
      }
      const tail = assembler.flush();
      if (tail) await this.speak(tail, seq);
    } catch (err) {
      if (!isAbort(err)) {
        log.error("turn failed", { err: String(err) });
        this.send({ type: "error", message: "Sorry, something went wrong generating a reply." });
      }
    } finally {
      if (seq === this.turnSeq) {
        this.convo.addAssistant(full);
        if (this.ttsActive) {
          this.ttsActive = false;
          this.send({ type: "tts_stop", reason: "done" });
        }
      }
    }
  }

  /** Synthesize one sentence and stream its PCM to the browser. */
  private async speak(sentence: string, seq: number): Promise<void> {
    const text = sentence.trim();
    if (!text || this.closed) return;
    this.send({ type: "agent", text });
    if (!this.cfg.tts) return; // text-only mode (no voice configured)

    this.ttsAbort = new AbortController();
    if (!this.ttsActive) {
      this.ttsActive = true;
      this.send({ type: "tts_start" });
    }
    try {
      for await (const chunk of synthesize(this.cfg.tts, text, detectLang(text), this.ttsAbort.signal)) {
        if (seq !== this.turnSeq || this.closed) return; // barge-in cut us off
        this.sendBinary(chunk);
      }
    } catch (err) {
      if (!isAbort(err)) log.error("tts failed", { err: String(err) });
    }
  }

  private bargeIn(): void {
    log.info("barge-in");
    this.abortInflight();
    this.turnSeq++; // invalidate the interrupted turn
    if (this.ttsActive) {
      this.ttsActive = false;
      this.send({ type: "tts_stop", reason: "barge_in" });
    }
  }

  private abortInflight(): void {
    this.llmAbort?.abort();
    this.ttsAbort?.abort();
    this.llmAbort = null;
    this.ttsAbort = null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortInflight();
    this.stt.close();
  }

  private send(msg: ServerMessage): void {
    if (this.browser.readyState === 1 /* OPEN */) this.browser.send(JSON.stringify(msg));
  }

  private sendBinary(pcm: Uint8Array): void {
    if (this.browser.readyState === 1 /* OPEN */) this.browser.send(pcm, { binary: true });
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
}
