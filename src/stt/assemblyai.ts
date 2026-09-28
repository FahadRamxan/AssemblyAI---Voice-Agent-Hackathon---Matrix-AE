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

export interface SttEvents {
  /** Session is live (AssemblyAI "Begin" received). */
  onReady?: (sessionId: string) => void;
  /** Interim transcript for the current turn (not yet finalized). */
  onPartial?: (text: string) => void;
  /** A finalized turn — the caller has stopped speaking. */
  onFinal?: (text: string) => void;
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
}

const ENDPOINT = "wss://streaming.assemblyai.com/v3/ws";

export type SttInterpretation =
  | { kind: "ready"; id: string }
  | { kind: "partial"; text: string }
  | { kind: "final"; text: string }
  | { kind: "termination" }
  | { kind: "ignore" };

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
      const endOfTurn = msg.end_of_turn === true;
      const formatted = msg.turn_is_formatted === true;
      if (endOfTurn && (!requireFormatted || formatted)) return { kind: "final", text };
      if (!endOfTurn) return { kind: "partial", text };
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
        this.events.onFinal?.(result.text);
        break;
      case "partial":
        if (result.text !== this.lastPartial) {
          this.lastPartial = result.text;
          this.events.onPartial?.(result.text);
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
