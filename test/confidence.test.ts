/**
 * Confidence intelligence — the logic that turns AssemblyAI word confidence
 * into "the agent should confirm this". The important behaviour: confirm a
 * mis-heard NUMBER or NAME, but don't nag about a low-confidence filler word.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  utteranceConfidence,
  lowConfidenceWords,
  shouldConfirm,
  confirmationNote,
} from "../src/confidence.ts";

test("utteranceConfidence prefers end_of_turn_confidence, else the word mean", () => {
  assert.equal(utteranceConfidence([{ text: "a", confidence: 0.5 }], 0.82), 0.82);
  assert.equal(utteranceConfidence([{ text: "a", confidence: 0.4 }, { text: "b", confidence: 0.6 }]), 0.5);
  assert.equal(utteranceConfidence([]), 1);
});

test("lowConfidenceWords filters by threshold", () => {
  const w = [{ text: "a", confidence: 0.4 }, { text: "b", confidence: 0.7 }];
  assert.equal(lowConfidenceWords(w).length, 1);
  assert.equal(lowConfidenceWords(w, 0.8).length, 2);
});

test("shouldConfirm fires on an uncertain number or name, not on fillers", () => {
  assert.equal(shouldConfirm([{ text: "is", confidence: 0.9 }, { text: "0412", confidence: 0.4 }]), true);
  assert.equal(shouldConfirm([{ text: "Khalid", confidence: 0.45 }]), true); // name, 4+ letters
  assert.equal(shouldConfirm([{ text: "0412", confidence: 0.95 }]), false); // confident number
  assert.equal(shouldConfirm([{ text: "um", confidence: 0.2 }]), false); // short filler, not critical
});

test("confirmationNote names the uncertain value + its confidence", () => {
  const note = confirmationNote([{ text: "is", confidence: 0.9 }, { text: "0412", confidence: 0.42 }]);
  assert.ok(note && note.includes("0412") && note.includes("42%"));
  assert.equal(confirmationNote([{ text: "hello", confidence: 0.99 }]), null);
});
