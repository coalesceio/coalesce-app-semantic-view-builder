// Semantic View Builder — author Snowflake semantic views as nodes of Coalesce's Semantic
// View package (@coalesce/snowflake/semantic-view). See pkg.js for the node format.
//
//   GET  /api/state                 views, usable source nodes, locations, connection
//   GET  /api/view?id=ID            one view: spec, issues, DDL
//   POST /api/check                 { name, location, description, spec } → issues + DDL
//   POST /api/suggest               { spec, add: { location, node } } → table, fields, relationships
//   POST /api/uppercase             { spec } → spec with upper-case aliases and field names (for Cortex Analyst)
//   POST /api/save                  write nodes/<LOCATION>-<NAME>.yml
//   POST /api/delete                { id } remove the node file
//   POST /api/deploy                { id } coa create for this node (creates it in the workspace schema)
//   GET  /api/drift?id=ID           repo definition vs the view in the workspace schema
//   POST /api/query                 run a SEMANTIC_VIEW() query against the deployed view
//   POST /api/check-key             { location, node, columns } duplicate and NULL key counts
//   GET  /api/sf/views              semantic views in the Snowflake account
//   POST /api/import                { database, schema, name } → draft spec from Snowflake
//   POST /api/install-package       { confirm: true } add the Semantic View package and run coa install
//   GET  /api/version               bumps when workspace files change
//
// Routes match with endsWith so they work under a Coalesce mount prefix.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const YAML = require("yaml");
const S = require("./spec");
const P = require("./pkg");
const { loadWorkspace } = require("./workspace");
const { makeSnowflake } = require("./snowflake");
const { coaCommand } = require("./coa");

const PORT = process.env.PORT || 3018;
const APP_DIR = path.resolve(__dirname, "..");
const WORKSPACE_DIR = process.env.WORKSPACE_DIR ? path.resolve(process.env.WORKSPACE_DIR) : path.resolve(APP_DIR, "..", "..");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const sf = makeSnowflake(WORKSPACE_DIR);

let version = 0;
let bumpTimer = null;
const bump = () => { clearTimeout(bumpTimer); bumpTimer = setTimeout(() => version++, 300); };
for (const t of ["nodes", "nodeTypes", "workspace.yml", "packages"]) {
  const p = path.join(WORKSPACE_DIR, t);
  if (fs.existsSync(p)) try { fs.watch(p, { recursive: true }, bump); } catch (e) { console.warn(`watch ${p}: ${e.message}`); }
}

// Bump when /api responses change shape; public/app.js checks it (see API_VERSION there).
const API_VERSION = 4;
const fail = (status, message) => Object.assign(new Error(message), { status });
const ws = () => loadWorkspace(WORKSPACE_DIR);
const svNodes = (w) => [...w.nodes.values()].filter((n) => n.semantic);

// Card positions in the join editor live beside the node, not in it, so moving a card is
// not a change to deploy. They are kept in the workspace at apps/.semantic-view-builder/,
// outside the app's own folder: installing or updating the app from the marketplace
// replaces that whole folder, and Coalesce doesn't treat dot-folders under apps/ as apps.
// The file is shared through git like the nodes. layouts.json: { <node id>: { <alias>: { x, y } } }
const LAYOUT_DIR = path.join(WORKSPACE_DIR, "apps", ".semantic-view-builder");
const LAYOUTS = path.join(LAYOUT_DIR, "layouts.json");
(function moveOldLayouts() { // before 0.0.1 the file sat in the app folder
  const old = path.join(APP_DIR, "layouts.json");
  try {
    if (!fs.existsSync(old)) return;
    // An old build may still have written there after an earlier move: its entries are newer.
    const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
    fs.mkdirSync(LAYOUT_DIR, { recursive: true });
    fs.writeFileSync(LAYOUTS, JSON.stringify({ ...read(LAYOUTS), ...read(old) }, null, 2) + "\n");
    fs.unlinkSync(old);
  } catch (e) { console.warn(`Could not move ${old} to ${LAYOUTS}: ${e.message}`); }
})();
const readLayouts = () => { try { return JSON.parse(fs.readFileSync(LAYOUTS, "utf8")); } catch { return {}; } };
function writeLayout(id, layout) {
  const all = readLayouts();
  const has = layout && Object.keys(layout).length;
  if (!has && !(id in all)) return;
  if (has) all[id] = layout; else delete all[id];
  fs.mkdirSync(LAYOUT_DIR, { recursive: true });
  fs.writeFileSync(LAYOUTS, JSON.stringify(all, null, 2) + "\n");
}

function findView(w, id) {
  const n = svNodes(w).find((x) => x.id === id);
  if (!n) throw fail(404, "That semantic view is no longer in the workspace.");
  const { view, notes } = P.fromNode(n.obj, w);
  view.spec.layout = readLayouts()[view.id] || {};
  return { node: n, view, notes };
}
const errorCount = (issues) => issues.filter((i) => i.level === "error").length;

// Why the workspace cannot store Semantic View nodes yet, or "".
function nodeTypeProblem(w) {
  if (w.semanticType) return "";
  if (w.semanticPackage && !w.semanticPackage.hydrated) return `The Semantic View package is declared in packages/${w.semanticPackage.alias}.yml but not downloaded to this machine.`;
  return `This app needs Coalesce's Semantic View package (${P.PACKAGE_ID}).`;
}
// What the setup screen needs to know.
function setup(w) {
  const p = w.semanticPackage;
  return {
    needed: !w.semanticType,
    declared: !!p, hydrated: !!(p && p.hydrated), alias: p ? p.alias : "semantic-view",
    installed: p && p.version ? p.version : null, tested: P.TESTED_RELEASE.version, packageID: P.PACKAGE_ID,
  };
}

function state() {
  const w = ws();
  let connection;
  try { connection = sf.describe(); } catch (e) { connection = { error: e.message }; }
  return {
    api: API_VERSION, version, connection, nodeType: w.semanticType, nodeTypeProblem: nodeTypeProblem(w), setup: setup(w),
    locations: Object.keys(w.locations).filter((l) => !w.sourceOnlyLocations.has(l) || l === w.defaultLocation).map((l) => ({ name: l, ...w.locations[l] })),
    defaultLocation: w.defaultLocation,
    views: svNodes(w).map((n) => {
      const { view: v } = P.fromNode(n.obj, w);
      const issues = [...S.validate(v.name, v.spec, w), ...P.packageIssues(v.spec, w)];
      return { id: v.id, name: v.name, location: v.location, description: v.description, tables: v.spec.tables.length, fields: v.spec.facts.length + v.spec.dimensions.length + v.spec.metrics.length, errors: errorCount(issues), warnings: issues.length - errorCount(issues) };
    }).sort((a, b) => a.name.localeCompare(b.name)),
    sources: [...w.nodes.values()].filter((n) => !n.isSource && !n.semantic).map((n) => ({
      location: n.location, name: n.name, type: n.typeName, description: n.description,
      modeled: /^(Dimension|Fact)/i.test(n.typeName) || /^(DIM|FCT|FACT)_/i.test(n.name),
      columns: n.columns.map((c) => ({ name: c.name, dataType: c.dataType, description: c.description, key: c.isBusinessKey })),
    })).sort((a, b) => (b.modeled - a.modeled) || a.location.localeCompare(b.location) || a.name.localeCompare(b.name)),
  };
}

function check(body) {
  const w = ws();
  const issues = [...S.validate(body.name, body.spec, w), ...P.packageIssues(body.spec, w)];
  const problem = nodeTypeProblem(w);
  if (problem) issues.unshift({ level: "error", where: "workspace", message: problem });
  if (body.location && !w.locations[body.location]) issues.push({ level: "error", where: "view", message: `Location ${body.location} is not mapped in workspace.yml.` });
  const clash = w.nodes.get(`${body.location}.${body.name}`.toUpperCase());
  if (clash && clash.id !== body.id) issues.push({ level: "error", where: "view", message: `${body.location}.${body.name} is already used by another node.` });
  return { issues, ddl: P.toDDL(body, w) };
}

function writeNode(w, view, existingNode) {
  const obj = P.toNode(view, w, existingNode && existingNode.obj, w.semanticType.ref);
  const file = path.join(WORKSPACE_DIR, "nodes", `${view.location}-${view.name}.yml`);
  fs.writeFileSync(file, YAML.stringify(obj, { lineWidth: 0 }));
  if (existingNode && path.resolve(existingNode.file) !== path.resolve(file)) fs.unlinkSync(existingNode.file);
  writeLayout(obj.id, view.spec.layout);
  return { id: obj.id, file: path.relative(WORKSPACE_DIR, file) };
}

function save(body) {
  const w = ws();
  const view = { id: body.id, name: String(body.name || "").trim(), location: body.location, description: body.description || "", spec: S.normalize(body.spec) };
  const problem = nodeTypeProblem(w);
  if (problem) throw fail(409, problem);
  if (!S.IDENT.test(view.name)) throw fail(400, "Give the view a name made of letters, digits and underscores.");
  if (!w.locations[view.location]) throw fail(400, `Location ${view.location} is not mapped in workspace.yml.`);
  const existing = view.id ? svNodes(w).find((n) => n.id === view.id) : null;
  const clash = w.nodes.get(`${view.location}.${view.name}`.toUpperCase());
  if (clash && (!existing || clash.id !== existing.id)) throw fail(409, `${view.location}.${view.name} is already used by another node.`);
  const unmapped = view.spec.tables.filter((t) => !w.nodes.has(`${t.location}.${t.node}`.toUpperCase()));
  if (unmapped.length) throw fail(400, `Choose a workspace node for: ${unmapped.map((t) => t.alias).join(", ")}.`);
  // The node format cannot hold these, so saving would lose them.
  const lossy = P.packageIssues(view.spec, w);
  if (lossy.length) throw fail(400, `The Semantic View package can't store ${lossy.length === 1 ? "one part" : `${lossy.length} parts`} of this view yet, so it was not saved. First: ${lossy[0].message}`);
  const written = writeNode(w, view, existing);
  return { ...written, ...check({ ...view, id: written.id }) };
}

// ── coa ─────────────────────────────────────────────────────────────────────
function coa(args) {
  const { cmd, pre, env } = coaCommand();
  return new Promise((resolve) => {
    execFile(cmd, [...pre, ...args], { env, cwd: WORKSPACE_DIR, timeout: 300000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      let json = null;
      const at = stdout.lastIndexOf('{"command"');
      if (at >= 0) try { json = JSON.parse(stdout.slice(at)); } catch { /* not JSON */ }
      resolve({ json, stdout, stderr, failed: !!err, message: err && !json ? (stderr || err.message).trim().split("\n").slice(-6).join("\n") : "" });
    });
  });
}

async function describe(view, w) {
  const fqn = S.viewFqn(view.location, view.name, w);
  try {
    return S.fromDescribe(await sf.objects(`DESCRIBE SEMANTIC VIEW ${fqn}`), w);
  } catch (e) {
    if (/does not exist|not authorized/i.test(e.message)) return null;
    throw e;
  }
}

let deploying = false;
async function deploy(id) {
  if (deploying) throw fail(409, "Another deploy is still running.");
  deploying = true;
  try {
    const w = ws();
    const { view } = findView(w, id);
    const problems = check(view).issues.filter((i) => i.level === "error");
    if (problems.length) throw fail(400, `Fix ${problems.length} error${problems.length > 1 ? "s" : ""} before deploying: ${problems[0].message}`);
    const selector = `{ name: "${view.name}", location: "${view.location}" }`;
    const r = await coa(["create", "--json", "--dir", WORKSPACE_DIR, "--include", selector]);
    const results = (r.json && r.json.data && r.json.data.results) || [];
    const result = results.find((x) => x.nodeID === id) || results[0];
    const flat = JSON.stringify(result || r.json || {});
    const ok = !!(r.json && r.json.success && result && !/"status":"(error|failed)"/i.test(flat));
    const error = ok ? "" : (result && (result.error || result.errorMessage || (result.stages || []).map((s) => s.error || s.errorMessage).filter(Boolean)[0])) || (r.json && (r.json.error || r.json.message)) || r.message || "coa create failed without a message.";
    const out = { ok, target: S.viewFqn(view.location, view.name, w), error: typeof error === "string" ? error : JSON.stringify(error), stages: ((result && result.stages) || []).map((s) => ({ name: s.name, sql: s.sql })) };
    return out;
  } finally { deploying = false; }
}

async function drift(id) {
  const w = ws();
  const { view } = findView(w, id);
  const target = S.viewFqn(view.location, view.name, w);
  const deployed = await describe(view, w);
  if (!deployed) return { status: "missing", target, diffs: [], notes: [] };
  const diffs = S.diffSpecs(view, deployed, w);
  return { status: diffs.length ? "drifted" : "in-sync", target, diffs, notes: deployed.notes };
}

async function runQuery(body) {
  const w = ws();
  const { view } = findView(w, body.id);
  const sql = S.toQuery({ ...body, fqn: S.viewFqn(view.location, view.name, w) });
  const t0 = Date.now();
  try {
    const { columns, rows } = await sf.query(sql);
    return { sql, columns: columns.map((c) => c.name), rows: rows.slice(0, 1000), ms: Date.now() - t0 };
  } catch (e) {
    if (e.snowflake) return { sql, error: e.message };
    throw e;
  }
}

// Does a (possibly composite) key identify one row of the node's table in the workspace
// schema? Counts key values on more than one row and rows with a NULL key column.
async function checkKey(body) {
  const w = ws();
  const node = w.nodes.get(`${body.location}.${body.node}`.toUpperCase());
  if (!node) throw fail(404, `${body.location}.${body.node} is not a node in this workspace.`);
  const loc = w.locations[node.location];
  if (!loc) throw fail(400, `Location ${node.location} is not mapped in workspace.yml.`);
  const cols = Array.isArray(body.columns) ? body.columns.map(String) : [];
  if (!cols.length) throw fail(400, "Pick the key columns first.");
  const unknown = cols.filter((c) => !node.columns.some((x) => x.name === c));
  if (unknown.length) throw fail(400, `${unknown.join(", ")} ${unknown.length > 1 ? "are not columns" : "is not a column"} of ${node.name}.`);
  const q = (x) => `"${String(x).replace(/"/g, '""')}"`;
  const table = [loc.database, loc.schema, node.name].map(q).join(".");
  const keyList = cols.map(q).join(", ");
  const anyNull = cols.map((c) => `${q(c)} IS NULL`).join(" OR ");
  try {
    const [stats] = await sf.objects(
      `WITH g AS (SELECT ${keyList}, COUNT(*) AS N FROM ${table} GROUP BY ${keyList})
       SELECT COALESCE(SUM(N), 0) AS ROWS_TOTAL, COALESCE(SUM(IFF(${anyNull}, N, 0)), 0) AS NULL_ROWS,
              COUNT_IF(N > 1) AS DUP_KEYS, COALESCE(SUM(IFF(N > 1, N, 0)), 0) AS DUP_ROWS FROM g`);
    const out = { target: `${loc.database}.${loc.schema}.${node.name}`, rows: +stats.rows_total, nullRows: +stats.null_rows, dupKeys: +stats.dup_keys, dupRows: +stats.dup_rows, samples: [] };
    if (out.dupKeys) {
      const { rows } = await sf.query(`SELECT ${keyList}, COUNT(*) AS N FROM ${table} GROUP BY ${keyList} HAVING COUNT(*) > 1 ORDER BY N DESC LIMIT 5`);
      out.samples = rows;
    }
    return out;
  } catch (e) {
    if (e.snowflake) throw fail(400, /does not exist|not authorized/i.test(e.message) ? `${loc.database}.${loc.schema}.${node.name} is not in Snowflake yet. Create the node first.` : e.message);
    throw e;
  }
}

// Install the Semantic View package, only when the user confirms it on the setup screen:
// add packages/<alias>.yml (the release this app is verified against) unless the workspace
// already declares the package, then download it with coa install. A failed install removes
// the declaration it added.
let installing = false;
const stripAnsi = (x) => String(x || "").replace(/\u001b\[[0-9;]*m/g, "");
async function installPackage(body) {
  if (!body || body.confirm !== true) throw fail(400, "Confirm the install first.");
  if (installing) throw fail(409, "An install is already running.");
  installing = true;
  try {
    let w = ws();
    if (w.semanticType) return { ok: true, already: true };
    let wrote = null, madeDir = false;
    const dir = path.join(WORKSPACE_DIR, "packages");
    if (!w.semanticPackage) {
      let alias = "semantic-view", n = 2;
      while (fs.existsSync(path.join(dir, `${alias}.yml`))) alias = `semantic-view-${n++}`;
      madeDir = !fs.existsSync(dir);
      fs.mkdirSync(dir, { recursive: true });
      wrote = path.join(dir, `${alias}.yml`);
      fs.writeFileSync(wrote, YAML.stringify(P.packageDeclaration(alias)));
    }
    const r = await coa(["install", "--dir", WORKSPACE_DIR]);
    w = ws();
    version++;
    if (r.failed || !w.semanticType) {
      if (wrote) fs.unlinkSync(wrote);
      if (madeDir) try { fs.rmdirSync(dir); } catch { /* not empty */ }
      const out = stripAnsi(`${r.stdout}\n${r.stderr}`).split("\n").map((x) => x.trim()).filter(Boolean).slice(-4).join(" ");
      throw fail(502, `coa install did not install the package${wrote ? ", so the app removed the declaration it had added" : ""}. ${out || r.message} You can install it from Build Settings → Packages instead.`);
    }
    return { ok: true, wrote: wrote ? path.relative(WORKSPACE_DIR, wrote) : null, version: w.semanticPackage && w.semanticPackage.version };
  } finally { installing = false; }
}

async function listSnowflakeViews() {
  const w = ws();
  const rows = await sf.objects("SHOW SEMANTIC VIEWS IN ACCOUNT");
  const mine = new Set(svNodes(w).map((n) => S.viewFqn(n.location, n.name, w)));
  return {
    views: rows.map((r) => ({
      database: r.database_name, schema: r.schema_name, name: r.name, comment: r.comment || "", owner: r.owner,
      inWorkspace: mine.has([r.database_name, r.schema_name, r.name].map((x) => `"${x}"`).join(".")),
    })),
  };
}

async function importView(body) {
  const w = ws();
  for (const k of ["database", "schema", "name"]) if (!body[k]) throw fail(400, "Pick a semantic view to import.");
  const fqn = [body.database, body.schema, body.name].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(".");
  const d = S.fromDescribe(await sf.objects(`DESCRIBE SEMANTIC VIEW ${fqn}`), w);
  // Land it in the location mapped to that schema when there is one, otherwise the
  // workspace's default location.
  const loc = Object.entries(w.locations).find(([l, v]) => !w.sourceOnlyLocations.has(l) && String(v.schema).toUpperCase() === String(body.schema).toUpperCase());
  return { name: body.name, location: loc ? loc[0] : w.defaultLocation, description: d.description, spec: d.spec, unmatched: d.unmatched, notes: d.notes, from: fqn };
}

function suggest(body) {
  const w = ws();
  const spec = S.normalize(body.spec);
  const out = {};
  if (body.add) {
    const node = w.nodes.get(`${body.add.location}.${body.add.node}`.toUpperCase());
    if (!node) throw fail(404, `${body.add.location}.${body.add.node} is not a node in this workspace.`);
    out.table = S.suggestTable(node, new Set(spec.tables.map((t) => t.alias.toUpperCase())));
    out.fields = S.suggestFields(out.table, node);
    spec.tables.push(out.table);
  }
  out.relationships = S.suggestRelationships(spec, w);
  return out;
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 8e6) reject(fail(413, "Request too large.")); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(fail(400, "Invalid JSON.")); } });
    req.on("error", reject);
  });
}
// Inline CSS + JS so the page works under any mount prefix.
// Read once at startup: the page must match this server's API. Coalesce keeps an app's
// server running until the app is reopened, so a page read per request could be newer than
// the server serving it.
const PAGE = (() => {
  const read = (f) => fs.readFileSync(path.join(PUBLIC_DIR, f), "utf8");
  return read("index.html")
    .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${read("styles.css")}\n</style>`)
    .replace('<script src="app.js"></script>', () => `<script>\n${read("app.js")}\n</script>`);
})();

const GET = {
  version: () => ({ version }),
  state: () => state(),
  view: (q) => { const { view, notes } = findView(ws(), q.get("id")); return { ...view, notes, ...check(view) }; },
  drift: (q) => drift(q.get("id")),
  "sf/views": () => listSnowflakeViews(),
};
const POST = {
  check: (b) => check(b),
  suggest: (b) => suggest(b),
  uppercase: (b) => S.upperNames(b.spec, ws()),
  save: (b) => save(b),
  delete: (b) => { const { node } = findView(ws(), b.id); fs.unlinkSync(node.file); writeLayout(b.id, null); return { ok: true }; },
  deploy: (b) => deploy(b.id),
  query: (b) => runQuery(b),
  import: (b) => importView(b),
  "check-key": (b) => checkKey(b),
  "install-package": (b) => installPackage(b),
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    // This server can write to the workspace and to Snowflake, so only this machine may use it.
    if (!/^(::1|(::ffff:)?127\.\d+\.\d+\.\d+)$/.test(req.socket.remoteAddress || "")) return send(res, 403, { error: "Local connections only." });
    const api = p.match(/\/api\/(.+)$/);
    if (api) {
      const table = req.method === "POST" ? POST : GET;
      const fn = table[api[1]];
      if (!fn) return send(res, 404, { error: "Unknown endpoint." });
      // Writes must come from this app's own page: a JSON content type cannot be sent by
      // another site's page without a CORS preflight, which this server never grants.
      if (req.method === "POST" && !/^application\/json/.test(req.headers["content-type"] || "")) return send(res, 415, { error: "Send JSON." });
      return send(res, 200, await fn(req.method === "POST" ? await readBody(req) : url.searchParams));
    }
    return send(res, 200, PAGE, "text/html; charset=utf-8");
  } catch (e) {
    if (!e.status) console.error(e);
    return send(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`semantic-view-builder on :${PORT} — WORKSPACE_DIR=${WORKSPACE_DIR}`));
