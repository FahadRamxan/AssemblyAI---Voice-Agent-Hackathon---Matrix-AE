/**
 * Hermetic unit tests for the pure orchestration logic — no network, no keys.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SentenceAssembler, detectLang, Conversation } from "../src/agent.js";
import { interpretSttMessage } from "../src/stt/assemblyai.js";

test("SentenceAssembler releases complete sentences as they finish", () => {
  const a = new SentenceAssembler();
  assert.deepEqual(a.push("Hello there"), []); // no terminator yet
  assert.deepEqual(a.push(". How can I help"), ["Hello there."]);
  assert.deepEqual(a.push(" you today?"), ["How can I help you today?"]);
  assert.equal(a.flush(), "");
});

test("SentenceAssembler flushes a trailing fragment", () => {
  const a = new SentenceAssembler();
  a.push("One. Two");
  assert.equal(a.flush(), "Two");
});

test("SentenceAssembler handles the Arabic question mark", () => {
  const a = new SentenceAssembler();
  const out = a.push("كيف يمكنني مساعدتك؟");
  assert.equal(out.length, 1);
  assert.match(out[0]!, /؟$/);
});

test("detectLang distinguishes Arabic from English", () => {
  assert.equal(detectLang("Book me a flight to Boston"), "en");
  assert.equal(detectLang("مرحبا كيف حالك"), "ar");
});

test("Conversation seeds a system prompt and tracks turns", () => {
  const c = new Conversation("SYS");
  assert.equal(c.messages()[0]!.role, "system");
  c.addUser("hi");
  c.addAssistant("hello");
  assert.equal(c.turnCount(), 1);
  assert.equal(c.messages().at(-1)!.content, "hello");
});

test("interpretSttMessage: Begin -> ready", () => {
  assert.deepEqual(interpretSttMessage(JSON.stringify({ type: "Begin", id: "s1" }), true), {
    kind: "ready",
    id: "s1",
  });
});

test("interpretSttMessage: partial vs formatted final", () => {
  const partial = interpretSttMessage(
    JSON.stringify({ type: "Turn", transcript: "book a", end_of_turn: false }),
    true,
  );
  assert.deepEqual(partial, { kind: "partial", text: "book a" });

  const finalFormatted = interpretSttMessage(
    JSON.stringify({ type: "Turn", transcript: "Book a table.", end_of_turn: true, turn_is_formatted: true }),
    true,
  );
  assert.deepEqual(finalFormatted, { kind: "final", text: "Book a table." });
});

test("interpretSttMessage: the UNFORMATTED final is ignored when formatting is on (no double turn)", () => {
  const unformatted = interpretSttMessage(
    JSON.stringify({ type: "Turn", transcript: "book a table", end_of_turn: true, turn_is_formatted: false }),
    true,
  );
  assert.deepEqual(unformatted, { kind: "ignore" });
});

test("interpretSttMessage: with formatting off, the plain end_of_turn is the final", () => {
  const final = interpretSttMessage(
    JSON.stringify({ type: "Turn", transcript: "book a table", end_of_turn: true, turn_is_formatted: false }),
    false,
  );
  assert.deepEqual(final, { kind: "final", text: "book a table" });
});

test("interpretSttMessage: empty transcript and garbage are ignored", () => {
  assert.deepEqual(interpretSttMessage(JSON.stringify({ type: "Turn", transcript: "  " }), true), {
    kind: "ignore",
  });
  assert.deepEqual(interpretSttMessage("not json", true), { kind: "ignore" });
  assert.deepEqual(interpretSttMessage(JSON.stringify({ type: "Termination" }), true), {
    kind: "termination",
  });
});
