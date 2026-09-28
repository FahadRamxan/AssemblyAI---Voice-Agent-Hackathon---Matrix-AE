/** Tiny shared HTTP helpers used by the server + route modules. */
import type { IncomingMessage, ServerResponse } from "node:http";

export function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0]?.trim() ?? "unknown";
  return req.socket.remoteAddress ?? "unknown";
}

/** Read + parse a JSON body with a size cap (defends against oversized posts). */
export async function readJson(req: IncomingMessage, limitBytes = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

// ---- coercion helpers for untrusted JSON bodies ----
export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function optStr(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}

export function strArray(v: unknown, max = 100): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").slice(0, max);
}
