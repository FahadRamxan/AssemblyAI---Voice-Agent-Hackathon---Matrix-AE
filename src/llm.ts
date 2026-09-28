/**
 * LLM brain — streams a reply token-by-token from an OpenAI-compatible
 * Chat Completions endpoint. OpenAI and Gemini (via its OpenAI-compat
 * endpoint) share this one code path.
 *
 * Streaming matters for a voice agent: we forward each *sentence* to TTS
 * the moment it completes, so the caller hears the first words while the
 * model is still generating the rest. The AbortSignal lets barge-in kill
 * an in-flight generation instantly.
 */
import type { LlmConfig } from "./config.js";
import { log } from "./logger.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// gpt-5 / gpt-6 / o-series reasoning models use a different request shape.
const isReasoningModel = (model: string): boolean => /^(gpt-5|gpt-6|o1|o3|o4)/.test(model);

/** Stream assistant text deltas. Yields partial strings as they arrive. */
export async function* streamLlm(
  cfg: LlmConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: true,
  };
  if (isReasoningModel(cfg.model)) {
    body.max_completion_tokens = 768;
    body.reasoning_effort = "low";
  } else {
    body.max_tokens = 400;
    body.temperature = 0.5;
  }

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM ${cfg.provider} ${res.status}: ${detail.slice(0, 200)}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length) yield delta;
        } catch {
          // partial JSON across chunk boundaries — ignore, it re-parses next loop
        }
      }
    }
  }
}

/** Convenience: collect a full reply (used by the headless test + greeting). */
export async function completeLlm(
  cfg: LlmConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  let out = "";
  try {
    for await (const delta of streamLlm(cfg, messages, signal)) out += delta;
  } catch (err) {
    log.error("llm completion failed", { err: String(err) });
    throw err;
  }
  return out.trim();
}
