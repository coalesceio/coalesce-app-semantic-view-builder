// Semantic View Builder UI. Plain DOM; the server does validation, DDL and Snowflake work.
(() => {
  // The server API this page expects; must equal API_VERSION in src/server.js.
  const API_VERSION = 4;
  const BASE = location.pathname.endsWith("/") ? location.pathname : location.pathname + "/";
  async function api(path, body) {
    const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const r = await fetch(new URL(BASE + "api/" + path, location.origin), opts);
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  // h("div.card", { onclick }, child, ...) — strings become text nodes.
  function h(sel, props, ...kids) {
    const [tag, ...cls] = sel.split(".");
    const el = document.createElement(tag || "div");
    if (cls.length) el.className = cls.join(" ");
    if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== "list") el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const $ = (id) => document.getElementById(id);
  // Mark a control as the place that fixes issues about `name` (an issue's `fix`).
  const fix = (name, el) => { el.dataset.fix = name; return el; };

  const NS = "Not supported by Coalesce's Semantic View package yet";
  const emptySpec = () => ({ tables: [], relationships: [], facts: [], dimensions: [], metrics: [], aiSqlGeneration: "", aiQuestionCategorization: "", verifiedQueries: [] });
  const st = {
    app: null,          // /api/state
    draft: null,        // { id, name, location, description, spec }
    dirty: false,
    tab: "tables",
    issues: [], ddl: "",
    notes: [],          // notes about the open draft (import, or reading a node)
    notesTitle: "",
    picker: null,       // null | { replace: index | null }
    sel: null,          // join editor selection: { kind: "table", key: alias } | { kind: "rel", key: index }
    canvasScroll: { left: 0, top: 0 }, listScroll: {}, cardFilter: {}, keyChecks: {},
    pickerAll: false, pickerQuery: "",
    drift: null, driftBusy: false,
    deployed: null,     // last deploy result
    busy: "",           // "save" | "deploy"
    installing: false, installError: "",
    test: { metrics: new Set(), dimensions: new Set(), facts: new Set(), where: "", limit: 100, result: null, busy: false },
    version: -1,
  };

  let toastTimer;
  function toast(msg, err) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (err ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), err ? 7000 : 2600);
  }
  // In-page confirmation: the browser's own confirm dialog does nothing inside a sandboxed app frame.
  function ask(message, okLabel = "OK", detail = "", { danger = false } = {}) {
    return new Promise((resolve) => {
      const modal = $("modal");
      const done = (v) => { modal.classList.add("hidden"); modal.onclick = null; resolve(v); };
      const ok = h("button.primary" + (danger ? ".danger" : ""), { onclick: () => done(true) }, okLabel);
      modal.replaceChildren(h("div.box.small", h("h3", message), detail ? h("p.muted", { style: "white-space:pre-wrap;margin:6px 0 0" }, detail) : null,
        h("div.foot", h("button", { onclick: () => done(false) }, "Cancel"), ok)));
      modal.classList.remove("hidden");
      modal.onclick = (e) => { if (e.target === modal) done(false); };
      ok.focus();
    });
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  const source = (t) => st.app.sources.find((s) => s.location === t.location && s.name === t.node);
  const columnsOf = (alias) => { const t = st.draft.spec.tables.find((x) => x.alias === alias); const s = t && source(t); return s ? s.columns : []; };

  // ── Draft lifecycle ───────────────────────────────────────────────────────
  let checkTimer;
  function changed(rerender) {
    st.dirty = true;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(guard(runCheck), 350);
    if (rerender) render(); else renderHead();
  }
  async function runCheck() {
    if (!st.draft) return;
    const r = await api("check", st.draft);
    st.issues = r.issues; st.ddl = r.ddl;
    renderHead();
    if (st.tab === "sql" || st.tab === "issues") renderTab();
    else if (st.tab === "tables") refreshSelIssues();
  }
  const confirmDiscard = async () => !st.dirty || ask("Discard your unsaved changes to this view?", "Discard");
  function resetView() {
    st.drift = null; st.deployed = null; st.notes = []; st.picker = null;
    st.sel = null; st.canvasScroll = { left: 0, top: 0 }; st.listScroll = {}; st.cardFilter = {}; st.keyChecks = {};
    st.test = { metrics: new Set(), dimensions: new Set(), facts: new Set(), where: "", limit: 100, result: null, busy: false };
  }
  async function openView(id) {
    if (!(await confirmDiscard())) return;
    const v = await api(`view?id=${encodeURIComponent(id)}`);
    resetView();
    st.draft = { id: v.id, name: v.name, location: v.location, description: v.description, spec: v.spec };
    st.issues = v.issues; st.ddl = v.ddl; st.dirty = false; st.tab = "tables";
    st.notes = v.notes || []; st.notesTitle = "About this node:";
    render();
  }
  async function newView() {
    if (!(await confirmDiscard())) return;
    resetView();
    const loc = st.app.locations.find((l) => l.name === st.app.defaultLocation) || st.app.locations[0];
    st.draft = { id: null, name: "SV_", location: loc ? loc.name : "", description: "", spec: emptySpec() };
    st.issues = []; st.ddl = ""; st.dirty = true; st.tab = "tables"; st.picker = { replace: null };
    render();
    guard(runCheck)();
  }
  async function save() {
    st.busy = "save"; renderHead();
    try {
      const r = await api("save", st.draft);
      st.draft.id = r.id; st.issues = r.issues; st.ddl = r.ddl; st.dirty = false; st.notes = [];
      st.app = await api("state"); st.version = st.app.version;
      toast(`Saved ${r.file}`);
    } finally { st.busy = ""; render(); }
  }
  async function deploy() {
    if (st.dirty) await save();
    const target = `${loc().database}.${loc().schema}.${st.draft.name}`;
    if (!(await ask(`Create or replace ${target} in Snowflake?`, "Create", `Runs "coa create" for this node with the ${st.app.connection.profile} profile, as role ${st.app.connection.role}.`))) return;
    st.busy = "deploy"; renderHead();
    try {
      st.deployed = await api("deploy", { id: st.draft.id });
      st.drift = null;
      if (st.deployed.ok) toast(`Created ${target}`);
      st.tab = st.deployed.ok ? "test" : "issues";
    } finally { st.busy = ""; render(); }
  }
  async function removeView() {
    if (!st.draft.id) { if (!(await ask("Discard this draft?", "Discard", "", { danger: true }))) return; st.draft = null; st.dirty = false; return render(); }
    if (!(await ask(`Delete ${st.draft.name}?`, "Delete", `This removes nodes/${st.draft.location}-${st.draft.name}.yml from the workspace${st.dirty ? ", along with your unsaved changes" : ""}.\n\nThe view already created in your workspace schema is not dropped. In deployed environments, the next deploy of this change drops it.`, { danger: true }))) return;
    await api("delete", { id: st.draft.id });
    st.draft = null; st.dirty = false;
    st.app = await api("state"); st.version = st.app.version;
    render();
  }
  const loc = () => st.app.locations.find((l) => l.name === st.draft.location) || { database: "?", schema: "?" };
  // Why the app's own Snowflake queries (Test, Drift, Check in Snowflake) can't run, or "".
  // Create goes through coa and only needs a profile.
  const noQueries = () => st.app.connection.error || st.app.connection.queryError || "";

  // ── Sidebar and top bar ───────────────────────────────────────────────────
  function renderChrome() {
    const c = st.app.connection;
    const conn = $("conn");
    conn.className = "chip " + (c.error ? "err" : c.queryError ? "warn" : "ok");
    conn.textContent = c.error ? "Snowflake not connected" : [c.account, c.role, `profile ${c.profile}`].filter(Boolean).join(" · ");
    conn.title = c.error || c.queryError || `User ${c.user}, warehouse ${c.warehouse}`;
    const side = $("sidebar");
    side.replaceChildren(h("h4", `Semantic views (${st.app.views.length})`));
    if (!st.app.views.length) side.append(h("div.muted", { style: "padding:6px" }, "None in this workspace yet."));
    for (const v of st.app.views) {
      side.append(h("div.viewItem" + (st.draft && st.draft.id === v.id ? ".on" : ""), { onclick: guard(() => openView(v.id)) },
        h("div.name", v.name),
        h("div.meta", h("span", v.location), h("span", `${v.tables} tables`), h("span", `${v.fields} fields`),
          v.errors ? h("span.chip.err", `${v.errors} error${v.errors > 1 ? "s" : ""}`) : null,
          !v.errors && v.warnings ? h("span.chip.warn", `${v.warnings} warning${v.warnings > 1 ? "s" : ""}`) : null)));
    }
  }

  // ── Small controls ────────────────────────────────────────────────────────
  const field = (label, control) => h("label.field", label, control);
  function text(obj, key, opts = {}) {
    return h(opts.area ? "textarea" : "input", {
      value: obj[key] || "", placeholder: opts.placeholder || "", className: opts.code ? "code" : "", rows: opts.rows || 1, spellcheck: !opts.code,
      oninput: (e) => { obj[key] = e.target.value; changed(false); if (opts.after) opts.after(); },
    });
  }
  // Comma-separated list bound to an array.
  function listInput(obj, key, placeholder) {
    return h("input", { value: (obj[key] || []).join(", "), placeholder, oninput: (e) => { obj[key] = e.target.value.split(",").map((s) => s.trim()).filter(Boolean); changed(false); } });
  }
  function selectBox(value, options, onchange, placeholder) {
    const el = h("select", { onchange: (e) => onchange(e.target.value) });
    if (placeholder !== undefined) el.append(h("option", { value: "" }, placeholder));
    for (const o of options) el.append(h("option", { value: o.value ?? o }, o.label ?? o));
    if (value && !options.some((o) => (o.value ?? o) === value)) el.append(h("option", { value }, `${value} (missing)`));
    el.value = value || "";
    return el;
  }
  // Ordered column list: pills with remove, plus a select to add.
  function columnPills(columns, selected, onchange) {
    const box = h("div.pills");
    selected.forEach((c, i) => box.append(h("span.pill", c, h("button", { title: "Remove", onclick: () => { selected.splice(i, 1); onchange(); } }, "×"))));
    const rest = columns.filter((c) => !selected.includes(c.name));
    if (rest.length) box.append(selectBox("", rest.map((c) => ({ value: c.name, label: c.key ? `${c.name} (key)` : c.name })), (v) => { if (v) { selected.push(v); onchange(); } }, "+ column"));
    return box;
  }

  // ── Main ──────────────────────────────────────────────────────────────────
  // ── Setup: the app needs Coalesce's Semantic View package ────────────────
  // Coalesce has no way for an app to declare the packages it needs, so the app checks for
  // itself and offers to install the package, only with the user's go-ahead.
  async function installPackage() {
    const s = st.app.setup, c = st.app.connection;
    const ok = s.declared
      ? await ask("Download the Semantic View package?", "Download",
        `packages/${s.alias}.yml already declares it. This runs coa install${c.profile ? ` with the ${c.profile} profile` : ""} to download its node types from Coalesce to this machine. No workspace files change.`)
      : await ask("Install Coalesce's Semantic View package?", "Install",
        `This will:\n\n• Add packages/${s.alias}.yml, declaring ${s.packageID} ${s.tested}, the release this app is verified against. This is shared workspace configuration: once you commit it, everyone who uses this workspace gets the package.\n\n• Run coa install${c.profile ? ` with the ${c.profile} profile` : ""} to download the package from Coalesce.\n\nIf the download fails, the app removes the file again. You can also install it yourself from Build Settings → Packages.`);
    if (!ok) return;
    st.installing = true; st.installError = ""; render();
    try {
      const r = await api("install-package", { confirm: true });
      await refresh();
      toast(r.wrote ? `Installed the Semantic View package (${r.version || s.tested}). Added ${r.wrote}.` : "The Semantic View package is ready.");
    } catch (e) { st.installError = e.message; }
    finally { st.installing = false; render(); }
  }
  function setupScreen() {
    const s = st.app.setup;
    return h("div.empty.setup",
      h("h2", "This app needs Coalesce's Semantic View package"),
      h("p", "Each semantic view is saved as a node of the package's Semantic View node type. The package's template creates, replaces and drops the view in Snowflake, and the nodes also open in Coalesce's own config panel."),
      s.declared && !s.hydrated ? h("p", `packages/${s.alias}.yml declares the package, but it has not been downloaded to this machine yet.`) : null,
      st.installError ? h("div.banner.err", { style: "text-align:left" }, st.installError) : null,
      h("div.actions",
        h("button.primary", { disabled: !!st.installing, onclick: guard(installPackage) }, st.installing ? (s.declared ? "Downloading…" : "Installing…") : s.declared ? "Download the package" : "Install the package")),
      s.declared ? null : h("p.muted", { style: "margin-top:16px;font-size:12px" }, `Or install it yourself: Build Settings → Packages → Install, package ID ${s.packageID}. The app picks it up automatically.`));
  }

  function render() {
    renderChrome();
    const main = $("main");
    const blocked = !!(st.app.setup && st.app.setup.needed);
    $("btnNew").disabled = blocked; $("btnImport").disabled = blocked;
    if (blocked) { main.replaceChildren(setupScreen()); return; }
    if (!st.draft) {
      main.replaceChildren(h("div.empty",
        h("h2", "Build semantic views on your Coalesce nodes"),
        h("p", "Pick dimensions and facts from this workspace, define how they join, and describe the facts, dimensions and metrics people can ask for. Each view is saved as a node of Coalesce's Semantic View package, so it deploys with the rest of the pipeline."),
        h("div.actions", h("button.primary", { onclick: guard(newView) }, "New semantic view"), h("button", { onclick: guard(openImport) }, "Import from Snowflake"))));
      return;
    }
    main.replaceChildren(h("div", { id: "head" }), h("div", { id: "tab" }));
    renderHead();
    renderTab();
  }

  const TABS = [["tables", "Tables and joins"], ["fields", "Fields"], ["ai", "Cortex Analyst"], ["sql", "SQL"], ["test", "Test"], ["drift", "Drift"], ["issues", "Issues"]];
  function renderHead() {
    const head = $("head");
    if (!head) return;
    const active = document.activeElement && head.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    const d = st.draft, s = d.spec;
    const errors = st.issues.filter((i) => i.level === "error").length, warnings = st.issues.length - errors;
    const counts = { tables: s.tables.length, fields: s.facts.length + s.dimensions.length + s.metrics.length, ai: s.verifiedQueries.length || "" };
    const nameIn = h("input.code", { value: d.name, "data-k": "name", placeholder: "SV_NAME", oninput: (e) => { d.name = e.target.value.trim(); changed(false); } });
    const descIn = h("input", { value: d.description, "data-k": "desc", placeholder: "What this view is for. Cortex Analyst reads this.", oninput: (e) => { d.description = e.target.value; changed(false); } });
    head.replaceChildren(
      h("div.head",
        field("View name", nameIn),
        field("Location", selectBox(d.location, st.app.locations.map((l) => l.name), (v) => { d.location = v; changed(false); })),
        field("Description", descIn)),
      h("div.headbar",
        h("span.chip", { title: "Where this workspace creates the view" }, `${loc().database}.${loc().schema}.${d.name || "?"}`),
        st.dirty ? h("span.chip.warn", d.id ? "Unsaved changes" : "Not saved yet") : h("span.chip.ok", "Saved"),
        errors ? h("button.chip.err", { title: "Show the issues", onclick: () => { st.tab = "issues"; renderHead(); renderTab(); } }, `${errors} error${errors > 1 ? "s" : ""}`) : null,
        warnings ? h("button.chip.warn", { title: "Show the issues", onclick: () => { st.tab = "issues"; renderHead(); renderTab(); } }, `${warnings} warning${warnings > 1 ? "s" : ""}`) : null,
        h("span.spacer"),
        h("button.danger", { disabled: !!st.busy, title: d.id ? "Delete this semantic view's node" : "Discard this unsaved draft", onclick: guard(removeView) }, d.id ? "Delete" : "Discard draft"),
        h("button", { disabled: !!st.busy || !st.dirty, onclick: guard(save) }, st.busy === "save" ? "Saving…" : "Save"),
        h("button.primary", { disabled: !!st.busy || !!errors || !!st.app.connection.error, title: errors ? "Fix the errors first" : "Runs coa create for this node", onclick: guard(deploy) }, st.busy === "deploy" ? "Creating…" : "Create in workspace schema")),
      h("div.tabs", TABS.map(([k, label]) => h("button" + (st.tab === k ? ".on" : ""), { onclick: () => { st.tab = k; renderHead(); renderTab(); } }, label,
        k === "issues" ? (st.issues.length ? h("span.count." + (errors ? "err" : "warn"), st.issues.length) : null) : counts[k] ? h("span.count", counts[k]) : null))));
    if (active) { const el = head.querySelector(`[data-k="${active}"]`); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  }

  function renderTab() {
    const el = $("tab");
    if (!el) return;
    const out = [];
    const su = st.app.setup;
    if (su.installed && su.installed !== su.tested) out.push(h("div.banner", `This workspace has Semantic View package ${su.installed}; the app is verified against ${su.tested}. If the SQL tab looks different from what the package creates, run npm test in the app folder to compare.`));
    if (st.notes.length) out.push(h("div.banner", st.notesTitle || "Review before saving:", h("ul", st.notes.map((n) => h("li", n)))));
    out.push({ tables: tabTables, fields: tabFields, ai: tabAI, sql: tabSQL, test: tabTest, drift: tabDrift, issues: tabIssues }[st.tab]());
    el.replaceChildren(...out.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
  }

  // ── Tables and joins: diagram + inspector ─────────────────────────────────
  // Tables are cards on a canvas; a join is drawn by dragging from a column to a column of
  // another table. A join points from the many side to the table it looks up; the arrow
  // ends at the looked-up table, labelled with the cardinality the declared keys imply.
  const CARD_W = 256, ROW_H = 24, MAX_ROWS = 10, GAP_X = 370;
  const SVGNS = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const shortType = (t) => String(t || "").replace(/\(.*$/, "").replace(/^TIMESTAMP_/, "TS_");
  const tableBy = (alias) => st.draft.spec.tables.find((t) => t.alias === alias);
  const sameSet = (a, b) => a.length > 0 && a.length === b.length && a.every((c) => b.includes(c));
  const isKeyOf = (t, cols) => !!t && (sameSet(t.primaryKey, cols) || (t.unique || []).some((u) => sameSet(u, cols)));
  function cardinalityOf(r) {
    const to = isKeyOf(tableBy(r.to), r.toColumns), from = isKeyOf(tableBy(r.from), r.fromColumns);
    return to ? (from ? "one-to-one" : "many-to-one") : "many-to-many";
  }
  const CARD_LABEL = { "many-to-one": "N : 1", "one-to-one": "1 : 1", "many-to-many": "N : N" };
  const relWhere = (r) => `relationship ${r.name || `${r.from} → ${r.to}`}`;
  const relBroken = (r) => !r.fromColumns.length || r.fromColumns.length !== r.toColumns.length || !tableBy(r.from) || !tableBy(r.to);
  function joinedColumns(alias) {
    const out = new Set();
    for (const r of st.draft.spec.relationships) { if (r.from === alias) r.fromColumns.forEach((c) => out.add(c)); if (r.to === alias) r.toColumns.forEach((c) => out.add(c)); }
    return out;
  }
  function cardHeight(t) {
    const s = source(t), n = s ? s.columns.length : 0;
    return 50 + (t.primaryKey.length ? 15 : 0) + (n > MAX_ROWS ? 32 : 0) + Math.max(1, Math.min(n, MAX_ROWS)) * ROW_H + 6;
  }
  // Place tables without a position: tables that look others up on the left, the tables
  // they look up one column to the right, and so on.
  function ensureLayout(arrange) {
    const spec = st.draft.spec;
    if (arrange) spec.layout = {};
    const L = spec.layout || (spec.layout = {});
    const missing = spec.tables.filter((t) => !L[t.alias]);
    if (!missing.length) return;
    // Unjoined tables: facts on the left, everything else one column over.
    const isFact = (t) => { const s = source(t); return /fact/i.test((s && s.type) || "") || /^(FCT|FACT)_/i.test(t.node); };
    const joinedSet = new Set(spec.relationships.flatMap((r) => [r.from, r.to]));
    const level = Object.fromEntries(spec.tables.map((t) => [t.alias, joinedSet.has(t.alias) || isFact(t) ? 0 : 1]));
    for (let i = 0; i < spec.tables.length; i++) for (const r of spec.relationships) {
      if (r.from in level && r.to in level && r.from !== r.to) level[r.to] = Math.min(Math.max(level[r.to], level[r.from] + 1), spec.tables.length);
    }
    const bottom = {};
    for (const t of spec.tables) if (L[t.alias]) { const c = Math.max(0, Math.round((L[t.alias].x - 24) / GAP_X)); bottom[c] = Math.max(bottom[c] || 0, L[t.alias].y + cardHeight(t) + 30); }
    for (const t of missing) { const c = level[t.alias]; const y = bottom[c] || 24; L[t.alias] = { x: 24 + c * GAP_X, y }; bottom[c] = y + cardHeight(t) + 30; }
  }
  function select(sel) { st.sel = sel; renderTab(); }
  const selected = (kind, key) => st.sel && st.sel.kind === kind && st.sel.key === key;

  function nodePicker() {
    const p = st.picker;
    const listEl = h("div.list");
    const fill = () => {
      const q = st.pickerQuery.toLowerCase();
      const rows = st.app.sources.filter((s) => (st.pickerAll || s.modeled) && (!q || `${s.location}.${s.name} ${s.description}`.toLowerCase().includes(q)));
      listEl.replaceChildren(...rows.slice(0, 200).map((s) => h("div.item", { onclick: guard(() => pickNode(s, p.replace)) },
        h("span.nodeName", s.name), h("span.muted", s.location), h("span.muted", s.type), h("span.d", { title: s.description }, `${s.columns.length} columns${s.description ? " · " + s.description : ""}`))));
      if (!rows.length) listEl.append(h("div.muted", { style: "padding:10px" }, st.pickerAll ? "No nodes match." : "No dimensions or facts match. Tick “All nodes” to search everything."));
      else if (rows.length > 200) listEl.append(h("div.muted", { style: "padding:8px" }, `Showing 200 of ${rows.length}. Type to narrow.`));
    };
    const search = h("input", { type: "search", placeholder: p.replace !== null && p.replace !== undefined ? `Choose the node for ${st.draft.spec.tables[p.replace].alias}` : "Search nodes by name or description", value: st.pickerQuery, oninput: (e) => { st.pickerQuery = e.target.value; fill(); } });
    fill();
    setTimeout(() => search.focus());
    return h("div.picker",
      h("div.row", search,
        h("label.check", h("input", { type: "checkbox", checked: st.pickerAll, onchange: (e) => { st.pickerAll = e.target.checked; fill(); } }), "All nodes"),
        h("button", { onclick: () => { st.picker = null; renderTab(); } }, "Close")),
      listEl);
  }
  async function pickNode(s, replace) {
    const spec = st.draft.spec;
    if (replace !== null && replace !== undefined) { // re-point an existing table at a node
      Object.assign(spec.tables[replace], { location: s.location, node: s.name });
      st.picker = null;
      return changed(true);
    }
    if (spec.tables.some((t) => t.location === s.location && t.node === s.name) && !(await ask(`${s.name} is already in this view. Add it again under another alias?`, "Add again", "Use a second alias when the same table plays two roles, such as order date and ship date."))) return;
    const r = await api("suggest", { spec, add: { location: s.location, node: s.name } });
    spec.tables.push(r.table);
    st.picker = null;
    const n = r.fields.dimensions.length + r.fields.facts.length;
    if (n && (await ask(`Add starter fields for ${s.name}?`, "Add fields", `${r.fields.dimensions.length} dimensions, ${r.fields.facts.length} facts and ${r.fields.metrics.length} SUM metrics, one per column. You can edit or remove them on the Fields tab.`))) {
      for (const k of ["facts", "dimensions", "metrics"]) spec[k].push(...r.fields[k]);
    }
    if (r.relationships.length) {
      spec.relationships.push(...r.relationships);
      toast(`Drew ${r.relationships.length} join${r.relationships.length > 1 ? "s" : ""} where key column names match. Click a line to check it.`);
    }
    st.sel = { kind: "table", key: r.table.alias };
    changed(true);
  }
  function renameAlias(t, next) {
    const prev = t.alias, spec = st.draft.spec;
    t.alias = next;
    if (spec.layout && spec.layout[prev]) { spec.layout[next] = spec.layout[prev]; delete spec.layout[prev]; }
    if (st.sel && st.sel.kind === "table" && st.sel.key === prev) st.sel.key = next;
    if (!prev || !/^[A-Za-z_][\w$]*$/.test(next)) return;
    const re = new RegExp(`(?<![\\w$."])${prev}(?=\\s*\\.)`, "g");
    for (const r of spec.relationships) { if (r.from === prev) r.from = next; if (r.to === prev) r.to = next; }
    for (const k of ["facts", "dimensions", "metrics"]) for (const f of spec[k]) { if (f.table === prev) f.table = next; f.expr = f.expr.replace(re, next); }
  }
  async function removeTable(t) {
    const spec = st.draft.spec;
    const used = ["facts", "dimensions", "metrics"].reduce((n, k) => n + spec[k].filter((f) => f.table === t.alias).length, 0);
    const joins = spec.relationships.filter((r) => r.from === t.alias || r.to === t.alias).length;
    if ((used || joins) && !(await ask(`Remove ${t.alias}?`, "Remove", `Its ${used} field${used === 1 ? "" : "s"} and ${joins} join${joins === 1 ? "" : "s"} are removed too.`))) return;
    spec.tables.splice(spec.tables.indexOf(t), 1);
    spec.relationships = spec.relationships.filter((r) => r.from !== t.alias && r.to !== t.alias);
    for (const k of ["facts", "dimensions", "metrics"]) spec[k] = spec[k].filter((f) => f.table !== t.alias);
    if (spec.layout) delete spec.layout[t.alias];
    st.sel = null;
    changed(true);
  }
  function uniqueRelName(from, to) {
    const names = new Set(st.draft.spec.relationships.map((r) => r.name.toUpperCase()));
    let base = `${from}_to_${to}`.toUpperCase(), n = base, i = 2;
    while (names.has(n)) n = `${base}_${i++}`;
    return n;
  }
  // Composite keys: a key is a list of columns that together identify one row.
  const colNames = (t) => ((t && source(t)) || { columns: [] }).columns.map((c) => c.name);
  const sameName = (cols, name) => cols.find((c) => c.toUpperCase() === String(name || "").toUpperCase());
  // The key of t (primary key first, then unique keys) that contains every column in cols.
  const keyContaining = (t, cols) => (t ? [t.primaryKey, ...(t.unique || [])].find((k) => k.length && cols.length && cols.every((c) => k.includes(c))) : null) || null;
  // Join pairs follow the key's column order; an as-of pair stays last.
  function orderPairs(r, key) {
    const pairs = r.fromColumns.map((f, k) => [f, r.toColumns[k]]);
    const last = r.asof ? pairs.pop() : null;
    const rank = (t) => (key.includes(t) ? key.indexOf(t) : key.length);
    pairs.sort((x, y) => rank(x[1]) - rank(y[1]));
    if (last) pairs.push(last);
    r.fromColumns = pairs.map((x) => x[0]); r.toColumns = pairs.map((x) => x[1]);
  }
  // Add pairs for the key columns of r.to that r does not match yet, using the column of
  // r.from with the same name. Returns the key columns still unmatched.
  function completeKey(r) {
    const key = keyContaining(tableBy(r.to), r.toColumns.filter(Boolean));
    if (!key) return [];
    const missing = [];
    for (const k of key) {
      if (r.toColumns.includes(k)) continue;
      const f = sameName(colNames(tableBy(r.from)).filter((c) => !r.fromColumns.includes(c)), k);
      if (!f) { missing.push(k); continue; }
      const at = r.asof ? r.fromColumns.length - 1 : r.fromColumns.length;
      r.fromColumns.splice(at, 0, f); r.toColumns.splice(at, 0, k);
    }
    orderPairs(r, key);
    return missing;
  }
  // A drag from column aCol of table a, dropped on column bCol of table b (or on the card, bCol null).
  function connect(a, aCol, b, bCol) {
    const spec = st.draft.spec, A = tableBy(a), B = tableBy(b);
    if (!bCol) { // dropped on the card: start from its key column with the same name
      const key = B.primaryKey.length ? B.primaryKey : (B.unique[0] || []);
      bCol = sameName(key, aCol) || (key.length === 1 ? key[0] : null) || sameName(colNames(B), aCol)
        || key.find((k) => !spec.relationships.some((r) => r.from === a && r.to === b && r.toColumns.includes(k))) || null;
    }
    const keyish = (t, c) => !!keyContaining(t, [c]);
    let from = a, fc = aCol, to = b, tc = bCol;
    // Point the join at the side whose column is a key: that is the table being looked up.
    if (tc && !keyish(B, tc) && keyish(A, fc)) [from, fc, to, tc] = [b, bCol, a, aCol];
    const key = tc ? keyContaining(tableBy(to), [tc]) : null;
    // A further column of a composite key extends the join that already matches part of it.
    const ext = key && spec.relationships.find((r) => r.from === from && r.to === to && !r.toColumns.includes(tc) && !r.fromColumns.includes(fc)
      && r.toColumns.length < key.length && r.toColumns.every((c) => key.includes(c)));
    let r;
    if (ext) {
      r = ext;
      const at = r.asof ? r.fromColumns.length - 1 : r.fromColumns.length;
      r.fromColumns.splice(at, 0, fc); r.toColumns.splice(at, 0, tc);
    } else {
      r = { name: uniqueRelName(from, to), from, fromColumns: [fc], to, toColumns: tc ? [tc] : [], asof: false };
      spec.relationships.push(r);
    }
    const missing = key ? completeKey(r) : [];
    st.sel = { kind: "rel", key: spec.relationships.indexOf(r) };
    const card = cardinalityOf(r);
    const on = r.fromColumns.map((f, k) => `${f} = ${r.toColumns[k]}`).join(", ");
    if (!tc) toast(`Pick the ${to} column that ${from}.${fc} matches.`);
    else if (key && key.length > 1 && missing.length) toast(`Matched ${key.length - missing.length} of the ${key.length} key columns of ${to}. Pick the column for ${missing.join(", ")} in the panel.`, true);
    else if (key && key.length > 1) toast(`${from} → ${to} on the whole key: ${on} · ${card}`);
    else toast(`${from} → ${to} on ${on}${ext ? ` (added to ${r.name})` : ""} · ${card}${card === "many-to-many" ? `: ${to} has no key on ${r.toColumns.join(", ")}` : ""}`, card === "many-to-many");
    changed(true);
  }

  // Pointer gestures on the canvas: drag a card header to move it, drag a column to join.
  function onCardHeaderDown(e, t) {
    if (e.button !== 0 || e.target.closest("input,button")) return;
    e.preventDefault();
    const L = st.draft.spec.layout, start = { x: e.clientX, y: e.clientY }, orig = { ...L[t.alias] };
    const card = e.currentTarget.closest(".jcard");
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      card.classList.add("moving");
      L[t.alias] = { x: Math.max(0, Math.round((orig.x + dx) / 8) * 8), y: Math.max(0, Math.round((orig.y + dy) / 8) * 8) };
      card.style.left = L[t.alias].x + "px"; card.style.top = L[t.alias].y + "px";
      sizeCanvas(); drawEdges();
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      card.classList.remove("moving");
      if (moved) changed(false); else select({ kind: "table", key: t.alias });
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }
  function onColumnDown(e, t, col) {
    if (e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    const content = document.querySelector(".jcontent"), overlay = content.querySelector("svg.jdrag");
    const start = { x: e.clientX, y: e.clientY };
    const row = e.currentTarget;
    let moved = false, target = null;
    const path = svgEl("path", { class: "jtemp" });
    const clear = () => content.querySelectorAll(".jdrop").forEach((x) => x.classList.remove("jdrop"));
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      if (!moved) { moved = true; overlay.append(path); content.classList.add("connecting"); row.classList.add("jsource"); }
      const base = content.getBoundingClientRect(), rr = row.getBoundingClientRect();
      const right = ev.clientX >= rr.left + rr.width / 2;
      const ax = (right ? rr.right : rr.left) - base.left, ay = rr.top + rr.height / 2 - base.top;
      const bx = ev.clientX - base.left, by = ev.clientY - base.top, dx = Math.max(40, Math.abs(bx - ax) / 2) * (right ? 1 : -1);
      path.setAttribute("d", `M${ax},${ay} C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`);
      clear();
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const card = el && el.closest(".jcard");
      target = null;
      if (card && card.dataset.alias !== t.alias) {
        const colEl = el.closest(".jcol");
        target = { alias: card.dataset.alias, col: colEl ? colEl.dataset.col : null };
        (colEl || card).classList.add("jdrop");
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      path.remove(); clear(); content.classList.remove("connecting"); row.classList.remove("jsource");
      if (!moved) return select({ kind: "table", key: t.alias });
      if (target) connect(t.alias, col, target.alias, target.col);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }

  function tableCard(t, index) {
    const s = source(t), cols = s ? s.columns : [];
    const pos = st.draft.spec.layout[t.alias];
    const joined = joinedColumns(t.alias), pk = new Set(t.primaryKey);
    const ordered = cols; // node order, so rows never move under the pointer
    const filter = (st.cardFilter[t.alias] || "").toLowerCase();
    const shown = filter ? ordered.filter((c) => c.name.toLowerCase().includes(filter) || joined.has(c.name) || pk.has(c.name)) : ordered;
    const tableIssues = st.issues.filter((i) => i.where === `table ${t.alias}`);
    const list = h("div.jcols", { style: `max-height:${MAX_ROWS * ROW_H}px`, onscroll: (e) => { st.listScroll[t.alias] = e.target.scrollTop; drawEdges(); } },
      shown.map((c) => h("div.jcol" + (pk.has(c.name) ? ".pk" : "") + (joined.has(c.name) ? ".joined" : ""), {
        "data-col": c.name, title: `${c.name} ${c.dataType || ""}${c.description ? "\n" + c.description : ""}\nDrag onto a column of another table to join.`,
        onpointerdown: (e) => onColumnDown(e, t, c.name),
      },
      h("button.jkey", { title: pk.has(c.name) ? `Remove from the primary key${pk.size > 1 ? " (column " + (t.primaryKey.indexOf(c.name) + 1) + " of " + pk.size + ")" : ""}` : pk.size ? `Add to the primary key as column ${pk.size + 1}, making a composite key` : "Make this the primary key", onclick: () => {
        if (pk.has(c.name)) t.primaryKey.splice(t.primaryKey.indexOf(c.name), 1); else t.primaryKey.push(c.name);
        changed(true);
      } }, pk.size > 1 && pk.has(c.name) ? `PK${t.primaryKey.indexOf(c.name) + 1}` : "PK"),
      h("span.jname", c.name), h("span.jtype", shortType(c.dataType)))));
    if (!cols.length) list.append(h("div.muted", { style: "padding:6px 10px" }, s ? "No columns" : "Not a node in this workspace"));
    return h("div.jcard" + (selected("table", t.alias) ? ".on" : "") + (!s || tableIssues.some((i) => i.level === "error") ? ".bad" : ""), { "data-alias": t.alias, style: `left:${pos.x}px;top:${pos.y}px;width:${CARD_W}px` },
      h("div.jhead", { onpointerdown: (e) => onCardHeaderDown(e, t), title: "Drag to move. Click to edit." },
        h("div.jalias", t.alias, t.primaryKey.length ? null : h("span.chip.warn", { title: "No primary key: joins to this table are many-to-many" }, "no key")),
        h("div.jnode", `${t.location}.${t.node}`, s ? h("span.muted", ` · ${s.type}`) : null),
        t.primaryKey.length ? h("div.jkeyline", { title: t.primaryKey.length > 1 ? "Composite primary key: these columns together identify one row" : "Primary key" }, `key ${t.primaryKey.join(" + ")}`) : null),
      cols.length > MAX_ROWS ? h("input.jfilter", { type: "search", placeholder: `Filter ${cols.length} columns`, value: st.cardFilter[t.alias] || "", oninput: (e) => {
        st.cardFilter[t.alias] = e.target.value;
        const pos2 = e.target.selectionStart;
        renderTab();
        const again = document.querySelector(`.jcard[data-alias="${CSS.escape(t.alias)}"] .jfilter`);
        if (again) { again.focus({ preventScroll: true }); again.setSelectionRange(pos2, pos2); }
      } }) : null,
      list);
  }

  function sizeCanvas() {
    const content = document.querySelector(".jcontent");
    if (!content) return;
    const spec = st.draft.spec;
    let w = 0, hgt = 0;
    for (const t of spec.tables) { const p = spec.layout[t.alias]; if (!p) continue; w = Math.max(w, p.x + CARD_W); hgt = Math.max(hgt, p.y + cardHeight(t)); }
    content.style.width = w + 240 + "px"; content.style.height = hgt + 160 + "px";
  }
  function drawEdges() {
    const content = document.querySelector(".jcontent");
    if (!content) return;
    const svg = content.querySelector("svg.jedges"), labels = content.querySelector("svg.jlabels");
    svg.querySelectorAll(".edge").forEach((x) => x.remove());
    labels.replaceChildren();
    const base = content.getBoundingClientRect();
    for (const layer of [svg, labels]) { layer.setAttribute("width", content.scrollWidth); layer.setAttribute("height", content.scrollHeight); }
    const cardOf = (alias) => content.querySelector(`.jcard[data-alias="${CSS.escape(alias)}"]`);
    const anchor = (card, col, side) => {
      const cr = card.getBoundingClientRect();
      const x = (side === "right" ? cr.right : cr.left) - base.left;
      const row = col && card.querySelector(`.jcol[data-col="${CSS.escape(col)}"]`);
      if (!row) return { x, y: cr.top + 22 - base.top, clipped: true };
      const rr = row.getBoundingClientRect(), lr = card.querySelector(".jcols").getBoundingClientRect();
      const mid = rr.top + rr.height / 2, y = Math.min(Math.max(mid, lr.top + 3), lr.bottom - 3);
      return { x, y: y - base.top, clipped: y !== mid };
    };
    st.draft.spec.relationships.forEach((r, i) => {
      const A = cardOf(r.from), B = cardOf(r.to);
      if (!A || !B || A === B) return;
      const ar = A.getBoundingClientRect(), br = B.getBoundingClientRect();
      // Sides facing each other; when the cards overlap horizontally, loop out on the right.
      let sa = "right", sb = "left";
      if (br.left >= ar.right - 20) [sa, sb] = ["right", "left"];
      else if (ar.left >= br.right - 20) [sa, sb] = ["left", "right"];
      else [sa, sb] = ["right", "right"];
      const card = cardinalityOf(r), broken = relBroken(r), sel = selected("rel", i);
      const cls = `edge ${sel ? "sel" : ""} ${broken || card === "many-to-many" ? "warn" : ""}`;
      const g = svgEl("g", { class: cls });
      const n = Math.max(r.fromColumns.length, r.toColumns.length, 1);
      let mid = null;
      for (let k = 0; k < n; k++) {
        const p = anchor(A, r.fromColumns[k], sa), q = anchor(B, r.toColumns[k], sb);
        const dirA = sa === "right" ? 1 : -1, dirB = sb === "right" ? 1 : -1;
        const dx = Math.max(36, Math.abs(q.x - p.x) / 2);
        const d = `M${p.x},${p.y} C${p.x + dx * dirA},${p.y} ${q.x + dx * dirB},${q.y} ${q.x},${q.y}`;
        const asofPair = r.asof && k === n - 1;
        g.append(svgEl("path", { d, class: "hit" }));
        g.append(svgEl("path", { d, class: `line${p.clipped || q.clipped || broken ? " dashed" : ""}${asofPair ? " asof" : ""}`, "marker-end": `url(#jarrow${sel ? "Sel" : broken || card === "many-to-many" ? "Warn" : ""})` }));
        g.append(svgEl("circle", { cx: p.x, cy: p.y, r: 3, class: "dot" }));
        if (!mid) mid = { x: (p.x + q.x) / 2 + (sa === sb ? dx * dirA * 0.75 : 0), y: (p.y + q.y) / 2 };
      }
      const label = CARD_LABEL[card] + (r.asof ? " · ASOF" : "");
      const w = label.length * 6.6 + 14;
      // The label sits on a layer above the cards so a narrow gap never hides it.
      const lg = svgEl("g", { class: cls });
      const lab = svgEl("g", { class: "label", transform: `translate(${mid.x - w / 2},${mid.y - 10})` });
      lab.append(svgEl("rect", { width: w, height: 20, rx: 10 }));
      const tx = svgEl("text", { x: w / 2, y: 14, "text-anchor": "middle" }); tx.textContent = label; lab.append(tx);
      lg.append(lab);
      const tip = `${r.name || "join"}: ${r.from} (${r.fromColumns.join(", ")}) → ${r.to} (${r.toColumns.join(", ")}), ${card}`;
      for (const x of [g, lg]) {
        const title = svgEl("title"); title.textContent = tip; x.append(title);
        x.addEventListener("pointerdown", (e) => e.stopPropagation());
        x.addEventListener("click", () => select({ kind: "rel", key: i }));
        x.addEventListener("pointerenter", () => { g.classList.add("hover"); lg.classList.add("hover"); });
        x.addEventListener("pointerleave", () => { g.classList.remove("hover"); lg.classList.remove("hover"); });
      }
      svg.append(g); labels.append(lg);
    });
  }
  window.addEventListener("resize", () => drawEdges());
  document.addEventListener("keydown", (e) => {
    if (!st.draft || st.tab !== "tables" || !st.sel || st.sel.kind !== "rel") return;
    if (!["Delete", "Backspace"].includes(e.key) || e.target.closest("input,textarea,select")) return;
    e.preventDefault();
    st.draft.spec.relationships.splice(st.sel.key, 1); st.sel = null; changed(true);
  });

  // Inspector: what is selected on the canvas.
  function issueList(where) {
    // The partial-key banner already explains that case, with a fix button.
    const sel = st.sel && st.sel.kind === "rel" && st.draft.spec.relationships[st.sel.key];
    const list = st.issues.filter((i) => i.where === where && !(sel && partOfKey(sel) && /^The key of /.test(i.message)));
    return h("div", { id: "selIssues", "data-where": where }, list.map((i) => h("div.banner" + (i.level === "error" ? ".err" : ""), { style: "margin:8px 0 0" }, i.message)));
  }
  function refreshSelIssues() {
    const el = document.getElementById("selIssues");
    if (el) el.replaceWith(issueList(el.dataset.where));
    const loop = document.getElementById("loopIssues");
    if (loop) loop.replaceWith(loopBanner());
  }
  const loopBanner = () => h("div", { id: "loopIssues" }, st.issues.filter((i) => i.where === "joins").map((i) => h("div.banner.err", i.message)));
  const partOfKey = (r) => { const T = tableBy(r.to), have = r.toColumns.filter(Boolean); return T && [T.primaryKey, ...(T.unique || [])].find((k) => k.length > have.length && have.length && have.every((c) => k.includes(c))); };
  function joinSentence(r) {
    const card = cardinalityOf(r), keyName = (t, cols) => (sameSet(t.primaryKey, cols) ? "the primary key" : "a unique key");
    const T = tableBy(r.to);
    if (!r.toColumns.length) return `Choose the ${r.to} column${r.fromColumns.length > 1 ? "s" : ""} to match.`;
    const match = r.asof
      ? `Each ${r.from} row matches the latest ${r.to} row whose ${r.toColumns[r.toColumns.length - 1]} is at or before its ${r.fromColumns[r.fromColumns.length - 1]}${r.fromColumns.length > 1 ? `, with ${r.fromColumns.slice(0, -1).join(", ")} equal` : ""}.`
      : `Each ${r.from} row matches ${r.to} rows where ${r.fromColumns.map((c, k) => `${c} = ${r.toColumns[k] || "?"}`).join(" and ")}.`;
    if (card === "many-to-many" && partOfKey(r)) return `${match} That matches only part of the key of ${r.to} (${partOfKey(r).join(" + ")}), so one ${r.from} row can match many ${r.to} rows.`;
    if (card === "many-to-many") return `${match} ${r.toColumns.join(", ")} is not a key of ${r.to}, so one ${r.from} row can match many ${r.to} rows. Snowflake runs this as a many-to-many relationship (preview). Usually the fix is to set the primary key of ${r.to}, or to join on it.`;
    return `${match} That is at most one ${r.to} row, because ${r.toColumns.join(", ")} is ${keyName(T, r.toColumns)} of ${r.to}.${card === "one-to-one" ? ` ${r.fromColumns.join(", ")} is also a key of ${r.from}, so this is one-to-one.` : ""}`;
  }
  // When a join matches only some columns of a composite key, offer to match the rest.
  function partialKeyBanner(r) {
    const T = tableBy(r.to), have = r.toColumns.filter(Boolean);
    const key = T && [T.primaryKey, ...(T.unique || [])].find((k) => k.length > have.length && have.length && have.every((c) => k.includes(c)));
    if (!key) return null;
    const rest = key.filter((c) => !have.includes(c));
    return h("div.banner", `The key of ${r.to} is ${key.join(" + ")}. Match ${rest.join(" and ")} too, or one ${r.from} row can match many ${r.to} rows.`,
      h("div", { style: "margin-top:6px" }, h("button", { onclick: () => {
        const missing = completeKey(r);
        for (const k of missing) { const at = r.asof ? r.fromColumns.length - 1 : r.fromColumns.length; r.fromColumns.splice(at, 0, ""); r.toColumns.splice(at, 0, k); }
        orderPairs(r, key);
        toast(missing.length ? `Pick the ${r.from} column for ${missing.join(", ")}.` : `Now matching the whole key of ${r.to}.`);
        changed(true);
      } }, `Match the rest of the key`)));
  }
  function relInspector(r, i) {
    const spec = st.draft.spec, aliases = spec.tables.map((t) => t.alias);
    const colsOf = (alias) => (source(tableBy(alias) || {}) || { columns: [] }).columns;
    const n = Math.max(r.fromColumns.length, r.toColumns.length);
    const pairs = [];
    for (let k = 0; k < n; k++) {
      const asofPair = r.asof && k === n - 1;
      pairs.push(h("div.pair",
        selectBox(r.fromColumns[k] || "", colsOf(r.from).map((c) => c.name), (v) => { r.fromColumns[k] = v; changed(true); }, "column"),
        h("span.op", { title: asofPair ? "as-of: at or before" : "equals" }, asofPair ? "≥" : "="),
        selectBox(r.toColumns[k] || "", colsOf(r.to).map((c) => ({ value: c.name, label: (tableBy(r.to).primaryKey.includes(c.name) ? "🔑 " : "") + c.name })), (v) => { r.toColumns[k] = v; changed(true); }, "column"),
        h("button.icon", { title: "Remove this column pair", onclick: () => { r.fromColumns.splice(k, 1); r.toColumns.splice(k, 1); changed(true); } }, "×")));
    }
    const card = cardinalityOf(r);
    return h("div.inspector",
      h("div.ihead", h("span.ititle", `${r.from || "?"} → ${r.to || "?"}`), h("span.chip." + (card === "many-to-many" ? "warn" : "ok"), card)),
      h("p.isent", joinSentence(r)),
      field("Name", fix("name", h("input.code", { value: r.name, placeholder: "optional", oninput: (e) => { r.name = e.target.value.trim(); changed(false); } }))),
      h("div.two",
        field("From (many side)", fix("from", selectBox(r.from, aliases, (v) => { r.from = v; r.fromColumns = r.fromColumns.map(() => ""); changed(true); }))),
        field("Looks up", fix("to", selectBox(r.to, aliases, (v) => { r.to = v; r.toColumns = r.toColumns.map(() => ""); changed(true); })))),
      fix("columns", h("div.ilabel", "Matching columns")),
      pairs,
      partialKeyBanner(r),
      h("div.toolbar", h("button", { disabled: n >= 1, title: n >= 1 ? `${NS}: a join matches one column, the primary key of the looked-up table` : "", onclick: () => {
        const T = tableBy(r.to), next = T && T.primaryKey.find((c) => !r.toColumns.includes(c));
        const at = r.asof ? Math.max(0, n - 1) : n;
        r.fromColumns.splice(at, 0, next && colsOf(r.from).some((c) => c.name === next) ? next : "");
        r.toColumns.splice(at, 0, next || "");
        changed(true);
      } }, "+ Column pair")),
      fix("asof", h("div.ilabel", "Match")),
      h("label.radio", h("input", { type: "radio", name: "match", checked: !r.asof, onchange: () => { r.asof = false; changed(true); } }), h("span", h("b", "Exact"), h("span.muted", " — every pair is equal"))),
      h("label.radio", { title: r.asof ? "" : NS }, h("input", { type: "radio", name: "match", checked: r.asof, disabled: !r.asof, onchange: () => { r.asof = true; changed(true); } }), h("span", h("b", "As of"), h("span.muted", ` — the last pair matches the latest row at or before. ${NS}.`))),
      issueList(relWhere(r)),
      h("div.toolbar",
        h("button", { title: "Make the other table the many side", onclick: () => { [r.from, r.to, r.fromColumns, r.toColumns] = [r.to, r.from, r.toColumns, r.fromColumns]; if (r.name === uniqueRelName(r.to, r.from) || /_to_/i.test(r.name)) r.name = uniqueRelName(r.from, r.to); changed(true); } }, "⇄ Reverse"),
        h("span.spacer"),
        h("button.danger", { onclick: () => { spec.relationships.splice(i, 1); st.sel = null; changed(true); } }, "Delete join")));
  }
  // Offer the node's business key (its @isBusinessKey columns) as the primary key.
  function businessKeyButton(t, s) {
    const bk = s ? s.columns.filter((c) => c.key).map((c) => c.name) : [];
    if (!bk.length || (bk.length === t.primaryKey.length && bk.every((c) => t.primaryKey.includes(c)))) return null;
    return h("div.toolbar", h("button", { onclick: () => { t.primaryKey = bk; changed(true); } }, `Use the node's business key (${bk.join(" + ")})`));
  }
  // Check in Snowflake that a key really identifies one row: no duplicates, no NULLs.
  function keyCheck(t, cols) {
    const id = `${t.location}.${t.node}|${cols.join(",")}`;
    const c = st.keyChecks[id];
    const run = guard(async () => {
      st.keyChecks[id] = { busy: true }; renderTab();
      try { st.keyChecks[id] = { result: await api("check-key", { location: t.location, node: t.node, columns: cols }) }; }
      catch (e) { st.keyChecks[id] = { error: e.message }; }
      renderTab();
    });
    const fmt = (n) => Number(n).toLocaleString();
    let out = null;
    if (c && c.error) out = h("div.banner.err", c.error);
    else if (c && c.result) {
      const r = c.result, keyText = cols.length > 1 ? `(${cols.join(", ")})` : cols[0];
      if (!r.dupKeys && !r.nullRows) out = h("div.banner.ok", `Holds in ${r.target}: each of the ${fmt(r.rows)} rows has its own ${keyText}, and none is NULL.`);
      else out = h("div.banner.err",
        r.dupKeys ? `${fmt(r.dupKeys)} ${keyText} value${r.dupKeys === 1 ? "" : "s"} appear on more than one row (${fmt(r.dupRows)} of ${fmt(r.rows)} rows in ${r.target}). ` : "",
        r.nullRows ? `${fmt(r.nullRows)} row${r.nullRows === 1 ? " has" : "s have"} a NULL in the key. ` : "",
        "Joins that rely on this key would count those rows more than once.",
        r.samples.length ? h("div.result", { style: "margin-top:6px;max-height:160px" }, h("table", h("thead", h("tr", [...cols, "rows"].map((x) => h("th", x)))),
          h("tbody", r.samples.map((row) => h("tr", row.map((v) => h("td", v === null ? "NULL" : v))))))) : null);
    }
    return h("div",
      h("div.toolbar", h("button", { disabled: !!(c && c.busy) || !!noQueries(), title: noQueries() || "Counts duplicate and NULL key values in the table in your workspace schema", onclick: run }, c && c.busy ? "Checking…" : `Check ${cols.length > 1 ? "this composite key" : "this key"} in Snowflake`)),
      out);
  }
  function tableInspector(t) {
    const spec = st.draft.spec, s = source(t), i = spec.tables.indexOf(t);
    const joins = spec.relationships.map((r, k) => [r, k]).filter(([r]) => r.from === t.alias || r.to === t.alias);
    const used = ["facts", "dimensions", "metrics"].reduce((n, k) => n + spec[k].filter((f) => f.table === t.alias).length, 0);
    return h("div.inspector",
      h("div.ihead", h("span.ititle", t.alias), s ? h("span.chip", s.type) : h("span.chip.err", "missing node")),
      h("p.isent", h("span.mono", `${t.location}.${t.node}`), s ? ` · ${s.columns.length} columns · ${used} fields ` : " ", fix("node", h("button.link", { onclick: () => { st.picker = { replace: i }; renderTab(); } }, s ? "change node" : "choose a node"))),
      field("Alias", fix("alias", h("input.code", { value: t.alias, onchange: (e) => { renameAlias(t, e.target.value.trim()); changed(true); } }))),
      h("div.ilabel", t.primaryKey.length > 1 ? `Primary key — composite, ${t.primaryKey.length} columns` : "Primary key"),
      fix("primaryKey", columnPills(s ? s.columns : [], t.primaryKey, () => changed(true))),
      h("div.muted", { style: "font-size:12px" }, "One column, or several that together identify one row. Add columns here or click PK on the card, in key order."),
      businessKeyButton(t, s),
      t.primaryKey.length ? keyCheck(t, t.primaryKey) : null,
      fix("unique", h("div.ilabel", "Unique keys")),
      t.unique.map((u, k) => h("div",
        h("div.pair", columnPills(s ? s.columns : [], u, () => { if (!u.length) t.unique.splice(k, 1); changed(true); }), h("button.icon", { title: "Remove", onclick: () => { t.unique.splice(k, 1); changed(true); } }, "×")),
        u.length ? keyCheck(t, u) : null)),
      t.unique.length ? null : h("div.muted", { style: "font-size:12px" }, `${NS}.`),
      field("Synonyms (comma-separated)", fix("synonyms", listInput(t, "synonyms", "orders, sales orders"))),
      field("Comment", fix("comment", text(t, "comment", { area: true, rows: 2, placeholder: "What one row of this table is" }))),
      h("div.ilabel", `Joins (${joins.length})`),
      joins.length ? joins.map(([r, k]) => h("div.jlink", { onclick: () => select({ kind: "rel", key: k }) }, `${r.from} (${r.fromColumns.join(", ")}) → ${r.to} (${r.toColumns.join(", ")})`, h("span.muted", ` · ${cardinalityOf(r)}`)))
        : h("div.muted", "None. Drag from one of its columns to a column of another table."),
      issueList(`table ${t.alias}`),
      h("div.toolbar", h("span.spacer"), h("button.danger", { onclick: guard(() => removeTable(t)) }, "Remove table")));
  }
  function helpInspector() {
    return h("div.inspector",
      h("div.ihead", h("span.ititle", "Joins")),
      h("ul.help",
        h("li", "Drag from a column onto the matching column of another table to join them. Drop on a card to match its primary key."),
        h("li", "The arrow points at the table being looked up. N : 1 means each row matches at most one row there; N : N means that table has no key on those columns."),
        h("li", "Click PK on a column to set the primary key; click PK on more columns for a composite key (PK1, PK2…). Dropping onto a table with a composite key matches every key column whose name matches."),
        h("li", "Drag a header to move a card."),
        h("li", "Click a line or a card to edit it. Delete removes the selected join.")));
  }

  function tabTables() {
    const spec = st.draft.spec;
    ensureLayout(false);
    if (st.sel && st.sel.kind === "rel" && !spec.relationships[st.sel.key]) st.sel = null;
    if (st.sel && st.sel.kind === "table" && !tableBy(st.sel.key)) st.sel = null;
    const defs = svgEl("defs");
    for (const [id, cls] of [["jarrow", ""], ["jarrowSel", "sel"], ["jarrowWarn", "warn"]]) {
      const m = svgEl("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: "auto-start-reverse" });
      m.append(svgEl("path", { d: "M0,1 L9,5 L0,9 z", class: `arrow ${cls}` }));
      defs.append(m);
    }
    const edges = svgEl("svg", { class: "jedges" }); edges.append(defs);
    const content = h("div.jcontent", { onpointerdown: (e) => { if (e.target === e.currentTarget && st.sel) select(null); } },
      edges, spec.tables.map(tableCard), svgEl("svg", { class: "jlabels" }), svgEl("svg", { class: "jdrag" }));
    const canvas = h("div.jcanvas", { onscroll: (e) => { st.canvasScroll = { left: e.target.scrollLeft, top: e.target.scrollTop }; } }, content);
    if (!spec.tables.length) content.append(h("div.jempty", "Add the fact and dimension tables this view reads, then drag between their columns to join them."));
    const inspector = st.sel && st.sel.kind === "rel" ? relInspector(spec.relationships[st.sel.key], st.sel.key)
      : st.sel && st.sel.kind === "table" ? tableInspector(tableBy(st.sel.key)) : helpInspector();
    requestAnimationFrame(() => {
      sizeCanvas();
      canvas.scrollLeft = st.canvasScroll.left; canvas.scrollTop = st.canvasScroll.top;
      content.querySelectorAll(".jcard").forEach((c) => { const l = c.querySelector(".jcols"); if (l) l.scrollTop = st.listScroll[c.dataset.alias] || 0; });
      drawEdges();
    });
    const joinRows = spec.relationships.map((r, i) => h("tr" + (selected("rel", i) ? ".on" : ""), { onclick: () => select({ kind: "rel", key: i }) },
      h("td.mono", r.name || h("span.muted", "(unnamed)")),
      h("td.mono", `${r.from} (${r.fromColumns.join(", ")})`), h("td", "→"), h("td.mono", `${r.to} (${r.toColumns.join(", ")})${r.asof ? " ASOF" : ""}`),
      h("td", h("span.chip." + (relBroken(r) ? "err" : cardinalityOf(r) === "many-to-many" ? "warn" : "ok"), relBroken(r) ? "incomplete" : cardinalityOf(r)))));
    return [
      loopBanner(),
      st.picker ? nodePicker() : null,
      h("div.toolbar", { style: "margin:0 0 8px" },
        fix("addTable", h("button.primary", { onclick: () => { st.picker = { replace: null }; st.pickerQuery = ""; renderTab(); } }, "Add table")),
        h("button", { disabled: spec.tables.length < 2, onclick: guard(async () => {
          const r = await api("suggest", { spec });
          if (!r.relationships.length) return toast("No more joins found from matching key column names.");
          spec.relationships.push(...r.relationships); changed(true);
          toast(`Drew ${r.relationships.length} join${r.relationships.length > 1 ? "s" : ""}. Click a line to check it.`);
        }) }, "Suggest joins from keys"),
        h("button", { disabled: spec.tables.length < 2, title: "Add a join by picking tables and columns in the panel", onclick: () => {
          spec.relationships.push({ name: uniqueRelName(spec.tables[0].alias, spec.tables[1].alias), from: spec.tables[0].alias, fromColumns: [""], to: spec.tables[1].alias, toColumns: [""], asof: false });
          st.sel = { kind: "rel", key: spec.relationships.length - 1 }; changed(true);
        } }, "Add join manually"),
        h("button", { disabled: !spec.tables.length, onclick: () => { ensureLayout(true); st.canvasScroll = { left: 0, top: 0 }; changed(true); } }, "Auto-arrange")),
      h("div.joinEditor", canvas, inspector),
      spec.relationships.length ? h("div.section", { style: "margin-top:16px" }, h("h3", `All joins (${spec.relationships.length})`),
        h("table.grid.jlist", h("tbody", joinRows))) : null,
    ];
  }

  // ── Fields ────────────────────────────────────────────────────────────────
  const FIELD_KINDS = [
    ["dimensions", "Dimensions", "var(--dim)", "How people slice results: names, categories, dates. One expression per row of the table. Name fields in uppercase: Cortex Analyst can't use a view with lowercase names."],
    ["facts", "Facts", "var(--fact)", "Row-level numbers that metrics aggregate. Mark one private to use it in metrics without exposing it."],
    ["metrics", "Metrics", "var(--metric)", "Aggregates such as SUM(ORDERS.AMOUNT). Don't name a metric like a column that a fact reads: the metric's name would hide the column. Choose “derived” to combine metrics from several tables, for example ORDERS.REVENUE / CUSTOMERS.CUSTOMER_COUNT."],
  ];
  function tabFields() {
    const spec = st.draft.spec;
    const aliases = spec.tables.map((t) => t.alias);
    if (!aliases.length) return h("div.muted", "Add a table first.");
    return FIELD_KINDS.map(([key, title, color, help]) => {
      const rows = spec[key].map((f, i) => {
        const expr = h("textarea.code", { value: f.expr, rows: 1, spellcheck: false, placeholder: key === "metrics" ? "COUNT, SUM, AVG, MIN or MAX(ALIAS.COLUMN)" : "ALIAS.COLUMN", oninput: (e) => { f.expr = e.target.value; grow(e.target); changed(false); } });
        setTimeout(() => grow(expr));
        return h("tr", { "data-goto": `${key}:${i}` },
          h("td", { style: "width:150px" }, fix("table", selectBox(f.table, key === "metrics" && !f.table ? [{ value: "", label: "(derived)" }, ...aliases] : aliases, (v) => { f.table = v; changed(false); }, key === "metrics" ? undefined : "table"))),
          h("td", { style: "width:190px" }, fix("name", h("input.code", { value: f.name, placeholder: "NAME", oninput: (e) => { f.name = e.target.value.trim(); changed(false); } }))),
          h("td", fix("expr", expr)),
          h("td", { style: "width:17%" }, fix("synonyms", listInput(f, "synonyms", "synonyms"))),
          h("td", { style: "width:22%" }, fix("comment", text(f, "comment", { placeholder: "description" }))),
          key !== "dimensions" ? h("td.narrow", fix("private", h("input", { type: "checkbox", checked: !!f.private, disabled: !f.private, title: f.private ? "Private: usable in other expressions, hidden from queries. " + NS + "." : NS, onchange: (e) => { f.private = e.target.checked; changed(false); } }))) : null,
          h("td.narrow", h("button.icon", { title: "Remove", onclick: () => { spec[key].splice(i, 1); changed(true); } }, "×")));
      });
      return h("div.section",
        h("h3", h("span.dot", { style: `background:${color}` }), `${title} (${spec[key].length})`),
        h("p.help", help),
        rows.length ? h("table.grid", h("thead", h("tr", h("th", "Table"), h("th", "Name"), h("th", "Expression"), h("th", "Synonyms"), h("th", "Description"), key !== "dimensions" ? h("th", "Private") : null, h("th", ""))), h("tbody", rows)) : null,
        h("div.toolbar",
          fix(key === "dimensions" ? "addField" : "add-" + key, h("button", { onclick: () => { spec[key].push({ table: aliases[0], name: "", expr: "", synonyms: [], comment: "" }); changed(true); } }, `Add ${title.toLowerCase().replace(/s$/, "")}`)),
          spec[key].length ? h("button", { onclick: guard(async () => { if (await ask(`Remove all ${spec[key].length} ${title.toLowerCase()}?`, "Remove all")) { spec[key] = []; changed(true); } }) }, "Remove all") : null));
    });
  }
  function grow(el) { el.style.height = "auto"; el.style.height = Math.max(30, el.scrollHeight + 2) + "px"; }

  // ── Cortex Analyst ────────────────────────────────────────────────────────
  function tabAI() {
    const spec = st.draft.spec;
    return [
      h("div.section", h("h3", "Instructions"),
        h("p.help", "Optional guidance Cortex Analyst follows when it answers questions with this view."),
        h("div.card", field("SQL generation", text(spec, "aiSqlGeneration", { area: true, rows: 3, placeholder: "For example: revenue is in US dollars. Use fiscal years unless asked otherwise." })),
          h("div", { style: "height:10px" }),
          field("Question categorization", text(spec, "aiQuestionCategorization", { area: true, rows: 2, placeholder: "For example: decline questions that are not about revenue." })))),
      h("div.section", h("h3", `Verified queries (${spec.verifiedQueries.length})`),
        h("p.help", "Question and SQL pairs you have checked. Cortex Analyst uses them as examples; onboarding questions are suggested to new users."),
        spec.verifiedQueries.map((v, i) => h("div.card", { "data-goto": `vq:${i}` },
          h("div", { style: "display:grid;grid-template-columns:220px minmax(0,1fr) auto auto;gap:10px;align-items:end" },
            field("Name", fix("name", h("input.code", { value: v.name, placeholder: "ARR_BY_YEAR", oninput: (e) => { v.name = e.target.value.trim(); changed(false); } }))),
            field("Question", fix("question", text(v, "question", { placeholder: "What was ARR by fiscal year?" }))),
            h("label.check", h("input", { type: "checkbox", checked: v.onboarding, onchange: (e) => { v.onboarding = e.target.checked; changed(false); } }), "Onboarding"),
            h("button.icon", { title: "Remove", onclick: () => { spec.verifiedQueries.splice(i, 1); changed(true); } }, "×")),
          h("div", { style: "height:8px" }),
          h("div", { style: "display:grid;grid-template-columns:minmax(0,1fr) 220px auto;gap:10px;align-items:end" },
            field("Verified by", text(v, "verifiedBy", { placeholder: "Who checked the answer" })),
            field("Verified at", h("input", { type: "date", value: v.verifiedAt ? new Date(+v.verifiedAt * 1000).toISOString().slice(0, 10) : "", onchange: (e) => { v.verifiedAt = e.target.value ? String(Math.floor(Date.parse(e.target.value + "T00:00:00Z") / 1000)) : ""; changed(false); } })),
            h("button", { onclick: () => { v.verifiedAt = String(Math.floor(Date.now() / 1000)); changed(true); } }, "Verified now")),
          h("div", { style: "height:8px" }),
          field("SQL", fix("sql", text(v, "sql", { area: true, code: true, rows: 3, placeholder: `SELECT … FROM "__${(spec.tables[0] || { alias: "table" }).alias}" … (logical table names prefixed with __)` }))))),
        h("div.toolbar", h("button", { onclick: () => { spec.verifiedQueries.push({ name: "", question: "", sql: "", onboarding: false, verifiedAt: "", verifiedBy: "" }); changed(true); } }, "Add verified query"))),
    ];
  }

  // ── SQL ───────────────────────────────────────────────────────────────────
  function tabSQL() {
    return h("div.section",
      h("h3", "CREATE SEMANTIC VIEW", h("span.spacer"), h("button", { onclick: () => navigator.clipboard.writeText(st.ddl).then(() => toast("Copied")) }, "Copy")),
      h("p.help", `What the Semantic View package${st.app.nodeType ? ` (${st.app.nodeType.ref})` : ""} creates for this node in your workspace schema. Other environments get their own database and schema names at deploy time. Names are quoted, so they keep their case.`),
      h("pre.sql", st.ddl || "Add a table to see the statement."));
  }

  // ── Test ──────────────────────────────────────────────────────────────────
  function tabTest() {
    const spec = st.draft.spec, t = st.test;
    const group = (title, key, items) => h("div", h("div.muted", { style: "margin-bottom:4px" }, `${title} (${t[key].size} of ${items.length})`),
      h("div.checks", items.length ? items.map((n) => h("label.check.mono", h("input", { type: "checkbox", checked: t[key].has(n), onchange: (e) => { e.target.checked ? t[key].add(n) : t[key].delete(n); renderTab(); } }), n)) : h("span.muted", "None")));
    const names = (key) => spec[key].filter((f) => !f.private).map((f) => (f.table ? `${f.table}.${f.name}` : f.name));
    const out = [];
    if (st.deployed && !st.deployed.ok) out.push(h("div.banner.err", h("b", "Snowflake rejected the view. "), st.deployed.error));
    if (st.deployed && st.deployed.ok) out.push(h("div.banner.ok", `Created ${st.deployed.target}.${st.deployed.note ? " " + st.deployed.note : ""}`));
    if (st.dirty) out.push(h("div.banner", "You have unsaved changes. Queries run against the view as it was last created in Snowflake."));
    const r = t.result;
    out.push(h("div.section",
      h("h3", "Query the view"),
      h("p.help", `Runs SELECT … FROM SEMANTIC_VIEW(…) against ${loc().database}.${loc().schema}.${st.draft.name}. Create the view first. Metrics and facts cannot be mixed in one query.`),
      h("div.testgrid", group("Metrics", "metrics", names("metrics")), group("Dimensions", "dimensions", names("dimensions")), group("Facts", "facts", names("facts"))),
      h("div.toolbar",
        h("input.code", { style: "flex:1;min-width:200px", placeholder: "WHERE (optional), for example dates.fiscal_year = 2026", value: t.where, oninput: (e) => { t.where = e.target.value; } }),
        h("label.check", "Limit", h("input", { type: "number", min: 1, max: 1000, style: "width:76px", value: t.limit, oninput: (e) => { t.limit = e.target.value; } })),
        h("button.primary", { disabled: t.busy || !st.draft.id || !!noQueries(), title: noQueries(), onclick: guard(async () => {
          t.busy = true; renderTab();
          try { t.result = await api("query", { id: st.draft.id, metrics: [...t.metrics], dimensions: [...t.dimensions], facts: [...t.facts], where: t.where, limit: t.limit }); }
          finally { t.busy = false; renderTab(); }
        }) }, t.busy ? "Running…" : "Run")),
      r ? h("div", { style: "margin-top:12px" },
        h("pre.sql", r.sql),
        r.error ? h("div.banner.err", { style: "margin-top:10px" }, r.error) : h("div",
          h("div.muted", { style: "margin-top:8px" }, `${r.rows.length} row${r.rows.length === 1 ? "" : "s"} in ${r.ms} ms`),
          h("div.result", h("table", h("thead", h("tr", r.columns.map((c) => h("th", c)))), h("tbody", r.rows.map((row) => h("tr", row.map((v) => h("td", v === null ? h("span.muted", "null") : v))))))))) : null));
    return out;
  }

  // ── Drift ─────────────────────────────────────────────────────────────────
  async function checkDrift() {
    st.driftBusy = true; renderTab();
    try { st.drift = await api(`drift?id=${encodeURIComponent(st.draft.id)}`); }
    finally { st.driftBusy = false; renderTab(); }
  }
  function tabDrift() {
    const d = st.drift;
    const out = [h("div.section",
      h("h3", "Repo against Snowflake"),
      h("p.help", `Compares the saved node with the semantic view in ${loc().database}.${loc().schema}, the schema this workspace deploys to. Differences mean someone changed the view in Snowflake, or the node changed since it was last created.`),
      h("div.toolbar", h("button.primary", { disabled: st.driftBusy || !st.draft.id || !!noQueries(), title: noQueries(), onclick: guard(checkDrift) }, st.driftBusy ? "Checking…" : "Check now"),
        !st.draft.id ? h("span.muted", "Save the view first.") : st.dirty ? h("span.muted", "Unsaved changes are not compared.") : null))];
    if (!d) return out;
    if (d.status === "missing") out.push(h("div.banner", `${d.target} does not exist in Snowflake yet. Use “Create in workspace schema”.`));
    else if (d.status === "in-sync") out.push(h("div.banner.ok", `${d.target} matches the node.`));
    else {
      out.push(h("div.banner.err", `${d.diffs.length} difference${d.diffs.length > 1 ? "s" : ""} between the node and ${d.target}.`));
      out.push(h("table.diff", h("thead", h("tr", h("th", "Object"), h("th", "Difference"), h("th", "In the node"), h("th", "In Snowflake"))),
        h("tbody", d.diffs.map((x) => h("tr",
          h("td", h("span.muted", x.kind + " "), h("span.mono", x.name)),
          h("td", x.change === "differs" ? `${x.field} differs` : x.change === "not deployed" ? "missing in Snowflake" : "not in the node"),
          h("td.mono", x.repo), h("td.mono", x.deployed))))));
      out.push(h("div.toolbar", h("span.muted", "To make Snowflake match the node, create the view again. To keep Snowflake's version, import it and save over this node.")));
    }
    if (d.notes && d.notes.length) out.push(h("div.muted", { style: "margin-top:10px" }, d.notes.join(" ")));
    return out;
  }

  // ── Issues ────────────────────────────────────────────────────────────────
  // Where an issue points. `where` uses the same labels as the server's checks:
  // "table A", "relationship N" (or "A → B"), "fact|dimension|metric T.N", "verified query N",
  // "view", "tables", "fields", "joins".
  function issueTarget(where) {
    const spec = st.draft.spec, w = String(where || "");
    const m = w.match(/^(table|relationship|fact|dimension|metric|verified query) (.*)$/);
    if (!m) return ["view", "tables", "fields", "joins"].includes(w) ? { kind: w } : null;
    const [, kind, rest] = m;
    if (kind === "table") return spec.tables.some((t) => (t.alias || "(no alias)") === rest) ? { kind, key: rest } : { kind: "tables" };
    if (kind === "relationship") {
      const i = spec.relationships.findIndex((r) => (r.name || `${r.from} → ${r.to}`) === rest);
      return i >= 0 ? { kind, key: i } : { kind: "tables" };
    }
    if (kind === "verified query") {
      const i = spec.verifiedQueries.findIndex((v) => (v.name || "(no name)") === rest);
      return { kind: "vq", key: Math.max(0, i) };
    }
    const key = { fact: "facts", dimension: "dimensions", metric: "metrics" }[kind];
    const i = spec[key].findIndex((f) => `${f.table ? f.table + "." : ""}${f.name || "(no name)"}` === rest);
    return i >= 0 ? { kind: "field", list: key, key: i } : { kind: "fields" };
  }
  // Open the tab that holds the target, select it, scroll it into view and flash it.
  function goTo(t) {
    const flash = (el) => { if (!el) return; el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" }); el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); };
    const after = (fn) => setTimeout(fn, 0); // the tab is already rendered; this lets the canvas lay out
    if (t.kind === "view") { const el = document.querySelector('#head [data-k="name"]'); if (el) { el.focus(); flash(el); } return; }
    st.tab = { table: "tables", relationship: "tables", tables: "tables", joins: "tables", field: "fields", fields: "fields", vq: "ai" }[t.kind];
    if (t.kind === "table") st.sel = { kind: "table", key: t.key };
    if (t.kind === "relationship") st.sel = { kind: "rel", key: t.key };
    renderHead(); renderTab();
    after(() => {
      // The control that fixes the issue: inside the object's editor when there is one.
      const scope = t.kind === "field" ? document.querySelector(`tr[data-goto="${t.list}:${t.key}"]`)
        : t.kind === "vq" ? document.querySelector(`[data-goto="vq:${t.key}"]`)
        : t.kind === "table" || t.kind === "relationship" ? document.querySelector(".inspector") : document;
      const marked = t.fix && scope && scope.querySelector(`[data-fix="${t.fix}"]`);
      if (marked) {
        if (t.kind === "table") document.querySelector(`.jcard[data-alias="${CSS.escape(t.key)}"]`)?.scrollIntoView({ block: "nearest", inline: "center" });
        const focusable = (el) => el.matches("input,select,textarea,button") ? el : el.querySelector("input:not([disabled]),select,textarea,button");
        let target = focusable(marked);
        for (let sib = marked.nextElementSibling, n = 0; !target && sib && n < 4; sib = sib.nextElementSibling, n++) target = sib.matches("input,select,textarea,button") ? sib : sib.querySelector("input:not([disabled]),select,textarea,button");
        const shown = marked.closest("label.field") || marked.closest("td") || marked;
        flash(shown);
        if (target && !target.disabled) target.focus({ preventScroll: true });
        return;
      }
      if (t.kind === "table") flash(document.querySelector(`.jcard[data-alias="${CSS.escape(t.key)}"]`));
      else if (t.kind === "relationship") {
        const r = st.draft.spec.relationships[t.key];
        flash(document.querySelector(`.jcard[data-alias="${CSS.escape(r.from)}"]`) || document.querySelector(".inspector"));
        flash(document.querySelector(".inspector"));
      } else if (t.kind === "joins") flash(document.getElementById("loopIssues"));
      else if (t.kind === "field") {
        const row = document.querySelector(`tr[data-goto="${t.list}:${t.key}"]`);
        flash(row);
        const input = row && row.querySelector("textarea, input"); if (input) input.focus({ preventScroll: true });
      } else if (t.kind === "vq") flash(document.querySelector(`[data-goto="vq:${t.key}"]`));
    });
  }
  function tabIssues() {
    const out = [];
    if (st.deployed && !st.deployed.ok) out.push(h("div.banner.err", h("b", "Snowflake rejected the view. "), st.deployed.error));
    if (st.issues.some((i) => i.cortex)) {
      out.push(h("div.banner.fixall", h("span", "Cortex Analyst needs upper-case table and field names. Rename them all at once; every expression keeps reading what it reads now."),
        h("button", { onclick: guard(makeUppercase) }, "Make names uppercase")));
    }
    if (!st.issues.length) out.push(h("div.banner.ok", "No problems found. These checks run against the workspace's node metadata; Snowflake checks the expressions when the view is created."));
    else out.push(h("div.card", { style: "padding:0" }, st.issues.map((i) => {
      const target = issueTarget(i.where);
      if (target) target.fix = i.fix;
      return h("div.issue" + (target ? ".linked" : ""), { onclick: target ? () => goTo(target) : null, title: target ? `Go to ${i.where}` : "" },
        h("span.chip." + (i.level === "error" ? "err" : "warn"), i.pkg ? "package" : i.level),
        target ? h("a.mono", { href: "#", onclick: (e) => { e.preventDefault(); e.stopPropagation(); goTo(target); } }, i.where) : h("span.mono", i.where),
        h("span", i.message));
    })));
    return out;
  }

  async function makeUppercase() {
    const r = await api("uppercase", { spec: st.draft.spec });
    st.draft.spec = r.spec;
    st.sel = null;
    changed(true);
    const kept = r.kept.length ? ` Kept ${r.kept.join(", ")}: in uppercase ${r.kept.length === 1 ? "it" : "they"} would hide a column other fields read, so rename ${r.kept.length === 1 ? "it" : "them"} yourself.` : "";
    toast(`Renamed ${r.renamed} name${r.renamed === 1 ? "" : "s"} to uppercase. Save to keep the change.${kept}`, !!r.kept.length);
  }

  // ── Import ────────────────────────────────────────────────────────────────
  async function openImport() {
    if (!(await confirmDiscard())) return;
    const modal = $("modal");
    const close = () => modal.classList.add("hidden");
    const listEl = h("div.list", h("div.muted", { style: "padding:12px" }, "Loading semantic views from Snowflake…"));
    const search = h("input", { type: "search", placeholder: "Filter by database, schema or name", style: "margin-top:10px" });
    modal.replaceChildren(h("div.box", h("h3", "Import a semantic view"),
      h("div.muted", "Reads the definition with DESCRIBE SEMANTIC VIEW and maps its tables to nodes in this workspace. Nothing is saved until you save the draft."),
      search, listEl, h("div.foot", h("button", { onclick: close }, "Cancel"))));
    modal.classList.remove("hidden");
    modal.onclick = (e) => { if (e.target === modal) close(); };
    let views = [];
    const fill = () => {
      const q = search.value.toLowerCase();
      const rows = views.filter((v) => !q || `${v.database}.${v.schema}.${v.name}`.toLowerCase().includes(q));
      listEl.replaceChildren(...rows.map((v) => h("div.item", { onclick: guard(async () => {
        const r = await api("import", v);
        close(); resetView();
        const existing = st.app.views.find((x) => x.name === r.name && x.location === r.location);
        st.draft = { id: existing ? existing.id : null, name: r.name, location: r.location, description: r.description, spec: r.spec };
        st.notesTitle = "Imported from Snowflake. Review before saving:";
        st.notes = [`Source: ${r.from}.`, ...(existing ? [`Saving will replace the existing node ${r.location}.${r.name}.`] : []), ...r.notes,
          ...r.unmatched.map((u) => `Table ${u.alias} reads ${u.database}.${u.schema}.${u.table}, which is not a node in this workspace. Choose a node for it or remove it.`)];
        st.dirty = true; st.tab = "tables";
        render();
        await runCheck();
      }) }, h("span.nodeName", v.name), h("span.muted", `${v.database}.${v.schema}`), h("span.muted", v.comment), v.inWorkspace ? h("span.chip.accent", "this workspace") : h("span"))));
      if (!rows.length) listEl.append(h("div.muted", { style: "padding:12px" }, "No semantic views match."));
    };
    search.oninput = fill;
    try { views = (await api("sf/views")).views; fill(); search.focus(); }
    catch (e) { listEl.replaceChildren(h("div.banner.err", { style: "margin:10px" }, e.message)); }
  }

  // ── Boot and live refresh ─────────────────────────────────────────────────
  $("btnNew").onclick = guard(newView);
  $("btnImport").onclick = guard(openImport);
  window.addEventListener("beforeunload", (e) => { if (st.dirty) e.preventDefault(); });
  // A server started from an older build (Coalesce keeps it running until the app is
  // reopened) answers in a shape this page does not know.
  function staleServer(state) { return !state || state.api !== API_VERSION; }
  function staleScreen() {
    $("btnNew").disabled = true; $("btnImport").disabled = true;
    $("main").replaceChildren(h("div.empty",
      h("h2", "Semantic View Builder was updated"),
      h("p", "Coalesce is still running the previous version of the app. Close the Semantic View Builder tab and open it again from Apps to restart it.")));
  }
  async function refresh() {
    const wasBlocked = !!(st.app && st.app.setup && st.app.setup.needed);
    const next = await api("state");
    if (staleServer(next)) { st.app = next; st.version = next && next.version; st.stale = true; return staleScreen(); }
    st.app = next;
    st.version = st.app.version;
    if (wasBlocked !== !!st.app.setup.needed) return render(); // package installed (or removed) meanwhile
    // Reload the open view when its file changed on disk and there is nothing unsaved to lose.
    if (st.draft && st.draft.id && !st.dirty && !st.busy) {
      if (!st.app.views.some((v) => v.id === st.draft.id)) st.draft = null;
      else { const v = await api(`view?id=${encodeURIComponent(st.draft.id)}`); st.draft = { id: v.id, name: v.name, location: v.location, description: v.description, spec: v.spec }; st.issues = v.issues; st.ddl = v.ddl; }
      if (!document.activeElement || document.activeElement === document.body) render(); else renderChrome();
    } else renderChrome();
  }
  (async () => {
    try { await refresh(); if (st.stale) return; render(); }
    catch (e) { $("main").replaceChildren(h("div.empty", h("h2", "Could not load the workspace"), h("p", e.message))); return; }
    setInterval(async () => {
      try {
        const v = (await api("version")).version;
        // While the package is missing, also notice an install made from Build Settings.
        if (v !== st.version || (st.app.setup && st.app.setup.needed && !st.installing)) await refresh();
      } catch { /* server restarting */ }
    }, 2000);
  })();
})();
