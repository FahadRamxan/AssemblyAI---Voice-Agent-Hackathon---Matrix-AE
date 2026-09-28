/**
 * Tiny structured logger — no dependency, JSON-ish single line per event.
 * Keeps the audio path uncluttered while staying grep-friendly.
 */
type Level = "info" | "warn" | "error" | "debug";

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const tail = fields && Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => {
    if (process.env.DEBUG) emit("debug", msg, fields);
  },
};
