/**
 * Environment configuration for Raabta Live.
 *
 * Loads `.env` (zero-dep), then resolves the three provider layers:
 *   - AssemblyAI  : realtime speech-to-text (the Path-2 core, required)
 *   - LLM brain   : OpenAI or Gemini (whichever key is present)
 *   - TTS voice   : ElevenLabs or Cartesia (whichever key is present)
 *
 * Nothing here throws on a missing optional key — the server still boots so
 * the UI loads and the startup banner tells you exactly what is wired.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { log } from "./logger.js";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", ".env");

// Node >=20.12 ships process.loadEnvFile; guard for older 20.x.
if (existsSync(envPath)) {
  try {
    (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(envPath);
  } catch (err) {
    log.warn("could not parse .env", { err: String(err) });
  }
}

const env = (k: string): string => (process.env[k] ?? "").trim();

export interface LlmConfig {
  provider: "openai" | "gemini";
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface TtsConfig {
  provider: "elevenlabs" | "cartesia";
  apiKey: string;
  voiceId: string;
  model: string;
}

export interface Config {
  port: number;
  greeting: string;
  assemblyAiKey: string;
  llm: LlmConfig | null;
  tts: TtsConfig | null;
}

function resolveLlm(): LlmConfig | null {
  if (env("OPENAI_API_KEY")) {
    return {
      provider: "openai",
      apiKey: env("OPENAI_API_KEY"),
      model: env("OPENAI_MODEL") || "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
    };
  }
  if (env("GEMINI_API_KEY")) {
    return {
      provider: "gemini",
      apiKey: env("GEMINI_API_KEY"),
      model: env("GEMINI_MODEL") || "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    };
  }
  return null;
}

function resolveTts(): TtsConfig | null {
  if (env("ELEVENLABS_API_KEY")) {
    return {
      provider: "elevenlabs",
      apiKey: env("ELEVENLABS_API_KEY"),
      voiceId: env("ELEVENLABS_VOICE_ID") || "21m00Tcm4TlvDq8ikWAM", // "Rachel", a safe default
      model: env("ELEVENLABS_MODEL") || "eleven_turbo_v2_5",
    };
  }
  if (env("CARTESIA_API_KEY")) {
    return {
      provider: "cartesia",
      apiKey: env("CARTESIA_API_KEY"),
      voiceId: env("CARTESIA_VOICE_ID") || "",
      model: env("CARTESIA_MODEL") || "sonic-2",
    };
  }
  return null;
}

export function loadConfig(): Config {
  const cfg: Config = {
    port: Number(env("PORT")) || 8790,
    greeting: env("AGENT_GREETING"),
    assemblyAiKey: env("ASSEMBLYAI_API_KEY"),
    llm: resolveLlm(),
    tts: resolveTts(),
  };
  return cfg;
}

/** A human-readable summary of what is wired — never prints a key value. */
export function describeConfig(cfg: Config): Record<string, string> {
  return {
    port: String(cfg.port),
    assemblyai: cfg.assemblyAiKey ? "configured" : "MISSING",
    llm: cfg.llm ? `${cfg.llm.provider}:${cfg.llm.model}` : "MISSING",
    tts: cfg.tts ? `${cfg.tts.provider}:${cfg.tts.voiceId || "default"}` : "MISSING",
    greeting: cfg.greeting ? "on" : "off",
  };
}
