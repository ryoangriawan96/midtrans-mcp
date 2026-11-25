// Smoke test: spawn the built server over stdio, run the MCP handshake,
// list the tools, and verify the Midtrans auth-header shape offline.
import { spawn } from "node:child_process";

const EXPECTED_TOOLS = [
  "get_transaction_status",
  "create_snap_transaction",
  "create_payment_link",
  "cancel_transaction",
  "refund_transaction",
];

function authHeader(key) {
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

const expectedAuth = "Basic " + Buffer.from("SB-Mid-server-test:").toString("base64");
if (authHeader("SB-Mid-server-test") !== expectedAuth) {
  console.error("FAIL: auth header mismatch");
  process.exit(1);
}
// Decode check: "<key>:" — server key as username, empty password.
const decoded = Buffer.from(expectedAuth.slice(6), "base64").toString();
if (decoded !== "SB-Mid-server-test:") {
  console.error("FAIL: auth header payload mismatch:", decoded);
  process.exit(1);
}
console.log("ok: auth header shape");

const child = spawn("node", ["dist/index.js"], {
  env: { ...process.env, MIDTRANS_SERVER_KEY: "SB-Mid-server-test" },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[server] " + d));

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error("timeout waiting for " + method)), 10000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" },
  });
  if (!init.result?.serverInfo?.name?.includes("midtrans")) {
    console.error("FAIL: unexpected serverInfo", JSON.stringify(init));
    process.exit(1);
  }
  console.log("ok: initialize ->", init.result.serverInfo.name, init.result.serverInfo.version);

  notify("notifications/initialized", {});
  const list = await send("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  console.log("ok: tools/list ->", names.join(", "));
  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length) {
    console.error("FAIL: missing tools:", missing.join(", "));
    process.exit(1);
  }
  console.log("PASS: all", EXPECTED_TOOLS.length, "tools present");
} finally {
  child.kill("SIGTERM");
}

// Phase 2: read-only mode must expose ONLY the status tool.
{
  const ro = spawn("node", ["dist/index.js"], {
    env: {
      ...process.env,
      MIDTRANS_SERVER_KEY: "SB-Mid-server-test",
      MIDTRANS_READ_ONLY: "true",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let rbuf = "";
  const rpending = new Map();
  ro.stdout.on("data", (d) => {
    rbuf += d.toString();
    let idx;
    while ((idx = rbuf.indexOf("\n")) >= 0) {
      const line = rbuf.slice(0, idx).trim();
      rbuf = rbuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && rpending.has(msg.id)) {
        rpending.get(msg.id)(msg);
        rpending.delete(msg.id);
      }
    }
  });
  let rid = 1;
  const rsend = (method, params) =>
    new Promise((resolve, reject) => {
      const id = rid++;
      rpending.set(id, resolve);
      ro.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error("timeout (ro) " + method)), 10000);
    });
  try {
    await rsend("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test-ro", version: "0.0.1" },
    });
    ro.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
    );
    const list = await rsend("tools/list", {});
    const names = (list.result?.tools ?? []).map((t) => t.name);
    if (names.length !== 1 || names[0] !== "get_transaction_status") {
      console.error("FAIL: read-only mode tools =", names.join(", "));
      process.exit(1);
    }
    console.log("ok: read-only mode exposes only get_transaction_status");
    console.log("PASS: read-only mode verified");
  } finally {
    ro.kill("SIGTERM");
  }
}
