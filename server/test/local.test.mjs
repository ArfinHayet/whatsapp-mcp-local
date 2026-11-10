import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Database } from "../dist/db.js";
import { Operations } from "../dist/operations.js";
import { Queries } from "../dist/queries.js";

const base = "http://127.0.0.1:7865";
const migration = fileURLToPath(new URL("../../migrations/001-initial.sql", import.meta.url));

async function eventually(check) {
  for (let i = 0; i < 100; i++) {
    try { const result = await check(); if (result) return result; }
    catch {}
    await delay(50);
  }
  throw new Error("Timed out waiting for the local service");
}

test("SQLite read behavior and interrupted operation results", async () => {
  const root = await mkdtemp("/tmp/wm-db-");
  const db = new Database(join(root, "test.sqlite3"), migration);
  try {
    await db.ready;
    const chat = "11111111111@s.whatsapp.net";
    await db.run("INSERT INTO chats VALUES(?,?,?)", chat, "München", 3);
    await db.run("INSERT INTO messages (id,chat_jid,sender,content,timestamp,is_from_me) VALUES(?,?,?,?,?,0)", "before", chat, chat, "before", 1);
    await db.run("INSERT INTO messages (id,chat_jid,sender,content,timestamp,is_from_me) VALUES(?,?,?,?,?,1)", "match", chat, chat, "ÜBER", 2);
    await db.run("INSERT INTO messages (id,chat_jid,sender,content,timestamp,is_from_me) VALUES(?,?,?,?,?,0)", "after", chat, chat, "after", 3);
    const queries = new Queries(db);
    const rows = await queries.messages({ query: "über", limit: 20, page: 0, include_context: true, context_before: 1, context_after: 1 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].context.before[0].id, "before");
    assert.equal(rows[0].context.after[0].id, "after");
    assert.equal(rows[0].is_from_me, true);

    const operations = new Operations(db, () => "offline");
    assert.equal((await operations.submit("send", { message: "unsubmitted" })).status, "offline");
    assert.equal((await db.get("SELECT count(*) AS n FROM commands")).n, 0);
    await db.run(`INSERT INTO commands(id,idempotency_key,kind,payload_json,status,created_at_ms,expires_at_ms)
      VALUES('op','key','send','{"message":"sent"}','unknown',1,2)`);
    assert.equal((await operations.submit("send", { message: "sent" }, "key")).status, "unknown");
    assert.equal((await operations.submit("send", { message: "different" }, "key")).status, "conflict");
    assert.match((await operations.status("op")).message, /Check the chat/);
  } finally {
    await db.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("local HTTP, QR, assets, dual MCP handshakes, restart and durable stop", { timeout: 30_000 }, async (t) => {
  const root = await realpath(await mkdtemp("/tmp/wm-app-"));
  const data = join(root, "data");
  const marker = join(data, "control/enabled");
  const cli = join(root, "bin/whatsapp-mcp");
  let child;
  let errors = "";
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(["bin", "current/bin", "current/migrations", "data/control", "data/run", "data/db", "data/assets"]
    .map((dir) => mkdir(join(root, dir), { recursive: true, mode: 0o700 })));
  await copyFile(migration, join(root, "current/migrations/001-initial.sql"));
  await writeFile(marker, "");
  await writeFile(join(root, "current/ffmpeg.path"), "");
  await writeFile(join(root, "current/bin/whatsapp-bridge"), `#!${process.execPath}
const { createInterface } = require("node:readline");
console.log(JSON.stringify({ type: "state", state: "pairing_required" }));
let requests = 0;
createInterface({input: process.stdin}).on("line", (line) => {
  const { type } = JSON.parse(line);
  if (type === "drain") process.exit(0);
  if (type === "pair") {
    if (++requests === 2) {
      console.log(JSON.stringify({type: "state", state: "pairing_required", reason: "qr_expired"}));
      return;
    }
    console.log(JSON.stringify({type: "state", state: "pairing"}));
    console.log(JSON.stringify({type: "qr", code: "synthetic test QR", expiresAtMs: Date.now() + 30000}));
  }
});`, { mode: 0o700 });
  if (process.env.WHATSAPP_TEST_CLI) {
    await copyFile(process.env.WHATSAPP_TEST_CLI, cli);
  } else {
    await writeFile(cli, `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "disable-boot") fs.unlinkSync(${JSON.stringify(marker)});
else {
  const socket = require("node:net").connect(${JSON.stringify(join(data, "run/mcp.sock"))});
  socket.on("error", () => process.exit(1));
  socket.on("close", () => process.exit(0));
  process.stdin.pipe(socket).pipe(process.stdout);
}`, { mode: 0o700 });
  }
  async function boot() {
    child = spawn(process.execPath, [fileURLToPath(new URL("../dist/main.js", import.meta.url)), "--data-dir", data], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    try {
      return await eventually(async () => {
        const status = await (await fetch(base + "/api/status")).json();
        return status.app === "whatsapp-mcp-local" && status.state === "running" && status;
      });
    } catch (error) { throw new Error(errors, { cause: error }); }
  }

  const first = await boot();
  assert.match(await (await fetch(base)).text(), /WhatsApp connection/);
  assert.match(await eventually(async () => (await (await fetch(base + "/api/pairing")).json()).image), /^data:image\/png;base64,/);
  const requestQR = () => fetch(base + "/api/pairing", { method: "POST", headers: { origin: base } });
  assert.equal((await requestQR()).status, 202);
  await eventually(async () => (await (await fetch(base + "/api/status")).json()).pairingError === "qr_expired");
  assert.deepEqual(await (await fetch(base + "/api/pairing")).json(), { image: null });
  assert.equal((await requestQR()).status, 202);
  assert.match(await eventually(async () => (await (await fetch(base + "/api/pairing")).json()).image), /^data:image\/png;base64,/);
  assert.equal((await stat(join(data, "run/mcp.sock"))).mode & 0o777, 0o600);
  const configs = await (await fetch(base + "/api/config")).json();
  assert.equal(JSON.parse(configs.claude).mcpServers.whatsapp.command, cli);
  assert.ok(configs.codex.includes(cli));
  assert.ok(configs.hermes.includes(cli));

  const upload = await fetch(base + "/api/assets", {
    method: "POST",
    headers: { origin: base, "content-type": "application/octet-stream", "x-whatsapp-filename": "..%2Fnotes.txt" },
    body: "content survives restart",
  });
  assert.equal(upload.status, 201);
  const { id, filename } = await upload.json();
  assert.equal(filename, "notes.txt");
  assert.equal(await readFile(join(data, "assets", id), "utf8"), "content survives restart");
  assert.equal((await fetch(base + "/api/pairing", { method: "POST", headers: { origin: "https://example.com" } })).status, 403);
  assert.equal((await fetch(base + "/api/pairing", { method: "POST" })).status, 403);

  for (const versionNegotiation of [undefined, { mode: "auto" }]) {
    const agent = new Client({ name: "local-test", version: "0.1.0" }, { versionNegotiation });
    try {
      await agent.connect(new StdioClientTransport({ command: cli, args: ["stdio"] }));
      const { tools } = await agent.listTools();
      assert.equal(tools.length, 14);
      const result = await agent.callTool({ name: "get_connection_status", arguments: {} });
      assert.ok(["pairing", "pairing_required"].includes(result.structuredContent.status));
      const chats = await agent.callTool({ name: "list_chats", arguments: {} });
      assert.deepEqual(JSON.parse(chats.content[0].text), []);
    } finally { await agent.close(); }
  }

  let exit = once(child, "exit");
  assert.equal((await fetch(base + "/api/service/restart", { method: "POST", headers: { origin: base } })).status, 202);
  assert.deepEqual(await exit, [75, null]);
  assert.ok(await stat(marker));
  assert.notEqual((await boot()).instance, first.instance);
  const downloaded = await fetch(base + "/api/assets/" + id);
  assert.match(downloaded.headers.get("content-disposition"), /^attachment/);
  assert.equal(await downloaded.text(), "content survives restart");

  exit = once(child, "exit");
  const stop = await fetch(base + "/api/service/stop", { method: "POST", headers: { origin: base } });
  assert.equal(stop.status, 202);
  assert.match((await stop.json()).startCommand, /whatsapp-mcp' start$/);
  assert.deepEqual(await exit, [0, null]);
  await assert.rejects(stat(marker), { code: "ENOENT" });
  await assert.rejects(stat(join(data, "run/mcp.sock")), { code: "ENOENT" });
});
