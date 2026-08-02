// Tokscale local dashboard app — multiple views, all from local core data.

const T = window.__TAURI__ || {};
const invoke = (T.core && T.core.invoke) || T.invoke;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtCost = (c) => "$" + (Number(c) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtTokens = (t) => {
  const n = Number(t) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};
const tokenTotal = (e) => (e.input || 0) + (e.output || 0) + (e.cache_read || 0) + (e.cache_write || 0) + (e.reasoning || 0);

function aggregateBy(entries, keyFn, pick) {
  const m = new Map();
  for (const e of entries || []) {
    const k = keyFn(e);
    m.set(k, (m.get(k) || 0) + pick(e));
  }
  return [...m.entries()].map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
}
function shortLabel(label) {
  const l = (label || "").toLowerCase();
  if (l.includes("session")) return "5hr";
  if (l.includes("weekly")) return "weekly";
  return label || "";
}
function formatReset(iso) {
  try {
    const t = new Date(iso).getTime();
    const mins = Math.round((t - Date.now()) / 60000);
    if (!isFinite(mins) || mins <= 0) return "";
    if (mins < 60) return mins + "m";
    const h = Math.floor(mins / 60);
    const mm = mins % 60;
    return mm ? h + "h" + mm + "m" : h + "h";
  } catch { return ""; }
}

function section(title, inner) {
  return '<div class="section"><div class="section-title">' + esc(title) + "</div>" + inner + "</div>";
}
function table(headers, rows, rightCols) {
  const right = new Set(rightCols || []);
  return '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
    headers.map((h) => "<th>" + esc(h) + "</th>").join("") + "</tr></thead><tbody>" +
    (rows.length
      ? rows.map((r) => "<tr>" + r.map((c, i) =>
          '<td class="' + (right.has(i) ? "num" : "") + '">' + esc(String(c)) + "</td>").join("") + "</tr>").join("")
      : '<tr><td colspan="' + headers.length + '" class="empty">No data</td></tr>') +
    "</tbody></table></div>";
}

// ── View switching ────────────────────────────────────────────────────────
let currentView = "overview";
document.querySelectorAll("#views .view-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});
function switchView(name) {
  if (window.__threeStop) { window.__threeStop(); window.__threeStop = null; }
  currentView = name;
  document.querySelectorAll("#views .view-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  load();
}

// ── Right-click view switcher ─────────────────────────────────────────────
const VIEW_LABELS = {
  overview: "Overview", usage: "Usage", suppliers: "Suppliers", models: "Models",
  monthly: "Monthly", hourly: "Hourly", "3d": "3D", wrapped: "Wrapped",
};
const VIEW_ORDER = ["overview", "usage", "suppliers", "models", "monthly", "hourly", "3d", "wrapped"];

document.addEventListener("contextmenu", (e) => { e.preventDefault(); showViewMenu(e.clientX, e.clientY); });
function showViewMenu(x, y) {
  const m = $("contextMenu");
  m.innerHTML = VIEW_ORDER.map((v) =>
    '<div class="ctx-item' + (v === currentView ? " active" : "") + '" data-view="' + v + '">' +
    VIEW_LABELS[v] + "</div>"
  ).join("");
  m.style.left = x + "px";
  m.style.top = y + "px";
  m.hidden = false;
  const r = m.getBoundingClientRect();
  if (x + r.width > window.innerWidth) m.style.left = Math.max(8, window.innerWidth - r.width - 8) + "px";
  if (y + r.height > window.innerHeight) m.style.top = Math.max(8, window.innerHeight - r.height - 8) + "px";
}
function hideViewMenu() { $("contextMenu").hidden = true; }
document.addEventListener("pointerdown", (e) => {
  if (!$("contextMenu").hidden && !$("contextMenu").contains(e.target)) hideViewMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideViewMenu(); });
$("contextMenu").addEventListener("click", (e) => {
  const item = e.target.closest(".ctx-item");
  if (!item) return;
  hideViewMenu();
  switchView(item.dataset.view);
});

async function load() {
  $("content").innerHTML = '<div class="empty">Loading…</div>';
  try {
    if (currentView === "overview") await loadOverview();
    else if (currentView === "usage") await loadUsage();
    else if (currentView === "suppliers") await loadSuppliers();
    else if (currentView === "models") await loadModels();
    else if (currentView === "monthly") await loadMonthly();
    else if (currentView === "hourly") await loadHourly();
    else if (currentView === "3d") await load3D();
    else if (currentView === "wrapped") await loadWrapped();
  } catch (e) {
    $("content").innerHTML = '<div class="empty error">' + esc(String(e)) + "</div>";
  }
}

// ── Overview ──────────────────────────────────────────────────────────────
async function loadOverview() {
  const [graph, byClient, byModel, monthly] = await Promise.all([
    invoke("get_overview_graph"),
    invoke("get_models_report", { groupBy: "client,model", since: null, until: null }),
    invoke("get_models_report", { groupBy: "model", since: null, until: null }),
    invoke("get_monthly_view"),
  ]);
  const s = (graph && graph.summary) || {};
  const suppliers = aggregateBy((byClient && byClient.entries) || [], (e) => e.client || "?", (e) => Number(e.cost) || 0);
  const supplierTok = new Map(aggregateBy((byClient && byClient.entries) || [], (e) => e.client || "?", tokenTotal).map((x) => [x.k, x.v]));
  const models = aggregateBy((byModel && byModel.entries) || [], (e) => e.model || "?", (e) => Number(e.cost) || 0).slice(0, 12);
  const modelTok = new Map(aggregateBy((byModel && byModel.entries) || [], (e) => e.model || "?", tokenTotal).map((x) => [x.k, x.v]));

  $("content").innerHTML =
    section("All-time", stats(s)) +
    section("Contribution heatmap (all days)", heatmap((graph && graph.contributions) || [])) +
    section("Monthly cost trend", monthlyBars((monthly && monthly.entries) || [])) +
    '<div class="grid2">' +
      section("Top suppliers · tokens / cost", breakdownList(suppliers, supplierTok)) +
      section("Top models · tokens / cost", breakdownList(models, modelTok)) +
    "</div>" +
    section("Subscription quotas", '<div id="overviewQuotas" class="empty">Loading quotas…</div>');
  loadOverviewQuotas();
}

// Non-blocking subscription quota cards appended to the Overview. Fetches hit
// external provider APIs (15s timeout + 5m cache), so they never gate the
// locally-computed Overview body above.
async function loadOverviewQuotas() {
  const host = document.getElementById("overviewQuotas");
  if (!host) return;
  const quotas = await invoke("get_subscription_usage").catch(() => null);
  if (!host) return;
  if (!quotas) { host.classList.add("empty"); host.textContent = "Usage unavailable."; return; }
  host.classList.remove("empty");
  host.innerHTML = quotas.length ? quotaCards(quotas) : "No authenticated providers.";
}
function quotaCards(quotas) {
  return '<div class="quota-grid">' + quotas.map((q) => {
    const planTag = q.plan ? ' · <span class="qplan">' + esc(q.plan) + "</span>" : "";
    const bars = (q.metrics || []).map((m) => {
      const used = Math.max(0, Math.min(100, Math.round(m.used_percent || 0)));
      const rem = m.remaining_label || (Math.round(m.remaining_percent || 0) + "% left");
      const reset = m.resets_at ? " · resets " + formatReset(m.resets_at) : "";
      return '<div class="qmetric">' +
        '<div class="qm-top"><span class="qm-label">' + esc(shortLabel(m.label)) + "</span>" +
        '<span class="qm-pct">' + used + "% used</span></div>" +
        '<div class="qm-bar"><div class="qm-fill" style="width:' + used + '%"></div></div>' +
        '<div class="qm-sub">' + esc(rem) + reset + "</div></div>";
    }).join("");
    return '<div class="quota-card"><div class="qhead">' + esc(q.provider) + planTag + "</div>" +
      (bars || '<div class="qm-sub">No quota data</div>') + "</div>";
  }).join("") + "</div>";
}

function stats(s) {
  const items = [
    ["Tokens", fmtTokens(s.total_tokens)],
    ["Spend", fmtCost(s.total_cost)],
    ["Active days", String(s.active_days || 0)],
    ["Suppliers", String((s.clients || []).length)],
    ["Models", String((s.models || []).length)],
  ];
  return '<div class="stats">' + items.map(([k, v]) =>
    '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + "</div></div>").join("") + "</div>";
}
function heatmap(contribs) {
  return '<div class="heatmap">' + contribs.map((c) =>
    '<span class="hm-cell i' + Math.min(4, c.intensity || 0) +
    '" title="' + esc(c.date) + ": " + fmtTokens((c.totals && c.totals.tokens) || 0) + " " +
    fmtCost((c.totals && c.totals.cost) || 0) + '"></span>').join("") + "</div>";
}
function monthlyBars(entries) {
  const recent = entries.slice(-12);
  const max = Math.max(1, ...recent.map((e) => Number(e.cost) || 0));
  return '<div class="bars">' + recent.map((e) => {
    const h = Math.round(((Number(e.cost) || 0) / max) * 120);
    return '<div class="bar-col"><span class="val">' + fmtCost(e.cost) + "</span>" +
      '<div class="bar" style="height:' + h + 'px"></div><span class="lbl">' + esc(e.month) + "</span></div>";
  }).join("") + "</div>";
}
function breakdownList(rows, tokMap) {
  if (!rows.length) return '<div class="list"><div class="empty">No data</div></div>';
  return '<div class="list">' + rows.map((r) =>
    '<div class="list-row"><span class="k">' + esc(r.k) + '</span><span class="v"><span class="tok">' +
    fmtTokens(tokMap.get(r.k) || 0) + "</span>" + fmtCost(r.v) + "</span></div>").join("") + "</div>";
}

// ── Usage (subscription quotas) ───────────────────────────────────────────
async function loadUsage() {
  const quotas = await invoke("get_subscription_usage").catch(() => []);
  if (!quotas.length) {
    $("content").innerHTML = '<div class="empty">No authenticated providers.</div>';
    return;
  }
  const rows = quotas.map((q) => {
    const m = (q.metrics || []).filter((x) => /session|^weekly$/i.test(x.label || ""));
    const used = m.map((x) => shortLabel(x.label) + " " + Math.round(x.used_percent || 0) + "%").join(", ") || "—";
    const reset = m.map((x) => (x.resets_at ? formatReset(x.resets_at) : "")).filter(Boolean).join(", ") || "—";
    return [q.display_name || q.provider, q.plan || "—", used, reset, q.email || "—"];
  });
  $("content").innerHTML = section("Subscription quotas", table(["Provider", "Plan", "Used", "Resets", "Account"], rows, [2, 3]));
}

// ── Suppliers / Models ────────────────────────────────────────────────────
async function loadSuppliers() {
  const r = await invoke("get_models_report", { groupBy: "client,model", since: null, until: null });
  const cost = aggregateBy((r && r.entries) || [], (e) => e.client || "?", (e) => Number(e.cost) || 0);
  const tok = new Map(aggregateBy((r && r.entries) || [], (e) => e.client || "?", tokenTotal).map((x) => [x.k, x.v]));
  const rows = cost.map((x) => [x.k, fmtTokens(tok.get(x.k) || 0), fmtCost(x.v)]);
  $("content").innerHTML = section("Suppliers · tokens / cost", table(["Supplier", "Tokens", "Cost"], rows, [1, 2]));
}
async function loadModels() {
  const r = await invoke("get_models_report", { groupBy: "model", since: null, until: null });
  const cost = aggregateBy((r && r.entries) || [], (e) => e.model || "?", (e) => Number(e.cost) || 0);
  const tok = new Map(aggregateBy((r && r.entries) || [], (e) => e.model || "?", tokenTotal).map((x) => [x.k, x.v]));
  const rows = cost.map((x) => [x.k, fmtTokens(tok.get(x.k) || 0), fmtCost(x.v)]);
  $("content").innerHTML = section("Models · tokens / cost", table(["Model", "Tokens", "Cost"], rows, [1, 2]));
}

// ── Monthly / Hourly ──────────────────────────────────────────────────────
async function loadMonthly() {
  const r = await invoke("get_monthly_view");
  const rows = ((r && r.entries) || []).slice().reverse().map((e) => [e.month, fmtTokens(tokenTotal(e)), fmtCost(e.cost)]);
  $("content").innerHTML = section("Monthly · tokens / cost", table(["Month", "Tokens", "Cost"], rows, [1, 2]));
}
async function loadHourly() {
  const r = await invoke("get_hourly_view");
  const rows = ((r && r.entries) || []).slice().reverse().map((e) => [e.hour, fmtTokens(tokenTotal(e)), fmtCost(e.cost)]);
  $("content").innerHTML = section("Recent hours · tokens / cost", table(["Hour", "Tokens", "Cost"], rows, [1, 2]));
}

// ── 3D contribution graph (Three.js) ──────────────────────────────────────
function intensityColor(i) {
  return [0x2a2f3a, 0x0e4429, 0x006d32, 0x26a641, 0x39d353][Math.min(4, i | 0)] || 0x2a2f3a;
}
async function load3D() {
  if (typeof THREE === "undefined") {
    $("content").innerHTML = '<div class="empty error">Three.js failed to load (offline?). 3D view unavailable.</div>';
    return;
  }
  const graph = await invoke("get_overview_graph");
  const contribs = (graph.contributions || []).filter((c) => (c.intensity || 0) || ((c.totals || {}).tokens || 0));
  $("content").innerHTML =
    '<div class="section"><div class="section-title">3D contribution graph · ' + contribs.length +
    ' active days</div><div class="three-wrap" id="threeWrap"></div>' +
    '<div class="three-note">auto-rotating · bar height &amp; color = daily intensity</div></div>';
  initThree(contribs);
}
function initThree(contribs) {
  const wrap = $("threeWrap");
  const W = Math.min(960, wrap.clientWidth || 960), H = 460;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(W, H);
  wrap.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1116);
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 3000);
  const group = new THREE.Group();
  scene.add(group);
  const cols = Math.ceil(contribs.length / 7);
  contribs.forEach((c, i) => {
    const col = Math.floor(i / 7);
    const row = i % 7;
    const h = Math.max(0.5, (c.intensity || 0)) * 2.5;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, h, 0.85),
      new THREE.MeshStandardMaterial({ color: intensityColor(c.intensity || 0), roughness: 0.6 })
    );
    mesh.position.set(col - cols / 2, h / 2, row - 3);
    group.add(mesh);
  });
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dl = new THREE.DirectionalLight(0xffffff, 0.85);
  dl.position.set(40, 80, 30);
  scene.add(dl);
  camera.position.set(cols * 0.9, cols * 0.8, cols * 1.2);
  camera.lookAt(0, 2, 0);
  let raf;
  (function animate() {
    raf = requestAnimationFrame(animate);
    group.rotation.y += 0.0025;
    renderer.render(scene, camera);
  })();
  if (window.__threeStop) window.__threeStop();
  window.__threeStop = () => { cancelAnimationFrame(raf); renderer.dispose(); wrap.innerHTML = ""; };
}

// ── Wrapped (year-in-review summary) ──────────────────────────────────────
function dayActive(c) {
  return (c.intensity || 0) > 0 || ((c.totals || {}).tokens || 0) > 0;
}
function longestStreak(contribs) {
  let best = 0, cur = 0;
  for (const c of contribs) { if (dayActive(c)) { cur++; best = Math.max(best, cur); } else cur = 0; }
  return best;
}
function currentStreak(contribs) {
  let cur = 0;
  for (let i = contribs.length - 1; i >= 0; i--) { if (dayActive(contribs[i])) cur++; else break; }
  return cur;
}
function bestDay(contribs) {
  let best = { tokens: 0, date: "" };
  for (const c of contribs) {
    const t = (c.totals || {}).tokens || 0;
    if (t > best.tokens) best = { tokens: t, date: c.date };
  }
  return best;
}
async function loadWrapped() {
  const [graph, byClient, byModel] = await Promise.all([
    invoke("get_overview_graph"),
    invoke("get_models_report", { groupBy: "client,model", since: null, until: null }),
    invoke("get_models_report", { groupBy: "model", since: null, until: null }),
  ]);
  const s = (graph && graph.summary) || {};
  const year = new Date().getFullYear();
  const contribs = (graph && graph.contributions) || [];
  const topClients = aggregateBy((byClient && byClient.entries) || [], (e) => e.client || "?", (e) => Number(e.cost) || 0).slice(0, 5);
  const topModels = aggregateBy((byModel && byModel.entries) || [], (e) => e.model || "?", (e) => Number(e.cost) || 0).slice(0, 5);
  const clientTok = new Map(aggregateBy((byClient && byClient.entries) || [], (e) => e.client || "?", tokenTotal).map((x) => [x.k, x.v]));
  const modelTok = new Map(aggregateBy((byModel && byModel.entries) || [], (e) => e.model || "?", tokenTotal).map((x) => [x.k, x.v]));
  const best = bestDay(contribs);

  $("content").innerHTML =
    '<div class="wrapped-hero"><div class="year">' + year + '</div><div class="sub">' +
      fmtTokens(s.total_tokens) + " tokens · " + fmtCost(s.total_cost) + " · " + (s.active_days || 0) + " active days</div></div>" +
    '<div class="wrapped-grid">' +
      wrappedCard("Longest streak", '<div class="big">' + longestStreak(contribs) + " days</div>") +
      wrappedCard("Current streak", '<div class="big">' + currentStreak(contribs) + " days</div>") +
      wrappedCard("Best day", '<div class="big">' + fmtTokens(best.tokens) + '</div><div class="three-note">' + esc(best.date) + "</div>") +
      wrappedCard("Top models", topModels.map((m, i) => rank(i + 1, m.k, fmtTokens(modelTok.get(m.k) || 0))).join("")) +
      wrappedCard("Top suppliers", topClients.map((c, i) => rank(i + 1, c.k, fmtTokens(clientTok.get(c.k) || 0))).join("")) +
    "</div>";
}
function wrappedCard(title, body) {
  return '<div class="wrapped-card"><div class="title">' + esc(title) + "</div>" + body + "</div>";
}
function rank(n, name, val) {
  return '<div class="rank"><span><span class="n">' + n + ".</span> " + esc(name) + '</span><span>' + esc(val) + "</span></div>";
}

$("refreshBtn").addEventListener("click", load);
load();
