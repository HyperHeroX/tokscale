// Tokscale desktop widget frontend.
//
// Every view shows tokens (not just cost). The right-click "Dashboard" entry
// is a built-in local dashboard (heatmap + stats + top models) — no external
// frontend server. Window ops route through Rust commands via core.invoke.

const T = window.__TAURI__ || {};
const invoke = (T.core && T.core.invoke) || T.invoke;

// Surface any uncaught runtime error so a half-loaded script does not look
// like a silent "Loading…" freeze.
window.addEventListener("error", (e) => {
  try {
    document.getElementById("viewBody").innerHTML =
      '<div class="empty error">JS error: ' + String((e.error && e.error.message) || e.message) + "</div>";
  } catch (_) {}
});
window.addEventListener("unhandledrejection", (e) => {
  try {
    document.getElementById("viewBody").innerHTML =
      '<div class="empty error">Promise reject: ' + String(e.reason) + "</div>";
  } catch (_) {}
});

const MIN_H = 220;
const MAX_H = 820;

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
const fmtCost = (c) =>
  "$" + (Number(c) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtTokens = (t) => {
  const n = Number(t) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};
const tokenTotal = (e) =>
  (e.input || 0) + (e.output || 0) + (e.cache_read || 0) +
  (e.cache_write || 0) + (e.reasoning || 0);

function setBody(html) { $("viewBody").innerHTML = html; }
// Debounced: collapse repeated fitHeight calls (e.g. multi-step render of the
// Dashboard view) into a single resize, so the window snaps to its final
// height instead of visibly growing step-by-step.
let fitTimer = null;
function fitHeight() {
  if (fitTimer) clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    const h = Math.ceil(document.documentElement.scrollHeight);
    const height = Math.max(MIN_H, Math.min(h + 2, MAX_H));
    invoke("fit_window_height", { height: height }).catch(() => {});
  }, 120);
}

const PROVIDER_TO_CLIENT = {
  claude: "claude", codex: "codex", amp: "amp", copilot: "copilot",
  "grok build": "grok", kimi: "kimi", "warp/oz": "warp",
  "z.ai": "kilo", minimax: null, "minimax token plan": null, sakana: null,
};
const CLIENT_LABEL = { kilo: "kilo · z.ai" };

function providerToClient(provider) {
  return PROVIDER_TO_CLIENT[String(provider || "").toLowerCase()] ?? null;
}
function aggregateByClient(report, pick) {
  const m = new Map();
  for (const e of (report && report.entries) || []) {
    const k = e.client || "unknown";
    m.set(k, (m.get(k) || 0) + pick(e));
  }
  return m;
}
const aggregateCostByClient = (r) => aggregateByClient(r, (e) => Number(e.cost) || 0);
const aggregateTokenByClient = (r) => aggregateByClient(r, tokenTotal);

function pickMetrics(metrics) {
  if (!metrics || !metrics.length) return [];
  const out = [];
  const session = metrics.find((m) => /session/i.test(m.label || ""));
  const weekly = metrics.find((m) => /^weekly$/i.test((m.label || "").trim()));
  if (session) out.push(session);
  if (weekly) out.push(weekly);
  return out.length ? out : metrics.slice(0, 2);
}
function shortLabel(label) {
  const l = (label || "").toLowerCase();
  if (l.includes("session")) return "5hr";
  if (l.includes("weekly")) return "weekly";
  return label || "";
}
// ── Views ─────────────────────────────────────────────────────────────────
const VIEW_LABELS = {
  usage: "Usage", models: "Models", monthly: "Monthly", hourly: "Hourly",
  stats: "Stats", dashboard: "Dashboard",
};
let currentView = "usage";

async function loadView(name) {
  const changing = name !== currentView;
  currentView = name;
  if (changing) {
    $("viewName").textContent = VIEW_LABELS[name] || name;
    setBody('<div class="empty">Loading…</div>');
    // No fitHeight here: only resize once after real content renders, so the
    // window does not visibly grow step-by-step on open.
  }
  try {
    if (name === "usage") await loadUsageView();
    else if (name === "models") await loadModelsView();
    else if (name === "monthly") await loadMonthlyView();
    else if (name === "hourly") await loadHourlyView();
    else if (name === "stats") await loadStatsView();
    else if (name === "dashboard") await loadDashboardView();
  } catch (e) {
    setBody('<div class="empty error">' + esc(String(e)) + "</div>");
  }
  fitHeight();
}

async function loadUsageView() {
  // Silent load: no "Fetching…" / "Got N" progress messages — they wipe the
  // existing content and hurt UX. On a same-view refresh the previous content
  // stays visible until the new data is ready, then is replaced in place.
  let quotas = [];
  try { quotas = await invoke("get_subscription_usage"); } catch (e) { quotas = []; }
  let report = null;
  try { report = await invoke("get_models_report", { groupBy: "client,model", since: null, until: null }); } catch (e) {}
  const costByClient = aggregateCostByClient(report);
  const tokenByClient = aggregateTokenByClient(report);

  const seen = new Set();
  const rows = quotas.map((q) => {
    const client = providerToClient(q.provider);
    if (client) seen.add(client);
    return {
      name: q.display_name || q.provider,
      metrics: pickMetrics(q.metrics),
      token: client ? tokenByClient.get(client) || 0 : null,
      cost: client ? costByClient.get(client) || 0 : null,
    };
  });
  if (report) {
    for (const client of [...new Set([...costByClient.keys(), ...tokenByClient.keys()])].sort()) {
      if (seen.has(client)) continue;
      const tok = tokenByClient.get(client) || 0;
      const cost = costByClient.get(client) || 0;
      if (!tok && !cost) continue;
      rows.push({ name: CLIENT_LABEL[client] || client, metrics: [], token: tok, cost });
    }
  }

  if (!rows.length) {
    setBody('<div class="empty">No usage data yet.</div>');
    return;
  }
  const totalTok = rows.reduce((a, r) => a + (r.token || 0), 0);
  const totalCost = rows.reduce((a, r) => a + (r.cost || 0), 0);

  setBody(
    '<div class="section-label">Suppliers · used% / tokens / cost</div>' +
    '<div class="suppliers">' + rows.map(supplierRow).join("") + "</div>" +
    '<div class="sup-total">Total · ' + fmtTokens(totalTok) + " tok · " + fmtCost(totalCost) + "</div>"
  );
}

function supplierRow(r) {
  const bars = (r.metrics || []).map(barRow).join("");
  return (
    '<div class="sup-row">' +
      '<div class="sup-line">' +
        '<span class="sup-name">' + esc(r.name) + "</span>" +
        '<span class="sup-meta">' +
          (r.token != null ? '<span class="tok">' + fmtTokens(r.token) + "</span>" : "") +
          '<span class="cost">' + fmtCost(r.cost || 0) + "</span>" +
        "</span>" +
      "</div>" +
      (bars ? '<div class="sup-bars">' + bars + "</div>" : "") +
    "</div>"
  );
}
function barRow(m) {
  const used = Math.max(0, Math.min(100, Math.round(m.used_percent || 0)));
  return (
    '<div class="sup-bar-row">' +
      '<span class="sup-bar-label">' + esc(shortLabel(m.label)) + "</span>" +
      '<span class="sup-bar"><span class="sup-bar-fill" style="width:' + used + '%"></span></span>' +
      '<span class="sup-bar-pct">' + used + "%</span>" +
    "</div>"
  );
}

async function loadModelsView() {
  const r = await invoke("get_models_report", { groupBy: "model", since: null, until: null });
  const rows = (r.entries || []).slice().sort((a, b) => (b.cost || 0) - (a.cost || 0)).slice(0, 12);
  setBody(
    '<div class="section-label">Top models · tokens / cost</div><div class="list">' +
    rows.map((e) => '<div class="list-row"><span class="k">' + esc(e.model) +
      '</span><span class="v"><span class="tok">' + fmtTokens(tokenTotal(e)) +
      "</span>" + fmtCost(e.cost) + "</span></div>").join("") +
    "</div>"
  );
}

async function loadMonthlyView() {
  const r = await invoke("get_monthly_view");
  const rows = (r.entries || []).slice().reverse().slice(0, 8);
  setBody(
    '<div class="section-label">Monthly · tokens / cost</div><div class="list">' +
    rows.map((e) => '<div class="list-row"><span class="k">' + esc(e.month) +
      '</span><span class="v"><span class="tok">' + fmtTokens(tokenTotal(e)) +
      "</span>" + fmtCost(e.cost) + "</span></div>").join("") +
    "</div>"
  );
}

async function loadHourlyView() {
  const r = await invoke("get_hourly_view");
  const rows = (r.entries || []).slice().reverse().slice(0, 10);
  setBody(
    '<div class="section-label">Recent hours · tokens / cost</div><div class="list">' +
    rows.map((e) => '<div class="list-row"><span class="k">' + esc(e.hour) +
      '</span><span class="v"><span class="tok">' + fmtTokens(tokenTotal(e)) +
      "</span>" + fmtCost(e.cost) + "</span></div>").join("") +
    "</div>"
  );
}

async function loadStatsView() {
  const g = await invoke("get_overview_graph");
  const s = g.summary || {};
  setBody(
    '<div class="section-label">All-time stats</div><div class="stats-grid">' +
    stat("Tokens", fmtTokens(s.total_tokens)) +
    stat("Spend", fmtCost(s.total_cost)) +
    stat("Active days", String(s.active_days || 0)) +
    stat("Suppliers", String((s.clients || []).length)) +
    "</div>"
  );
}

// 需求④: built-in local dashboard — heatmap + stats + top models, all from
// local tokscale-core data (no external frontend server).
async function loadDashboardView() {
  const [g, models] = await Promise.all([
    invoke("get_overview_graph"),
    invoke("get_models_report", { groupBy: "model", since: null, until: null }).catch(() => null),
  ]);
  const s = g.summary || {};
  const contribs = g.contributions || [];
  // last ~12 weeks as a GitHub-style heatmap
  const recent = contribs.slice(-84);
  const heat = recent.map((c) => {
    const t = (c.totals && c.totals.tokens) || 0;
    const cost = (c.totals && c.totals.cost) || 0;
    return (
      '<span class="hm-cell i' + Math.min(4, c.intensity || 0) +
      '" title="' + esc(c.date) + ": " + fmtTokens(t) + " " + fmtCost(cost) +
      '"></span>'
    );
  }).join("");
  const top = ((models && models.entries) || [])
    .slice().sort((a, b) => (b.cost || 0) - (a.cost || 0)).slice(0, 6);

  setBody(
    '<div class="section-label">All-time</div>' +
    '<div class="stats-grid">' +
      stat("Tokens", fmtTokens(s.total_tokens)) +
      stat("Spend", fmtCost(s.total_cost)) +
      stat("Active days", String(s.active_days || 0)) +
      stat("Suppliers", String((s.clients || []).length)) +
    "</div>" +
    '<div class="section-label">Recent activity (12 weeks)</div>' +
    '<div class="heatmap">' + heat + "</div>" +
    '<div class="section-label">Top models</div>' +
    '<div class="list">' +
      top.map((e) => '<div class="list-row"><span class="k">' + esc(e.model) +
        '</span><span class="v"><span class="tok">' + fmtTokens(tokenTotal(e)) +
        "</span>" + fmtCost(e.cost) + "</span></div>").join("") +
    "</div>"
  );
}

function stat(k, v) {
  return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + "</div></div>";
}

async function loadToday() {
  try {
    const g = await invoke("get_today_trend");
    const c = (g.contributions || []).slice(-1)[0];
    $("today").textContent =
      c && c.totals ? "today " + fmtTokens(c.totals.tokens) + " · " + fmtCost(c.totals.cost) : "today —";
  } catch {
    $("today").textContent = "today —";
  }
}

// ── Drag / pin via Rust commands ──────────────────────────────────────────
$("titlebar").addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest("button")) return;
  invoke("start_drag").catch(() => {});
});
let pinned = true;
$("pinBtn").addEventListener("click", async () => {
  const next = !pinned;
  try { pinned = await invoke("set_pinned", { pinned: next }); }
  catch { /* keep current */ }
  const b = $("pinBtn");
  b.classList.toggle("active", pinned);
  // Icon shows the NEXT action (like a play/pause button): 📌 = click to pin
  // on top, 📍 = currently pinned, click to release. This is the reverse of
  // the previous "show current state" mapping.
  b.textContent = pinned ? "📍" : "📌";
  b.title = pinned ? "On top — click to release" : "Click to pin on top";
});

// ── Right-click context menu ──────────────────────────────────────────────
const MENU = [
  { group: "View" },
  { id: "usage", ico: "◷", label: "Usage (quotas)" },
  { id: "dashboard", ico: "▦", label: "Dashboard" },
  { id: "models", ico: "◉", label: "Models" },
  { id: "monthly", ico: "▤", label: "Monthly" },
  { id: "hourly", ico: "⏱", label: "Hourly" },
  { id: "stats", ico: "∑", label: "Stats" },
  { sep: true },
  { group: "Full version" },
  { id: "__web", ico: "⌂", label: "Open frontend app" },
  { id: "__tui", ico: "▶", label: "Open TUI" },
  { sep: true },
  { group: "Commands" },
  { id: "__login", ico: "↳", label: "Login" },
  { id: "__submit", ico: "↗", label: "Submit" },
  { id: "__sync", ico: "⟳", label: "Refresh usage" },
  { sep: true },
  { id: "__quit", ico: "✕", label: "Quit" },
];

function showMenu(x, y) {
  const m = $("contextMenu");
  let html = "";
  for (const it of MENU) {
    if (it.group) html += '<div class="group-label">' + esc(it.group) + "</div>";
    else if (it.sep) html += '<div class="sep"></div>';
    else
      html +=
        '<div class="item' + (it.id === currentView ? " active" : "") +
        '" data-id="' + esc(it.id) + '"><span class="ico">' + it.ico + "</span>" +
        esc(it.label) + "</div>";
  }
  m.innerHTML = html;
  m.style.left = x + "px";
  m.style.top = y + "px";
  m.hidden = false;
  const rect = m.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (x + rect.width > vw) m.style.left = Math.max(0, vw - rect.width) + "px";
  if (y + rect.height > vh) m.style.top = Math.max(0, vh - rect.height) + "px";
}
function hideMenu() { $("contextMenu").hidden = true; }
$("widget").addEventListener("contextmenu", (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY); });
document.addEventListener("pointerdown", (e) => {
  if (!$("contextMenu").hidden && !$("contextMenu").contains(e.target)) hideMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideMenu(); });
window.addEventListener("blur", hideMenu);
$("contextMenu").addEventListener("click", (e) => {
  const item = e.target.closest(".item");
  if (!item) return;
  const id = item.dataset.id;
  hideMenu();
  handleMenu(id);
});
async function handleMenu(id) {
  if (id === "__web") invoke("open_external", { kind: "web" }).catch(() => {});
  else if (id === "__tui") invoke("open_external", { kind: "tui" }).catch(() => {});
  else if (id === "__login") invoke("run_cli", { command: "login" }).catch(() => {});
  else if (id === "__submit") invoke("run_cli", { command: "submit" }).catch(() => {});
  else if (id === "__sync") invoke("run_cli", { command: "usage" }).catch(() => {});
  else if (id === "__quit") invoke("quit_app").catch(() => {});
  else if (["usage", "dashboard", "models", "monthly", "hourly", "stats"].includes(id)) await loadView(id);
}

// ── Init + silent refresh ─────────────────────────────────────────────────
loadView("usage");
loadToday();
setInterval(() => { loadView(currentView); loadToday(); }, 60000);
// NOTE: no window resize listener — fitHeight is driven by loadView only,
// otherwise set_size would re-trigger resize and loop.
