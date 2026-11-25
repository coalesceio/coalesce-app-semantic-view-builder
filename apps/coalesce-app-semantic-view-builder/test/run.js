// Self-test. Pure checks always run. The parity check (the app's DDL preview equals what the
// Semantic View package's template renders, via `coa create --dry-run`) runs when the
// workspace has the package's node type.
//   npm test
//
// The tests read the sample project at the root of this app's repository: TPC-H source nodes
// (Snowflake's SNOWFLAKE_SAMPLE_DATA.TPCH_SF1) in location TPCH, and an empty default location
// SAMPLE. A fresh clone needs nothing else; to run the parity check too, copy
// workspace.example.yml to workspace.yml and run `coa install` at the repository root.
// SVB_TEST_WORKSPACE points the tests at another copy of that project.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");
const YAML = require("yaml");
const S = require("../src/spec");
const P = require("../src/pkg");
const { loadWorkspace, sqlNodeColumns } = require("../src/workspace");
const { coaCommand } = require("../src/coa");

const dir = path.resolve(process.env.SVB_TEST_WORKSPACE || path.join(__dirname, "..", "..", ".."));
const ws = loadWorkspace(dir);
if (!ws.nodes.has("TPCH.LINEITEM")) {
  console.error(`${dir} isn't the app repository's sample project (it has no TPCH.LINEITEM node). Run the tests from a clone of coalesceio/coalesce-app-semantic-view-builder, or set SVB_TEST_WORKSPACE to a copy of its sample project.`);
  process.exit(1);
}
// Without a personal workspace.yml (a fresh clone), use the example's location mappings.
if (!Object.keys(ws.locations).length) {
  const example = YAML.parse(fs.readFileSync(path.join(dir, "workspace.example.yml"), "utf8"));
  for (const [l, v] of Object.entries(example.locations)) ws.locations[l] = { database: v.database, schema: v.schema };
}
const view = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── Spec checks (Snowflake's rules) ─────────────────────────────────────────
// The fixture keeps lowercase names to test quoting, so its only issues are the Cortex Analyst
// name warnings: one per table alias, one per table's fields.
const fixtureIssues = S.validate(view.name, view.spec, ws);
assert(fixtureIssues.every((i) => i.level === "warning" && /Cortex Analyst/.test(i.message)), JSON.stringify(fixtureIssues, null, 1));
assert.deepStrictEqual(fixtureIssues.map((i) => i.where).sort(),
  ["dimension orders.order_priority", "fact lines.list_price", "metric parts.part_count", "table lines", "table orders", "table parts"]);
assert(/7 field names on lines have lowercase letters \(list_price, net_price, ship_mode, ship_date, total_list_price, total_net_price, …\)/.test(fixtureIssues.find((i) => i.where === "fact lines.list_price").message));
assert(fixtureIssues.every((i) => i.cortex), "Cortex name warnings are flagged for the page's rename button");
// Upper-case names validate cleanly.
const upper = {
  tables: [
    { alias: "LINES", location: "TPCH", node: "LINEITEM", primaryKey: ["L_ORDERKEY", "L_LINENUMBER"] },
    { alias: "ORDERS", location: "TPCH", node: "ORDERS", primaryKey: ["O_ORDERKEY"] },
  ],
  relationships: [{ name: "lines_orders", from: "LINES", fromColumns: ["L_ORDERKEY"], to: "ORDERS", toColumns: ["O_ORDERKEY"] }],
  facts: [{ table: "LINES", name: "NET_PRICE", expr: "LINES.L_EXTENDEDPRICE * (1 - LINES.L_DISCOUNT)" }],
  dimensions: [{ table: "LINES", name: "L_SHIPMODE", expr: "LINES.L_SHIPMODE" }, { table: "ORDERS", name: "ORDER_PRIORITY", expr: "ORDERS.O_ORDERPRIORITY" }],
  metrics: [{ table: "LINES", name: "TOTAL_LIST_PRICE", expr: "SUM(LINES.L_EXTENDEDPRICE)" }, { table: "LINES", name: "TOTAL_NET_PRICE", expr: "SUM(LINES.NET_PRICE)" }],
};
assert.deepStrictEqual(S.validate("V", upper, ws), [], "an upper-case view validates cleanly (relationship names may be any case)");
// A metric named like a column hides it from the fact that reads the column.
const shadow = clone(upper);
shadow.metrics.push({ table: "LINES", name: "L_DISCOUNT", expr: "SUM(LINES.L_DISCOUNT)" });
assert.deepStrictEqual(S.validate("V", shadow, ws).map((i) => [i.level, i.where, i.fix]), [["error", "metric LINES.L_DISCOUNT", "name"]]);
const readsMetric = clone(upper);
readsMetric.dimensions.push({ table: "LINES", name: "BIG", expr: "LINES.TOTAL_LIST_PRICE > 1000" });
assert.deepStrictEqual(S.validate("V", readsMetric, ws).map((i) => [i.level, i.where, i.fix]), [["error", "dimension LINES.BIG", "expr"]]);
// Starter names are upper case, and common prefixes come off the alias.
const linesNode = ws.nodes.get("TPCH.LINEITEM");
const starterTable = S.suggestTable(linesNode, new Set());
const starter = S.suggestFields(starterTable, linesNode);
assert.strictEqual(starterTable.alias, "LINEITEM");
assert([...starter.dimensions, ...starter.facts, ...starter.metrics].every((f) => S.CORTEX_NAME.test(f.name)), "starter field names are upper case");
assert(starter.metrics.some((m) => m.name === "TOTAL_L_EXTENDEDPRICE"));
assert.deepStrictEqual(S.validate("V", { tables: [starterTable], ...starter }, ws), [], "a starter view validates cleanly");
assert.deepStrictEqual(["FCT_MONTHLY_SALES", "DIM_CUSTOMER", "stg_orders", "2024_TARGETS"].map((n) => S.suggestTable({ name: n, location: "X", columns: [] }, new Set(["CUSTOMER"])).alias),
  ["MONTHLY_SALES", "CUSTOMER_2", "ORDERS", "T_2024_TARGETS"]);
// The default location comes from the workspace, never a fixed name.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "svb-ws-"));
  try {
    fs.writeFileSync(path.join(tmp, "workspace.yml"), "locations:\n  RAW: { database: D, schema: RAW }\n  MART: { database: D, schema: MART }\n");
    fs.writeFileSync(path.join(tmp, "locations.yml"), "defaultStorageMapping: MART\nfileVersion: 1\nlocations: [RAW, MART]\n");
    assert.strictEqual(loadWorkspace(tmp).defaultLocation, "MART", "locations.yml defaultStorageMapping");
    fs.writeFileSync(path.join(tmp, "locations.yml"), "fileVersion: 1\nlocations: [RAW, MART]\n");
    assert.strictEqual(loadWorkspace(tmp).defaultLocation, "RAW", "without a declared default, the first location");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
assert.strictEqual(ws.defaultLocation, "SAMPLE");
assert(ws.sourceOnlyLocations.has("TPCH") && !ws.sourceOnlyLocations.has("SAMPLE"), "source-only locations are found from the nodes");
// Make names uppercase: every reference keeps its target, verified queries follow.
const ren = S.upperNames({ ...clone(view.spec), layout: { lines: { x: 1, y: 2 } } }, ws);
assert.strictEqual(ren.renamed, 13);
assert.deepStrictEqual(ren.kept, []);
assert.deepStrictEqual(S.validate(view.name, ren.spec, ws), [], "renamed fixture validates cleanly");
assert.deepStrictEqual(ren.spec.tables.map((t) => t.alias), ["LINES", "ORDERS", "PARTS"]);
assert.deepStrictEqual(ren.spec.relationships.map((r) => [r.name, r.from, r.to]), [["lines_to_orders", "LINES", "ORDERS"], ["lines_to_parts", "LINES", "PARTS"]]);
assert.deepStrictEqual(ren.spec.metrics.map((m) => `${m.table}.${m.name}=${m.expr}`),
  ["LINES.TOTAL_LIST_PRICE=SUM(LINES.LIST_PRICE)", "LINES.TOTAL_NET_PRICE=SUM(LINES.NET_PRICE)", "LINES.ORDER_COUNT=COUNT(DISTINCT LINES.L_ORDERKEY)", "PARTS.PART_COUNT=COUNT(PARTS.P_PARTKEY)"]);
assert.strictEqual(ren.spec.dimensions[3].expr, "'P' || ORDERS.O_ORDERPRIORITY");
assert.strictEqual(ren.spec.verifiedQueries[0].sql, 'SELECT * FROM SEMANTIC_VIEW(SV_SAMPLE_SELFTEST METRICS "LINES"."TOTAL_NET_PRICE" DIMENSIONS "ORDERS"."ORDER_PRIORITY")');
assert.deepStrictEqual(Object.keys(ren.spec.layout), ["LINES"]);
assert.strictEqual(P.toDDL({ ...view, spec: ren.spec }, ws).replace(/"[^"]*"/g, (q) => q.toUpperCase()), P.toDDL(view, ws).replace(/"[^"]*"/g, (q) => q.toUpperCase()), "same view apart from the names' case");
// A name is kept when its upper-case form would hide a column that isn't simply its own.
const hiding = clone(upper);
hiding.metrics.push({ table: "LINES", name: "l_tax", expr: "SUM(LINES.L_TAX)" });
hiding.dimensions.push({ table: "LINES", name: "ship_label", expr: "LINES.L_SHIPMODE" }, { table: "LINES", name: "l_returnflag", expr: "UPPER(LINES.L_RETURNFLAG)" }, { table: "LINES", name: "l_linestatus", expr: "LINES.L_LINESTATUS" });
const hid = S.upperNames(hiding, ws);
assert.deepStrictEqual(hid.kept, ["LINES.l_returnflag", "LINES.l_tax"]);
assert.deepStrictEqual(hid.spec.dimensions.slice(2).map((d) => d.name), ["SHIP_LABEL", "l_returnflag", "L_LINESTATUS"]);
assert(!S.validate("V", hid.spec, ws).some((i) => i.level === "error"), "renaming never introduces an error");
const broken = clone(view.spec);
broken.tables[0].primaryKey = ["NOPE"]; broken.metrics[0].expr = "lines.list_price"; broken.dimensions[0].table = "ghost";
const levels = S.validate("9bad", broken, ws).map((i) => i.level);
assert(levels.filter((l) => l === "error").length >= 3 && levels.includes("warning"), "broken spec should raise errors and a warning");
assert.deepStrictEqual(sqlNodeColumns('@id("x")\nWITH a AS (SELECT 1 AS z FROM t)\nSELECT CAST(a.x AS NUMBER(18,0)) AS X @description("a, (b)"), "Mixed" AS "Mixed" @isBusinessKey, t.Y @id("abc123")\nFROM a').map((c) => [c.id, c.name, c.dataType, c.isBusinessKey]),
  [["X", "X", "NUMBER(18,0)", false], ["Mixed", "Mixed", "", true], ["abc123", "Y", "", false]]);
const loop = clone(view.spec);
loop.relationships.push({ name: "back", from: "parts", fromColumns: ["P_PARTKEY"], to: "lines", toColumns: ["L_PARTKEY"] });
assert(S.validate(view.name, loop, ws).some((i) => i.where === "joins" && i.level === "error"), "a join loop should be an error");
const join = S.joinClause(view.spec);
assert(!/CROSS JOIN/i.test(join) && /LEFT JOIN \{\{ ref\('TPCH', 'ORDERS'\) \}\} "orders"\s+ON "lines"\."L_ORDERKEY" = "orders"\."O_ORDERKEY"/.test(join), join);
assert.strictEqual(S.cardinality(S.normalize(view.spec), view.spec.relationships[0]), "many-to-one");
const rel = (prop, value) => ({ object_kind: "RELATIONSHIP", object_name: "R", parent_entity: "LINES", property: prop, property_value: value });
const tbl = (prop, value) => ({ object_kind: "TABLE", object_name: "LINES", parent_entity: null, property: prop, property_value: value });
const imported = S.fromDescribe([tbl("BASE_TABLE_NAME", "LINEITEM"), tbl("PRIMARY_KEY", '["L_ORDERKEY","L_LINENUMBER"]'), tbl("UNIQUE_KEY", '[["L_LINENUMBER"],["L_SHIPMODE","L_LINENUMBER"]]'),
  rel("TABLE", "LINES"), rel("REF_TABLE", "ORDERS"), rel("FOREIGN_KEY", '["L_SHIPDATE","L_ORDERKEY"]'), rel("REF_KEY", '[{"type":"ASOF","column":"O_ORDERDATE"},"O_ORDERKEY"]')], ws);
assert.deepStrictEqual(imported.spec.relationships[0], { name: "R", from: "LINES", fromColumns: ["L_ORDERKEY", "L_SHIPDATE"], to: "ORDERS", toColumns: ["O_ORDERKEY", "O_ORDERDATE"], asof: true });
assert.deepStrictEqual(imported.spec.tables[0].unique, [["L_LINENUMBER"], ["L_SHIPMODE", "L_LINENUMBER"]]);
assert.deepStrictEqual(S.diffSpecs(view, { description: view.description, spec: view.spec }, ws), []);
assert(/METRICS "lines"\."total_list_price"\n    DIMENSIONS "orders"\."order_priority"/.test(S.toQuery({ fqn: "V", metrics: ["lines.total_list_price"], dimensions: ["orders.order_priority"] })), "test queries quote names");

// ── Package node format ─────────────────────────────────────────────────────
assert.deepStrictEqual(P.packageIssues(view.spec, ws), [], "fixture fits the package");
const lossy = clone(view.spec);
lossy.relationships[0].asof = true; lossy.facts[1].private = true; lossy.tables[0].unique = [["L_SHIPMODE", "L_LINENUMBER"]];
lossy.metrics.push({ table: "", name: "ratio", expr: "DIV0(lines.total_net_price, lines.total_list_price)" }, { table: "lines", name: "m", expr: "MEDIAN(lines.L_EXTENDEDPRICE)" });
lossy.relationships.push({ name: "c2", from: "parts", fromColumns: ["P_PARTKEY", "P_NAME"], to: "lines", toColumns: ["L_ORDERKEY", "L_LINENUMBER"] });
lossy.tables.push({ alias: "orders2", location: "TPCH", node: "ORDERS", primaryKey: ["O_ORDERKEY"] });
lossy.tables[2].synonyms = ["a", "b"];
const lossyWhere = P.packageIssues(lossy, ws).map((i) => i.where).sort();
assert.deepStrictEqual(lossyWhere, ["fact lines.net_price", "metric lines.m", "metric ratio", "relationship lines_to_orders", "relationship c2", "table lines", "table parts", "table orders2"].sort(), lossyWhere.join(", "));
assert.strictEqual(P.pkgExpr(`'P' || orders.O_ORDERPRIORITY + lines.list_price + "lines".x`, S.normalize(view.spec), ws), `'P' || "orders"."O_ORDERPRIORITY" + "lines"."list_price" + "lines"."X"`);
assert.strictEqual(P.appExpr(`"lines"."list_price" + "a b"."X"`), `lines.list_price + "a b"."X"`);
assert.deepStrictEqual(P.metricParts("COUNT(DISTINCT lines.L_ORDERKEY)"), { agg: "COUNT", inner: "DISTINCT lines.L_ORDERKEY" });
assert.strictEqual(P.metricParts("SUM(a.x) / SUM(a.y)"), null);
const decl = P.packageDeclaration("semantic-view");
assert.deepStrictEqual([decl.packageID, decl.name, decl.type, decl.releaseID], [P.PACKAGE_ID, "semantic-view", "Package", P.TESTED_RELEASE.releaseID]);
if (ws.semanticPackage && ws.semanticPackage.version && ws.semanticPackage.version !== P.TESTED_RELEASE.version) {
  console.log(`note: this workspace has package ${ws.semanticPackage.version}; the app is verified against ${P.TESTED_RELEASE.version}.`);
}
// Bare column names (how Snowflake reports simple expressions) store as Source Columns.
const bare = clone(view.spec);
bare.dimensions = [{ table: "lines", name: "L_SHIPMODE", expr: "L_SHIPMODE" }];
bare.metrics = [{ table: "lines", name: "orders_n", expr: "COUNT(DISTINCT l_orderkey)" }, { table: "lines", name: "rows_n", expr: "COUNT(l_orderkey)" }];
bare.facts = []; bare.verifiedQueries = [];
const bareCfg = P.toNode({ ...view, spec: bare }, ws, null, "x:::632").operation.config;
assert.deepStrictEqual([bareCfg.DimConfig.items[0].dimCol.name, bareCfg.DimConfig.items[0].dimTransform], ["L_SHIPMODE", ""], "a bare dimension is a Source Column");
assert.deepStrictEqual(bareCfg.metricConfig.items.map((i) => [i.metricCol && i.metricCol.name, i.metricTransformExprn]), [["L_ORDERKEY", 'DISTINCT "lines"."L_ORDERKEY"'], ["L_ORDERKEY", ""]]);
const fromSf = S.fromDescribe([{ object_kind: "METRIC", object_name: "M", parent_entity: "LINES", property: "TABLE", property_value: "LINES" }, { object_kind: "METRIC", object_name: "M", parent_entity: "LINES", property: "EXPRESSION", property_value: "COUNT(l_orderkey)" }], ws);
assert.strictEqual(fromSf.spec.metrics[0].expr, "COUNT(LINES.l_orderkey)");

const typeRef = ws.semanticType ? ws.semanticType.ref : "semantic-view:::632";
const node = P.toNode(view, ws, null, typeRef);
assert(P.isPackageNode(node) && node.operation.config.deriveCol === false && node.operation.sqlType === typeRef);
const back = P.fromNode(node, ws);
assert.deepStrictEqual(back.view.spec, S.normalize(view.spec), "spec survives a round trip through the package node");
assert.deepStrictEqual(P.toNode(view, ws, node, typeRef).operation.metadata.columns.map((c) => c.columnReference.columnCounter),
  node.operation.metadata.columns.map((c) => c.columnReference.columnCounter), "column ids are stable across saves");

// ── Parity with the package's template ──────────────────────────────────────
if (!ws.semanticType || !fs.existsSync(path.join(dir, "workspace.yml"))) {
  console.log(`ok: spec and package-format checks pass. Skipped the coa parity check: ${dir} needs a workspace.yml and the Semantic View package (copy workspace.example.yml to workspace.yml, then run "coa install").`);
  process.exit(0);
}
const run = coaCommand();
const file = path.join(dir, "nodes", `${view.location}-${view.name}.yml`);
fs.writeFileSync(file, YAML.stringify(node, { lineWidth: 0 }));
try {
  const out = execFileSync(run.cmd, [...run.pre, "create", "--dry-run", "--json", "--dir", dir, "--include", `{ name: "${view.name}", location: "${view.location}" }`], { encoding: "utf8", maxBuffer: 64e6, env: run.env });
  const result = JSON.parse(out.slice(out.lastIndexOf('{"command"'))).data.results[0];
  const stage = result.stages.find((s) => /create semantic view/i.test(s.name));
  assert(stage, `no Create Semantic View stage: ${result.stages.map((s) => s.name).join(", ")}`);
  const norm = (s) => s.replace(/\s+/g, "");
  assert.strictEqual(norm(stage.sql), norm(P.toDDL(view, ws)), "the package rendered different SQL from the app's preview");
  assert.deepStrictEqual(result.validationIssues, []);
} finally { fs.unlinkSync(file); }
console.log(`ok: spec and package-format checks pass, and the app's DDL matches the package template (${ws.semanticType.ref} from ${ws.semanticType.source})`);
