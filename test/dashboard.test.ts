/**
 * Dashboard HTTP layer — the two security-critical properties: it refuses an
 * unauthenticated request, and an owner sees only their own tenant's data.
 * (Full CRUD is exercised by the live e2e; this pins the gate cheaply.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { openDb } from "../src/db/db.ts";
import { signup, createSession, SESSION_COOKIE } from "../src/auth.ts";
import { handleDashboard } from "../src/dashboard.ts";

function fakeReq(headers: Record<string, string>, method = "GET", url = "/api/dashboard/agents") {
  const r = new EventEmitter() as EventEmitter & Record<string, unknown>;
  r.headers = headers;
  r.method = method;
  r.url = url;
  r.socket = { remoteAddress: "127.0.0.1" };
  return r;
}

function fakeRes() {
  return {
    code: 0,
    body: "",
    headers: {} as Record<string, unknown>,
    writeHead(c: number, h?: Record<string, unknown>) {
      this.code = c;
      if (h) Object.assign(this.headers, h);
      return this;
    },
    end(b?: string) {
      this.body = b ?? "";
    },
    setHeader(k: string, v: unknown) {
      this.headers[k] = v;
    },
    get headersSent() {
      return this.code !== 0;
    },
  };
}

test("dashboard refuses an unauthenticated request", async () => {
  const db = openDb(":memory:");
  const res = fakeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await handleDashboard(fakeReq({}) as any, res as any, db);
  assert.equal(res.code, 401);
  db.close();
});

test("dashboard lists only the owner's own agents", async () => {
  const db = openDb(":memory:");
  const a = signup(db, { email: "a@x.io", password: "supersecret1", workspaceName: "Alpha" });
  signup(db, { email: "b@x.io", password: "supersecret1", workspaceName: "Bravo" });
  const { token } = createSession(db, { userId: a.principal.userId, tenantId: a.principal.tenantId });

  const res = fakeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await handleDashboard(fakeReq({ cookie: `${SESSION_COOKIE}=${token}` }) as any, res as any, db);
  assert.equal(res.code, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.agents.length, 1); // only Alpha's default agent, never Bravo's
  assert.equal(body.agents[0].name, "Alpha Agent");
  db.close();
});
