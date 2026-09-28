/**
 * CallRecorder — persists a live call's transcript + metrics to the DB.
 *
 * 100% real analytics: every row here is captured from the SAME loop that
 * already streams partial/final/agent, adding only tiny synchronous inserts.
 * Best-effort by contract: every write is swallowed on error and NONE is awaited
 * by the audio path (better-sqlite3 is synchronous + sub-millisecond), so a DB
 * hiccup can never delay first audio, break barge-in, or drop a call.
 */
import type { Db } from "./db/db.js";
import { scopedRepo } from "./db/repo.js";
import type { CallRecorder } from "./session.js";
import { log } from "./logger.js";

export function createRecorder(db: Db, tenantId: string, callId: string): CallRecorder {
  const repo = scopedRepo(db, tenantId);
  let seq = 0;

  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      log.warn("recorder write failed", { callId, err: String(err) });
    }
  };

  return {
    callerTurn(text, lang) {
      safe(() => {
        repo.addTurn({ callId, seq: seq++, role: "caller", text, lang });
        repo.incTurnCount(callId); // a "turn" = a caller utterance
      });
    },
    agentReply(text, lang, latencyMs) {
      safe(() =>
        repo.addTurn({
          callId,
          seq: seq++,
          role: "agent",
          text,
          lang,
          // 0 = the opening greeting (no caller preceded it) -> null, excluded from latency stats
          latencyMs: latencyMs > 0 ? latencyMs : null,
        }),
      );
    },
    bargeIn() {
      safe(() => repo.incBargeIn(callId));
    },
    finalize(reason, languagePrimary) {
      safe(() => repo.finalizeCall(callId, { endedReason: reason, languagePrimary }));
    },
  };
}
