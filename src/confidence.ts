/**
 * Confidence intelligence — turns AssemblyAI's per-word confidence into agent
 * behaviour. Standard voice agents throw the transcript at an LLM and hope it
 * heard right. We read the word-level `confidence` AssemblyAI returns on every
 * Turn and, when an IMPORTANT word was uncertain (a digit, a name, an email),
 * make the agent read it back to confirm — the difference between "sure I got
 * that" and quietly booking the wrong phone number.
 */
import type { SttWord } from "./stt/assemblyai.js";

/** Below this, a word is treated as "unsure". */
export const LOW_CONFIDENCE = 0.55;

/** Overall confidence for a turn — AssemblyAI's end_of_turn_confidence, else the word mean. */
export function utteranceConfidence(words: SttWord[], endOfTurnConfidence?: number): number {
  if (typeof endOfTurnConfidence === "number") return endOfTurnConfidence;
  if (!words.length) return 1;
  return words.reduce((sum, w) => sum + w.confidence, 0) / words.length;
}

export function lowConfidenceWords(words: SttWord[], threshold = LOW_CONFIDENCE): SttWord[] {
  return words.filter((w) => w.confidence < threshold);
}

const HAS_DIGIT = /\d/;
/** A word worth confirming if misheard: numbers, or names/keywords (4+ letters, Latin or Arabic). */
function isCritical(text: string): boolean {
  if (HAS_DIGIT.test(text)) return true;
  return text.replace(/[^A-Za-z؀-ۿ]/g, "").length >= 4;
}

/** True when an important word came through with low confidence. */
export function shouldConfirm(words: SttWord[], threshold = LOW_CONFIDENCE): boolean {
  return lowConfidenceWords(words, threshold).some((w) => isCritical(w.text));
}

/** A one-line instruction for the LLM to confirm the uncertain value(s) back to the caller. */
export function confirmationNote(words: SttWord[], threshold = LOW_CONFIDENCE): string | null {
  const low = lowConfidenceWords(words, threshold).filter((w) => isCritical(w.text));
  if (!low.length) return null;
  const list = low.map((w) => `"${w.text}" (${Math.round(w.confidence * 100)}%)`).join(", ");
  return `[recognition uncertain] The speech-to-text was not confident about: ${list}. Before acting, briefly read that value back to the caller to confirm you heard it right.`;
}
