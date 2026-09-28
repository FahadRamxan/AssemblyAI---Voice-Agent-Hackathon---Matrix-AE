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
  $("#who").textContent = `${me.user.email}\n${me.tenant.name}`;
  for (const b of document.querySelectorAll("#nav button")) {
    b.onclick = () => {
      activeTab = b.dataset.tab;
      for (const x of document.querySelectorAll("#nav button")) x.classList.toggle("active", x === b);
      renderTab();
    };
  }
  $("#logoutBtn").onclick = async () => {
    await api("POST", "/api/auth/logout");
    me = null;
    showAuth();
  };
  renderTab();
}

function renderTab() {
  const v = $("#view");
  v.innerHTML = `<div class="muted">Loading…</div>`;
  ({ home: tabHome, agents: tabAgents, keys: tabKeys, calls: tabCalls, talk: tabTalk })[activeTab](v);
}

// --------------------------------------------------------------------------
// Overview
// --------------------------------------------------------------------------
async function tabHome(v) {
  const { data: a } = await api("GET", "/api/dashboard/analytics");
  const dur = a.avgDurationMs ? (a.avgDurationMs / 1000).toFixed(1) + "s" : "—";
  const tile = (k, val, accent) => `<div class="tile"><div class="k">${k}</div><div class="v ${accent ? "accent" : ""}">${val}</div></div>`;
  const ls = a.languageSplit || { en: 0, ar: 0, unknown: 0 };
  const lsTotal = Math.max(1, ls.en + ls.ar + ls.unknown);
  v.innerHTML = `
    <h2 class="view-title">Overview</h2>
    <p class="view-sub">Live metrics from calls your agents actually handled.</p>
    <div class="tiles">
      ${tile("Total calls", a.totalCalls)}
      ${tile("Calls · last 7 days", a.callsLast7Days)}
      ${tile("Avg duration", dur)}
      ${tile("Avg turns / call", a.avgTurnsPerCall)}
      ${tile("Barge-in rate", a.bargeInRate, true)}
      ${tile("Reply latency p50", a.latencyMsP50 != null ? a.latencyMsP50 + "ms" : "—")}
      ${tile("Reply latency p95", a.latencyMsP95 != null ? a.latencyMsP95 + "ms" : "—")}
    </div>
    <div class="panel">
      <h3>Calls · last 14 days</h3>
      ${sparkline(a.callsPerDay || [])}
    </div>
    <div class="panel">
      <h3>Language split</h3>
      <div class="bar">
        <span style="width:${(ls.en / lsTotal) * 100}%;background:var(--accent)"></span>
        <span style="width:${(ls.ar / lsTotal) * 100}%;background:var(--accent2)"></span>
        <span style="width:${(ls.unknown / lsTotal) * 100}%;background:rgba(255,255,255,.12)"></span>
      </div>
      <p class="muted mt">English ${ls.en} · Arabic ${ls.ar} · Unknown ${ls.unknown}</p>
    </div>`;
}

function sparkline(days) {
  if (!days.length) return `<p class="muted">No calls yet.</p>`;
  const max = Math.max(1, ...days.map((d) => d.calls));
  const w = 100, h = 60, step = w / Math.max(1, days.length - 1);
  const pts = days.map((d, i) => `${(i * step).toFixed(1)},${(h - (d.calls / max) * (h - 6) - 3).toFixed(1)}`).join(" ");
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline fill="none" stroke="var(--accent)" stroke-width="1.5" points="${pts}" />
  </svg><p class="muted">${days.reduce((s, d) => s + d.calls, 0)} calls across the window · peak ${max}/day</p>`;
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
  v.innerHTML = `
    <h2 class="view-title">Calls</h2>
    <p class="view-sub">Every conversation your agents handled — click one to read the transcript.</p>
    <div class="panel">
      <table><thead><tr><th>Started</th><th>Duration</th><th>Turns</th><th>Barge-ins</th><th>Lang</th><th>Status</th></tr></thead>
      <tbody>${
        calls
          .map(
            (c) => `<tr data-call="${c.id}">
        <td>${new Date(c.started_at).toLocaleString()}</td>
        <td>${c.duration_ms != null ? (c.duration_ms / 1000).toFixed(1) + "s" : "—"}</td>
        <td>${c.turn_count}</td>
        <td>${c.barge_in_count}</td>
        <td>${c.language_primary || "—"}</td>
        <td><span class="pill neutral">${c.status}</span></td>
      </tr>`,
          )
          .join("") || `<tr><td colspan="6" class="muted">No calls yet. Open the “Talk to your agent” tab to make one.</td></tr>`
      }</tbody></table>
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
    v.innerHTML = `<h2 class="view-title">Talk to your agent</h2><p class="view-sub">Create an active embed key first (Embed &amp; keys tab).</p>`;
    return;
  }
  v.innerHTML = `
    <h2 class="view-title">Talk to your agent</h2>
    <p class="view-sub">This is exactly what your visitors get — click Start and talk. Try interrupting it.</p>
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
