// The node format of Coalesce's Semantic View package (@coalesce/snowflake/semantic-view,
// node type "Semantic View"). The app edits a view as a spec (see spec.js) and stores it
// as one of these nodes:
//
//   operation.config
//     deriveCol: false                       (true builds a "schema table" instead of the view)
//     semanticMaterialization: semantic view
//     tableOnlyToggle                        no PRIMARY KEY on any table
//     primaryKeyConfig.items[]               { primaryKey: <col>, primAlias, primSynonym, primComment }
//                                            one row per key column; rows are grouped by the
//                                            column's source node, so each row set is a table
//     foreignToggle, foreignKeyConfig.items[] { foreignKey: <col>, refTable: <alias>, refAlias }
//                                            "<from> (<col>) REFERENCES <refTable>" (its primary key)
//     factToggle, factDetConfig.items[]      { factLayer, factCol: <col>, factTranform, factAlias, factSynonym, factComment }
//     dimToggle, DimConfig.items[]           { dimLayer, dimCol, dimTransform, dimAlias, dimSynonym, dimComment }
//     metricToggle, metricConfig.items[]     { metricLayer, metricTransform: COUNT|SUM|AVG|MIN|MAX, metricCol,
//                                              metricTransformExprn, metricAlias, metricSynonym, metricComment }
//     aiSqlGeneration, aiQuestionCategorization
//     aiVerifiedQueriesEnabled, aiVerifiedQueries.items[] { name, question, verifiedAt, verifiedBy, useAsOnboardingQuestion, sql }
//
//   <col> = { columnCounter, name, stepCounter } — a column of this node. The node's columns
//   are the physical source columns the view uses, with lineage to their source node, and
//   the package finds each column's table through that lineage. Names are quoted exactly as
//   written, so case is preserved.
const crypto = require("crypto");
const S = require("./spec");

const PACKAGE_ID = "@coalesce/snowflake/semantic-view";
// The release this app is verified against: npm test renders its fixture through it, and
// the app installs this release when the user asks it to.
const TESTED_RELEASE = { version: "1.1.0", releaseID: "e64bb2fc-372c-4ecd-8100-f0ac70ccec29" };
// packages/<alias>.yml, as Coalesce writes it when the package is installed from Build Settings.
function packageDeclaration(alias) {
  return { config: { entities: { nodeTypes: {} }, packageVariables: "" }, fileVersion: 1, id: PACKAGE_ID, name: alias, packageID: PACKAGE_ID, releaseID: TESTED_RELEASE.releaseID, type: "Package" };
}
const AGGS = ["COUNT", "SUM", "AVG", "MIN", "MAX"];
const str = (v) => (v === null || v === undefined ? "" : String(v));
const up = (s) => str(s).toUpperCase();
const unq = (s) => str(s).trim().replace(/"/g, "");
const synonymText = (list) => list.join(", ");
const synonymList = (text) => str(text).split(",").map((x) => x.trim()).filter(Boolean);

// Is this a Semantic View package node? (Recognised by its config, so any install alias works.)
function isPackageNode(obj) {
  const op = (obj && obj.operation) || {};
  return !!(op.config && op.config.primaryKeyConfig !== undefined && str(op.materializationType).toLowerCase() === "semantic view");
}

// ── Expressions ─────────────────────────────────────────────────────────────
const mapRefs = S.mapRefs;
// Rewrite `table.name` references for the package, which quotes every alias and field name:
// table aliases become "alias", a field of that table becomes "<field name as defined>", and a
// physical column becomes "<COLUMN>" (an unquoted name means its upper-case form). A
// reference means what S.resolveRef says: a field whose name matches exactly, else a
// physical column of the table, else a field whose name matches ignoring case.
function pkgExpr(expr, spec, ws, self) {
  const q = (x) => `"${str(x).replace(/"/g, '""')}"`;
  return mapRefs(expr, (a, b) => {
    const r = S.resolveRef(spec, ws, a, b, self);
    if (!r) return null;
    return `${q(r.table.alias)}.${q(r.field ? r.field.name : r.column ? r.column.name : r.physical)}`;
  });
}
// The reverse, for display: "alias"."NAME" → alias.NAME wherever that reads the same.
function appExpr(expr) {
  const plain = /^[A-Za-z_][A-Za-z0-9_$]*$/;
  return mapRefs(expr, (a, b) => (a.quoted && b.quoted && plain.test(a.name) && plain.test(b.name) ? `${a.name}.${b.name}` : null));
}
// AGG(inner) where the outer parentheses wrap the whole rest of the expression.
function metricParts(expr) {
  const m = str(expr).trim().match(/^([A-Za-z_]+)\s*\(([\s\S]*)\)$/);
  if (!m || !AGGS.includes(up(m[1]))) return null;
  let depth = 0, quote = false;
  for (const ch of m[2]) {
    if (ch === "'") quote = !quote;
    if (quote) continue;
    if (ch === "(") depth++;
    if (ch === ")" && --depth < 0) return null;
  }
  return depth === 0 ? { agg: up(m[1]), inner: m[2].trim() } : null;
}
// "alias.COLUMN" (or quoted parts) naming one physical column of the field's own table, and
// not a field of that table (a field with that exact name wins, as in pkgExpr).
// A bare name ("ACCOUNT_ID") is a column of the field's own table. `self` is the field being
// stored: a field named like its column (ACCOUNT_ID AS t.ACCOUNT_ID) reads the column.
function plainColumn(expr, table, node, spec, self) {
  if (!node) return null;
  const e = str(expr).trim();
  let m = e.match(/^(?:"([^"]+)"|([A-Za-z_][\w$]*))\s*\.\s*(?:"([^"]+)"|([A-Za-z_][\w$]*))$/);
  let quoted, name;
  if (m) {
    const alias = m[1] !== undefined ? m[1] : m[2];
    if (m[1] !== undefined ? alias !== table : up(alias) !== up(table)) return null;
    quoted = m[3] !== undefined; name = quoted ? m[3] : m[4];
  } else {
    m = e.match(/^(?:"([^"]+)"|([A-Za-z_][\w$]*))$/);
    if (!m || /^(TRUE|FALSE|NULL)$/i.test(m[2] || "")) return null;
    quoted = m[1] !== undefined; name = quoted ? m[1] : m[2];
  }
  if (spec && ["facts", "dimensions", "metrics"].some((k) => spec[k].some((f) => f !== self && f.table === table && f.name === name))) return null;
  return node.columns.find((c) => (quoted ? c.name === name : up(c.name) === up(name))) || null;
}
// COUNT(DISTINCT t.COL): the column inside DISTINCT, when it is one.
function distinctColumn(inner, table, node, spec, self) {
  const m = str(inner).trim().match(/^DISTINCT\s+(\S[\s\S]*)$/i);
  return m ? plainColumn(m[1], table, node, spec, self) : null;
}

// ── What the package can store ──────────────────────────────────────────────
// Issues for definitions the package's node format cannot hold. Each is an error: saving
// would lose it.
function packageIssues(specIn, ws) {
  const spec = S.normalize(specIn);
  const issues = [];
  const add = (where, message, fix) => issues.push({ level: "error", where, message, pkg: true, ...(fix ? { fix } : {}) });
  const PKG = "The Semantic View package";
  const byNode = new Map();
  for (const t of spec.tables) {
    const k = up(`${t.location}.${t.node}`);
    if (byNode.has(k)) add(`table ${t.alias}`, `${PKG} keys tables by node, so ${t.node} can appear only once (it is also ${byNode.get(k)}). Remove one of them.`, "node");
    else byNode.set(k, t.alias);
    if (t.unique.length) add(`table ${t.alias}`, `${PKG} has no unique keys yet. Remove the unique keys from ${t.alias}.`, "unique");
  }
  const keyed = spec.tables.filter((t) => t.primaryKey.length);
  if (keyed.length && keyed.length < spec.tables.length) {
    for (const t of spec.tables) if (!t.primaryKey.length) add(`table ${t.alias}`, `${PKG} needs a primary key on every table once any table has one. Set the primary key of ${t.alias}.`, "primaryKey");
  }
  if (!keyed.length && spec.tables.length > 1 && spec.relationships.length) {
    add("joins", `${PKG} joins to a table's primary key, and no table has one. Set the primary keys.`);
  }
  for (const r of spec.relationships) {
    const where = `relationship ${r.name || `${r.from} → ${r.to}`}`;
    const to = spec.tables.find((t) => t.alias === r.to);
    if (r.asof) add(where, `${PKG} has no as-of joins yet. Make this an exact join.`, "asof");
    if (r.fromColumns.length > 1 || r.toColumns.length > 1) {
      add(where, `${PKG} joins on one column, so it cannot join to a composite key (${r.toColumns.join(" + ")}) yet. Join on a single-column key instead.`, "columns");
    } else if (to && r.toColumns.length === 1 && !(to.primaryKey.length === 1 && to.primaryKey[0] === r.toColumns[0])) {
      add(where, `${PKG} always joins to the primary key of the looked-up table, and ${r.toColumns[0]} is not the primary key of ${r.to}${to.primaryKey.length ? ` (${to.primaryKey.join(" + ")})` : ""}.`, "columns");
    }
  }
  for (const [key, kind] of [["facts", "fact"], ["dimensions", "dimension"], ["metrics", "metric"]]) {
    for (const f of spec[key]) {
      const where = `${kind} ${f.table ? f.table + "." : ""}${f.name}`;
      if (f.private) add(where, `${PKG} has no private ${kind}s yet. Clear Private.`, "private");
      if (f.synonyms.some((x) => /[',]/.test(x))) add(where, `${PKG} cannot store synonyms containing a comma or an apostrophe.`, "synonyms");
      if (kind === "metric" && f.expr) {
        if (!f.table) add(where, `${PKG} has no derived metrics yet; every metric belongs to a table.`, "table");
        else if (!metricParts(f.expr)) add(where, `${PKG} builds each metric as COUNT, SUM, AVG, MIN or MAX of one expression, for example SUM(${f.table}.AMOUNT) or COUNT(DISTINCT ${f.table}.ID).`, "expr");
      }
    }
  }
  for (const t of spec.tables) {
    if (t.synonyms.some((x) => /[',]/.test(x))) add(`table ${t.alias}`, `${PKG} cannot store synonyms containing a comma or an apostrophe.`, "synonyms");
    const room = Math.max(1, t.primaryKey.length);
    if (t.synonyms.length > room) add(`table ${t.alias}`, `${PKG} stores one table synonym per primary key column, so ${t.alias} can have ${room === 1 ? "one synonym" : `${room} synonyms`}. Remove ${t.synonyms.length - room}.`, "synonyms");
  }
  return issues;
}

// ── Spec → node ─────────────────────────────────────────────────────────────
// view: { id, name, location, description, spec }, ws: workspace, existing: current node
// object (keeps column ids stable), nodeType: the node type reference (e.g. "semantic-view:::632").
function toNode(view, ws, existing, nodeType) {
  const spec = S.normalize(view.spec);
  const nodeId = view.id || crypto.randomUUID();
  const oldOp = (existing && existing.operation) || {};
  const tableNode = (t) => ws.nodes.get(up(`${t.location}.${t.node}`));
  const byAlias = new Map(spec.tables.map((t) => [t.alias, t]));
  // Existing column ids by source column, so config references stay stable across saves.
  const oldIds = new Map();
  for (const c of (oldOp.metadata && oldOp.metadata.columns) || []) {
    const ref = (((c.sourceColumnReferences || [])[0] || {}).columnReferences || [])[0];
    if (ref) oldIds.set(`${ref.stepCounter}|${ref.columnCounter}`, c.columnReference.columnCounter);
  }
  const columns = [];
  const colKey = new Map(); // "alias|COLUMN" → node column
  const useColumn = (t, name) => {
    const node = tableNode(t);
    const src = node && node.columns.find((c) => c.name === name);
    if (!src) return null;
    const k = `${t.alias}|${src.name}`;
    if (colKey.has(k)) return colKey.get(k);
    const srcId = src.id || src.name;
    const col = {
      appliedColumnTests: {},
      columnReference: { columnCounter: oldIds.get(`${node.id}|${srcId}`) || crypto.randomUUID(), stepCounter: nodeId },
      config: {},
      dataType: src.dataType || "VARCHAR",
      description: src.description || "",
      name: src.name,
      nullable: true,
      sourceColumnReferences: [{ columnReferences: [{ columnCounter: srcId, stepCounter: node.id }], transform: "" }],
    };
    columns.push(col); colKey.set(k, col);
    return col;
  };
  const ref = (col) => (col ? { columnCounter: col.columnReference.columnCounter, name: col.name, stepCounter: nodeId } : null);
  // The first physical column of the field's own table that an expression reads (gives the package the table).
  const firstColumn = (f) => {
    const t = byAlias.get(f.table), node = t && tableNode(t);
    if (!node) return null;
    for (const r of S.exprRefs(f.expr)) {
      if (r.quoted ? r.table !== t.alias : up(r.table) !== up(t.alias)) continue;
      const c = node.columns.find((x) => (r.quoted ? x.name === r.name : up(x.name) === up(r.name)));
      if (c) return useColumn(t, c.name);
    }
    return null;
  };

  const tableOnly = !spec.tables.some((t) => t.primaryKey.length);
  const primaryKeyConfig = [];
  for (const t of spec.tables) {
    const node = tableNode(t);
    // Without keys the package still lists a table through one of its columns.
    const keyCols = tableOnly ? (node && node.columns.length ? [node.columns[0].name] : []) : t.primaryKey;
    // Each key row carries one table synonym: the package turns every row's text into one synonym.
    keyCols.forEach((c, k) => primaryKeyConfig.push({
      primAlias: t.alias, primComment: k ? "" : t.comment, primSynonym: t.synonyms[k] || "", primaryKey: ref(useColumn(t, c)),
    }));
  }
  const foreignKeyConfig = spec.relationships.filter((r) => byAlias.has(r.from) && r.fromColumns[0]).map((r) => ({
    foreignKey: ref(useColumn(byAlias.get(r.from), r.fromColumns[0])), refAlias: r.name, refTable: r.to,
  }));
  const fieldItem = (f, p) => {
    const t = byAlias.get(f.table), node = t && tableNode(t);
    const plain = plainColumn(f.expr, f.table, node, spec, f);
    const col = plain ? useColumn(t, plain.name) : firstColumn(f);
    return {
      [`${p}Layer`]: "1",
      [`${p}Col`]: ref(col),
      [p === "fact" ? "factTranform" : `${p}Transform`]: plain ? "" : pkgExpr(f.expr, spec, ws, f),
      [`${p}Alias`]: col ? f.name : `${f.table}.${f.name}`,
      [`${p}Synonym`]: synonymText(f.synonyms),
      [`${p}Comment`]: f.comment,
    };
  };
  const metricItem = (f) => {
    const t = byAlias.get(f.table), node = t && tableNode(t);
    const parts = metricParts(f.expr) || { agg: "SUM", inner: f.expr };
    const plain = plainColumn(parts.inner, f.table, node, spec, f);
    const distinct = !plain && distinctColumn(parts.inner, f.table, node, spec, f);
    const col = plain ? useColumn(t, plain.name) : distinct ? useColumn(t, distinct.name) : firstColumn({ ...f, expr: parts.inner });
    return {
      metricAlias: col ? f.name : `${f.table}.${f.name}`,
      metricCol: ref(col),
      metricComment: f.comment,
      metricLayer: "1",
      metricSynonym: synonymText(f.synonyms),
      metricTransform: parts.agg,
      metricTransformExprn: plain ? "" : distinct ? `DISTINCT "${f.table}"."${distinct.name}"` : pkgExpr(parts.inner, spec, ws, f),
    };
  };
  const factDetConfig = spec.facts.map((f) => fieldItem(f, "fact"));
  const DimConfig = spec.dimensions.map((f) => fieldItem(f, "dim"));
  const metricConfig = spec.metrics.map(metricItem);
  // Every physical column an expression reads is a node column too, for column lineage.
  for (const k of ["facts", "dimensions", "metrics"]) for (const f of spec[k]) {
    const t = byAlias.get(f.table), node = t && tableNode(t);
    if (node) for (const r of S.exprRefs(f.expr)) {
      if (r.quoted ? r.table !== t.alias : up(r.table) !== up(t.alias)) continue;
      const c = node.columns.find((x) => (r.quoted ? x.name === r.name : up(x.name) === up(r.name)));
      if (c) useColumn(t, c.name);
    }
  }

  const deps = [];
  for (const t of spec.tables) if (!deps.some((d) => d.locationName === t.location && d.nodeName === t.node)) deps.push({ locationName: t.location, nodeName: t.node });
  const config = {
    ...(oldOp.config || {}),
    deriveCol: false,
    semanticMaterialization: "semantic view",
    tableOnlyToggle: tableOnly,
    primaryKeyConfig: { items: primaryKeyConfig },
    foreignToggle: foreignKeyConfig.length > 0,
    foreignKeyConfig: { items: foreignKeyConfig },
    factToggle: factDetConfig.length > 0,
    factDetConfig: { items: factDetConfig },
    dimToggle: DimConfig.length > 0,
    DimConfig: { items: DimConfig },
    metricToggle: metricConfig.length > 0,
    metricConfig: { items: metricConfig },
    aiSqlGeneration: spec.aiSqlGeneration,
    aiQuestionCategorization: spec.aiQuestionCategorization,
    aiVerifiedQueriesEnabled: spec.verifiedQueries.length > 0,
    aiVerifiedQueries: { items: spec.verifiedQueries.map((v) => ({
      name: v.name, question: v.question, verifiedAt: v.verifiedAt, verifiedBy: v.verifiedBy, useAsOnboardingQuestion: v.onboarding, sql: v.sql,
    })) },
  };
  return {
    fileVersion: 1,
    id: nodeId,
    name: view.name,
    operation: {
      config,
      database: "",
      deployEnabled: oldOp.deployEnabled !== false,
      description: str(view.description).trim(),
      isMultisource: false,
      locationName: view.location,
      materializationType: "semantic view",
      metadata: {
        appliedNodeTests: [],
        columns,
        sourceMapping: [{ aliases: {}, dependencies: deps, join: { joinCondition: S.joinClause(spec) }, name: view.name, noLinkRefs: [] }],
      },
      name: view.name,
      overrideSQL: false,
      schema: "",
      sqlType: nodeType,
      type: "sql",
      version: 1,
    },
    type: "Node",
  };
}

// ── Node → spec ─────────────────────────────────────────────────────────────
// Also reads nodes built in Coalesce's own config panel. Returns { view, notes }.
function fromNode(obj, ws) {
  const op = (obj && obj.operation) || {};
  const cfg = op.config || {};
  const items = (x) => (x && Array.isArray(x.items) ? x.items : Array.isArray(x) ? x : []);
  const nodesById = new Map([...ws.nodes.values()].map((n) => [String(n.id), n]));
  const notes = [];
  // Node column id → { name, source node }
  const cols = new Map();
  for (const c of (op.metadata && op.metadata.columns) || []) {
    const r = (((c.sourceColumnReferences || [])[0] || {}).columnReferences || [])[0];
    cols.set(c.columnReference && c.columnReference.columnCounter, { name: c.name, node: r ? nodesById.get(String(r.stepCounter)) : null });
  }
  const colOf = (ref) => (ref && (cols.get(ref.columnCounter) || cols.get(ref.id))) || (ref ? { name: ref.name, node: null } : null);
  const tables = [];
  const aliasOfNode = new Map(); // source node id → alias
  const tableFor = (node, alias) => {
    if (!node) return null;
    if (aliasOfNode.has(node.id)) return tables.find((t) => t.alias === aliasOfNode.get(node.id));
    const t = { alias: unq(alias) || node.name, location: node.location, node: node.name, primaryKey: [], unique: [], synonyms: [], comment: "" };
    tables.push(t); aliasOfNode.set(node.id, t.alias);
    return t;
  };
  for (const it of items(cfg.primaryKeyConfig)) {
    const c = colOf(it.primaryKey);
    const t = c && tableFor(c.node, it.primAlias);
    if (!t) { notes.push(`A primary key row points at a column (${(it.primaryKey || {}).name || "?"}) whose table could not be found.`); continue; }
    if (!cfg.tableOnlyToggle && !t.primaryKey.includes(c.name)) t.primaryKey.push(c.name);
    const syn = str(it.primSynonym).trim();
    if (syn && !t.synonyms.includes(syn)) t.synonyms.push(syn);
    if (str(it.primComment).trim() && !t.comment.split(", ").includes(str(it.primComment).trim())) t.comment = t.comment ? `${t.comment}, ${str(it.primComment).trim()}` : str(it.primComment).trim();
  }
  const aliasOf = (c) => (c && c.node ? (aliasOfNode.get(c.node.id) || tableFor(c.node, "").alias) : "");
  const relationships = cfg.foreignToggle ? items(cfg.foreignKeyConfig).map((it) => {
    const c = colOf(it.foreignKey);
    const to = tables.find((t) => t.alias === unq(it.refTable)) || tables.find((t) => up(t.alias) === up(unq(it.refTable)));
    return { name: unq(it.refAlias), from: aliasOf(c), fromColumns: c ? [c.name] : [], to: to ? to.alias : unq(it.refTable), toColumns: to ? [...to.primaryKey] : [], asof: false };
  }) : [];
  const field = (it, p, transformKey) => {
    const c = colOf(it[`${p}Col`]);
    const alias = unq(it[`${p}Alias`]);
    const [tbl, nm] = alias.includes(".") ? [alias.split(".")[0], alias.split(".").slice(1).join(".")] : [aliasOf(c), alias || (c && c.name) || ""];
    const transform = S.qualifyBare(appExpr(str(it[transformKey]).trim()), tbl);
    return { table: tbl, name: nm, expr: transform || (c ? `${tbl}.${/^[A-Z_][A-Z0-9_$]*$/.test(c.name) ? c.name : `"${c.name}"`}` : ""), synonyms: synonymList(it[`${p}Synonym`]), comment: str(it[`${p}Comment`]).trim() };
  };
  const facts = cfg.factToggle ? items(cfg.factDetConfig).map((it) => field(it, "fact", "factTranform")) : [];
  const dimensions = cfg.dimToggle ? items(cfg.DimConfig).map((it) => field(it, "dim", "dimTransform")) : [];
  const metrics = cfg.metricToggle ? items(cfg.metricConfig).map((it) => {
    const c = colOf(it.metricCol);
    const alias = unq(it.metricAlias);
    const [tbl, nm] = alias.includes(".") ? [alias.split(".")[0], alias.split(".").slice(1).join(".")] : [aliasOf(c), alias || (c && c.name) || ""];
    const inner = appExpr(str(it.metricTransformExprn).trim()) || (c ? `${tbl}.${/^[A-Z_][A-Z0-9_$]*$/.test(c.name) ? c.name : `"${c.name}"`}` : "");
    return { table: tbl, name: nm, expr: S.qualifyBare(`${it.metricTransform || "SUM"}(${inner})`, tbl), synonyms: synonymList(it.metricSynonym), comment: str(it.metricComment).trim() };
  }) : [];
  if (cfg.deriveCol) notes.push("Create Schema Table is on in this node, so deploying it builds a table instead of the semantic view. Saving here turns it off.");
  const verifiedQueries = cfg.aiVerifiedQueriesEnabled ? items(cfg.aiVerifiedQueries).map((v) => ({
    name: str(v.name).trim(), question: str(v.question).trim(), sql: str(v.sql).trim(), onboarding: !!v.useAsOnboardingQuestion, verifiedAt: str(v.verifiedAt).trim(), verifiedBy: str(v.verifiedBy).trim(),
  })) : [];
  return {
    view: {
      id: String(obj.id), name: obj.name || op.name, location: op.locationName, description: op.description || "",
      spec: S.normalize({ tables, relationships, facts, dimensions, metrics, aiSqlGeneration: cfg.aiSqlGeneration, aiQuestionCategorization: cfg.aiQuestionCategorization, verifiedQueries }),
    },
    notes,
  };
}

// ── DDL preview ─────────────────────────────────────────────────────────────
// What the package's create template renders for toNode()'s output (checked by npm test
// against coa when the package is installed).
function toDDL(view, ws) {
  const spec = S.normalize(view.spec);
  const q = (x) => `"${unq(x)}"`;
  const lit = (x) => `'${str(x).replace(/'/g, "''")}'`;
  const loc = (l) => ws.locations[l];
  const fqn = (l, name) => (loc(l) ? `"${loc(l).database}"."${loc(l).schema}"."${name}"` : `${l}."${name}"`);
  const syn = (list) => (list.length ? ` WITH SYNONYMS (${list.map((x) => `'${x}'`).join(", ")})` : "");
  // Comments, the view comment and the instructions go through Coalesce's escape filter.
  const esc = (x) => `'${str(x).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"')}'`;
  const cmt = (c) => (c ? ` COMMENT = ${esc(c)}` : "");
  const tableOnly = !spec.tables.some((t) => t.primaryKey.length);
  const qn = (name, table) => (unq(name).includes(".") ? `${q(unq(name).split(".")[0])}.${q(unq(name).split(".").slice(1).join("."))}` : table ? `${q(table)}.${q(name)}` : q(name));
  const node = (t) => ws.nodes.get(up(`${t.location}.${t.node}`));
  const block = (kw, list) => (list.length ? `${kw} (\n${list.map((x) => `    ${x}`).join(",\n")}\n)\n` : "");
  let sql = `CREATE OR REPLACE SEMANTIC VIEW ${fqn(view.location, view.name)}\n`;
  // The package lists tables grouped (so sorted) by their table path.
  const tables = [...spec.tables].sort((a, b) => (fqn(a.location, a.node) < fqn(b.location, b.node) ? -1 : 1));
  sql += block("TABLES", tables.map((t) => `${q(t.alias)} AS ${fqn(t.location, t.node)}${tableOnly ? "" : ` PRIMARY KEY (${t.primaryKey.map(q).join(", ")})`}${syn(t.synonyms)}${cmt(t.comment)}`));
  sql += block("RELATIONSHIPS", spec.relationships.map((r) => `${r.name ? `${q(r.name)} AS ` : ""}${q(r.from)} (${q(r.fromColumns[0] || "")}) REFERENCES ${q(r.to)}`));
  const field = (f) => {
    const plain = plainColumn(f.expr, f.table, node(spec.tables.find((t) => t.alias === f.table) || {}), spec, f);
    return `${qn(f.name, f.table)} AS ${plain ? `${q(f.table)}.${q(plain.name)}` : pkgExpr(f.expr, spec, ws, f)}${syn(f.synonyms)}${cmt(f.comment)}`;
  };
  sql += block("FACTS", spec.facts.map(field));
  sql += block("DIMENSIONS", spec.dimensions.map(field));
  sql += block("METRICS", spec.metrics.map((f) => {
    const p = metricParts(f.expr) || { agg: "SUM", inner: f.expr };
    const tn = node(spec.tables.find((t) => t.alias === f.table) || {});
    const plain = plainColumn(p.inner, f.table, tn, spec, f);
    const distinct = !plain && distinctColumn(p.inner, f.table, tn, spec, f);
    const inner = plain ? `${q(f.table)}.${q(plain.name)}` : distinct ? `DISTINCT ${q(f.table)}.${q(distinct.name)}` : pkgExpr(p.inner, spec, ws, f);
    return `${qn(f.name, f.table)} AS ${p.agg}(${inner})${syn(f.synonyms)}${cmt(f.comment)}`;
  }));
  if (str(view.description).trim()) sql += `COMMENT = ${esc(str(view.description).trim())}\n`;
  if (spec.aiSqlGeneration) sql += `AI_SQL_GENERATION ${esc(spec.aiSqlGeneration)}\n`;
  if (spec.aiQuestionCategorization) sql += `AI_QUESTION_CATEGORIZATION ${esc(spec.aiQuestionCategorization)}\n`;
  sql += block("AI_VERIFIED_QUERIES", spec.verifiedQueries.map((v) => `${q(v.name)} AS (\n        QUESTION ${lit(v.question)}${v.verifiedAt ? `\n        VERIFIED_AT ${v.verifiedAt}` : ""}${v.onboarding ? "\n        ONBOARDING_QUESTION TRUE" : ""}${v.verifiedBy ? `\n        VERIFIED_BY ${lit(v.verifiedBy)}` : ""}\n        SQL ${lit(v.sql)}\n    )`));
  return sql.trimEnd();
}

module.exports = { PACKAGE_ID, TESTED_RELEASE, packageDeclaration, AGGS, isPackageNode, packageIssues, toNode, fromNode, toDDL, pkgExpr, appExpr, metricParts, mapRefs };
