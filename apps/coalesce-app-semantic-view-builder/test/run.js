// Self-test. Pure checks always run. The parity check (the app's DDL preview equals what the
// Semantic View package's template renders, via `coa create --dry-run`) runs when the
// workspace has the package's node type; set SVB_TEST_WORKSPACE to test another workspace.
//   npm test
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");
const YAML = require("yaml");
const S = require("../src/spec");
const P = require("../src/pkg");
const { loadWorkspace, sqlNodeColumns } = require("../src/workspace");
const { coaCommand } = require("../src/coa");

const dir = path.resolve(process.env.SVB_TEST_WORKSPACE || path.join(__dirname, "..", "..", ".."));
const view = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture.json"), "utf8"));
const ws = loadWorkspace(dir);
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── Spec checks (Snowflake's rules) ─────────────────────────────────────────
// The fixture keeps lowercase names to test quoting, so its only issues are the Cortex Analyst
// name warnings: one per table alias, one per table's fields.
const fixtureIssues = S.validate(view.name, view.spec, ws);
assert(fixtureIssues.every((i) => i.level === "warning" && /Cortex Analyst/.test(i.message)), JSON.stringify(fixtureIssues, null, 1));
assert.deepStrictEqual(fixtureIssues.map((i) => i.where).sort(),
  ["dimension dates.fiscal_year", "fact arr.ending_arr", "metric contact.contact_count", "table arr", "table contact", "table dates"]);
assert(/7 field names on arr have lowercase letters \(ending_arr, net_new, account_name, month, total_ending_arr, total_net_new, …\)/.test(fixtureIssues.find((i) => i.where === "fact arr.ending_arr").message));
// Upper-case names validate cleanly.
const upper = {
  tables: [
    { alias: "ARR", location: "EDW", node: "FCT_MONTHLY_ACCOUNT_ARR", primaryKey: ["ACCOUNT_ID", "MONTH"] },
    { alias: "DATES", location: "EDW", node: "DIM_DATE", primaryKey: ["DATE_KEY"] },
  ],
  relationships: [{ name: "arr_month", from: "ARR", fromColumns: ["MONTH"], to: "DATES", toColumns: ["DATE_KEY"] }],
  facts: [{ table: "ARR", name: "NET_CHANGE", expr: "ARR.NEW_BUSINESS_ARR + ARR.CHURN_ARR" }],
  dimensions: [{ table: "ARR", name: "MONTH", expr: "ARR.MONTH" }, { table: "DATES", name: "FISCAL_YEAR", expr: "DATES.FISCAL_YEAR" }],
  metrics: [{ table: "ARR", name: "TOTAL_ARR", expr: "SUM(ARR.ENDING_ARR)" }, { table: "ARR", name: "NET_NEW", expr: "SUM(ARR.NET_CHANGE)" }],
};
assert.deepStrictEqual(S.validate("V", upper, ws), [], "an upper-case view validates cleanly (relationship names may be any case)");
// A metric named like a column hides it from the fact that reads the column.
const shadow = clone(upper);
shadow.metrics.push({ table: "ARR", name: "NEW_BUSINESS_ARR", expr: "SUM(ARR.NEW_BUSINESS_ARR)" });
assert.deepStrictEqual(S.validate("V", shadow, ws).map((i) => [i.level, i.where, i.fix]), [["error", "metric ARR.NEW_BUSINESS_ARR", "name"]]);
const readsMetric = clone(upper);
readsMetric.dimensions.push({ table: "ARR", name: "BIG", expr: "ARR.TOTAL_ARR > 1000" });
assert.deepStrictEqual(S.validate("V", readsMetric, ws).map((i) => [i.level, i.where, i.fix]), [["error", "dimension ARR.BIG", "expr"]]);
// Starter names are upper case.
const arrNode = ws.nodes.get("EDW.FCT_MONTHLY_ACCOUNT_ARR");
const starterTable = S.suggestTable(arrNode, new Set());
const starter = S.suggestFields(starterTable, arrNode);
assert.strictEqual(starterTable.alias, "MONTHLY_ACCOUNT_ARR");
assert([...starter.dimensions, ...starter.facts, ...starter.metrics].every((f) => S.CORTEX_NAME.test(f.name)), "starter field names are upper case");
assert(starter.metrics.some((m) => m.name === "TOTAL_ENDING_ARR"));
assert.deepStrictEqual(S.validate("V", { tables: [starterTable], ...starter }, ws), [], "a starter view validates cleanly");
assert(fixtureIssues.every((i) => i.cortex), "Cortex name warnings are flagged for the page's rename button");
// The default location comes from the workspace, never a fixed name.
{
  const os = require("os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "svb-ws-"));
  try {
    fs.writeFileSync(path.join(tmp, "workspace.yml"), "locations:\n  RAW: { database: D, schema: RAW }\n  MART: { database: D, schema: MART }\n");
    fs.writeFileSync(path.join(tmp, "locations.yml"), "defaultStorageMapping: MART\nfileVersion: 1\nlocations: [RAW, MART]\n");
    assert.strictEqual(loadWorkspace(tmp).defaultLocation, "MART", "locations.yml defaultStorageMapping");
    fs.writeFileSync(path.join(tmp, "locations.yml"), "fileVersion: 1\nlocations: [RAW, MART]\n");
    assert.strictEqual(loadWorkspace(tmp).defaultLocation, "RAW", "without a declared default, the first location");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
if (fs.existsSync(path.join(dir, "locations.yml")) && /defaultStorageMapping:\s*EDW/.test(fs.readFileSync(path.join(dir, "locations.yml"), "utf8"))) {
  assert.strictEqual(ws.defaultLocation, "EDW");
  assert(![...ws.sourceOnlyLocations].includes("EDW") && ws.sourceOnlyLocations.has("SRC_SALESFORCE"), "source-only locations are found from the nodes");
}
// Make names uppercase: every reference keeps its target, verified queries follow.
const ren = S.upperNames({ ...clone(view.spec), layout: { arr: { x: 1, y: 2 } } }, ws);
assert.strictEqual(ren.renamed, 13);
assert.deepStrictEqual(ren.kept, []);
assert.deepStrictEqual(S.validate(view.name, ren.spec, ws), [], "renamed fixture validates cleanly");
assert.deepStrictEqual(ren.spec.tables.map((t) => t.alias), ["ARR", "DATES", "CONTACT"]);
assert.deepStrictEqual(ren.spec.relationships.map((r) => [r.name, r.from, r.to]), [["arr_to_dates", "ARR", "DATES"], ["arr_to_contact", "ARR", "CONTACT"]]);
assert.deepStrictEqual(ren.spec.metrics.map((m) => `${m.table}.${m.name}=${m.expr}`),
  ["ARR.TOTAL_ENDING_ARR=SUM(ARR.ENDING_ARR)", "ARR.TOTAL_NET_NEW=SUM(ARR.NET_NEW)", "ARR.ACCOUNT_COUNT=COUNT(DISTINCT ARR.ACCOUNT_ID)", "CONTACT.CONTACT_COUNT=COUNT(CONTACT.ID)"]);
assert.strictEqual(ren.spec.dimensions[3].expr, "'FY' || DATES.FISCAL_YEAR");
assert.strictEqual(ren.spec.verifiedQueries[0].sql, 'SELECT * FROM SEMANTIC_VIEW(SV_BUILDER_SELFTEST METRICS "ARR"."TOTAL_ENDING_ARR" DIMENSIONS "DATES"."FISCAL_YEAR")');
assert.deepStrictEqual(Object.keys(ren.spec.layout), ["ARR"]);
assert.strictEqual(P.toDDL({ ...view, spec: ren.spec }, ws).replace(/"[^"]*"/g, (q) => q.toUpperCase()), P.toDDL(view, ws).replace(/"[^"]*"/g, (q) => q.toUpperCase()), "same view apart from the names' case");
// A name is kept when its upper-case form would hide a column that isn't simply its own.
const hiding = clone(upper);
hiding.metrics.push({ table: "ARR", name: "ending_arr", expr: "SUM(ARR.ENDING_ARR)" });
hiding.dimensions.push({ table: "ARR", name: "month_label", expr: "ARR.MONTH" }, { table: "ARR", name: "account_name", expr: "UPPER(ARR.ACCOUNT_NAME)" }, { table: "ARR", name: "account_id", expr: "ARR.ACCOUNT_ID" });
const hid = S.upperNames(hiding, ws);
assert.deepStrictEqual(hid.kept, ["ARR.account_name", "ARR.ending_arr"]);
assert.deepStrictEqual(hid.spec.dimensions.slice(2).map((d) => d.name), ["MONTH_LABEL", "account_name", "ACCOUNT_ID"]);
assert(!S.validate("V", hid.spec, ws).some((i) => i.level === "error"), "renaming never introduces an error");
const broken = clone(view.spec);
broken.tables[0].primaryKey = ["NOPE"]; broken.metrics[0].expr = "arr.ending_arr"; broken.dimensions[0].table = "ghost";
const levels = S.validate("9bad", broken, ws).map((i) => i.level);
assert(levels.filter((l) => l === "error").length >= 3 && levels.includes("warning"), "broken spec should raise errors and a warning");
assert.deepStrictEqual(sqlNodeColumns('@id("x")\nWITH a AS (SELECT 1 AS z FROM t)\nSELECT CAST(a.x AS NUMBER(18,0)) AS X @description("a, (b)"), "Mixed" AS "Mixed" @isBusinessKey, t.Y @id("abc123")\nFROM a').map((c) => [c.id, c.name, c.dataType, c.isBusinessKey]),
  [["X", "X", "NUMBER(18,0)", false], ["Mixed", "Mixed", "", true], ["abc123", "Y", "", false]]);
const loop = clone(view.spec);
loop.relationships.push({ name: "back", from: "contact", fromColumns: ["ID"], to: "arr", toColumns: ["ACCOUNT_ID"] });
assert(S.validate(view.name, loop, ws).some((i) => i.where === "joins" && i.level === "error"), "a join loop should be an error");
const join = S.joinClause(view.spec);
assert(!/CROSS JOIN/i.test(join) && /LEFT JOIN \{\{ ref\('EDW', 'DIM_DATE'\) \}\} "dates"\s+ON "arr"\."MONTH" = "dates"\."DATE_KEY"/.test(join), join);
assert.strictEqual(S.cardinality(S.normalize(view.spec), view.spec.relationships[0]), "many-to-one");
const rel = (prop, value) => ({ object_kind: "RELATIONSHIP", object_name: "R", parent_entity: "ARR", property: prop, property_value: value });
const tbl = (prop, value) => ({ object_kind: "TABLE", object_name: "ARR", parent_entity: null, property: prop, property_value: value });
const imported = S.fromDescribe([tbl("BASE_TABLE_NAME", "FCT_MONTHLY_ACCOUNT_ARR"), tbl("PRIMARY_KEY", '["ACCOUNT_ID","MONTH"]'), tbl("UNIQUE_KEY", '[["MONTH"],["ACCOUNT_NAME","MONTH"]]'),
  rel("TABLE", "ARR"), rel("REF_TABLE", "DATES"), rel("FOREIGN_KEY", '["MONTH","ACCOUNT_ID"]'), rel("REF_KEY", '[{"type":"ASOF","column":"DATE_KEY"},"ACCOUNT_ID"]')], ws);
assert.deepStrictEqual(imported.spec.relationships[0], { name: "R", from: "ARR", fromColumns: ["ACCOUNT_ID", "MONTH"], to: "DATES", toColumns: ["ACCOUNT_ID", "DATE_KEY"], asof: true });
assert.deepStrictEqual(imported.spec.tables[0].unique, [["MONTH"], ["ACCOUNT_NAME", "MONTH"]]);
assert.deepStrictEqual(S.diffSpecs(view, { description: view.description, spec: view.spec }, ws), []);
assert(/METRICS "arr"\."total_ending_arr"\n    DIMENSIONS "dates"\."fiscal_year"/.test(S.toQuery({ fqn: "V", metrics: ["arr.total_ending_arr"], dimensions: ["dates.fiscal_year"] })), "test queries quote names");

// ── Package node format ─────────────────────────────────────────────────────
assert.deepStrictEqual(P.packageIssues(view.spec, ws), [], "fixture fits the package");
const lossy = clone(view.spec);
lossy.relationships[0].asof = true; lossy.facts[1].private = true; lossy.tables[0].unique = [["ACCOUNT_NAME", "MONTH"]];
lossy.metrics.push({ table: "", name: "ratio", expr: "DIV0(arr.total_net_new, arr.total_ending_arr)" }, { table: "arr", name: "m", expr: "MEDIAN(arr.ENDING_ARR)" });
lossy.relationships.push({ name: "c2", from: "contact", fromColumns: ["ACCOUNT_ID", "LAST_NAME"], to: "arr", toColumns: ["ACCOUNT_ID", "MONTH"] });
lossy.tables.push({ alias: "dates2", location: "EDW", node: "DIM_DATE", primaryKey: ["DATE_KEY"] });
lossy.tables[2].synonyms = ["a", "b"];
const lossyWhere = P.packageIssues(lossy, ws).map((i) => i.where).sort();
assert.deepStrictEqual(lossyWhere, ["fact arr.net_new", "metric arr.m", "metric ratio", "relationship arr_to_dates", "relationship c2", "table arr", "table contact", "table dates2"].sort(), lossyWhere.join(", "));
assert.strictEqual(P.pkgExpr(`'FY' || dates.FISCAL_YEAR + arr.ending_arr + "arr".x`, S.normalize(view.spec), ws), `'FY' || "dates"."FISCAL_YEAR" + "arr"."ending_arr" + "arr"."X"`);
assert.strictEqual(P.appExpr(`"arr"."ending_arr" + "a b"."X"`), `arr.ending_arr + "a b"."X"`);
assert.deepStrictEqual(P.metricParts("COUNT(DISTINCT arr.ID)"), { agg: "COUNT", inner: "DISTINCT arr.ID" });
assert.strictEqual(P.metricParts("SUM(a.x) / SUM(a.y)"), null);
const decl = P.packageDeclaration("semantic-view");
assert.deepStrictEqual([decl.packageID, decl.name, decl.type, decl.releaseID], [P.PACKAGE_ID, "semantic-view", "Package", P.TESTED_RELEASE.releaseID]);
if (ws.semanticPackage && ws.semanticPackage.version && ws.semanticPackage.version !== P.TESTED_RELEASE.version) {
  console.log(`note: this workspace has package ${ws.semanticPackage.version}; the app is verified against ${P.TESTED_RELEASE.version}.`);
}
// Bare column names (how Snowflake reports simple expressions) store as Source Columns.
const bare = clone(view.spec);
bare.dimensions = [{ table: "arr", name: "ACCOUNT_NAME", expr: "ACCOUNT_NAME" }];
bare.metrics = [{ table: "arr", name: "accounts", expr: "COUNT(DISTINCT account_id)" }, { table: "arr", name: "rows_n", expr: "COUNT(account_id)" }];
bare.facts = []; bare.verifiedQueries = [];
const bareCfg = P.toNode({ ...view, spec: bare }, ws, null, "x:::632").operation.config;
assert.deepStrictEqual([bareCfg.DimConfig.items[0].dimCol.name, bareCfg.DimConfig.items[0].dimTransform], ["ACCOUNT_NAME", ""], "a bare dimension is a Source Column");
assert.deepStrictEqual(bareCfg.metricConfig.items.map((i) => [i.metricCol && i.metricCol.name, i.metricTransformExprn]), [["ACCOUNT_ID", 'DISTINCT "arr"."ACCOUNT_ID"'], ["ACCOUNT_ID", ""]]);
const fromSf = S.fromDescribe([{ object_kind: "METRIC", object_name: "M", parent_entity: "ARR", property: "TABLE", property_value: "ARR" }, { object_kind: "METRIC", object_name: "M", parent_entity: "ARR", property: "EXPRESSION", property_value: "COUNT(org_id)" }], ws);
assert.strictEqual(fromSf.spec.metrics[0].expr, "COUNT(ARR.org_id)");

const typeRef = ws.semanticType ? ws.semanticType.ref : "semantic-view:::632";
const node = P.toNode(view, ws, null, typeRef);
assert(P.isPackageNode(node) && node.operation.config.deriveCol === false && node.operation.sqlType === typeRef);
const back = P.fromNode(node, ws);
assert.deepStrictEqual(back.view.spec, S.normalize(view.spec), "spec survives a round trip through the package node");
assert.deepStrictEqual(P.toNode(view, ws, node, typeRef).operation.metadata.columns.map((c) => c.columnReference.columnCounter),
  node.operation.metadata.columns.map((c) => c.columnReference.columnCounter), "column ids are stable across saves");

// ── Parity with the package's template ──────────────────────────────────────
if (!ws.semanticType) {
  console.log(`ok: spec and package-format checks pass. Skipped the coa parity check: ${dir} has no Semantic View node type (install ${P.PACKAGE_ID}).`);
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
