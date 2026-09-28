/**
 * Owner dashboard REST — the SaaS control plane. EVERY route requires an owner
 * session (requireOwner) and is tenant-scoped via scopedRepo(db, principal.tenantId),
 * so an embed key is never accepted here and one tenant can't touch another's data.
 *
 *   GET   /api/dashboard/agents            list agents
 *   POST  /api/dashboard/agents            create agent
 *   PATCH /api/dashboard/agents/:id        update agent
 *   GET   /api/dashboard/keys              list embed keys
 *   POST  /api/dashboard/keys              mint an embed key for an agent
 *   POST  /api/dashboard/keys/:id/revoke   revoke a key
 *   GET   /api/dashboard/calls             recent calls
 *   GET   /api/dashboard/calls/:id         call detail + transcript
 *   GET   /api/dashboard/analytics         tenant analytics
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db } from "./db/db.js";
import type { Agent, EmbedKey } from "./db/types.js";
import { scopedRepo } from "./db/repo.js";
import { requireOwner } from "./auth.js";
import { computeAnalytics, computeAbStats } from "./analytics.js";
import { liveOps } from "./liveops.js";
import { json, readJson, str, optStr, strArray } from "./http.js";

// "multi" opts the agent into AssemblyAI's multilingual streaming model (live EN/ES/FR/DE/IT/PT).
const LANGS = new Set(["auto", "en", "ar", "multi"]);

export async function handleDashboard(req: IncomingMessage, res: ServerResponse, db: Db): Promise<void> {
  const principal = requireOwner(db, req.headers);
  if (!principal) return json(res, 401, { error: "unauthenticated" });

  const repo = scopedRepo(db, principal.tenantId);
  const url = (req.url ?? "").split("?")[0] ?? "";
  const method = req.method ?? "GET";
  const path = url.replace(/^\/api\/dashboard/, "");

  try {
    // ---- agents ----
    if (path === "/agents" && method === "GET") {
      return json(res, 200, { agents: repo.listAgents().map(publicAgent) });
    }
    if (path === "/agents" && method === "POST") {
      const body = await readJson(req);
      const name = str(body.name).trim();
      const persona = str(body.persona).trim();
      if (!name) return json(res, 400, { error: "name_required" });
      if (!persona) return json(res, 400, { error: "persona_required" });
      const language = str(body.language, "auto");
      if (!LANGS.has(language)) return json(res, 400, { error: "invalid_language" });
      const agent = repo.createAgent({
        name: name.slice(0, 100),
        persona: persona.slice(0, 8000),
        personaB: optStr(body.personaB)?.slice(0, 8000) ?? null,
        abEnabled: Boolean(body.abEnabled),
        greeting: str(body.greeting).slice(0, 500),
        language,
        voiceId: optStr(body.voiceId)?.slice(0, 100) ?? null,
        keyterms: strArray(body.keyterms),
      });
      return json(res, 201, { agent: publicAgent(agent) });
    }
    const agentId = matchId(path, "/agents/");
    if (agentId && method === "PATCH") {
      const body = await readJson(req);
      if (body.language !== undefined && !LANGS.has(str(body.language))) {
        return json(res, 400, { error: "invalid_language" });
      }
      const updated = repo.updateAgent(agentId, {
        name: body.name !== undefined ? str(body.name).slice(0, 100) : undefined,
        persona: body.persona !== undefined ? str(body.persona).slice(0, 8000) : undefined,
        personaB: body.personaB !== undefined ? (optStr(body.personaB)?.slice(0, 8000) ?? null) : undefined,
        abEnabled: body.abEnabled !== undefined ? Boolean(body.abEnabled) : undefined,
        greeting: body.greeting !== undefined ? str(body.greeting).slice(0, 500) : undefined,
        language: body.language !== undefined ? str(body.language) : undefined,
        voiceId: body.voiceId !== undefined ? (optStr(body.voiceId)?.slice(0, 100) ?? null) : undefined,
        keyterms: body.keyterms !== undefined ? strArray(body.keyterms) : undefined,
        isActive: body.isActive !== undefined ? Boolean(body.isActive) : undefined,
      });
      if (!updated) return json(res, 404, { error: "agent_not_found" });
      return json(res, 200, { agent: publicAgent(updated) });
    }
    const abId = matchId(path, "/agents/", "/ab");
    if (abId && method === "GET") {
      if (!repo.getAgent(abId)) return json(res, 404, { error: "agent_not_found" });
      return json(res, 200, { variants: computeAbStats(db, principal.tenantId, abId) });
    }

    // ---- embed keys ----
    if (path === "/keys" && method === "GET") {
      return json(res, 200, { keys: repo.listEmbedKeys().map(publicKey) });
    }
    if (path === "/keys" && method === "POST") {
      const body = await readJson(req);
      const forAgent = str(body.agentId);
      if (!repo.getAgent(forAgent)) return json(res, 400, { error: "agent_not_found" });
      const key = repo.createEmbedKey({
        agentId: forAgent,
        label: str(body.label, "default").slice(0, 60),
        allowedOrigins: strArray(body.allowedOrigins, 50),
      });
      return json(res, 201, { key: publicKey(key) });
    }
    const revokeId = matchId(path, "/keys/", "/revoke");
    if (revokeId && method === "POST") {
      const ok = repo.revokeEmbedKey(revokeId);
      if (!ok) return json(res, 404, { error: "key_not_found" });
      return json(res, 200, { revoked: true });
    }

    // ---- calls ----
    if (path === "/calls" && method === "GET") {
      return json(res, 200, { calls: repo.listCalls(100) });
    }
    const shareId = matchId(path, "/calls/", "/share");
    if (shareId && method === "POST") {
      const token = repo.shareCall(shareId);
      if (!token) return json(res, 404, { error: "call_not_found" });
      return json(res, 200, { token, path: `/r?t=${encodeURIComponent(token)}` });
    }
    const unshareId = matchId(path, "/calls/", "/unshare");
    if (unshareId && method === "POST") {
      if (!repo.getCall(unshareId)) return json(res, 404, { error: "call_not_found" });
      repo.unshareCall(unshareId);
      return json(res, 200, { unshared: true });
    }
    const callId = matchId(path, "/calls/");
    if (callId && method === "GET") {
      const call = repo.getCall(callId);
      if (!call) return json(res, 404, { error: "call_not_found" });
      return json(res, 200, { call, turns: repo.listTurns(callId) });
    }

    // ---- live ops ----
    if (path === "/live" && method === "GET") {
      return json(res, 200, { calls: liveOps.listForTenant(principal.tenantId), now: Date.now() });
    }

    // ---- analytics ----
    if (path === "/analytics" && method === "GET") {
      return json(res, 200, computeAnalytics(db, principal.tenantId));
    }

    return json(res, 404, { error: "not_found" });
  } catch (err) {
    if (err instanceof Error && /json|body too large/i.test(err.message)) {
      return json(res, 400, { error: "invalid_body" });
    }
    throw err;
  }
}

/** Match "/agents/:id" (and optionally a trailing segment like "/revoke"). */
function matchId(path: string, prefix: string, suffix = ""): string | null {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const id = suffix ? (rest.endsWith(suffix) ? rest.slice(0, -suffix.length) : null) : rest;
  if (!id || id.includes("/")) return null;
  return id;
}

function safeArray(jsonStr: string): string[] {
  try {
    const v = JSON.parse(jsonStr);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function publicAgent(a: Agent) {
  return {
    id: a.id,
    name: a.name,
    persona: a.persona,
    personaB: a.persona_b,
    abEnabled: a.ab_enabled === 1,
    greeting: a.greeting,
    language: a.language,
    voiceId: a.voice_id,
    keyterms: safeArray(a.keyterms),
    isActive: a.is_active === 1,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

function publicKey(k: EmbedKey) {
  return {
    id: k.id,
    agentId: k.agent_id,
    publicKey: k.public_key, // publishable — safe to return to the authenticated owner (needed for the snippet)
    label: k.label,
    allowedOrigins: safeArray(k.allowed_origins),
    createdAt: k.created_at,
    revokedAt: k.revoked_at,
    lastUsedAt: k.last_used_at,
    active: k.revoked_at === null,
  };
}
