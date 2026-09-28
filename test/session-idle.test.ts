/**
 * Idle auto-hang-up: after IDLE_TIMEOUT_MS of no caller speech (and the agent
 * not speaking), the session sends {type:"ended",reason:"idle"}, finalizes the
 * call with reason="idle", and closes the socket (4409). Any sign of life resets
 * the clock; a timeout of 0 disables it entirely.
 *
 * Drives the real VoiceSession in text-only mode (no API key -> no STT socket,
 * no LLM -> the turn is a no-op after the reset) with a fake WebSocket + fake
 * recorder and short real timers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceSession, type SessionContext } from "../src/session.ts";
import type { ResolvedAgent } from "../src/embed.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const agent: ResolvedAgent = {
  embedKeyId: "k1",
  tenantId: "t1",
  agentId: "a1",
  name: "Test",
  persona: "You are a test agent.",
  personaB: null,
  abEnabled: false,
  greeting: "", // no greeting -> start() doesn't speak, so we isolate the idle timer
  language: "auto",
  voiceId: null,
  keyterms: [],
  allowedOrigins: ["*"],
};

/** Records everything the session sends + whether/how it was closed. */
class FakeWs {
  readyState = 1; // OPEN
  sent: unknown[] = [];
  closedCode: number | null = null;
  closedReason: string | null = null;
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (opts?.binary) return; // ignore audio frames
    try {
      this.sent.push(JSON.parse(String(data)));
    } catch {
      /* non-JSON */
    }
  }
  close(code?: number, reason?: string): void {
    this.closedCode = code ?? null;
    this.closedReason = reason ?? null;
    this.readyState = 3; // CLOSED
  }
  messages(type: string): unknown[] {
    return this.sent.filter((m) => (m as { type?: string }).type === type);
  }
}

/** Fake recorder — just captures the finalize reason. */
function fakeRecorder() {
  const calls: { finalizeReason: string | null } = { finalizeReason: null };
  return {
    recorder: {
      callerTurn() {},
      agentReply() {},
      bargeIn() {},
      finalize(reason: string) {
        calls.finalizeReason = reason;
      },
    },
    calls,
  };
}

function makeSession(idleTimeoutMs: number) {
  const ws = new FakeWs();
  const { recorder, calls } = fakeRecorder();
  const ctx: SessionContext = {
    resolved: agent,
    platform: { assemblyAiKey: "", llm: null, tts: null }, // text-only: no STT socket, no LLM
    callId: "call-1",
    sessionMaxMs: 60_000, // large, so the wall-clock cap never interferes
    idleTimeoutMs,
    recorder,
  };
  const session = new VoiceSession(ws as never, ctx);
  return { session, ws, calls };
}

test("hangs up after the idle window with no activity", async () => {
  const { session, ws, calls } = makeSession(40);
  session.start();
  await delay(90); // > idle window

  const ended = ws.messages("ended") as { reason: string }[];
  assert.equal(ended.length, 1, "one ended message");
  assert.equal(ended[0].reason, "idle");
  assert.equal(ws.closedCode, 4409, "socket closed with the idle code");
  assert.equal(calls.finalizeReason, "idle", "call finalized with reason=idle (before the socket close)");
});

test("caller activity resets the idle clock", async () => {
  const { session, ws, calls } = makeSession(100);
  session.start();
  await delay(60); // < window
  session.onText("still here"); // activity -> resets (onFinal resets before the no-LLM error)
  await delay(60); // 120ms since start, but only 60ms since activity -> must NOT have fired
  assert.equal(ws.messages("ended").length, 0, "not hung up yet — the clock was reset");
  assert.equal(calls.finalizeReason, null);

  await delay(80); // now 140ms since the last activity — past the reset window
  assert.equal((ws.messages("ended") as { reason: string }[])[0]?.reason, "idle", "fires after the reset window");
});

test("idleTimeoutMs=0 disables auto-hang-up", async () => {
  const { session, ws, calls } = makeSession(0);
  session.start();
  await delay(80);
  assert.equal(ws.messages("ended").length, 0, "never auto-hangs up when disabled");
  assert.equal(calls.finalizeReason, null);
  assert.equal(ws.closedCode, null);
  session.close();
});

test("no further idle fire after the session is closed", async () => {
  const { session, ws } = makeSession(40);
  session.start();
  session.close("client_close"); // client hung up first
  await delay(90);
  assert.equal(ws.messages("ended").length, 0, "a closed session never fires idle");
});
