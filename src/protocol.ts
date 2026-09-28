/**
 * The single source of truth for the browser <-> backend WebSocket contract.
 *
 * ONE socket carries two planes:
 *   - BINARY frames  = audio. client->server: mic PCM16 @ MIC_SAMPLE_RATE.
 *                              server->client: TTS PCM16 @ TTS_SAMPLE_RATE.
 *   - TEXT frames    = JSON control/transcript messages (the types below).
 * Direction disambiguates the audio, so no per-frame tagging is needed.
 *
 * public/app.js mirrors these constants — keep the two in sync.
 */
export const MIC_SAMPLE_RATE = 16000; // what we send to AssemblyAI
export const TTS_SAMPLE_RATE = 24000; // what TTS returns / the browser plays
export const MIC_FRAME_MS = 50; // ~50ms per mic frame (AssemblyAI sweet spot)

/** A recognized word with AssemblyAI's confidence (0..1) — drives the shaded transcript. */
export interface TranscriptWord {
  text: string;
  confidence: number;
}

/** server -> client */
export type ServerMessage =
  | { type: "ready"; micSampleRate: number; ttsSampleRate: number; sttLive: boolean }
  | { type: "partial"; text: string; words?: TranscriptWord[] } // interim transcript (overwrite the live caption)
  | { type: "final"; text: string; words?: TranscriptWord[]; confidence?: number; language?: string } // finalized caller turn (language = detected code when multilingual)
  | { type: "agent"; text: string } // a sentence the agent is about to speak
  | { type: "tts_start" }
  | { type: "tts_stop"; reason?: "barge_in" | "done" }
  | { type: "status"; text: string }
  | { type: "error"; message: string };

/** client -> server */
export type ClientMessage =
  | { type: "start" } // user gesture — begin the session
  | { type: "stop" } // end the session
  | { type: "text"; text: string }; // typed input (test the loop without a mic)

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}
