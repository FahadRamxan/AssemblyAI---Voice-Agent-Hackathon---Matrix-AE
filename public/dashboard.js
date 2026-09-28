/**
 * Raabta Live — owner dashboard SPA (vanilla, no framework).
 * Talks to /api/auth/* and /api/dashboard/* with the session cookie.
 */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isArabic = (t) => (String(t).match(/[؀-ۿ]/g) || []).length > (String(t).match(/[A-Za-z]/g) || []).length;

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { ok: res.ok, status: res.status, data };
}

// --------------------------------------------------------------------------
// auth
// --------------------------------------------------------------------------
let authMode = "login";

function renderAuthSwitch() {
  $("#authSub").textContent = authMode === "login" ? "Sign in to your workspace." : "Create your workspace — it takes a second.";
  $("#authBtn").textContent = authMode === "login" ? "Sign in" : "Create workspace";
  $("#wsField").classList.toggle("hidden", authMode === "login");
  $("#password").autocomplete = authMode === "login" ? "current-password" : "new-password";
  $("#authSwitch").innerHTML =
    authMode === "login"
      ? `New here? <a id="toSignup">Create a workspace</a>`
      : `Already have one? <a id="toLogin">Sign in</a>`;
  const to = $("#toSignup") || $("#toLogin");
  to.onclick = () => {
    authMode = authMode === "login" ? "signup" : "login";
    $("#authErr").textContent = "";
    renderAuthSwitch();
  };
}

function showAuth() {
  $("#app").classList.add("hidden");
  $("#auth").classList.remove("hidden");
  renderAuthSwitch();
}

$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#authErr").textContent = "";
  const email = $("#email").value.trim();
  const password = $("#password").value;
  const workspaceName = $("#workspace").value.trim();
  const btn = $("#authBtn");
  btn.disabled = true;
  const path = authMode === "login" ? "/api/auth/login" : "/api/auth/signup";
  const body = authMode === "login" ? { email, password } : { email, password, workspaceName };
  const { ok, data } = await api("POST", path, body);
  btn.disabled = false;
  if (!ok) {
    $("#authErr").textContent = errorText(data?.error);
    return;
  }
  await boot();
});

function errorText(code) {
  return (
    {
      invalid_credentials: "Wrong email or password.",
      email_taken: "That email already has a workspace.",
      invalid_email: "Enter a valid email address.",
      weak_password: "Password must be at least 8 characters.",
      invalid_workspace: "Enter your business name.",
      rate_limited: "Too many attempts — try again in a minute.",
    }[code] || "Something went wrong. Try again."
  );
}

// --------------------------------------------------------------------------
// app shell
// --------------------------------------------------------------------------
let me = null;
let activeTab = "home";

function showApp() {
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  const name = me.tenant.name || "Workspace";
  $("#who").innerHTML = `
    <div class="avatar" aria-hidden="true">${esc((name[0] || "R").toUpperCase())}</div>
    <div class="who-meta">
      <div class="who-name">${esc(name)}</div>
      <div class="who-email">${esc(me.user.email)}</div>
    </div>`;
  for (const b of document.querySelectorAll("#nav button")) {
    b.onclick = () => goTab(b.dataset.tab);
  }
  $("#logoutBtn").onclick = async () => {
    await api("POST", "/api/auth/logout");
    me = null;
    showAuth();
  };
  renderTab();
}

function goTab(tab) {
  activeTab = tab;
  for (const x of document.querySelectorAll("#nav button")) x.classList.toggle("active", x.dataset.tab === tab);
  renderTab();
}

function renderTab() {
  const v = $("#view");
  v.innerHTML = `<div class="loading"><span class="spinner"></span> Loading…</div>`;
  v.classList.remove("view-in");
  void v.offsetWidth; // restart the fade-in
  v.classList.add("view-in");
  ({ home: tabHome, agents: tabAgents, keys: tabKeys, calls: tabCalls, talk: tabTalk })[activeTab](v);
}

/** A reusable empty-state block (icon + message + optional CTA). */
function emptyState(icon, title, sub, ctaLabel, ctaTab) {
  const cta = ctaLabel ? `<button class="btn sm" data-empty-cta="${ctaTab}">${esc(ctaLabel)}</button>` : "";
  return `<div class="empty"><div class="empty-ic">${icon}</div><div class="empty-title">${esc(title)}</div><p class="empty-sub">${esc(sub)}</p>${cta}</div>`;
}
function wireEmptyCtas(root) {
  for (const b of root.querySelectorAll("[data-empty-cta]")) b.onclick = () => goTab(b.dataset.emptyCta);
}

// --------------------------------------------------------------------------
// Overview
// --------------------------------------------------------------------------
const ICONS = {
  calls: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>`,
  week: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  turns: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  bolt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>`,
  gauge: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14a2 2 0 1 0 2-2"/><path d="M3.3 18a10 10 0 1 1 17.4 0"/><path d="M14 12l3-3"/></svg>`,
};

function kpiTile(k, val, icon, opts = {}) {
  return `<div class="tile ${opts.accent ? "accent" : ""}">
    <div class="tile-top"><span class="tile-ic">${icon}</span><span class="k">${k}</span></div>
    <div class="v">${val}</div>
    ${opts.hint ? `<div class="tile-hint">${esc(opts.hint)}</div>` : ""}
  </div>`;
}

async function tabHome(v) {
  const [{ data: a }, { data: ad }, { data: kd }] = await Promise.all([
    api("GET", "/api/dashboard/analytics"),
    api("GET", "/api/dashboard/agents"),
    api("GET", "/api/dashboard/keys"),
  ]);
  const agents = ad?.agents || [];
  const keys = kd?.keys || [];
  const hasKey = keys.some((k) => k.active);
  const dur = a.avgDurationMs ? (a.avgDurationMs / 1000).toFixed(1) + "s" : "—";
  const ls = a.languageSplit || { en: 0, ar: 0, unknown: 0 };
  const lsTotal = Math.max(1, ls.en + ls.ar + ls.unknown);

  const steps = [
    { done: agents.length > 0, label: "Create your first agent", tab: "agents" },
    { done: hasKey, label: "Get your embed key + snippet", tab: "keys" },
    { done: (a.totalCalls || 0) > 0, label: "Make your first call", tab: "talk" },
  ];
  const remaining = steps.filter((s) => !s.done).length;
  const checklist = remaining
    ? `<div class="panel setup">
        <div class="panel-head"><h3>🚀 Get started</h3><span class="setup-count">${steps.length - remaining}/${steps.length} complete</span></div>
        <div class="steps">${steps
          .map(
            (s) => `<div class="step ${s.done ? "done" : ""}">
              <span class="tick">${s.done ? "✓" : ""}</span>
              <span class="step-label">${esc(s.label)}</span>
              ${s.done ? `<span class="step-status">Done</span>` : `<button class="btn sm ghost" data-empty-cta="${s.tab}">Go →</button>`}
            </div>`,
          )
          .join("")}</div>
      </div>`
    : "";

  v.innerHTML = `
    <div class="view-head">
      <div><h2 class="view-title">Overview</h2><p class="view-sub">Live metrics from calls your agents actually handled — nothing seeded.</p></div>
      <button class="btn" data-empty-cta="talk">Talk to your agent</button>
    </div>
    ${checklist}
    <div class="tiles">
      ${kpiTile("Total calls", a.totalCalls || 0, ICONS.calls)}
      ${kpiTile("Calls · last 7 days", a.callsLast7Days || 0, ICONS.week)}
      ${kpiTile("Avg duration", dur, ICONS.clock)}
      ${kpiTile("Avg turns / call", a.avgTurnsPerCall || 0, ICONS.turns)}
      ${kpiTile("Barge-in rate", a.bargeInRate || 0, ICONS.bolt, { accent: true, hint: "callers who interrupted" })}
      ${kpiTile("Reply latency p50", a.latencyMsP50 != null ? a.latencyMsP50 + "ms" : "—", ICONS.gauge, { hint: a.latencyMsP95 != null ? "p95 " + a.latencyMsP95 + "ms" : "" })}
    </div>
    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h3>Calls · last 14 days</h3></div>
        ${areaChart(a.callsPerDay || [])}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Language split</h3></div>
        <div class="bar">
          <span style="width:${(ls.en / lsTotal) * 100}%;background:var(--accent)"></span>
          <span style="width:${(ls.ar / lsTotal) * 100}%;background:var(--accent2)"></span>
          <span style="width:${(ls.unknown / lsTotal) * 100}%;background:rgba(255,255,255,.12)"></span>
        </div>
        <div class="legend">
          <span class="lg"><i style="background:var(--accent)"></i>English ${ls.en}</span>
          <span class="lg"><i style="background:var(--accent2)"></i>Arabic ${ls.ar}</span>
          <span class="lg"><i style="background:rgba(255,255,255,.18)"></i>Other ${ls.unknown}</span>
        </div>
      </div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h3>Languages detected</h3><span class="tag">AssemblyAI live</span></div>
        ${detectedLanguagesHtml(a.detectedLanguages || [])}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Usage this month</h3></div>
        ${usageHtml(a.usage)}
      </div>
    </div>`;
  wireEmptyCtas(v);
}

const LANG_NAMES = { en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", ar: "Arabic" };
const langName = (c) => LANG_NAMES[c] || String(c || "").toUpperCase();

function detectedLanguagesHtml(list) {
  if (!list.length)
    return `<p class="muted">No language detection yet. Set an agent to <b>Multilingual</b> and callers' languages (EN/ES/FR/DE/IT/PT) will break down here.</p>`;
  const total = Math.max(1, list.reduce((s, d) => s + d.calls, 0));
  const palette = ["var(--accent)", "var(--accent2)", "#f59e0b", "#ec4899", "#38bdf8", "#a3e635", "#f87171"];
  return `<div class="langrows">${list
    .map((d, i) => {
      const pct = Math.round((d.calls / total) * 100);
      const col = palette[i % palette.length];
      return `<div class="langrow">
        <div class="langrow-top"><span class="langrow-name"><i style="background:${col}"></i>${esc(langName(d.code))}</span><span class="muted">${pct}% · ${d.calls}</span></div>
        <div class="bar"><span style="width:${pct}%;background:${col}"></span></div>
      </div>`;
    })
    .join("")}</div>`;
}

function usageHtml(u) {
  if (!u) return `<p class="muted">No usage yet.</p>`;
  return `<div class="usage">
    <div class="usage-main"><span class="usage-v">${u.streamingMinutesMonth}</span><span class="usage-u">min streamed</span></div>
    <div class="usage-cost">≈ <b>$${u.estCostMonthUsd.toFixed(2)}</b> est. AssemblyAI streaming this month</div>
    <div class="usage-foot muted">${u.streamingMinutesTotal} min all-time · rate $${u.usdPerMin.toFixed(4)}/min (est.)</div>
  </div>`;
}

function areaChart(days) {
  if (!days.length) return `<p class="muted">No calls yet — your first call will show up here.</p>`;
  const max = Math.max(1, ...days.map((d) => d.calls));
  const w = 300, h = 80, pad = 3;
  const step = w / Math.max(1, days.length - 1);
  const y = (c) => (h - pad - (c / max) * (h - pad * 2)).toFixed(1);
  const pts = days.map((d, i) => `${(i * step).toFixed(1)},${y(d.calls)}`);
  const line = pts.join(" ");
  const area = `0,${h} ${line} ${w},${h}`;
  const last = days[days.length - 1];
  const lx = ((days.length - 1) * step).toFixed(1);
  const total = days.reduce((s, d) => s + d.calls, 0);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="areaFill" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient></defs>
      <polygon fill="url(#areaFill)" points="${area}"/>
      <polyline fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" points="${line}"/>
      <circle cx="${lx}" cy="${y(last.calls)}" r="3" fill="var(--accent)"/>
    </svg>
    <p class="muted chart-cap">${total} call${total === 1 ? "" : "s"} across the window · peak ${max}/day</p>`;
}

// --------------------------------------------------------------------------
// Agents
// --------------------------------------------------------------------------
async function tabAgents(v) {
  const { data } = await api("GET", "/api/dashboard/agents");
  const agents = data.agents || [];
  v.innerHTML = `
    <h2 class="view-title">Agents</h2>
    <p class="view-sub">Each agent has its own persona, greeting, voice and keyterms.</p>
    <div class="row" style="margin-bottom:16px"><button class="btn" id="newAgent">+ New agent</button></div>
    <div id="agentList"></div>`;
  $("#newAgent").onclick = () => renderAgentCard($("#agentList"), null, true);
  const list = $("#agentList");
  list.innerHTML = "";
  for (const ag of agents) renderAgentCard(list, ag, false);
  if (!agents.length) list.innerHTML = `<p class="muted">No agents yet — create one.</p>`;
}

function renderAgentCard(list, ag, isNew) {
  const c = document.createElement("div");
  c.className = "panel";
  const lang = ag?.language || "auto";
  c.innerHTML = `
    <div class="row">
      <div class="grow"><label>Name</label><input class="f-name" value="${esc(ag?.name || "")}" placeholder="Front desk" /></div>
      <div><label>Language</label><select class="f-lang">
        ${[
          ["auto", "auto (English STT)"],
          ["en", "English"],
          ["ar", "Arabic (brain + voice)"],
          ["multi", "Multilingual live (EN/ES/FR/DE/IT/PT)"],
        ]
          .map(([v, t]) => `<option value="${v}" ${v === lang ? "selected" : ""}>${t}</option>`)
          .join("")}
      </select></div>
      <div><label>Active</label><select class="f-active">
        <option value="1" ${ag?.isActive !== false ? "selected" : ""}>yes</option>
        <option value="0" ${ag?.isActive === false ? "selected" : ""}>no</option>
      </select></div>
    </div>
    <label>Greeting (spoken first)</label><input class="f-greet" value="${esc(ag?.greeting || "")}" placeholder="Thanks for calling! How can I help?" />
    <label>Keyterms (comma separated — boosts recognition of names/brands)</label>
    <input class="f-keyterms" value="${esc((ag?.keyterms || []).join(", "))}" placeholder="Acme, Dr. Khalid" />
    <label>Voice ID (optional — overrides the platform default)</label>
    <input class="f-voice" value="${esc(ag?.voiceId || "")}" placeholder="(default)" />
    <label>Persona / system prompt</label>
    <textarea class="f-persona" placeholder="You are a warm receptionist for…">${esc(ag?.persona || "")}</textarea>
    <div class="row mt"><button class="btn sm f-save">${isNew ? "Create agent" : "Save changes"}</button></div>`;
  if (isNew) list.prepend(c);
  else list.appendChild(c);

  $(".f-save", c).onclick = async () => {
    const payload = {
      name: $(".f-name", c).value.trim(),
      greeting: $(".f-greet", c).value,
      language: $(".f-lang", c).value,
      voiceId: $(".f-voice", c).value.trim() || null,
      keyterms: $(".f-keyterms", c).value.split(",").map((s) => s.trim()).filter(Boolean),
      persona: $(".f-persona", c).value,
      isActive: $(".f-active", c).value === "1",
    };
    if (isNew) {
      const { ok, data } = await api("POST", "/api/dashboard/agents", payload);
      if (!ok) return toast(errorText(data?.error));
      toast("Agent created");
      renderTab();
    } else {
      const { ok, data } = await api("PATCH", `/api/dashboard/agents/${ag.id}`, payload);
      if (!ok) return toast(errorText(data?.error));
      toast("Saved");
    }
  };
}

// --------------------------------------------------------------------------
// Embed & keys
// --------------------------------------------------------------------------
async function tabKeys(v) {
  const [{ data: kd }, { data: ad }] = [await api("GET", "/api/dashboard/keys"), await api("GET", "/api/dashboard/agents")];
  const keys = kd.keys || [];
  const agents = ad.agents || [];
  const agentName = (id) => agents.find((a) => a.id === id)?.name || "—";
  const active = keys.filter((k) => k.active);
  const snippetKey = active[0];
  v.innerHTML = `
    <h2 class="view-title">Embed &amp; keys</h2>
    <p class="view-sub">Drop your agent on any website with one line. Publishable keys are safe in the browser.</p>
    ${
      snippetKey
        ? `<div class="panel"><h3>Your embed snippet</h3>
            <div class="snippet" id="snippet">&lt;script src="${esc(location.origin)}/embed.js" data-agent-key="${esc(snippetKey.publicKey)}" async&gt;&lt;/script&gt;</div>
            <div class="row mt">
              <button class="btn sm" id="copySnippet">Copy snippet</button>
              <a class="btn sm ghost" href="/embed-demo.html?key=${encodeURIComponent(snippetKey.publicKey)}" target="_blank">Preview on a demo site ↗</a>
            </div></div>`
        : `<div class="panel"><p class="muted">No active key yet — create one below to get your embed snippet.</p></div>`
    }
    <div class="panel">
      <h3>Create a key</h3>
      <div class="row">
        <div><label>Agent</label><select id="keyAgent">${agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></div>
        <div class="grow"><label>Label</label><input id="keyLabel" placeholder="Website" /></div>
        <div style="align-self:flex-end"><button class="btn sm" id="createKey">Create key</button></div>
      </div>
    </div>
    <div class="panel">
      <h3>Keys</h3>
      <table><thead><tr><th>Label</th><th>Agent</th><th>Key</th><th>Status</th><th>Last used</th><th></th></tr></thead>
      <tbody>${
        keys
          .map(
            (k) => `<tr>
        <td>${esc(k.label)}</td>
        <td>${esc(agentName(k.agentId))}</td>
        <td><code class="key">${esc(k.publicKey)}</code></td>
        <td><span class="pill ${k.active ? "ok" : "off"}">${k.active ? "active" : "revoked"}</span></td>
        <td class="muted">${k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}</td>
        <td>${k.active ? `<button class="btn sm danger" data-revoke="${k.id}">Revoke</button>` : ""}</td>
      </tr>`,
          )
          .join("") || `<tr><td colspan="6" class="muted">No keys yet.</td></tr>`
      }</tbody></table>
    </div>`;

  if (snippetKey) {
    $("#copySnippet").onclick = () => {
      navigator.clipboard?.writeText($("#snippet").textContent).then(() => toast("Snippet copied"));
    };
  }
  $("#createKey").onclick = async () => {
    const agentId = $("#keyAgent").value;
    const label = $("#keyLabel").value.trim() || "default";
    if (!agentId) return toast("Create an agent first");
    const { ok, data } = await api("POST", "/api/dashboard/keys", { agentId, label });
    if (!ok) return toast(errorText(data?.error));
    toast("Key created");
    renderTab();
  };
  for (const b of v.querySelectorAll("[data-revoke]")) {
    b.onclick = async () => {
      const { ok } = await api("POST", `/api/dashboard/keys/${b.dataset.revoke}/revoke`);
      if (ok) {
        toast("Key revoked");
        renderTab();
      }
    };
  }
}

// --------------------------------------------------------------------------
// Calls
// --------------------------------------------------------------------------
async function tabCalls(v) {
  const { data } = await api("GET", "/api/dashboard/calls");
  const calls = data.calls || [];
  if (!calls.length) {
    v.innerHTML = `
      <h2 class="view-title">Calls</h2>
      <p class="view-sub">Every conversation your agents handled — click one to read the transcript.</p>
      ${emptyState(ICONS.calls, "No calls yet", "Open the “Talk to your agent” tab and say hello — your call will appear here with its full transcript.", "Talk to your agent", "talk")}`;
    wireEmptyCtas(v);
    return;
  }
  v.innerHTML = `
    <h2 class="view-title">Calls</h2>
    <p class="view-sub">Every conversation your agents handled — click one to read the transcript.</p>
    <div class="panel table-panel">
      <table><thead><tr><th>Started</th><th>Duration</th><th>Turns</th><th>Barge-ins</th><th>Lang</th><th>Status</th></tr></thead>
      <tbody>${calls
        .map(
          (c) => `<tr data-call="${c.id}">
        <td>${new Date(c.started_at).toLocaleString()}</td>
        <td>${c.duration_ms != null ? (c.duration_ms / 1000).toFixed(1) + "s" : "—"}</td>
        <td>${c.turn_count}</td>
        <td>${c.barge_in_count > 0 ? `<span class="pill accent">${c.barge_in_count}</span>` : "0"}</td>
        <td><span class="tag">${esc(c.language_primary || "—")}</span></td>
        <td><span class="pill neutral">${esc(c.status)}</span></td>
      </tr>`,
        )
        .join("")}</tbody></table>
    </div>
    <div id="callDetail"></div>`;
  for (const tr of v.querySelectorAll("[data-call]")) {
    tr.onclick = async () => {
      const { data } = await api("GET", `/api/dashboard/calls/${tr.dataset.call}`);
      const turns = data.turns || [];
      $("#callDetail").innerHTML = `<div class="panel"><h3>Transcript</h3>${
        turns
          .map(
            (t) =>
              `<div class="bubble ${t.role === "caller" ? "caller" : "agent"} ${isArabic(t.text) ? "rtl" : ""}">
                <div class="r">${t.role === "caller" ? "Caller" : "Agent"}${t.latency_ms ? " · " + t.latency_ms + "ms" : ""}</div>${esc(t.text)}</div>`,
          )
          .join("") || `<p class="muted">No transcript turns recorded.</p>`
      }</div>`;
      $("#callDetail").scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
  }
}

// --------------------------------------------------------------------------
// Talk to your agent
// --------------------------------------------------------------------------
async function tabTalk(v) {
  const { data } = await api("GET", "/api/dashboard/keys");
  const key = (data.keys || []).find((k) => k.active);
  if (!key) {
    v.innerHTML = `<h2 class="view-title">Talk to your agent</h2>
      <p class="view-sub">This is exactly what your visitors get — click Start and talk.</p>
      ${emptyState(ICONS.calls, "No active key yet", "Create an embed key so the widget can start a voice session for your agent.", "Go to Embed & keys", "keys")}`;
    wireEmptyCtas(v);
    return;
  }
  v.innerHTML = `
    <h2 class="view-title">Talk to your agent</h2>
    <p class="view-sub">This is exactly what your visitors get — click Start and talk. Try interrupting it mid-sentence, or switch to Spanish/French.</p>
    <iframe class="talk" allow="microphone" src="/widget?key=${encodeURIComponent(key.publicKey)}"></iframe>`;
}

// --------------------------------------------------------------------------
// boot
// --------------------------------------------------------------------------
async function boot() {
  const { ok, data } = await api("GET", "/api/auth/me");
  if (ok && data) {
    me = data;
    showApp();
  } else {
    showAuth();
  }
}
boot();
