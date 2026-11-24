// The semantic view spec the app edits, and everything derived from it, as pure functions:
//   normalize   clean a spec coming from the browser or a node file
//   validate    offline checks against the workspace's nodes (Snowflake's rules)
//   joinClause  the node's join, written from the relationships
//   fromDescribe  DESCRIBE SEMANTIC VIEW rows → spec (import, drift)
//   diffSpecs   repo spec vs deployed spec
//   suggest*    primary keys, relationships and starter fields from node metadata
//   toQuery     a SEMANTIC_VIEW() test query
// pkg.js stores a spec as a node of Coalesce's Semantic View package and checks what that
// node format can hold.
//
// Spec shape (the view's comment is the node description):
//   tables:        [{ alias, location, node, primaryKey: [col], unique: [[col]], synonyms: [], comment }]
//   relationships: [{ name, from, fromColumns: [col], to, toColumns: [col], asof }]
//                  from is the many side; to is the table it looks up. asof makes the last
//                  column pair an ASOF match (latest `to` row at or before the `from` value).
//   facts | dimensions | metrics: [{ table, name, expr, synonyms: [], comment, private }]
//                  (a metric with no table is a derived metric)
//   aiSqlGeneration, aiQuestionCategorization: text
//   verifiedQueries: [{ name, question, sql, onboarding, verifiedAt (epoch seconds), verifiedBy }]
//   layout:        { alias: { x, y } } card positions in the join editor (kept beside the node)
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
// The names Cortex Analyst accepts. The Semantic View package quotes every table alias and
// field name, so a name with a lowercase letter stays lowercase in Snowflake, and Cortex
// Analyst then rejects the whole view ("invalid logical table name", error 392700; checked
// 2026-11-23). Relationship names may be any case.
const CORTEX_NAME = /^[A-Z_][A-Z0-9_$]*$/;
const KINDS = [["facts", "fact"], ["dimensions", "dimension"], ["metrics", "metric"]];
const AGGREGATE = /\b(SUM|COUNT|COUNT_IF|AVG|MIN|MAX|MEDIAN|MODE|STDDEV\w*|VAR\w*|APPROX_\w+|LISTAGG|ARRAY_AGG|OBJECT_AGG|ANY_VALUE|BOOLAND_AGG|BOOLOR_AGG|BITAND_AGG|BITOR_AGG|HLL\w*|PERCENTILE_\w+|MIN_BY|MAX_BY|CORR|COVAR_\w+|REGR_\w+|SKEW|KURTOSIS)\s*\(/i;

const str = (v) => (v === null || v === undefined ? "" : String(v));
const list = (v) => (Array.isArray(v) ? v.map(str).map((s) => s.trim()).filter(Boolean) : []);
const up = (s) => str(s).toUpperCase();

function normalize(input) {
  const s = input || {};
  const field = (f, kind) => {
    const o = { table: str(f.table).trim(), name: str(f.name).trim(), expr: str(f.expr).trim(), synonyms: list(f.synonyms), comment: str(f.comment).trim() };
    if (kind !== "dimension" && f.private) o.private = true;
    return o;
  };
  return {
    tables: (s.tables || []).map((t) => ({
      alias: str(t.alias).trim(), location: str(t.location).trim(), node: str(t.node).trim(),
      primaryKey: list(t.primaryKey), unique: (t.unique || []).map(list).filter((u) => u.length),
      synonyms: list(t.synonyms), comment: str(t.comment).trim(),
    })),
    relationships: (s.relationships || []).map((r) => ({
      name: str(r.name).trim(), from: str(r.from).trim(), fromColumns: list(r.fromColumns), to: str(r.to).trim(), toColumns: list(r.toColumns), asof: !!r.asof,
    })),
    facts: (s.facts || []).map((f) => field(f, "fact")),
    dimensions: (s.dimensions || []).map((f) => field(f, "dimension")),
    metrics: (s.metrics || []).map((f) => field(f, "metric")),
    aiSqlGeneration: str(s.aiSqlGeneration).trim(),
    aiQuestionCategorization: str(s.aiQuestionCategorization).trim(),
    verifiedQueries: (s.verifiedQueries || []).map((v) => ({ name: str(v.name).trim(), question: str(v.question).trim(), sql: str(v.sql).trim(), onboarding: !!v.onboarding,
      verifiedAt: /^\d+$/.test(str(v.verifiedAt).trim()) ? str(v.verifiedAt).trim() : "", verifiedBy: str(v.verifiedBy).trim() })),
    layout: Object.fromEntries(Object.entries(s.layout || {})
      .filter(([, v]) => v && Number.isFinite(+v.x) && Number.isFinite(+v.y))
      .map(([k, v]) => [k, { x: Math.round(+v.x), y: Math.round(+v.y) }])),
  };
}

// ── Joins ───────────────────────────────────────────────────────────────────
// Rough type families, to catch joins that compare unlike values.
function typeFamily(t) {
  const u = up(t).trim();
  if (!u) return "";
  if (/^(NUMBER|DECIMAL|NUMERIC|INT|INTEGER|BIGINT|SMALLINT|TINYINT|BYTEINT|FLOAT|FLOAT4|FLOAT8|DOUBLE|REAL)\b/.test(u)) return "number";
  if (/^(VARCHAR|STRING|TEXT|CHAR|CHARACTER|NCHAR|NVARCHAR)\b/.test(u)) return "text";
  if (/^DATE\b/.test(u)) return "date";
  if (/^(TIMESTAMP|DATETIME)/.test(u)) return "timestamp";
  if (/^TIME\b/.test(u)) return "time";
  if (/^BOOLEAN\b/.test(u)) return "boolean";
  if (/^(VARIANT|OBJECT|ARRAY)\b/.test(u)) return "semi-structured";
  if (/^(BINARY|VARBINARY)\b/.test(u)) return "binary";
  return "";
}
const sameCols = (a, b) => a.length === b.length && a.every((c) => b.some((x) => up(x) === up(c)));
// "many-to-one", "one-to-one" or "many-to-many" from the keys declared on the two tables.
function cardinality(spec, r) {
  const t = (alias) => spec.tables.find((x) => up(x.alias) === up(alias));
  const isKey = (table, columns) => !!table && columns.length > 0 && (sameCols(table.primaryKey, columns) || table.unique.some((u) => sameCols(u, columns)));
  const toKey = isKey(t(r.to), r.toColumns), fromKey = isKey(t(r.from), r.fromColumns);
  return toKey ? (fromKey ? "one-to-one" : "many-to-one") : "many-to-many";
}

// The node's join, written as SQL for people reading the node in Coalesce (the template
// does not use it). The table nothing else references is the starting point, and each
// relationship becomes a LEFT JOIN (or ASOF JOIN) on its columns. Tables no relationship
// reaches are left out; the node's dependencies still link them in the DAG.
function joinClause(specIn) {
  const spec = normalize(specIn);
  if (!spec.tables.length) return "";
  const qa = (a) => `"${a}"`;
  const qc = (a, c) => `${qa(a)}."${c}"`;
  const refOf = (t) => `{{ ref('${t.location}', '${t.node}') }} ${qa(t.alias)}`;
  const byAlias = new Map(spec.tables.map((t) => [up(t.alias), t]));
  const rels = spec.relationships.filter((r) => byAlias.has(up(r.from)) && byAlias.has(up(r.to)) && up(r.from) !== up(r.to) && r.fromColumns.length && r.fromColumns.length === r.toColumns.length);
  const isFrom = (t) => rels.some((r) => up(r.from) === up(t.alias)), isTo = (t) => rels.some((r) => up(r.to) === up(t.alias));
  const root = spec.tables.find((t) => isFrom(t) && !isTo(t)) || spec.tables.find(isFrom) || spec.tables[0];
  const lines = [`FROM ${refOf(root)}`];
  const seen = new Set([up(root.alias)]);
  const used = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rels) {
      if (used.has(r)) continue;
      const fromIn = seen.has(up(r.from)), toIn = seen.has(up(r.to));
      if (fromIn === toIn) continue;
      const add = byAlias.get(up(fromIn ? r.to : r.from));
      const pairs = r.fromColumns.map((c, i) => [c, r.toColumns[i]]);
      const asofPair = r.asof ? pairs.pop() : null;
      const on = pairs.map(([f, t]) => `${qc(r.from, f)} = ${qc(r.to, t)}`).join("\n    AND ");
      // Reached from the looked-up side (two tables sharing a dimension): Snowflake aggregates
      // each table's metrics separately, so say so rather than imply a fan-out.
      const label = `-- ${r.name || `${r.from} -> ${r.to}`}: ${r.from} looks up ${r.to} (${cardinality(spec, r)})${fromIn ? "" : `; Snowflake does not join ${r.from} to the other tables row by row`}\n`;
      if (asofPair) {
        const cond = fromIn ? `${qc(r.from, asofPair[0])} >= ${qc(r.to, asofPair[1])}` : `${qc(r.to, asofPair[1])} <= ${qc(r.from, asofPair[0])}`;
        lines.push(`${label}ASOF JOIN ${refOf(add)}\n    MATCH_CONDITION (${cond})${on ? `\n    ON ${on}` : ""}`);
      } else {
        lines.push(`${label}LEFT JOIN ${refOf(add)}\n    ON ${on}`);
      }
      seen.add(up(add.alias));
      used.add(r);
      grew = true;
    }
  }
  const extra = rels.filter((r) => !used.has(r));
  if (extra.length) lines.push(`-- Also joined, on a second path:\n${extra.map((r) => `--   ${r.from} (${r.fromColumns.join(", ")}) -> ${r.to} (${r.toColumns.join(", ")})${r.asof ? " ASOF" : ""}`).join("\n")}`);
  const loose = spec.tables.filter((t) => !seen.has(up(t.alias)));
  if (loose.length) lines.push(`-- Not joined to the rest yet: ${loose.map((t) => `${t.alias} (${t.location}.${t.node})`).join(", ")}`);
  return lines.join("\n");
}

// ── Expressions ─────────────────────────────────────────────────────────────
// `alias.NAME` / `alias."Name"` references in an expression, skipping string literals.
function exprRefs(expr) {
  const out = [];
  const code = str(expr).replace(/'(?:[^']|'')*'/g, (m) => " ".repeat(m.length));
  const re = /(?<![\w$."])(?:"([^"]+)"|([A-Za-z_][\w$]*))\s*\.\s*(?:"([^"]+)"|([A-Za-z_][\w$]*))(?!\s*\()/g;
  let m;
  while ((m = re.exec(code))) out.push({ table: m[1] !== undefined ? m[1] : m[2], tableQuoted: m[1] !== undefined, name: m[3] !== undefined ? m[3] : m[4], quoted: m[3] !== undefined });
  return out;
}
// Snowflake reports simple expressions with bare column names ("ACCOUNT_ID",
// "COUNT(org_id)", "COUNT(DISTINCT org_id)"). Qualify those with the field's table so they
// read, validate and store like expressions written in the app.
function qualifyBare(expr, table) {
  const e = str(expr).trim();
  if (!table) return e;
  const id = '(?:"[^"]+"|[A-Za-z_][\\w$]*)';
  if (new RegExp(`^${id}$`).test(e)) return /^(TRUE|FALSE|NULL|CURRENT_\w+)$/i.test(e) ? e : `${table}.${e}`;
  const m = e.match(new RegExp(`^([A-Za-z_]+)\\s*\\(\\s*(DISTINCT\\s+)?(${id})\\s*\\)$`, "i"));
  return m ? `${m[1]}(${m[2] ? "DISTINCT " : ""}${table}.${m[3]})` : e;
}
// Rewrite each `table.name` reference in an expression: fn(a, b) gets both parts as
// { text, name, quoted } and returns the replacement text, or null to keep it. String
// literals and function calls (name followed by "(") are left alone.
function mapRefs(expr, fn) {
  const s = str(expr);
  let out = "", i = 0;
  const ident = /^(?:"((?:[^"]|"")+)"|([A-Za-z_][\w$]*))/;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") { // string literal
      let j = i + 1;
      while (j < s.length && !(s[j] === "'" && s[j + 1] !== "'")) j += s[j] === "'" ? 2 : 1;
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    const prev = i ? s[i - 1] : "";
    const m = /[\w$".]/.test(prev) ? null : s.slice(i).match(ident);
    if (m) {
      const a = { text: m[0], name: m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2], quoted: m[1] !== undefined };
      let j = i + m[0].length;
      const dot = s.slice(j).match(/^\s*\.\s*/);
      const m2 = dot && s.slice(j + dot[0].length).match(ident);
      if (m2 && !/^\s*\(/.test(s.slice(j + dot[0].length + m2[0].length))) {
        const b = { text: m2[0], name: m2[1] !== undefined ? m2[1].replace(/""/g, '"') : m2[2], quoted: m2[1] !== undefined };
        const r = fn(a, b);
        out += r === null || r === undefined ? s.slice(i, j + dot[0].length + m2[0].length) : r;
        i = j + dot[0].length + m2[0].length;
        continue;
      }
      out += m[0]; i = j; continue;
    }
    out += ch; i++;
  }
  return out;
}
const findColumn = (node, ref) => node && node.columns.find((c) => (ref.quoted ? c.name === ref.name : up(c.name) === up(ref.name)));
// What `table.name` means inside the view (tbl and col are { name, quoted }): a field of that
// table whose name matches exactly, else a physical column (an unquoted name means its
// upper-case form), else a field whose name matches ignoring case. Snowflake resolves names
// the same way, so a field hides a column with the same name. `self` is the field being
// defined; a field named like its column (ACCOUNT_ID AS t.ACCOUNT_ID) reads the column.
function resolveRef(spec, ws, tbl, col, self) {
  const t = tbl.quoted ? spec.tables.find((x) => x.alias === tbl.name) : spec.tables.find((x) => up(x.alias) === up(tbl.name));
  if (!t) return null;
  const node = (ws && ws.nodes.get(up(`${t.location}.${t.node}`))) || null;
  const fields = KINDS.flatMap(([k]) => spec[k] || []).filter((f) => f !== self && f.table === t.alias);
  const physical = col.quoted ? col.name : up(col.name);
  let field = fields.find((f) => f.name === col.name) || null;
  const column = (!field && node && node.columns.find((c) => c.name === physical)) || null;
  if (!field && !column && !col.quoted) field = fields.find((f) => up(f.name) === up(col.name)) || null;
  return { table: t, node, field, column, physical };
}

// ── Validation ──────────────────────────────────────────────────────────────
// ws: { nodes: Map key → node, locations: { LOC: { database, schema } } }
function validate(name, specIn, ws) {
  const spec = normalize(specIn);
  const issues = [];
  // fix: the setting to change, so the Issues tab can jump to it (see issueTarget in app.js).
  const add = (level, where, message, fix) => issues.push({ level, where, message, ...(fix ? { fix } : {}) });
  if (!IDENT.test(name || "")) add("error", "view", `The view name "${name || ""}" must start with a letter or underscore and use only letters, digits, _ and $.`, "name");
  if (!spec.tables.length) add("error", "tables", "Add at least one table.", "addTable");
  if (!spec.dimensions.length && !spec.metrics.length) add("error", "fields", "Add at least one dimension or metric. Snowflake rejects a semantic view with neither.", "addField");

  const byAlias = new Map();
  for (const t of spec.tables) {
    const where = `table ${t.alias || "(no alias)"}`;
    if (!IDENT.test(t.alias)) add("error", where, `The alias "${t.alias}" must be a plain identifier (letters, digits, _).`, "alias");
    if (byAlias.has(up(t.alias))) add("error", where, `The alias "${t.alias}" is used by more than one table.`, "alias");
    if (IDENT.test(t.alias) && !CORTEX_NAME.test(t.alias)) {
      add("warning", where, `Cortex Analyst can't use this view while the alias ${t.alias} has lowercase letters, because the Semantic View package keeps names exactly as typed. Rename it to ${up(t.alias)}.`, "alias");
      issues[issues.length - 1].cortex = true;
    }
    const node = ws.nodes.get(`${up(t.location)}.${up(t.node)}`);
    byAlias.set(up(t.alias), { t, node });
    if (!node) { add("error", where, `${t.location}.${t.node} is not a node in this workspace.`, "node"); continue; }
    if (!ws.locations[t.location]) add("warning", where, `Location ${t.location} has no database and schema in workspace.yml, so the table name cannot be resolved here.`, "node");
    const keys = [["primary key", t.primaryKey], ...t.unique.map((u, k) => [`unique key ${k + 1}`, u])];
    for (const [label, cols] of keys) {
      const dup = cols.find((c, k) => cols.indexOf(c) !== k);
      if (dup) add("error", where, `The ${label} lists ${dup} twice.`, label === "primary key" ? "primaryKey" : "unique");
    }
    t.unique.forEach((u, k) => {
      if (sameCols(u, t.primaryKey)) add("error", where, `Unique key ${k + 1} (${u.join(", ")}) is the same as the primary key. Snowflake rejects duplicate keys; remove it.`, "unique");
      else if (t.unique.some((o, j) => j < k && sameCols(o, u))) add("error", where, `Unique key ${k + 1} (${u.join(", ")}) repeats an earlier unique key.`, "unique");
    });
    for (const c of [...t.primaryKey, ...t.unique.flat()]) {
      if (!node.columns.some((x) => x.name === c)) add("error", where, `Key column "${c}" is not a column of ${t.node}.`, "primaryKey");
    }
    if (!t.primaryKey.length && spec.relationships.some((r) => up(r.to) === up(t.alias)) && !t.unique.length) {
      add("warning", where, "Other tables reference this table but it has no primary key, so Snowflake will treat those joins as many-to-many.", "primaryKey");
    }
  }

  const relNames = new Set();
  for (const r of spec.relationships) {
    const where = `relationship ${r.name || `${r.from} → ${r.to}`}`;
    if (r.name && !IDENT.test(r.name)) add("error", where, `The relationship name "${r.name}" must be a plain identifier.`, "name");
    if (r.name && relNames.has(up(r.name))) add("error", where, `The relationship name "${r.name}" is used more than once.`, "name");
    relNames.add(up(r.name));
    const a = byAlias.get(up(r.from)), b = byAlias.get(up(r.to));
    if (!a) add("error", where, `"${r.from}" is not a table in this view.`, "from");
    if (!b) add("error", where, `"${r.to}" is not a table in this view.`, "to");
    if (a && b && up(r.from) === up(r.to)) add("error", where, "A table cannot reference itself.", "to");
    if (!r.fromColumns.length || !r.toColumns.length) add("error", where, "Pick the join columns on both sides.", "columns");
    else if (r.fromColumns.length !== r.toColumns.length) add("error", where, `The two sides have different numbers of columns (${r.fromColumns.length} and ${r.toColumns.length}).`, "columns");
    for (const [side, cols] of [[a, r.fromColumns], [b, r.toColumns]]) {
      if (side && side.node) for (const c of cols) if (!side.node.columns.some((x) => x.name === c)) add("error", where, `"${c}" is not a column of ${side.t.node}.`, "columns");
    }
    if (a && a.node && b && b.node) {
      r.fromColumns.forEach((fc, i) => {
        const tc = r.toColumns[i];
        const x = a.node.columns.find((c) => c.name === fc), y = tc && b.node.columns.find((c) => c.name === tc);
        const fx = x && typeFamily(x.dataType), fy = y && typeFamily(y.dataType);
        if (fx && fy && fx !== fy) add("warning", where, `${r.from}.${fc} is ${x.dataType} but ${r.to}.${tc} is ${y.dataType}, so they may never match.`, "columns");
      });
    }
    if (r.asof && r.toColumns.length && r.fromColumns.length === r.toColumns.length) {
      const fc = r.fromColumns[r.fromColumns.length - 1], tc = r.toColumns[r.toColumns.length - 1];
      const fam = (side, c) => { const col = side && side.node && side.node.columns.find((x) => x.name === c); return col ? typeFamily(col.dataType) : ""; };
      const f1 = fam(a, fc), f2 = fam(b, tc);
      if ((f1 && !["number", "date", "timestamp", "time"].includes(f1)) || (f2 && !["number", "date", "timestamp", "time"].includes(f2))) {
        add("warning", where, `The as-of pair ${fc} → ${tc} should be dates, times or numbers.`, "columns");
      }
    }
    if (spec.relationships.some((o) => o !== r && up(o.from) === up(r.from) && up(o.to) === up(r.to) && normColsKey(o) === normColsKey(r))) {
      add("error", where, "Another join connects the same columns of these two tables.", "columns");
    }
    if (b && r.toColumns.length) {
      const same = (k) => k.length === r.toColumns.length && k.every((c) => r.toColumns.includes(c));
      if (!same(b.t.primaryKey) && !b.t.unique.some(same)) {
        const partOf = [b.t.primaryKey, ...b.t.unique].find((k) => k.length > r.toColumns.length && r.toColumns.every((c) => k.includes(c)));
        const msg = partOf
          ? `The key of ${r.to} is (${partOf.join(", ")}), but this join matches only ${r.toColumns.join(", ")}. Add ${[...new Set(partOf.filter((c) => !r.toColumns.includes(c)))].join(", ")} so each ${r.from} row finds at most one ${r.to} row; as it is, this is a many-to-many join (a Snowflake preview feature).`
          : `${r.toColumns.join(", ")} is not the primary key or a unique key of ${r.to}, so this is a many-to-many join (a Snowflake preview feature).`;
        const fromKeyed = a && (a.t.primaryKey.length || a.t.unique.length);
        add("warning", where, fromKeyed ? msg : `${msg} Snowflake also needs a primary key on ${r.from} for many-to-many joins; without one, queries that combine the two tables fail.`, "columns");
      }
    }
  }

  // Snowflake rejects relationships that form a loop (a → b → a).
  {
    const out = new Map();
    for (const r of spec.relationships) if (byAlias.has(up(r.from)) && byAlias.has(up(r.to)) && up(r.from) !== up(r.to)) {
      if (!out.has(up(r.from))) out.set(up(r.from), new Set());
      out.get(up(r.from)).add(up(r.to));
    }
    const state = new Map(), stack = [];
    let loop = null;
    const visit = (n) => {
      if (loop) return;
      state.set(n, 1); stack.push(n);
      for (const m of out.get(n) || []) {
        if (state.get(m) === 1) { loop = [...stack.slice(stack.indexOf(m)), m]; return; }
        if (!state.has(m)) visit(m);
        if (loop) return;
      }
      state.set(n, 2); stack.pop();
    };
    for (const n of out.keys()) if (!state.has(n)) visit(n);
    if (loop) {
      const name = (k) => byAlias.get(k).t.alias;
      add("error", "joins", `The joins form a loop (${loop.map(name).join(" → ")}). Snowflake does not allow circular relationships; remove or reverse one.`);
    }
  }

  // Field names live in one namespace per table.
  const fieldNames = new Map(); // "ALIAS.NAME" → kind
  for (const [key, kind] of KINDS) for (const f of spec[key]) fieldNames.set(`${up(f.table)}.${up(f.name)}`, kind);
  const seen = new Set();
  for (const [key, kind] of KINDS) {
    for (const f of spec[key]) {
      const where = `${kind} ${f.table ? f.table + "." : ""}${f.name || "(no name)"}`;
      if (!IDENT.test(f.name)) add("error", where, `The name "${f.name}" must be a plain identifier (letters, digits, _).`, "name");
      const k = `${up(f.table)}.${up(f.name)}`;
      if (seen.has(k)) add("error", where, `"${f.name}" is defined more than once${f.table ? ` on ${f.table}` : ""}.`, "name");
      seen.add(k);
      if (!f.table && kind !== "metric") add("error", where, `Choose the table this ${kind} belongs to.`, "table");
      if (f.table && !byAlias.has(up(f.table))) add("error", where, `"${f.table}" is not a table in this view.`, "table");
      if (!f.expr) { add("error", where, "The expression is empty.", "expr"); continue; }
      for (const ref of exprRefs(f.expr)) {
        const target = byAlias.get(up(ref.table));
        if (!target) { add("warning", where, `The expression mentions "${ref.table}.${ref.name}", but "${ref.table}" is not a table in this view.`, "expr"); continue; }
        if (!target.node) continue;
        if (!findColumn(target.node, ref) && !fieldNames.has(`${up(ref.table)}.${up(ref.name)}`)) {
          add("warning", where, `"${ref.name}" is neither a column of ${target.t.node} nor a fact, dimension or metric on ${ref.table}.`, "expr");
        }
      }
      // A fact or dimension can't read a metric. With upper-case names this happens by
      // accident when a metric is named like a column the fact reads (ARR.NEW_BUSINESS_ARR).
      if (kind !== "metric") {
        for (const ref of exprRefs(f.expr)) {
          const r = resolveRef(spec, ws, { name: ref.table, quoted: ref.tableQuoted }, ref, f);
          if (!r || !r.field || !spec.metrics.includes(r.field)) continue;
          const col = r.node && r.node.columns.find((c) => c.name === r.physical);
          if (col) {
            add("error", `metric ${r.field.table}.${r.field.name}`, `The ${kind} ${f.name} reads ${ref.table}.${ref.name}, which means this metric rather than the ${col.name} column: in a semantic view, a field's name hides a column with the same name. Snowflake doesn't let a ${kind} use a metric, so creating the view fails. Rename this metric, for example to TOTAL_${col.name}.`, "name");
          } else {
            add("error", where, `${ref.table}.${ref.name} is a metric, and Snowflake doesn't let a ${kind} use a metric. Use the columns or facts the metric aggregates instead.`, "expr");
          }
        }
      }
      if (kind === "metric" && f.table && !AGGREGATE.test(f.expr) && !/\bOVER\s*\(/i.test(f.expr)) {
        add("warning", where, "A metric on a table needs an aggregate such as SUM or COUNT. Remove the table to make it a derived metric.", "expr");
      }
      if (kind === "metric" && !f.table && !exprRefs(f.expr).length) add("warning", where, "A derived metric should combine other metrics, written as table.metric.", "expr");
    }
  }

  // Lower-case field names keep Cortex Analyst away from the whole view; one warning per table.
  const lowerNames = new Map(); // table → [{ kind, name }]
  for (const [key, kind] of KINDS) for (const f of spec[key]) {
    if (!f.table || !IDENT.test(f.name) || CORTEX_NAME.test(f.name)) continue;
    if (!lowerNames.has(f.table)) lowerNames.set(f.table, []);
    lowerNames.get(f.table).push({ kind, name: f.name });
  }
  for (const [table, items] of lowerNames) {
    const first = items[0], names = items.map((x) => x.name);
    const why = "because the Semantic View package keeps names exactly as typed";
    add("warning", `${first.kind} ${table}.${first.name}`, items.length === 1
      ? `Cortex Analyst can't use this view while the ${first.kind} name ${first.name} has lowercase letters, ${why}. Rename it to ${up(first.name)}.`
      : `Cortex Analyst can't use this view while ${items.length} field names on ${table} have lowercase letters (${names.slice(0, 6).join(", ")}${names.length > 6 ? ", …" : ""}), ${why}. Rename them in uppercase, starting with ${first.name}.`, "name");
    issues[issues.length - 1].cortex = true;
  }

  // Every table should be reachable through relationships.
  if (spec.tables.length > 1) {
    const adj = new Map(spec.tables.map((t) => [up(t.alias), new Set()]));
    for (const r of spec.relationships) if (adj.has(up(r.from)) && adj.has(up(r.to))) { adj.get(up(r.from)).add(up(r.to)); adj.get(up(r.to)).add(up(r.from)); }
    const start = up(spec.tables[0].alias), reach = new Set([start]), queue = [start];
    while (queue.length) for (const n of adj.get(queue.pop()) || []) if (!reach.has(n)) { reach.add(n); queue.push(n); }
    for (const t of spec.tables) if (!reach.has(up(t.alias))) add("warning", `table ${t.alias}`, `No relationship connects ${t.alias} to ${spec.tables[0].alias}, so their fields cannot be queried together.`);
  }

  const vq = new Set();
  for (const v of spec.verifiedQueries) {
    const where = `verified query ${v.name || "(no name)"}`;
    if (!IDENT.test(v.name)) add("error", where, `The name "${v.name}" must be a plain identifier.`, "name");
    if (vq.has(up(v.name))) add("error", where, `The name "${v.name}" is used more than once.`, "name");
    vq.add(up(v.name));
    if (!v.question) add("error", where, "The question is empty.", "question");
    if (!v.sql) add("error", where, "The SQL is empty.", "sql");
  }
  return issues;
}

function viewFqn(location, name, ws) {
  const loc = ws.locations[location];
  const qid = (x) => `"${str(x).replace(/"/g, '""')}"`;
  return loc ? [loc.database, loc.schema, name].map(qid).join(".") : qid(name);
}

// ── DESCRIBE SEMANTIC VIEW → spec ───────────────────────────────────────────
// UNIQUE_KEY is a JSON list of keys, each a list of column names: [["A"],["B","C"]].
function uniqueKeys(v) {
  if (!v) return [];
  let a;
  try { a = JSON.parse(v); } catch { return []; }
  if (!Array.isArray(a)) return [];
  if (a.every((x) => typeof x === "string")) a = [a]; // tolerate a single flat key
  return a.filter(Array.isArray).map((k) => k.filter((c) => typeof c === "string")).filter((k) => k.length);
}
// rows: [{ object_kind, object_name, parent_entity, property, property_value }]
function fromDescribe(rows, ws) {
  const jsonList = (v) => { try { const a = JSON.parse(v); return Array.isArray(a) ? a.map((x) => (typeof x === "string" ? x : null)) : [str(v)]; } catch { return v ? [str(v)] : []; } };
  const objects = new Map(); // kind|parent|name → { kind, name, parent, props }
  let description = "";
  const instructions = {};
  const notes = [];
  for (const r of rows) {
    const kind = r.object_kind;
    if (!kind) { if (r.property === "COMMENT") description = str(r.property_value); continue; }
    if (/^CUSTOM_INSTRUCTION/.test(kind)) { instructions[r.property] = str(r.property_value); continue; }
    if (kind === "EXTENSION") { if (!notes.some((n) => n.startsWith("Extension"))) notes.push(`Extension data (${r.object_name || "unnamed"}, such as Cortex Analyst sample values) is not kept in the node.`); continue; }
    const key = `${kind}|${r.parent_entity || ""}|${r.object_name}`;
    if (!objects.has(key)) objects.set(key, { kind, name: r.object_name, parent: r.parent_entity || "", props: {} });
    objects.get(key).props[r.property] = r.property_value;
  }
  const spec = { tables: [], relationships: [], facts: [], dimensions: [], metrics: [], verifiedQueries: [] };
  const locByDbSchema = new Map(Object.entries(ws.locations).map(([loc, l]) => [`${up(l.database)}.${up(l.schema)}`, loc]));
  const unmatched = [];
  for (const o of objects.values()) {
    const p = o.props;
    if (o.kind === "TABLE") {
      const db = p.BASE_TABLE_DATABASE_NAME, schema = p.BASE_TABLE_SCHEMA_NAME, base = p.BASE_TABLE_NAME;
      let match = null, how = "";
      const exactLoc = locByDbSchema.get(`${up(db)}.${up(schema)}`);
      if (exactLoc && ws.nodes.has(`${up(exactLoc)}.${up(base)}`)) { match = ws.nodes.get(`${up(exactLoc)}.${up(base)}`); how = "exact"; }
      if (!match) { // same schema name in another database (another environment or workspace)
        const cands = [...ws.nodes.values()].filter((n) => up(n.name) === up(base));
        match = cands.find((n) => ws.locations[n.location] && up(ws.locations[n.location].schema) === up(schema)) || (cands.length === 1 ? cands[0] : null);
        how = match ? "name" : "";
      }
      if (p.DEFINITION) notes.push(`Table ${o.name} is defined by an inline query, which is not supported here.`);
      if (!match) unmatched.push({ alias: o.name, database: db, schema, table: base });
      else if (how === "name") notes.push(`${db}.${schema}.${base} was matched to the node ${match.location}.${match.name} by name.`);
      spec.tables.push({
        alias: o.name, location: match ? match.location : "", node: match ? match.name : str(base),
        primaryKey: p.PRIMARY_KEY ? jsonList(p.PRIMARY_KEY).filter(Boolean) : [],
        unique: uniqueKeys(p.UNIQUE_KEY),
        synonyms: p.SYNONYMS ? jsonList(p.SYNONYMS).filter(Boolean) : [], comment: str(p.COMMENT),
        source: { database: db, schema, table: base },
      });
    } else if (o.kind === "RELATIONSHIP") {
      // REF_KEY items are column names, or { type: "ASOF", column } for the as-of column.
      let raw = [];
      try { raw = JSON.parse(p.REF_KEY); } catch { raw = [str(p.REF_KEY)]; }
      if (!Array.isArray(raw)) raw = [raw];
      const from = jsonList(p.FOREIGN_KEY).filter(Boolean);
      const pairs = raw.map((k, i) => ({ f: from[i], t: typeof k === "string" ? k : k && k.column, asof: !!(k && typeof k === "object" && up(k.type) === "ASOF"), other: k && typeof k === "object" && up(k.type) !== "ASOF" }));
      if (pairs.some((x) => x.other || !x.t)) notes.push(`Relationship ${o.name} is a range join, which is not supported here. Its join columns need review.`);
      const ordered = [...pairs.filter((x) => !x.asof), ...pairs.filter((x) => x.asof)];
      spec.relationships.push({ name: o.name, from: str(p.TABLE || o.parent), fromColumns: ordered.map((x) => x.f).filter(Boolean), to: str(p.REF_TABLE), toColumns: ordered.map((x) => x.t).filter(Boolean), asof: pairs.some((x) => x.asof) });
    } else if (["FACT", "DIMENSION", "METRIC", "DERIVED_METRIC"].includes(o.kind)) {
      const table = o.kind === "DERIVED_METRIC" ? "" : str(p.TABLE || o.parent);
      const f = { table, name: o.name, expr: qualifyBare(p.EXPRESSION, table), synonyms: p.SYNONYMS ? jsonList(p.SYNONYMS).filter(Boolean) : [], comment: str(p.COMMENT), dataType: str(p.DATA_TYPE) };
      if (p.ACCESS_MODIFIER === "PRIVATE") f.private = true;
      if (p.CORTEX_SEARCH_SERVICE_NAME) notes.push(`Dimension ${o.name} uses a Cortex Search service, which is not kept in the node.`);
      spec[o.kind === "FACT" ? "facts" : o.kind === "DIMENSION" ? "dimensions" : "metrics"].push(f);
    } else if (o.kind === "AI_VERIFIED_QUERY") {
      spec.verifiedQueries.push({ name: o.name, question: str(p.QUESTION), sql: str(p.SQL), onboarding: /^true$/i.test(str(p.ONBOARDING_QUESTION)), verifiedAt: str(p.VERIFIED_AT), verifiedBy: str(p.VERIFIED_BY) });
    } else if (!notes.some((n) => n.includes(o.kind))) {
      notes.push(`${o.kind} objects are not supported here and were skipped.`);
    }
  }
  spec.aiSqlGeneration = instructions.AI_SQL_GENERATION || "";
  spec.aiQuestionCategorization = instructions.AI_QUESTION_CATEGORIZATION || "";
  // Data types by "TABLE.NAME" for node columns.
  const dataTypes = {};
  for (const [key] of KINDS) for (const f of spec[key]) if (f.dataType) dataTypes[`${up(f.table)}.${up(f.name)}`] = f.dataType;
  const sources = Object.fromEntries(spec.tables.map((t) => [up(t.alias), t.source]));
  return { description, spec: normalize(spec), sources, dataTypes, unmatched, notes };
}

// ── Drift ───────────────────────────────────────────────────────────────────
// Snowflake stores names upper-cased and expressions as written; compare loosely.
const normExpr = (e) => str(e).replace(/\s+/g, "").replace(/"/g, "").toUpperCase();
const normCols = (a) => a.map(up).join(",");
const normSyn = (a) => [...a].sort().join("|");

function diffSpecs(repo, deployed, ws) {
  const a = normalize(repo.spec), b = normalize(deployed.spec);
  const out = [];
  const push = (kind, name, change, field, r, d) => out.push({ kind, name, change, field: field || "", repo: r === undefined ? "" : str(r), deployed: d === undefined ? "" : str(d) });
  const cmp = (kind, name, field, r, d, norm = (x) => str(x)) => { if (norm(r) !== norm(d)) push(kind, name, "differs", field, Array.isArray(r) ? r.join(", ") : r, Array.isArray(d) ? d.join(", ") : d); };
  const pair = (kind, xs, ys, keyOf, each) => {
    const ym = new Map(ys.map((y) => [keyOf(y), y]));
    for (const x of xs) { const y = ym.get(keyOf(x)); if (!y) push(kind, keyOf(x, true), "not deployed"); else { each(x, y, keyOf(x, true)); ym.delete(keyOf(x)); } }
    for (const y of ym.values()) push(kind, keyOf(y, true), "only in Snowflake");
  };
  cmp("view", "", "comment", str(repo.description).trim(), str(deployed.description).trim());
  pair("table", a.tables, b.tables, (t, show) => (show ? t.alias : up(t.alias)), (x, y, n) => {
    const src = (deployed.sources || {})[up(y.alias)];
    const loc = ws.locations[x.location];
    if (src && loc) cmp("table", n, "base table", `${loc.database}.${loc.schema}.${x.node}`, `${src.database}.${src.schema}.${src.table}`, up);
    cmp("table", n, "primary key", x.primaryKey, y.primaryKey, normCols);
    cmp("table", n, "unique keys", x.unique.map((u) => u.join("+")), y.unique.map((u) => u.join("+")), (u) => u.map(up).sort().join("|"));
    cmp("table", n, "synonyms", x.synonyms, y.synonyms, normSyn);
    cmp("table", n, "comment", x.comment, y.comment);
  });
  // Snowflake names unnamed relationships itself, so match on what they join.
  const relKey = (r, show) => (show ? r.name || `${r.from} → ${r.to}` : `${up(r.from)}(${normCols(r.fromColumns)})>${up(r.to)}(${normCols(r.toColumns)})${r.asof ? "ASOF" : ""}`);
  pair("relationship", a.relationships, b.relationships, relKey, (x, y, n) => { if (x.name) cmp("relationship", n, "name", x.name, y.name, up); });
  for (const [key, kind] of KINDS) {
    pair(kind, a[key], b[key], (f, show) => (show ? `${f.table ? f.table + "." : ""}${f.name}` : `${up(f.table)}.${up(f.name)}`), (x, y, n) => {
      cmp(kind, n, "expression", x.expr, y.expr, normExpr);
      cmp(kind, n, "synonyms", x.synonyms, y.synonyms, normSyn);
      cmp(kind, n, "comment", x.comment, y.comment);
      cmp(kind, n, "visibility", x.private ? "private" : "public", y.private ? "private" : "public");
    });
  }
  cmp("instructions", "", "SQL generation", a.aiSqlGeneration, b.aiSqlGeneration);
  cmp("instructions", "", "question categorization", a.aiQuestionCategorization, b.aiQuestionCategorization);
  pair("verified query", a.verifiedQueries, b.verifiedQueries, (v, show) => (show ? v.name : up(v.name)), (x, y, n) => {
    cmp("verified query", n, "question", x.question, y.question);
    cmp("verified query", n, "SQL", x.sql, y.sql, (s) => str(s).replace(/\s+/g, " ").trim());
    cmp("verified query", n, "onboarding", x.onboarding, y.onboarding);
    cmp("verified query", n, "verified by", x.verifiedBy, y.verifiedBy);
    cmp("verified query", n, "verified at", x.verifiedAt, y.verifiedAt);
  });
  return out;
}

// ── Upper-case names ────────────────────────────────────────────────────────
// Rename table aliases and field names to upper case, the only case Cortex Analyst accepts,
// keeping what every expression reads. A field keeps its name when the upper-case name would
// hide a column that other expressions read: a metric named like a column of its table, or
// a fact or dimension named like a column it isn't simply a copy of. Verified queries' SQL
// is updated where it names a renamed table or field in quotes.
// Returns { spec, renamed, kept: ["table.name", …] }.
function upperNames(specIn, ws) {
  const old = normalize(specIn);
  const spec = normalize(specIn);
  const aliasNew = new Map(); // old alias → new alias
  for (const t of old.tables) {
    const next = up(t.alias);
    if (IDENT.test(t.alias) && !CORTEX_NAME.test(t.alias) && !old.tables.some((o) => o !== t && o.alias === next)) aliasNew.set(t.alias, next);
  }
  const fieldNew = new Map(); // old field object → new name
  const kept = [];
  for (const [key, kind] of KINDS) {
    for (const f of old[key]) {
      if (!f.table || !IDENT.test(f.name) || CORTEX_NAME.test(f.name)) continue;
      const next = up(f.name);
      const t = old.tables.find((x) => x.alias === f.table);
      const node = t && ws && ws.nodes.get(up(`${t.location}.${t.node}`));
      const clash = KINDS.some(([k]) => old[k].some((o) => o !== f && o.table === f.table && o.name === next));
      let hides = false;
      if (node && node.columns.some((c) => c.name === next)) {
        // Only a copy of that very column may take its name.
        const refs = exprRefs(f.expr);
        const single = /^(?:"[^"]+"|[A-Za-z_][\w$]*)\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*)$/.test(f.expr.trim());
        const copy = kind !== "metric" && single && refs.length === 1 && (() => {
          const r = resolveRef(old, ws, { name: refs[0].table, quoted: refs[0].tableQuoted }, refs[0], f);
          return !!(r && r.column && r.column.name === next);
        })();
        hides = !copy;
      }
      if (clash || hides) kept.push(`${f.table}.${f.name}`);
      else fieldNew.set(f, next);
    }
  }
  // Expressions: rewrite each reference to what it read before.
  KINDS.forEach(([key]) => old[key].forEach((f, i) => {
    spec[key][i].expr = mapRefs(f.expr, (a, b) => {
      const r = resolveRef(old, ws, a, b, f);
      if (!r) return null;
      const alias = aliasNew.get(r.table.alias);
      const name = r.field && fieldNew.get(r.field);
      if (!alias && !name) return null;
      return `${alias || a.text}.${name || b.text}`;
    });
    if (aliasNew.has(f.table)) spec[key][i].table = aliasNew.get(f.table);
    if (fieldNew.has(f)) spec[key][i].name = fieldNew.get(f);
  }));
  spec.tables.forEach((t) => { if (aliasNew.has(t.alias)) t.alias = aliasNew.get(t.alias); });
  for (const r of spec.relationships) {
    if (aliasNew.has(r.from)) r.from = aliasNew.get(r.from);
    if (aliasNew.has(r.to)) r.to = aliasNew.get(r.to);
  }
  spec.layout = Object.fromEntries(Object.entries(spec.layout).map(([k, v]) => [aliasNew.get(k) || k, v]));
  // Verified queries name fields as "alias"."name", and logical tables as "__alias".
  const swaps = [];
  for (const [key] of KINDS) for (const f of old[key]) {
    const a = aliasNew.get(f.table) || f.table, n = fieldNew.get(f) || f.name;
    if (a !== f.table || n !== f.name) swaps.push([`"${f.table}"."${f.name}"`, `"${a}"."${n}"`]);
  }
  for (const [from, to] of aliasNew) swaps.push([`"${from}".`, `"${to}".`], [`"__${from}"`, `"__${to}"`]);
  for (const v of spec.verifiedQueries) for (const [from, to] of swaps) v.sql = v.sql.split(from).join(to);
  return { spec, renamed: aliasNew.size + fieldNew.size, kept };
}

// ── Suggestions from node metadata ──────────────────────────────────────────
const NUMERIC = /^(NUMBER|DECIMAL|NUMERIC|INT|INTEGER|BIGINT|SMALLINT|TINYINT|BYTEINT|FLOAT|FLOAT4|FLOAT8|DOUBLE|REAL)\b/i;
const SYSTEM_COL = /^(SYSTEM_|_FIVETRAN|_META|FLOW_|DBT_)/i;
const KEYISH = /(_ID|_KEY|_SK|_NUMBER|_CODE|^ID|^YEAR|^MONTH|^DAY|_YEAR|_MONTH|_FLAG)$/i;
const colRef = (alias, name) => (IDENT.test(name) && name === name.toUpperCase() ? `${alias}.${name}` : `${alias}."${name}"`);
// Suggested names are upper case, the only case Cortex Analyst accepts (see CORTEX_NAME).
const fieldName = (name) => { const n = name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase(); return /^[A-Z_]/.test(n) ? n : `C_${n}`; };

function aliasFor(nodeName, taken) {
  let base = nodeName.toUpperCase().replace(/^(DIM|FCT|FACT|V|STG|PSTG)_/, "").replace(/[^A-Z0-9_]+/g, "_") || "T";
  if (!/^[A-Z_]/.test(base)) base = `T_${base}`;
  let a = base, i = 2;
  while (taken.has(up(a))) a = `${base}_${i++}`;
  return a;
}

function suggestTable(node, taken) {
  return { alias: aliasFor(node.name, taken), location: node.location, node: node.name, primaryKey: node.columns.filter((c) => c.isBusinessKey).map((c) => c.name), unique: [], synonyms: [], comment: node.description || "" };
}

// Starter fields: text, date and key columns become dimensions; other numerics become facts
// plus a SUM metric.
function suggestFields(table, node) {
  const out = { facts: [], dimensions: [], metrics: [] };
  for (const c of node.columns) {
    if (SYSTEM_COL.test(c.name) || c.isSurrogateKey) continue;
    const base = { table: table.alias, name: fieldName(c.name), expr: colRef(table.alias, c.name), synonyms: [], comment: c.description || "" };
    if (NUMERIC.test(c.dataType || "") && !KEYISH.test(c.name) && !c.isBusinessKey) {
      out.facts.push(base);
      out.metrics.push({ table: table.alias, name: `TOTAL_${base.name}`, expr: `SUM(${base.expr})`, synonyms: [], comment: c.description ? `Sum of: ${c.description}` : "" });
    } else out.dimensions.push(base);
  }
  return out;
}

// A table whose columns include another table's whole primary key (by name) probably
// references it.
function suggestRelationships(specIn, ws) {
  const spec = normalize(specIn);
  const have = new Set(spec.relationships.map((r) => `${up(r.from)}>${up(r.to)}`));
  const out = [];
  for (const to of spec.tables) {
    if (!to.primaryKey.length) continue;
    for (const from of spec.tables) {
      if (from === to || have.has(`${up(from.alias)}>${up(to.alias)}`)) continue;
      const node = ws.nodes.get(`${up(from.location)}.${up(from.node)}`);
      if (!node) continue;
      const match = to.primaryKey.map((k) => node.columns.find((c) => up(c.name) === up(k)));
      if (match.some((m) => !m)) continue;
      // Two tables with the same key are peers; point the one without that key as its own primary key at the other.
      const samePk = from.primaryKey.length === to.primaryKey.length && from.primaryKey.every((k) => to.primaryKey.some((x) => up(x) === up(k)));
      if (samePk && have.has(`${up(to.alias)}>${up(from.alias)}`)) continue;
      if (samePk && out.some((r) => r.from === to.alias && r.to === from.alias)) continue;
      out.push({ name: up(`${from.alias}_to_${to.alias}`), from: from.alias, fromColumns: match.map((m) => m.name), to: to.alias, toColumns: [...to.primaryKey] });
    }
  }
  return out;
}

// SELECT over SEMANTIC_VIEW() for the test tab.
function toQuery({ fqn, metrics = [], dimensions = [], facts = [], where = "", limit = 100 }) {
  const ok = (a) => a.every((x) => /^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)?$/.test(x));
  if (!ok(metrics) || !ok(dimensions) || !ok(facts)) throw new Error("Field names must look like table.name.");
  // Names are quoted as defined: the Semantic View package creates them case-sensitive.
  const q = (a) => a.map((x) => x.split(".").map((p) => `"${p}"`).join("."));
  [metrics, dimensions, facts] = [q(metrics), q(dimensions), q(facts)];
  if (metrics.length && facts.length) throw new Error("Snowflake cannot return metrics and facts in the same query. Pick one or the other.");
  if (!metrics.length && !facts.length && !dimensions.length) throw new Error("Pick at least one metric, dimension or fact.");
  let sql = `SELECT * FROM SEMANTIC_VIEW(\n    ${fqn}`;
  if (metrics.length) sql += `\n    METRICS ${metrics.join(", ")}`;
  if (facts.length) sql += `\n    FACTS ${facts.join(", ")}`;
  if (dimensions.length) sql += `\n    DIMENSIONS ${dimensions.join(", ")}`;
  if (str(where).trim()) sql += `\n    WHERE ${str(where).trim()}`;
  return `${sql}\n)\nLIMIT ${Math.max(1, Math.min(1000, parseInt(limit, 10) || 100))}`;
}

module.exports = {
  IDENT, CORTEX_NAME, normalize, validate, resolveRef, mapRefs, upperNames, fromDescribe, diffSpecs,
  suggestTable, suggestFields, suggestRelationships, toQuery, viewFqn, exprRefs, joinClause, cardinality, qualifyBare,
};
