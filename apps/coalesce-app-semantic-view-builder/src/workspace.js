// Read the workspace: locations, node types and every node the builder can use as a table
// (YAML nodes and SQL nodes), plus the Semantic View nodes themselves.
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { isPackageNode, PACKAGE_ID } = require("./pkg");

const cache = new Map(); // file → { stamp, node }

// Split on top-level commas, respecting quotes and parentheses.
function splitTop(s) {
  const out = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote) { if (s[i + 1] === quote) i++; else quote = null; } else if (ch === "\\" && quote === '"' && s[i + 1] === '"') i++; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

// Columns of a SQL node: the aliases of its final top-level SELECT, with types from CAST
// and descriptions and keys from column annotations.
function sqlNodeColumns(text) {
  const body = text.replace(/--[^\n]*/g, "");
  let depth = 0, quote = null, selectAt = -1, fromAt = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /[sSfF]/.test(ch) && !/[\w$]/.test(body[i - 1] || " ")) {
      const word = body.slice(i, i + 7).toUpperCase();
      if (word.startsWith("SELECT") && !/[\w$]/.test(body[i + 6] || " ")) { selectAt = i + 6; fromAt = -1; }
      else if (word.startsWith("FROM") && !/[\w$]/.test(body[i + 4] || " ") && selectAt >= 0 && fromAt < 0) fromAt = i;
    }
  }
  if (selectAt < 0) return [];
  const listText = body.slice(selectAt, fromAt < 0 ? body.length : fromAt).replace(/^\s*(DISTINCT|ALL)\b/i, "");
  const columns = [];
  for (const item of splitTop(listText)) {
    const annot = item.match(/((?:\s*@\w+(?:\((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)"'])*\))?)*)\s*$/);
    const annotations = annot ? annot[1] : "";
    const expr = item.slice(0, item.length - (annot ? annot[0].length : 0)).trim();
    const m = expr.match(/\bAS\s+("(?:[^"]|"")+"|[A-Za-z_][\w$]*)$/i) || expr.match(/(?:^|\.)("(?:[^"]|"")+"|[A-Za-z_][\w$]*)$/);
    if (!m) continue;
    const quoted = m[1].startsWith('"');
    const name = quoted ? m[1].slice(1, -1).replace(/""/g, '"') : m[1].toUpperCase();
    const cast = expr.match(/^CAST\s*\([\s\S]*\bAS\s+([A-Za-z_][\w ]*(?:\([\d, ]+\))?)\s*\)\s+AS\b/i) || expr.match(/::\s*([A-Za-z_]\w*(?:\([\d, ]+\))?)\s+AS\b/i);
    const desc = annotations.match(/@description\(\s*"((?:[^"\\]|\\.)*)"/);
    // A SQL node's column id is its name, unless a (legacy) column @id re-keys it.
    const colId = annotations.match(/@id\(\s*"([^"]+)"/);
    columns.push({
      id: colId ? colId[1] : name, name, dataType: cast ? cast[1].trim().toUpperCase() : "",
      description: desc ? desc[1].replace(/\\(.)/g, "$1") : "",
      isBusinessKey: /@isBusinessKey\b/.test(annotations), isSurrogateKey: false,
    });
  }
  return columns;
}

function readNode(file, typeNames) {
  const text = fs.readFileSync(file, "utf8");
  const base = path.basename(file).replace(/\.(ya?ml|sql)$/, "");
  const dash = base.indexOf("-");
  if (file.endsWith(".sql")) {
    const id = (text.match(/^@id\(\s*"([^"]+)"/m) || [])[1];
    const type = (text.match(/^@nodeType\(\s*"([^"]+)"/m) || [])[1] || "";
    const desc = (text.match(/^@description\(\s*"((?:[^"\\]|\\.)*)"/m) || [])[1] || "";
    return { id: id || file, name: base.slice(dash + 1), location: base.slice(0, dash), sqlType: type, typeName: typeNames.get(type) || type, description: desc.replace(/\\(.)/g, "$1"), columns: sqlNodeColumns(text), file, format: "sql" };
  }
  const obj = YAML.parse(text) || {};
  const op = obj.operation || {};
  const sqlType = String(op.sqlType ?? "");
  return {
    id: String(obj.id), name: obj.name || op.name || base.slice(dash + 1), location: op.locationName || base.slice(0, dash),
    sqlType, typeName: typeNames.get(sqlType) || sqlType, description: op.description || "",
    isSource: op.type === "sourceInput" || sqlType === "Source",
    columns: ((op.metadata || {}).columns || []).map((c) => ({
      id: (c.columnReference || {}).columnCounter || null, name: c.name, dataType: c.dataType || "", description: c.description || "",
      isBusinessKey: !!c.isBusinessKey, isSurrogateKey: !!c.isSurrogateKey,
    })),
    file, format: "yml", obj: isPackageNode(obj) ? obj : undefined, semantic: isPackageNode(obj),
  };
}

function loadWorkspace(dir) {
  const read = (f) => { try { return YAML.parse(fs.readFileSync(path.join(dir, f), "utf8")) || {}; } catch { return {}; } };
  const wsYml = read("workspace.yml");
  const locations = {};
  for (const [loc, v] of Object.entries(wsYml.locations || {})) locations[loc] = { database: v.database, schema: v.schema };
  // Node types: the workspace's own, then those of installed packages (referenced as
  // <alias>:::<id>). The Semantic View package's type is recognised by its config.
  const typeNames = new Map();
  let semanticType = null;
  const scanTypes = (rel, prefix) => {
    const abs = path.join(dir, rel);
    for (const d of fs.existsSync(abs) ? fs.readdirSync(abs) : []) {
      const def = read(path.join(rel, d, "definition.yml"));
      if (def.id === undefined) continue;
      const spec = String((def.metadata || {}).nodeMetadataSpec || "");
      const name = (spec.match(/capitalized:\s*(.+)/) || [])[1] || def.name || d;
      // Package caches already store the full "<alias>:::<id>" reference.
      const ref = String(def.id).includes(":::") ? String(def.id) : prefix + String(def.id);
      typeNames.set(ref, name.trim());
      if (!semanticType && /attributeName:\s*primaryKeyConfig/.test(spec) && /semantic view/i.test(spec)) semanticType = { ref, name: name.trim(), source: prefix ? `package ${prefix.slice(0, -3)}` : `nodeTypes/${d}` };
    }
  };
  scanTypes("nodeTypes", "");
  const packages = [];
  const pkgDir = path.join(dir, "packages");
  for (const f of fs.existsSync(pkgDir) ? fs.readdirSync(pkgDir) : []) {
    if (!/\.ya?ml$/.test(f)) continue;
    const p = read(path.join("packages", f));
    const alias = f.replace(/\.ya?ml$/, "");
    const hydrated = fs.existsSync(path.join(dir, ".coa", "cache", "packages", alias, "nodeTypes"));
    let version = null;
    try { version = JSON.parse(fs.readFileSync(path.join(dir, ".coa", "cache", "packages.json"), "utf8"))[alias].contents.release.version; } catch { /* not downloaded */ }
    packages.push({ alias, packageID: p.packageID || p.id, releaseID: p.releaseID || null, hydrated, version });
    if (hydrated) scanTypes(path.join(".coa", "cache", "packages", alias, "nodeTypes"), `${alias}:::`);
  }
  const semanticPackage = packages.find((p) => p.packageID === PACKAGE_ID) || null;
  const nodes = new Map(); // "LOCATION.NAME" upper → node
  const nodesDir = path.join(dir, "nodes");
  for (const f of fs.existsSync(nodesDir) ? fs.readdirSync(nodesDir) : []) {
    if (!/\.(ya?ml|sql)$/.test(f)) continue;
    const full = path.join(nodesDir, f);
    const st = fs.statSync(full);
    const stamp = `${st.mtimeMs}:${st.size}`;
    let c = cache.get(full);
    if (!c || c.stamp !== stamp) {
      try { c = { stamp, node: readNode(full, typeNames) }; } catch (e) { c = { stamp, node: null, error: e.message }; }
      cache.set(full, c);
    }
    if (c.node) nodes.set(`${c.node.location}.${c.node.name}`.toUpperCase(), c.node);
  }
  // Locations holding only source nodes are where raw data lands, not where views go.
  const modeled = new Set(), sourced = new Set();
  for (const n of nodes.values()) (n.isSource ? sourced : modeled).add(n.location);
  const sourceOnlyLocations = new Set([...sourced].filter((l) => !modeled.has(l)));
  // The workspace's own default location (locations.yml defaultStorageMapping), else the
  // first location that isn't source-only.
  const locYml = read("locations.yml");
  const declared = locYml.defaultStorageMapping || wsYml.defaultStorageMapping;
  const known = (l) => !!l && (l in locations || (locYml.locations || []).includes(l));
  const defaultLocation = known(declared) ? declared
    : Object.keys(locations).find((l) => !sourceOnlyLocations.has(l)) || Object.keys(locations)[0] || "";
  return { dir, locations, nodes, profile: wsYml.profile, semanticType, semanticPackage, defaultLocation, sourceOnlyLocations };
}

module.exports = { loadWorkspace, sqlNodeColumns };
