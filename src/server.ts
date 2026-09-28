/**
 * HTTP + WebSocket server.
 *  - GET /health          -> liveness
 *  - GET /api/config      -> safe runtime config for the browser (no keys)
 *  - static               -> serves public/ (the SPA)
 *  - WS  /ws              -> a VoiceSession per connection
 */
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./config.js";
import { describeConfig } from "./config.js";
import { VoiceSession } from "./session.js";
import { MIC_SAMPLE_RATE, TTS_SAMPLE_RATE, type ClientMessage } from "./protocol.js";
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

export function createServer(cfg: Config) {
  const http = createHttp((req, res) => handleHttp(req, res, cfg));

  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachSession(ws, cfg));
  });

  return http;
}

function attachSession(ws: WebSocket, cfg: Config): void {
  const session = new VoiceSession(ws, cfg);
  log.info("call connected");

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

  ws.on("close", () => {
    session.close();
    log.info("call disconnected");
  });
  ws.on("error", (err) => log.warn("ws error", { err: String(err) }));
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, cfg: Config): Promise<void> {
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
