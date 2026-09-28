/**
 * TTS voice — turns agent text into raw PCM the browser can play directly.
 *
 * Output is 24 kHz mono s16le (little-endian) PCM. We stream chunks as they
 * arrive so the caller hears the first words fast, and honour an AbortSignal
 * so barge-in can cut the voice off mid-sentence.
 *
 * ElevenLabs streams natively; Cartesia returns the clip in one shot (still
 * quick). Both are exposed through the same async-generator interface.
 */
import type { TtsConfig } from "./config.js";

/** All synthesized audio is emitted at this rate — the browser plays it back at the same. */
export const TTS_SAMPLE_RATE = 24000;

export async function* synthesize(
  cfg: TtsConfig,
  text: string,
  lang: "en" | "ar",
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const clean = text.trim();
  if (!clean) return;
  if (cfg.provider === "elevenlabs") {
    yield* elevenLabsStream(cfg, clean, lang, signal);
  } else {
    yield* cartesiaBytes(cfg, clean, lang, signal);
  }
}

async function* elevenLabsStream(
  cfg: TtsConfig,
  text: string,
  lang: "en" | "ar",
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${cfg.voiceId}/stream` +
    `?output_format=pcm_${TTS_SAMPLE_RATE}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": cfg.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: cfg.model,
      // turbo_v2_5 is multilingual and auto-detects, but sending the hint helps Arabic.
      language_code: lang,
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 200)}`);
  }
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    yield chunk;
  }
}

async function* cartesiaBytes(
  cfg: TtsConfig,
  text: string,
  lang: "en" | "ar",
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const res = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "X-API-Key": cfg.apiKey,
      "Cartesia-Version": "2024-11-13",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model_id: cfg.model,
      transcript: text,
      voice: { mode: "id", id: cfg.voiceId },
      language: lang,
      output_format: {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: TTS_SAMPLE_RATE,
      },
    }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Cartesia ${res.status}: ${detail.slice(0, 200)}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length) yield buf;
}
