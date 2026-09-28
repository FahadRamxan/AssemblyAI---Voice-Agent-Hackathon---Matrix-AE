/**
 * AssemblyAI Universal-Streaming (v3) realtime speech-to-text client.
 *
 * This is the Path-2 core of the submission: caller audio (16 kHz mono
 * PCM16) is streamed to AssemblyAI over a WebSocket and comes back as
 * partial ("Turn" with end_of_turn=false) then final (end_of_turn=true)
 * transcripts, with AssemblyAI's own turn/endpoint detection deciding when
 * the caller has finished speaking.
 *
 * Auth: the backend holds the API key and passes it in the `Authorization`
 * header on the WS handshake (no browser-exposed token needed — the browser
 * only ever talks to *our* server).
 *
 * Docs: https://www.assemblyai.com/docs/speech-to-text/universal-streaming
 */
import WebSocket from "ws";
import { log } from "../logger.js";

/** One recognized word with AssemblyAI's confidence (0..1). */
export interface SttWord {
  text: string;
  confidence: number;
}

/** Metadata AssemblyAI attaches to a finalized turn. */
export interface SttMeta {
  words: SttWord[];
  /** AssemblyAI's end_of_turn_confidence (0..1), if present. */
  endOfTurnConfidence?: number;
  /** Detected language code (e.g. "es"), when language_detection is on. */
  languageCode?: string;
  /** Confidence of the language detection (0..1). */
  languageConfidence?: number;
}

export interface SttEvents {
  /** Session is live (AssemblyAI "Begin" received). */
  onReady?: (sessionId: string) => void;
  /** Interim transcript for the current turn (not yet finalized). */
  onPartial?: (text: string, words?: SttWord[]) => void;
  /** A finalized turn — the caller has stopped speaking. */
  onFinal?: (text: string, meta?: SttMeta) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export interface SttOptions {
  apiKey: string;
  sampleRate?: number; // must match the audio you send (default 16000)
  formatTurns?: boolean; // punctuation + casing on finals (default true)
  /** 0..1 — higher waits for more certainty before ending a turn (default AssemblyAI 0.4). */
  endOfTurnConfidenceThreshold?: number;
  /** Up to 100 terms to boost recognition of (brand/product names, e.g. "Raabta"). */
  keyterms?: string[];
  /** Override the speech model, e.g. "universal-streaming-multilingual" (EN/ES/FR/DE/IT/PT). */
  speechModel?: string;
  /** Enable per-turn language detection — only valid with the multilingual model. */
  languageDetection?: boolean;
}

const ENDPOINT = "wss://streaming.assemblyai.com/v3/ws";

export type SttInterpretation =
  | { kind: "ready"; id: string }
  | { kind: "partial"; text: string; words: SttWord[] }
  | {
      kind: "final";
      text: string;
      words: SttWord[];
      endOfTurnConfidence?: number;
      languageCode?: string;
      languageConfidence?: number;
    }
  | { kind: "termination" }
  | { kind: "ignore" };

/** Parse the per-word confidence array from a Turn message. */
function parseWords(raw: unknown): SttWord[] {
  if (!Array.isArray(raw)) return [];
  const out: SttWord[] = [];
  for (const w of raw) {
    if (!w || typeof w !== "object") continue;
    const rec = w as Record<string, unknown>;
    const text = String(rec.text ?? "").trim();
    if (!text) continue;
    out.push({ text, confidence: typeof rec.confidence === "number" ? rec.confidence : 1 });
  }
  return out;
}

/**
 * Pure interpreter for an AssemblyAI v3 inbound message. Kept separate from
 * the socket so the tricky bits — partial vs final, and the double-final
 * dedupe when format_turns is on — are unit-testable without a network.
 */
export function interpretSttMessage(raw: string, requireFormatted: boolean): SttInterpretation {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: "ignore" };
  }
  switch (msg.type) {
    case "Begin":
      return { kind: "ready", id: String(msg.id ?? "") };
    case "Turn": {
      const text = String(msg.transcript ?? "").trim();
      if (!text) return { kind: "ignore" };
      const words = parseWords(msg.words);
      const endOfTurn = msg.end_of_turn === true;
      const formatted = msg.turn_is_formatted === true;
      const eotConf = typeof msg.end_of_turn_confidence === "number" ? msg.end_of_turn_confidence : undefined;
      const languageCode = typeof msg.language_code === "string" ? msg.language_code : undefined;
      const languageConfidence =
        typeof msg.language_confidence === "number" ? msg.language_confidence : undefined;
      if (endOfTurn && (!requireFormatted || formatted))
        return { kind: "final", text, words, endOfTurnConfidence: eotConf, languageCode, languageConfidence };
      if (!endOfTurn) return { kind: "partial", text, words };
      return { kind: "ignore" }; // unformatted end_of_turn — wait for the formatted one
    }
    case "Termination":
      return { kind: "termination" };
    default:
      return { kind: "ignore" };
  }
}

export class AssemblyAiStt {
  private ws?: WebSocket;
  private events: SttEvents = {};
  private lastPartial = "";
  private closed = false;

  constructor(private readonly opts: SttOptions) {}

  connect(events: SttEvents): void {
    this.events = events;
    const sampleRate = this.opts.sampleRate ?? 16000;
    const params = new URLSearchParams({
      sample_rate: String(sampleRate),
      encoding: "pcm_s16le",
      format_turns: String(this.opts.formatTurns ?? true),
    });
    if (typeof this.opts.endOfTurnConfidenceThreshold === "number") {
      params.set("end_of_turn_confidence_threshold", String(this.opts.endOfTurnConfidenceThreshold));
    }
    if (this.opts.keyterms?.length) {
      params.set("keyterms_prompt", JSON.stringify(this.opts.keyterms.slice(0, 100)));
    }
    if (this.opts.speechModel) params.set("speech_model", this.opts.speechModel);
    if (this.opts.languageDetection) params.set("language_detection", "true");
    const url = `${ENDPOINT}?${params.toString()}`;

    this.ws = new WebSocket(url, {
      headers: { Authorization: this.opts.apiKey },
    });

    this.ws.on("open", () => log.debug("assemblyai ws open"));
    this.ws.on("message", (data) => this.onMessage(data));
    this.ws.on("error", (err) => {
      if (!this.closed) this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
    this.ws.on("close", () => {
      if (!this.closed) this.events.onClose?.();
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    if (process.env.DEBUG) {
      try {
        const m = JSON.parse(data.toString());
        if (m.type === "Turn") {
          log.debug("Turn", {
            eot: m.end_of_turn,
            fmt: m.turn_is_formatted,
            order: m.turn_order,
            text: String(m.transcript ?? "").slice(0, 40),
          });
        } else log.debug("msg", { type: m.type });
      } catch {
        /* ignore */
      }
    }
    const result = interpretSttMessage(data.toString(), this.opts.formatTurns ?? true);
    switch (result.kind) {
      case "ready":
        log.debug("assemblyai session begin", { id: result.id });
        this.events.onReady?.(result.id);
        break;
      case "final":
        this.lastPartial = "";
        this.events.onFinal?.(result.text, {
          words: result.words,
          endOfTurnConfidence: result.endOfTurnConfidence,
          languageCode: result.languageCode,
          languageConfidence: result.languageConfidence,
        });
        break;
      case "partial":
        if (result.text !== this.lastPartial) {
          this.lastPartial = result.text;
          this.events.onPartial?.(result.text, result.words);
        }
        break;
      case "termination":
        log.debug("assemblyai termination");
        break;
      case "ignore":
        break;
    }
  }

  /** Stream a chunk of raw PCM16 (mono, matching sampleRate). */
  sendAudio(pcm: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && pcm.length) {
      this.ws.send(pcm, { binary: true });
    }
  }

  /** Ask AssemblyAI to force-finalize the current turn (used on barge-in end / button release). */
  forceEndpoint(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "ForceEndpoint" }));
    }
  }

  /** Cleanly terminate the session (billing is by session wall-clock, so close promptly). */
  close(): void {
    this.closed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "Terminate" }));
      } catch {
        /* ignore */
      }
      this.ws.close();
    } else {
      this.ws?.terminate();
    }
  }
}
