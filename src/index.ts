/**
 * Entry point — load config, start the server, print a banner showing what's
 * wired (never a key), and shut down cleanly.
 */
import { loadConfig, describeConfig } from "./config.js";
import { createServer } from "./server.js";
import { closeDb } from "./db/db.js";
import { log } from "./logger.js";

const cfg = loadConfig();
const server = createServer(cfg);

server.listen(cfg.port, () => {
  log.info("Raabta Live is up", describeConfig(cfg));
  log.info(`open http://localhost:${cfg.port}`);
  if (!cfg.assemblyAiKey) log.warn("ASSEMBLYAI_API_KEY missing — live speech-to-text is off");
  if (!cfg.llm) log.warn("no LLM key — set OPENAI_API_KEY or GEMINI_API_KEY");
  if (!cfg.tts) log.warn("no TTS key — replies will be text-only");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("shutting down");
    server.close(() => {
      closeDb(); // checkpoint the WAL + close cleanly
      process.exit(0);
    });
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 2000).unref();
  });
}
