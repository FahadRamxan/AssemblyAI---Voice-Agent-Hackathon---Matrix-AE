/**
 * VoiceSession — one live call. Bridges a browser WebSocket to the three
 * layers and runs the turn loop with barge-in:
 *
 *   browser mic PCM ──> AssemblyAI STT ──partial──> live caption
 *                                        └─final──> LLM (stream) ──sentence──> TTS ──PCM──> browser
 *
 * Barge-in: while the agent is speaking, a fresh caller partial aborts the
 * in-flight LLM + TTS and tells the browser to flush playback.
 *
 * Multi-tenant: the session runs a RESOLVED per-tenant agent (persona, greeting,
 * voice, keyterms) — resolved from an embed key at the /ws upgrade — while the
 * provider KEYS stay platform-level. The turn loop + barge-in are unchanged from
 * the single-tenant version; only their inputs are injected.
 */
import type { WebSocket } from "ws";
import type { LlmConfig, TtsConfig } from "./config.js";
import type { ResolvedAgent } from "./embed.js";
import { AssemblyAiStt, type SttMeta, type SttWord } from "./stt/assemblyai.js";
import { utteranceConfidence, shouldConfirm, confirmationNote } from "./confidence.js";
import { streamLlm } from "./llm.js";
import { synthesize, TTS_SAMPLE_RATE } from "./tts.js";
import { Conversation, SentenceAssembler, detectLang } from "./agent.js";
import { MIC_SAMPLE_RATE, type ServerMessage } from "./protocol.js";
import { log } from "./logger.js";

/** Provider keys/config — platform-level, shared by every tenant. */
export interface PlatformProviders {
  assemblyAiKey: string;
  /** Platform default STT model (e.g. "universal-streaming-multilingual"). */
  assemblyAiSpeechModel?: string;
  llm: LlmConfig | null;
  tts: TtsConfig | null;
}

const MULTILINGUAL_MODEL = "universal-streaming-multilingual";

/** An agent set to language "multi" forces the multilingual model; else the platform default. */
export function resolveSpeechModel(agentLanguage: string, platformModel?: string): string | undefined {
  if (agentLanguage === "multi") return MULTILINGUAL_MODEL;
  return platformModel && platformModel.length ? platformModel : undefined;
}

/** Best-effort call persistence, wired in from the DB (see recorder.ts). Every
 *  method must be safe to throw-swallow and MUST NOT block the audio path. */
export interface CallRecorder {
  callerTurn(text: string, lang: string): void;
  agentReply(text: string, lang: string, latencyMs: number): void;
  bargeIn(): void;
  /** detectedLang = AssemblyAI's detected language code for the call (multilingual agents), else null. */
  finalize(reason: string, languagePrimary: string | null, detectedLang?: string | null): void;
}

export interface SessionContext {
  resolved: ResolvedAgent;
  platform: PlatformProviders;
  callId: string;
  sessionMaxMs: number;
  recorder?: CallRecorder;
}

export class VoiceSession {
  private stt: AssemblyAiStt;
  private convo: Conversation;
  private ttsConfig: TtsConfig | null;
  private llmAbort: AbortController | null = null;
  private ttsAbort: AbortController | null = null;
  private ttsActive = false;
  private turnSeq = 0; // increments each turn so a stale turn can't resume after barge-in
  private closed = false;
  private started = false; // start() runs exactly once per socket (no duplicate STT/greeting/spend)
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private turnStartAt = 0;
  private firstChunkAt = 0;
  private readonly langTally = { en: 0, ar: 0 };
  private readonly detectedTally = new Map<string, number>(); // AssemblyAI language_code -> count

  constructor(
    private readonly browser: WebSocket,
    private readonly ctx: SessionContext,
  ) {
    const { resolved, platform } = ctx;
    const speechModel = resolveSpeechModel(resolved.language, platform.assemblyAiSpeechModel);
    this.stt = new AssemblyAiStt({
      apiKey: platform.assemblyAiKey,
      sampleRate: MIC_SAMPLE_RATE,
      formatTurns: true,
      keyterms: resolved.keyterms,
      speechModel,
      languageDetection: speechModel === MULTILINGUAL_MODEL, // per-turn language codes on finals
    });
    this.convo = new Conversation(resolved.persona);
    // Per-agent voice over the platform TTS key (keys stay platform-level).
    this.ttsConfig = platform.tts
      ? { ...platform.tts, voiceId: resolved.voiceId || platform.tts.voiceId }
      : null;
  }

  start(): void {
    if (this.started || this.closed) return; // idempotent — a repeated {type:'start'} is a no-op
    this.started = true;

    this.send({
      type: "ready",
      micSampleRate: MIC_SAMPLE_RATE,
      ttsSampleRate: TTS_SAMPLE_RATE,
      sttLive: Boolean(this.ctx.platform.assemblyAiKey),
    });

    if (this.ctx.platform.assemblyAiKey) {
      this.stt.connect({
        onReady: () => log.info("stt session ready", { callId: this.ctx.callId }),
        onPartial: (text, words) => this.onPartial(text, words),
        onFinal: (text, meta) => this.onFinal(text, meta),
        onError: (err) => {
          log.error("stt error", { err: err.message });
          this.send({ type: "error", message: `Speech-to-text error: ${err.message}` });
        },
        onClose: () => log.debug("stt closed"),
      });
    } else {
      this.send({ type: "error", message: "ASSEMBLYAI_API_KEY not set — type to test the brain instead." });
    }

    // Hard wall-clock cap: bound a single session's provider spend.
    this.maxTimer = setTimeout(() => {
      this.send({ type: "status", text: "session time limit reached" });
      this.close("timeout");
    }, this.ctx.sessionMaxMs);
    this.maxTimer.unref?.();

    // Agent speaks first.
    const greeting = this.ctx.resolved.greeting;
    if (greeting) {
      this.convo.addAssistant(greeting);
      this.ctx.recorder?.agentReply(greeting, detectLang(greeting), 0); // seq 0, latency null
      void this.speak(greeting, ++this.turnSeq);
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

  private onPartial(text: string, words?: SttWord[]): void {
    this.send({ type: "partial", text, words });
    // Caller started talking while the agent was speaking -> barge-in.
    if (this.ttsActive) this.bargeIn();
  }

  private onFinal(text: string, meta?: SttMeta): void {
    const words = meta?.words ?? [];
    const confidence = utteranceConfidence(words, meta?.endOfTurnConfidence);
    this.send({ type: "final", text, words, confidence, language: meta?.languageCode });
    const lang = detectLang(text);
    if (lang === "ar") this.langTally.ar++;
    else this.langTally.en++;
    // AssemblyAI's own per-turn language detection (multilingual agents only).
    if (meta?.languageCode) this.detectedTally.set(meta.languageCode, (this.detectedTally.get(meta.languageCode) ?? 0) + 1);
    try {
      this.ctx.recorder?.callerTurn(text, lang);
    } catch (err) {
      log.warn("recorder callerTurn failed", { err: String(err) });
    }
    // AssemblyAI word confidence -> if an important word was uncertain, have the agent confirm it.
    const note = words.length && shouldConfirm(words) ? confirmationNote(words) : null;
    void this.handleTurn(text, note);
  }

  /** Run one caller turn: LLM (stream) -> sentences -> TTS -> audio. */
  private async handleTurn(userText: string, confirmNote?: string | null): Promise<void> {
    if (this.closed) return;
    if (!this.ctx.platform.llm) {
      this.send({ type: "error", message: "No LLM configured (set OPENAI_API_KEY or GEMINI_API_KEY)." });
      return;
    }
    // Any earlier turn is now stale.
    this.abortInflight();
    const seq = ++this.turnSeq;
    this.convo.addUser(userText);
    // AssemblyAI flagged a low-confidence word -> nudge the agent to confirm it.
    if (confirmNote) this.convo.addSystemNote(confirmNote);

    this.llmAbort = new AbortController();
    const assembler = new SentenceAssembler();
    let full = "";
    this.turnStartAt = Date.now();
    this.firstChunkAt = 0;
    this.send({ type: "status", text: "thinking" });

    try {
      for await (const delta of streamLlm(this.ctx.platform.llm, this.convo.messages(), this.llmAbort.signal)) {
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
        if (full.trim()) {
          const latency = (this.firstChunkAt || Date.now()) - this.turnStartAt;
          try {
            this.ctx.recorder?.agentReply(full, detectLang(full), latency);
          } catch (err) {
            log.warn("recorder agentReply failed", { err: String(err) });
          }
        }
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
    if (!this.ttsConfig) return; // text-only mode (no voice configured)

    this.ttsAbort = new AbortController();
    if (!this.ttsActive) {
      this.ttsActive = true;
      this.send({ type: "tts_start" });
    }
    try {
      for await (const chunk of synthesize(this.ttsConfig, text, detectLang(text), this.ttsAbort.signal)) {
        if (seq !== this.turnSeq || this.closed) return; // barge-in cut us off
        if (!this.firstChunkAt) this.firstChunkAt = Date.now(); // first audio of the turn (latency signal)
        this.sendBinary(chunk);
      }
    } catch (err) {
      if (!isAbort(err)) log.error("tts failed", { err: String(err) });
    }
  }

  private bargeIn(): void {
    log.info("barge-in", { callId: this.ctx.callId });
    this.abortInflight();
    this.turnSeq++; // invalidate the interrupted turn
    try {
      this.ctx.recorder?.bargeIn();
    } catch (err) {
      log.warn("recorder bargeIn failed", { err: String(err) });
    }
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

  close(reason = "client_close"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    this.abortInflight();
    this.stt.close();
    const primary = this.langTally.ar > this.langTally.en ? "ar" : this.langTally.en > 0 ? "en" : null;
    // Most-frequently detected language across the call (AssemblyAI multilingual).
    let detected: string | null = null;
    let best = 0;
    for (const [code, n] of this.detectedTally) if (n > best) ((best = n), (detected = code));
    try {
      this.ctx.recorder?.finalize(reason, primary, detected);
    } catch (err) {
      log.warn("recorder finalize failed", { err: String(err) });
    }
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
