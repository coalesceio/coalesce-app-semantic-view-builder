// Snowflake access over the SQL REST API with key-pair (JWT) auth, using the same
// credentials coa uses for this workspace: the profile named in workspace.yml, read from
// ~/.coa/config. Node built-ins only (the Coalesce app runtime cannot load native drivers).
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const YAML = require("yaml");

function readProfile(workspaceDir) {
  let name = process.env.COA_PROFILE;
  if (!name) {
    try { name = (YAML.parse(fs.readFileSync(path.join(workspaceDir, "workspace.yml"), "utf8")) || {}).profile; } catch { /* no workspace.yml */ }
  }
  name = name || "default";
  const file = path.join(os.homedir(), ".coa", "config");
  if (!fs.existsSync(file)) throw new Error(`No coa credentials file at ${file}. Create a profile with "coa profile create".`);
  let section = null;
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const s = line.match(/^\s*\[(.+?)\]\s*$/);
    if (s) { section = s[1]; continue; }
    const kv = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (kv && section === name) out[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!Object.keys(out).length) throw new Error(`coa profile "${name}" was not found in ${file}.`);
  return { name, ...out };
}

function makeSnowflake(workspaceDir) {
  let cached = null; // { profile, key, fingerprint, token, exp }
  function load() {
    if (cached) return cached;
    const profile = readProfile(workspaceDir);
    if (!/keypair/i.test(profile.snowflakeAuthType || "")) {
      throw new Error(`The coa profile "${profile.name}" signs in with ${profile.snowflakeAuthType || "an unknown method"}. Test, Drift, Import and Check in Snowflake need a key-pair profile; creating views works with any profile.`);
    }
    let pem = profile.snowflakeKeyPairKey || "";
    if (!pem.includes("BEGIN")) pem = fs.readFileSync(pem.replace(/^~/, os.homedir()), "utf8");
    const key = crypto.createPrivateKey({ key: pem, passphrase: profile.snowflakeKeyPairPass || undefined });
    const der = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
    const fingerprint = "SHA256:" + crypto.createHash("sha256").update(der).digest("base64");
    cached = { profile, key, fingerprint, token: null, exp: 0 };
    return cached;
  }
  function jwt() {
    const c = load();
    const now = Math.floor(Date.now() / 1000);
    if (c.token && c.exp - now > 120) return c.token;
    const account = c.profile.snowflakeAccount.toUpperCase().split(".")[0];
    const user = c.profile.snowflakeUsername.toUpperCase();
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: `${account}.${user}.${c.fingerprint}`, sub: `${account}.${user}`, iat: now, exp: now + 3300 })}`;
    c.token = `${body}.${crypto.sign("RSA-SHA256", Buffer.from(body), c.key).toString("base64url")}`;
    c.exp = now + 3300;
    return c.token;
  }
  function info() {
    const p = load().profile;
    return { profile: p.name, account: p.snowflakeAccount, user: p.snowflakeUsername, role: p.snowflakeRole, warehouse: p.snowflakeWarehouse };
  }
  // The profile, plus queryError when the app's own queries can't use it (coa still can).
  // Throws only when there is no profile at all.
  function describe() {
    const p = readProfile(workspaceDir);
    const out = { profile: p.name, account: p.snowflakeAccount, user: p.snowflakeUsername, role: p.snowflakeRole, warehouse: p.snowflakeWarehouse };
    try { load(); } catch (e) { out.queryError = e.message; }
    return out;
  }
  // Run one statement; resolves to { columns, rows } with rows as arrays of strings/null.
  async function query(sql, { database, schema, timeout = 120 } = {}) {
    const p = load().profile;
    const host = `https://${p.snowflakeAccount.toLowerCase()}.snowflakecomputing.com`;
    const headers = {
      Authorization: `Bearer ${jwt()}`,
      "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
      "Content-Type": "application/json", Accept: "application/json", "User-Agent": "semantic-view-builder/1.0",
    };
    const payload = { statement: sql, timeout, role: p.snowflakeRole, warehouse: p.snowflakeWarehouse };
    if (database) payload.database = database;
    if (schema) payload.schema = schema;
    let res = await fetch(`${host}/api/v2/statements`, { method: "POST", headers, body: JSON.stringify(payload) });
    let body = await res.json().catch(() => ({}));
    while (res.status === 202 && body.statementHandle) { // still running: poll
      await new Promise((r) => setTimeout(r, 700));
      res = await fetch(`${host}/api/v2/statements/${body.statementHandle}`, { headers });
      body = await res.json().catch(() => ({}));
    }
    if (!res.ok) {
      const e = new Error(body.message || `Snowflake returned HTTP ${res.status}`);
      e.snowflake = true; e.code = body.code; e.sqlState = body.sqlState;
      throw e;
    }
    const columns = ((body.resultSetMetaData || {}).rowType || []).map((c) => ({ name: c.name, type: c.type }));
    const rows = body.data || [];
    const parts = ((body.resultSetMetaData || {}).partitionInfo || []).length;
    for (let i = 1; i < parts; i++) {
      const r = await fetch(`${host}/api/v2/statements/${body.statementHandle}?partition=${i}`, { headers });
      rows.push(...((await r.json()).data || []));
    }
    return { columns, rows };
  }
  // Rows as objects keyed by lower-cased column name.
  async function objects(sql, opts) {
    const { columns, rows } = await query(sql, opts);
    return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name.toLowerCase(), r[i]])));
  }
  return { query, objects, info, describe };
}

module.exports = { makeSnowflake };
