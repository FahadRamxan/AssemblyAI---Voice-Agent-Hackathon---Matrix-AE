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
  window.RM?.pop(t);
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
  $("#logoutBtn").onclick = doLogout;
  $("#themeBtn").onclick = toggleTheme;
  $("#paletteBtn").onclick = openPalette;
  $("#collapseBtn").onclick = toggleSidebar;
  applyNavTitles();
  syncThemeIcon();
  if (liveBadgeTimer) clearInterval(liveBadgeTimer);
  startLiveBadgePoll();
  renderTab();
}

// Collapsible sidebar (icon rail) — persisted, spring-animated via CSS.
function toggleSidebar() {
  const collapsed = document.documentElement.classList.toggle("side-collapsed");
  try {
    localStorage.setItem("raabta_sidebar", collapsed ? "collapsed" : "expanded");
  } catch {
    /* ignore */
  }
  const b = $("#collapseBtn");
  if (b) {
    b.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    b.setAttribute("aria-label", b.title);
  }
}
// Native tooltips so the collapsed icon rail stays identifiable.
function applyNavTitles() {
  for (const b of document.querySelectorAll("#nav button")) {
    const label = b.querySelector("span:not(.live-badge)")?.textContent?.trim();
    if (label) b.title = label;
  }
}

async function doLogout() {
  stopLivePoll();
  if (liveBadgeTimer) {
    clearInterval(liveBadgeTimer);
    liveBadgeTimer = null;
  }
  await api("POST", "/api/auth/logout");
  me = null;
  showAuth();
}

// --------------------------------------------------------------------------
// theme
// --------------------------------------------------------------------------
function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light"; // light is the default
}
function syncThemeIcon() {
  const b = $("#themeBtn");
  if (b) b.textContent = currentTheme() === "light" ? "🌙" : "☀️";
}
function toggleTheme() {
  const next = currentTheme() === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("raabta_theme", next);
  } catch {
    /* ignore */
  }
  syncThemeIcon();
}

// --------------------------------------------------------------------------
// command palette (⌘K / Ctrl+K)
// --------------------------------------------------------------------------
function paletteCommands() {
  return [
    { label: "Go to Overview", hint: "Dashboard", run: () => goTab("home") },
    { label: "Go to Agents", hint: "Configure", run: () => goTab("agents") },
    { label: "Go to Embed & keys", hint: "Snippet", run: () => goTab("keys") },
    { label: "Go to Calls", hint: "Transcripts", run: () => goTab("calls") },
    { label: "Talk to your agent", hint: "Live test", run: () => goTab("talk") },
    { label: "New agent", hint: "Create", run: () => { goTab("agents"); setTimeout(() => $("#newAgent")?.click(), 80); } },
    { label: `Switch to ${currentTheme() === "light" ? "dark" : "light"} theme`, hint: "Appearance", run: toggleTheme },
    { label: "Log out", hint: "Session", run: doLogout },
  ];
}
let paletteIdx = 0;
let paletteFiltered = [];
function openPalette() {
  const p = $("#palette");
  if (!p) return;
  p.classList.remove("hidden");
  const input = $("#paletteInput");
  input.value = "";
  renderPalette("");
  input.focus();
}
function closePalette() {
  $("#palette")?.classList.add("hidden");
}
function renderPalette(q) {
  const query = q.trim().toLowerCase();
  paletteFiltered = paletteCommands().filter((c) => !query || c.label.toLowerCase().includes(query) || c.hint.toLowerCase().includes(query));
  paletteIdx = 0;
  const list = $("#paletteList");
  list.innerHTML =
    paletteFiltered
      .map(
        (c, i) => `<div class="palette-item ${i === 0 ? "sel" : ""}" data-i="${i}">
          <span>${esc(c.label)}</span><span class="palette-hint">${esc(c.hint)}</span></div>`,
      )
      .join("") || `<div class="palette-empty">No matching action</div>`;
  for (const el of list.querySelectorAll(".palette-item")) {
    el.onmouseenter = () => setPaletteSel(Number(el.dataset.i));
    el.onclick = () => runPalette(Number(el.dataset.i));
  }
}
function setPaletteSel(i) {
  paletteIdx = i;
  for (const el of $("#paletteList").querySelectorAll(".palette-item"))
    el.classList.toggle("sel", Number(el.dataset.i) === i);
}
function runPalette(i) {
  const cmd = paletteFiltered[i];
  closePalette();
  if (cmd) cmd.run();
}
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (!me) return; // only in the app
    const open = !$("#palette")?.classList.contains("hidden");
    open ? closePalette() : openPalette();
    return;
  }
  if ($("#palette")?.classList.contains("hidden")) return;
  if (e.key === "Escape") closePalette();
  else if (e.key === "ArrowDown") { e.preventDefault(); setPaletteSel(Math.min(paletteFiltered.length - 1, paletteIdx + 1)); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setPaletteSel(Math.max(0, paletteIdx - 1)); }
  else if (e.key === "Enter") { e.preventDefault(); runPalette(paletteIdx); }
});
document.addEventListener("input", (e) => {
  if (e.target && e.target.id === "paletteInput") renderPalette(e.target.value);
});
document.addEventListener("click", (e) => {
  if (e.target && e.target.id === "palette") closePalette(); // click backdrop
});

function goTab(tab) {
  activeTab = tab;
  for (const x of document.querySelectorAll("#nav button")) x.classList.toggle("active", x.dataset.tab === tab);
  renderTab();
}

let livePollTimer = null;
function stopLivePoll() {
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
}

function renderTab() {
  stopLivePoll(); // leaving any tab stops the live poller
  const v = $("#view");
  v.innerHTML = `<div class="loading"><span class="spinner"></span> Loading…</div>`;
  v.classList.remove("view-in");
  void v.offsetWidth; // restart the fade-in
  v.classList.add("view-in");
  ({ home: tabHome, live: tabLive, agents: tabAgents, keys: tabKeys, calls: tabCalls, talk: tabTalk })[activeTab](v);
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
  // When a numeric `count` is given, the value animates 0→count on reveal (motion.js).
  const vAttrs =
    opts.count != null && isFinite(opts.count)
      ? ` data-count="${opts.count}" data-suffix="${esc(opts.suffix || "")}" data-decimals="${opts.decimals || 0}"`
      : "";
  return `<div class="tile ${opts.accent ? "accent" : ""}">
    <div class="tile-top"><span class="tile-ic">${icon}</span><span class="k">${k}</span></div>
    <div class="v"${vAttrs}>${val}</div>
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
      ${kpiTile("Total calls", a.totalCalls || 0, ICONS.calls, { count: a.totalCalls || 0 })}
      ${kpiTile("Calls · last 7 days", a.callsLast7Days || 0, ICONS.week, { count: a.callsLast7Days || 0 })}
      ${kpiTile("Avg duration", dur, ICONS.clock)}
      ${kpiTile("Avg turns / call", a.avgTurnsPerCall || 0, ICONS.turns)}
      ${kpiTile("Barge-in rate", a.bargeInRate || 0, ICONS.bolt, { accent: true, hint: "callers who interrupted" })}
      ${kpiTile("Reply latency p50", a.latencyMsP50 != null ? a.latencyMsP50 + "ms" : "—", ICONS.gauge, { count: a.latencyMsP50 != null ? a.latencyMsP50 : null, suffix: "ms", hint: a.latencyMsP95 != null ? "p95 " + a.latencyMsP95 + "ms" : "" })}
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
  window.RM?.reveal(v);
  window.RM?.countUpAll(v);
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

// --------------------------------------------------------------------------
// Live ops
// --------------------------------------------------------------------------
let liveSig = "";
async function tabLive(v) {
  v.innerHTML = `
    <div class="view-head">
      <div><h2 class="view-title">Live ops</h2><p class="view-sub">Calls happening right now — running transcript + latency, refreshing every 2s.</p></div>
      <span class="live-pill"><span class="live-dot"></span> live</span>
    </div>
    <div id="liveGrid"></div>`;
  window.RM?.enter($(".view-head", v), { y: 8 });
  liveSig = "";
  let firstPaint = true;
  const paint = async () => {
    const { data } = await api("GET", "/api/dashboard/live");
    const grid = $("#liveGrid");
    if (!grid) return; // tab switched away
    const calls = data?.calls || [];
    const nowT = data?.now || Date.now();
    const sig = JSON.stringify(calls.map((c) => [c.callId, c.turnCount, c.bargeInCount, c.lastAgent, c.lastCaller]));
    if (sig === liveSig && calls.length) return; // no change → no flicker (timers still tick on change)
    const newIds = calls.map((c) => c.callId).join(",");
    const hadIds = liveSig ? JSON.parse(liveSig).map((x) => x[0]).join(",") : "";
    liveSig = sig;
    if (!calls.length) {
      grid.innerHTML = emptyState(
        ICONS.calls,
        "No active calls",
        "When someone is talking to your agent, the live conversation shows up here. Open “Talk to your agent” in another tab to try it.",
        "Talk to your agent",
        "talk",
      );
      wireEmptyCtas(grid);
      if (firstPaint) window.RM?.reveal(grid);
      firstPaint = false;
      return;
    }
    grid.innerHTML = `<div class="live-grid">${calls.map((c) => liveCard(c, nowT)).join("")}</div>`;
    // Animate cards in only when the SET of calls changes (not on every transcript tick).
    if (firstPaint || newIds !== hadIds) window.RM?.stagger(grid.querySelectorAll(".live-card"), { y: 10, step: 60 });
    firstPaint = false;
  };
  await paint();
  livePollTimer = setInterval(paint, 2000);
}

function liveCard(c, nowT) {
  const elapsed = Math.max(0, Math.round((nowT - c.startedAt) / 1000));
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  return `<div class="live-card">
    <div class="live-card-head"><span class="live-dot"></span><b>${esc(c.agentName)}</b><span class="muted live-elapsed">${mmss}</span></div>
    <div class="live-stats">
      <span>${c.turnCount} turn${c.turnCount === 1 ? "" : "s"}</span>
      ${c.bargeInCount ? `<span class="pill accent">${c.bargeInCount} barge-in</span>` : ""}
      ${c.lastLatencyMs ? `<span class="live-lat">⚡ ${c.lastLatencyMs}ms</span>` : ""}
    </div>
    <div class="live-lines">
      ${c.lastCaller ? `<div class="live-line caller"><span>Caller</span>${esc(c.lastCaller)}</div>` : ""}
      ${c.lastAgent ? `<div class="live-line agent"><span>Agent</span>${esc(c.lastAgent)}</div>` : ""}
      ${!c.lastCaller && !c.lastAgent ? `<div class="muted">Connecting…</div>` : ""}
    </div>
  </div>`;
}

// A lightweight always-on poll that shows the active-call count on the Live nav item.
let liveBadgeTimer = null;
function startLiveBadgePoll() {
  const tick = async () => {
    const { ok, data } = await api("GET", "/api/dashboard/live");
    const badge = $("#liveBadge");
    if (!badge) return;
    const n = ok && data?.calls ? data.calls.length : 0;
    const wasHidden = badge.hidden;
    badge.hidden = n === 0;
    badge.textContent = String(n);
    if (wasHidden && n > 0) window.RM?.pop(badge); // spring in when a call goes live
  };
  void tick();
  liveBadgeTimer = setInterval(tick, 6000);
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
  window.RM?.reveal(v);
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
    <label class="ab-toggle"><input type="checkbox" class="f-ab" ${ag?.abEnabled ? "checked" : ""} /> <span>A/B test a second persona</span></label>
    <div class="f-ab-wrap ${ag?.abEnabled ? "" : "hidden"}">
      <label>Persona B — the variant to split-test (traffic is split ~50/50)</label>
      <textarea class="f-persona-b" placeholder="An alternative persona to compare…">${esc(ag?.personaB || "")}</textarea>
      <div class="ab-stats"></div>
    </div>
    <div class="row mt"><button class="btn sm f-save">${isNew ? "Create agent" : "Save changes"}</button></div>`;
  if (isNew) list.prepend(c);
  else list.appendChild(c);

  const abBox = $(".f-ab-wrap", c);
  $(".f-ab", c).onchange = (e) => abBox.classList.toggle("hidden", !e.target.checked);
  if (!isNew && ag?.abEnabled) void loadAbStats(ag.id, $(".ab-stats", c));

  $(".f-save", c).onclick = async () => {
    const payload = {
      name: $(".f-name", c).value.trim(),
      greeting: $(".f-greet", c).value,
      language: $(".f-lang", c).value,
      voiceId: $(".f-voice", c).value.trim() || null,
      keyterms: $(".f-keyterms", c).value.split(",").map((s) => s.trim()).filter(Boolean),
      persona: $(".f-persona", c).value,
      personaB: $(".f-persona-b", c).value.trim() || null,
      abEnabled: $(".f-ab", c).checked,
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

async function loadAbStats(agentId, el) {
  if (!el) return;
  el.innerHTML = `<p class="muted ab-hint">Loading A/B results…</p>`;
  const { ok, data } = await api("GET", `/api/dashboard/agents/${agentId}/ab`);
  const variants = (ok && data?.variants) || [];
  if (!variants.length) {
    el.innerHTML = `<p class="muted ab-hint">No A/B data yet — variants A and B will compare here once calls come in.</p>`;
    return;
  }
  const row = (label, get) => `<tr><td class="muted">${label}</td>${variants.map((v) => `<td>${get(v)}</td>`).join("")}</tr>`;
  el.innerHTML = `<div class="ab-compare"><table>
    <thead><tr><th>Metric</th>${variants.map((v) => `<th>Variant ${esc(v.variant)}</th>`).join("")}</tr></thead>
    <tbody>
      ${row("Calls", (v) => v.calls)}
      ${row("Avg duration", (v) => (v.avgDurationMs ? (v.avgDurationMs / 1000).toFixed(1) + "s" : "—"))}
      ${row("Avg turns", (v) => v.avgTurns)}
      ${row("Barge-in rate", (v) => v.bargeInRate)}
      ${row("Reply latency p50", (v) => (v.latencyMsP50 != null ? v.latencyMsP50 + "ms" : "—"))}
    </tbody></table></div>`;
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

  window.RM?.reveal(v);
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
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCallsCsv(calls) {
  const header = ["Started", "Duration (s)", "Turns", "Barge-ins", "Language", "Variant", "Status"];
  const rows = calls.map((c) => [
    new Date(c.started_at).toISOString(),
    c.duration_ms != null ? (c.duration_ms / 1000).toFixed(1) : "",
    c.turn_count,
    c.barge_in_count,
    c.detected_lang || c.language_primary || "",
    c.variant || "",
    c.status,
  ]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `raabta-calls-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${calls.length} call${calls.length === 1 ? "" : "s"}`);
}

async function tabCalls(v) {
  const { data } = await api("GET", "/api/dashboard/calls");
  const calls = data.calls || [];
  if (!calls.length) {
    v.innerHTML = `
      <h2 class="view-title">Calls</h2>
      <p class="view-sub">Every conversation your agents handled — click one to read the transcript.</p>
      ${emptyState(ICONS.calls, "No calls yet", "Open the “Talk to your agent” tab and say hello — your call will appear here with its full transcript.", "Talk to your agent", "talk")}`;
    wireEmptyCtas(v);
    window.RM?.reveal(v);
    return;
  }
  v.innerHTML = `
    <div class="view-head">
      <div><h2 class="view-title">Calls</h2><p class="view-sub">Every conversation your agents handled — click one to read the transcript.</p></div>
      <button class="btn sm" id="exportCsv">⬇ Export CSV</button>
    </div>
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
  window.RM?.reveal(v);
  $("#exportCsv").onclick = () => exportCallsCsv(calls);
  for (const tr of v.querySelectorAll("[data-call]")) {
    tr.onclick = async () => {
      const callId = tr.dataset.call;
      const { data } = await api("GET", `/api/dashboard/calls/${callId}`);
      const turns = data.turns || [];
      $("#callDetail").innerHTML = `<div class="panel">
        <div class="panel-head"><h3>Transcript</h3><div id="shareCtl" class="share-ctl"></div></div>
        ${
          turns
            .map(
              (t) =>
                `<div class="bubble ${t.role === "caller" ? "caller" : "agent"} ${isArabic(t.text) ? "rtl" : ""}">
                  <div class="r">${t.role === "caller" ? "Caller" : "Agent"}${t.latency_ms ? " · " + t.latency_ms + "ms" : ""}</div>${esc(t.text)}</div>`,
            )
            .join("") || `<p class="muted">No transcript turns recorded.</p>`
        }</div>`;
      renderShareCtl(callId, data.call?.share_token || null);
      $("#callDetail").scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
  }
}

function renderShareCtl(callId, token) {
  const el = $("#shareCtl");
  if (!el) return;
  if (!token) {
    el.innerHTML = `<button class="btn sm ghost" id="shareBtn">🔗 Share report</button>`;
    $("#shareBtn").onclick = async () => {
      const { ok, data } = await api("POST", `/api/dashboard/calls/${callId}/share`);
      if (!ok) return toast(errorText(data?.error));
      renderShareCtl(callId, data.token);
      toast("Public link created");
    };
  } else {
    const url = `${location.origin}/r?t=${encodeURIComponent(token)}`;
    el.innerHTML = `<div class="share-live">
      <a href="${esc(url)}" target="_blank" class="share-url">${esc(url)}</a>
      <button class="btn sm" id="copyShare">Copy</button>
      <button class="btn sm danger" id="unshareBtn">Unshare</button>
    </div>`;
    $("#copyShare").onclick = () => navigator.clipboard?.writeText(url).then(() => toast("Link copied"));
    $("#unshareBtn").onclick = async () => {
      const { ok } = await api("POST", `/api/dashboard/calls/${callId}/unshare`);
      if (ok) {
        renderShareCtl(callId, null);
        toast("Link revoked");
      }
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
