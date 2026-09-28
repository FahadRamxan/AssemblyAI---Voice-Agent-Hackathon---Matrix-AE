/**
 * The agent — persona, per-call conversation memory, and the sentence
 * assembler that turns streamed LLM deltas into whole sentences for TTS.
 *
 * The persona is deliberately voice-shaped: mirror the caller's language
 * (Gulf Arabic <-> English, code-switch friendly), stay short, never emit
 * markdown, and don't hallucinate.
 */
import type { ChatMessage } from "./llm.js";

export const SYSTEM_PROMPT = [
  "You are Raabta, a warm and efficient voice receptionist for a business.",
  "You are on a LIVE PHONE CALL. Follow these rules exactly:",
  "- Reply in the SAME language the caller uses. If they speak Arabic, reply in natural Gulf Arabic; if English, reply in English. Handle code-switching between the two gracefully.",
  "- Keep every reply to ONE or TWO short sentences. It is spoken aloud, so NEVER use markdown, bullet points, emojis, code, or symbols. Say numbers, dates and times as words.",
  "- Sound human and natural. Do not repeat the greeting on every turn.",
  "- You can answer questions about the business, book an appointment (collect name, day and time and read it back to confirm), or take a message for a callback.",
  "- If a caller interrupts you, stop, listen, and address what they just said without repeating yourself.",
  "- If you do not know something, say a colleague will follow up. Never invent facts, prices, or availability.",
].join("\n");

/** Rolling conversation state for a single call. */
export class Conversation {
  private history: ChatMessage[] = [];

  constructor(systemPrompt: string = SYSTEM_PROMPT) {
    this.history.push({ role: "system", content: systemPrompt });
  }

  addUser(text: string): void {
    this.history.push({ role: "user", content: text });
  }

  addAssistant(text: string): void {
    if (text.trim()) this.history.push({ role: "assistant", content: text.trim() });
  }

  /** Full message list for the next LLM call. */
  messages(): ChatMessage[] {
    return this.history;
  }

  turnCount(): number {
    return this.history.filter((m) => m.role === "user").length;
  }
}

/**
 * Accumulates streamed text and releases complete sentences as soon as they
 * finish, so each can be synthesized while the model keeps generating.
 * Recognises English (. ? !) and Arabic (؟ ،-terminal, .) sentence enders.
 */
export class SentenceAssembler {
  private buf = "";
  private static readonly ENDERS = /[.!?؟\n]+/;

  /** Feed a delta; returns any sentences that just completed. */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let match: RegExpExecArray | null;
    // Release everything up to and including each terminator.
    while ((match = SentenceAssembler.ENDERS.exec(this.buf)) !== null) {
      const end = match.index + match[0].length;
      const sentence = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  /** Return the trailing fragment (call once the stream ends). */
  flush(): string {
    const rest = this.buf.trim();
    this.buf = "";
    return rest;
  }
}

/** Rough language pick for routing a sentence to the right TTS voice/locale. */
export function detectLang(text: string): "en" | "ar" {
  const arabic = (text.match(/[؀-ۿ]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return arabic > latin ? "ar" : "en";
}
