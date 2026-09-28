/**
 * HTTP + WebSocket server.
 *  - GET /health          -> liveness
 *  - GET /api/config      -> safe runtime config for the browser (no keys) + the demo embed key
 *  - static               -> serves public/ (the SPA / widget)
 *  - WS  /ws?key=pk_live_ -> a VoiceSession bound to the key's agent+tenant
 *
 * The upgrade handler resolves the embed key SYNCHRONOUSLY and rejects a
 * missing/unknown/revoked key, a disallowed Origin, or an over-cap tenant
 * BEFORE the handshake — so a bad key never opens an AssemblyAI/LLM/TTS socket
 * and never creates a call row.
 */
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, normalize, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./config.js";
import { describeConfig } from "./config.js";
import { VoiceSession, type SessionContext } from "./session.js";
import { MIC_SAMPLE_RATE, TTS_SAMPLE_RATE, type ClientMessage } from "./protocol.js";
import { getDb } from "./db/db.js";
import { scopedRepo } from "./db/repo.js";
import { sha256 } from "./db/ids.js";
import { resolveEmbedKey, originAllowed, touchEmbedKeyUsage } from "./embed.js";
import { createRecorder } from "./recorder.js";
import { ensureDemoKey } from "./seed.js";
import { ConcurrencyTracker, loadLimits } from "./limits.js";
import { log } from "./logger.js";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Per-boot salt so stored ip hashes are privacy-preserving (not reversible to an IP).
const IP_SALT = (process.env.IP_HASH_SALT ?? "").trim() || randomBytes(16).toString("hex");

export function createServer(cfg: Config) {
  const db = getDb();
  const demoKey = ensureDemoKey(db, cfg);
  const limits = loadLimits();
  const concurrency = new ConcurrencyTracker(limits.maxConcurrentPerTenant);

  const http = createHttp((req, res) => handleHttp(req, res, cfg, demoKey));
  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    // 1) Resolve + validate the embed key BEFORE the handshake.
    const key = url.searchParams.get("key") ?? "";
    const resolved = resolveEmbedKey(db, key);
    if (!resolved) return reject(socket, 401, "invalid or revoked embed key");

    // 2) Origin allowlist (browser-only defence; see embed.ts).
    const origin = req.headers.origin;
    if (!originAllowed(resolved.allowedOrigins, origin)) return reject(socket, 403, "origin not allowed");

    // 3) Per-tenant concurrent-call cap.
    if (!concurrency.tryAcquire(resolved.tenantId)) return reject(socket, 429, "too many concurrent calls");

    // 4) Create the call row (stamped with the key-resolved tenant/agent).
    let callId: string;
    try {
      const repo = scopedRepo(db, resolved.tenantId);
      const ipHash = sha256((req.socket.remoteAddress ?? "") + IP_SALT);
      const call = repo.createCall({
        agentId: resolved.agentId,
        embedKeyId: resolved.embedKeyId,
        origin: origin ?? null,
        clientIpHash: ipHash,
      });
      callId = call.id;
      touchEmbedKeyUsage(db, resolved.embedKeyId);
    } catch (err) {
      concurrency.release(resolved.tenantId);
      log.error("failed to open call", { err: String(err) });
      return reject(socket, 500, "could not start call");
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const ctx: SessionContext = {
        resolved,
        platform: cfg,
        callId,
        sessionMaxMs: limits.sessionMaxMs,
        recorder: createRecorder(db, resolved.tenantId, callId),
      };
      attachSession(ws, ctx, () => concurrency.release(resolved.tenantId));
      log.info("call connected", { tenant: resolved.tenantId, agent: resolved.agentId, callId });
    });
  });

  return http;
}

function reject(socket: import("node:stream").Duplex, code: number, msg: string): void {
  const reason =
    { 401: "Unauthorized", 403: "Forbidden", 429: "Too Many Requests", 500: "Internal Server Error" }[code] ??
    "Bad Request";
  socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
  log.debug("ws upgrade rejected", { code, msg });
}

function attachSession(ws: WebSocket, ctx: SessionContext, onClose: () => void): void {
  const session = new VoiceSession(ws, ctx);

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      session.onMicAudio(data as Buffer);
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "start") session.start();
    else if (msg.type === "stop") session.close();
    else if (msg.type === "text") session.onText(msg.text);
  });

  let released = false;
  const cleanup = () => {
    if (released) return;
    released = true;
    session.close();
    onClose();
    log.info("call disconnected", { callId: ctx.callId });
  };
  ws.on("close", cleanup);
  ws.on("error", (err) => {
    log.warn("ws error", { err: String(err) });
    cleanup();
  });
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: Config,
  demoKey: string,
): Promise<void> {
  const url = (req.url ?? "/").split("?")[0] || "/";

  if (url === "/health") {
    return json(res, 200, { status: "ok", ...describeConfig(cfg) });
  }
  if (url === "/api/config") {
    return json(res, 200, {
      sttLive: Boolean(cfg.assemblyAiKey),
      llm: cfg.llm ? cfg.llm.provider : null,
      tts: cfg.tts ? cfg.tts.provider : null,
      micSampleRate: MIC_SAMPLE_RATE,
      ttsSampleRate: TTS_SAMPLE_RATE,
      embedKey: demoKey, // the built-in demo page talks to the demo agent by its publishable key
    });
  }
  await serveStatic(url, res);
}

async function serveStatic(url: string, res: ServerResponse): Promise<void> {
  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  const filePath = normalize(resolve(publicDir, rel));
  // path-traversal guard
  if (!filePath.startsWith(publicDir + sep) && filePath !== publicDir) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
