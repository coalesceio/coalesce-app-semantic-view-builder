// How to run coa. In order:
//  1. the invocation Coalesce Desktop publishes in ~/.coalesce/desktop/agent.json while it runs;
//  2. the coa bundled in the Coalesce app itself, run with its Electron binary as Node (what
//     Desktop's ~/.coalesce/desktop/coa shim does). Inside Coalesce, process.execPath is that
//     binary, so this works even when agent.json is absent;
//  3. coa on PATH, which may be an older release (older ones lack create --dry-run).
const fs = require("fs");
const os = require("os");
const path = require("path");

function coaCommand() {
  try {
    const agent = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".coalesce", "desktop", "agent.json"), "utf8"));
    if (agent.coa && agent.coa.runInvocation && fs.existsSync(agent.coa.runInvocation[0])) {
      const [cmd, ...pre] = agent.coa.runInvocation;
      return { cmd, pre, env: { ...process.env, ...(agent.coa.env || {}) }, source: "Coalesce Desktop" };
    }
  } catch { /* fall through */ }
  const apps = [path.resolve(path.dirname(process.execPath), "..", ".."), "/Applications/Coalesce.app", path.join(os.homedir(), "Applications", "Coalesce.app")];
  for (const app of apps) {
    const bin = path.join(app, "Contents", "MacOS", "Coalesce"), js = path.join(app, "Contents", "Resources", "coa", "coa.js");
    if (fs.existsSync(bin) && fs.existsSync(js)) {
      return { cmd: bin, pre: [js], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_USE_SYSTEM_CA: "1" }, source: app };
    }
  }
  return { cmd: "coa", pre: [], env: { ...process.env, PATH: `${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin` }, source: "PATH" };
}

module.exports = { coaCommand };
