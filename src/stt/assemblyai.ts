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
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // v3 control frames are always JSON text; ignore anything else
    }
    switch (msg.type) {
      case "Begin": {
        const id = String(msg.id ?? "");
        log.debug("assemblyai session begin", { id });
        this.events.onReady?.(id);
        break;
      }
      case "Turn": {
        const transcript = String(msg.transcript ?? "").trim();
        const endOfTurn = msg.end_of_turn === true;
        const formatted = msg.turn_is_formatted === true;
        if (!transcript) break;
        // With format_turns=true AssemblyAI emits the final TWICE — first
        // unformatted, then formatted. Act on the clean formatted one only,
        // or your transcript (and LLM calls) double. When formatting is off,
        // fire on the plain end_of_turn.
        const requireFormatted = this.opts.formatTurns ?? true;
        if (endOfTurn && (!requireFormatted || formatted)) {
          this.lastPartial = "";
          this.events.onFinal?.(transcript);
        } else if (!endOfTurn && transcript !== this.lastPartial) {
          this.lastPartial = transcript;
          this.events.onPartial?.(transcript);
        }
        break;
      }
      case "Termination": {
        log.debug("assemblyai termination", {
          audio: msg.audio_duration_seconds,
          session: msg.session_duration_seconds,
        });
        break;
      }
      default:
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
