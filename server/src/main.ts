import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, chmod, lstat, readFile, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import QRCode from "qrcode";
import { Assets, HTTPError } from "./assets.js";
import { Bridge } from "./bridge.js";
import { Database } from "./db.js";
import { buildTools, makeSocketServer } from "./mcp.js";
import { dashboardURL, Operations } from "./operations.js";
import { Queries } from "./queries.js";

const execute = promisify(execFile);
const port = 7865;
const validHosts = new Set(["localhost:7865", "127.0.0.1:7865", "[::1]:7865"]);
const allowedOrigin = (host: string) => "http://" + host;
const permitted = new Set(["same-origin", "none"]);
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

function json(response: ServerResponse, code: number, value: unknown) {
  response.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
function clientConfigs(cli: string) {
  const command = JSON.stringify(cli);
  return {
    codex: `[mcp_servers.whatsapp]\ncommand = ${command}\nargs = ["stdio"]\n`,
    claude: JSON.stringify({ mcpServers: { whatsapp: { command: cli, args: ["stdio"] } } }, null, 2) + "\n",
    hermes: `mcp_servers:\n  whatsapp:\n    command: ${command}\n    args: ["stdio"]\n`,
  };
}

async function clearStaleSocket(path: string) {
  const entry = await lstat(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!entry) return;
  if (!entry.isSocket()) throw new Error("The MCP socket path contains an unexpected file");
  const socket = createConnection(path);
  try {
    await once(socket, "connect");
    throw new Error("Another MCP server already owns the socket");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
    await unlink(path);
  } finally {
    socket.destroy();
  }
}

async function main() {
  const data = process.argv[2] === "--data-dir" ? process.argv[3] : "";
  if (!data || !isAbsolute(data)) throw new Error("An absolute --data-dir is required");
  const app = dirname(data);
  const cli = join(app, "bin", "whatsapp-mcp");
  const launchMarker = join(data, "control", "enabled");
  const socketPath = join(data, "run", "mcp.sock");
  const files = fileURLToPath(new URL("../public", import.meta.url));
  const instance = randomUUID();
  const startCommand = shellQuote(cli) + " start";
  const database = new Database(join(data, "db", "app.sqlite3"), join(app, "current", "migrations", "001-initial.sql"));
  const assets = new Assets(join(data, "assets"), database);
  const bridge = new Bridge();
  const queries = new Queries(database);
  let state = "starting";
  let ownsSocket = false;
  let shutdown: Promise<void> | undefined;
  let pairingImage: { code: string; image: string } | undefined;
  const currentState = () => state === "running" ? bridge.state : state;
  const operations = new Operations(database, currentState);
  const mcp = makeSocketServer(() => buildTools(queries, operations, currentState));

  async function onRequest(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const host = request.headers.host ?? "";
    const path = request.url ?? "";
    const method = request.method;
    if (!validHosts.has(host) || !path.startsWith("/") || path.startsWith("//")) {
      throw new HTTPError(403, "Use localhost to access this dashboard.");
    }
    if (request.headers.origin && request.headers.origin !== allowedOrigin(host)) {
      throw new HTTPError(403, "Origin is outside this dashboard.");
    }
    const fetchSite = request.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && !permitted.has(fetchSite)) {
      throw new HTTPError(403, "Open the dashboard directly.");
    }
    if (method === "POST" && request.headers.origin !== allowedOrigin(host)) {
      throw new HTTPError(403, "Use the dashboard to perform this action.");
    }
    if (method === "GET" && path === "/api/status") {
      return json(response, 200, {
        app: "whatsapp-mcp-local", instance, state, whatsapp: currentState(),
        pairingError: bridge.pairingError, startCommand,
      });
    }
    if (method === "GET") {
      const file = staticFiles.get(path);
      if (file) {
        response.writeHead(200, { "Content-Type": file[1] });
        response.end(await readFile(join(files, file[0])));
        return;
      }
    }
    if (state !== "running") throw new HTTPError(503, "The service is starting or stopping.");
    if (method === "GET" && path === "/api/config") return json(response, 200, clientConfigs(cli));
    if (method === "GET" && path === "/api/pairing") {
      const qr = bridge.qr;
      if (!qr || qr.expiresAtMs <= Date.now()) {
        pairingImage = undefined;
        return json(response, 200, { image: null });
      }
      if (pairingImage?.code !== qr.code) {
        pairingImage = { code: qr.code, image: await QRCode.toDataURL(qr.code, { errorCorrectionLevel: "M", width: 300 }) };
      }
      if (bridge.qr !== qr || qr.expiresAtMs <= Date.now()) return json(response, 200, { image: null });
      return json(response, 200, { image: pairingImage.image, expiresAtMs: qr.expiresAtMs });
    }
    if (method === "POST" && path === "/api/pairing") {
      bridge.pair();
      return json(response, 202, { status: bridge.state });
    }
    if (method === "GET" && path === "/api/assets") return json(response, 200, await assets.list());
    if (method === "POST" && path === "/api/assets") return json(response, 201, await assets.upload(request));
    if (method === "GET" && path.startsWith("/api/assets/")) return assets.download(path.slice("/api/assets/".length), response);
    if (method === "POST" && (path === "/api/service/stop" || path === "/api/service/restart")) {
      const stop = path.endsWith("/stop");
      state = "stopping";
      if (stop) {
        try {
          await execute(cli, ["disable-boot"], { timeout: 5000 });
        } catch {
          state = "running";
          throw new HTTPError(500, "Could not save the stop setting. The service is still running.");
        }
      }
      const finish = () => void shutdownOnce(stop ? 0 : 75);
      response.once("finish", finish);
      response.once("close", finish);
      if (response.destroyed) finish();
      else json(response, 202, { state: stop ? "stopping" : "restarting", instance, startCommand });
      return;
    }
    throw new HTTPError(404, "Not found.");
  }

  const createDashboard = () => createServer({ requestTimeout: 60_000, headersTimeout: 15_000 }, (req, res) => {
    void onRequest(req, res).catch((error) => {
      if (res.headersSent || res.destroyed) return res.destroy();
      if (!(error instanceof HTTPError)) console.error("Dashboard request failed.");
      req.resume();
      json(res, error instanceof HTTPError ? error.status : 500, {
        error: error instanceof HTTPError ? error.message : "The request could not be completed.",
      });
    });
  });
  const dashboards = [createDashboard(), createDashboard()];

  function shutdownOnce(exitCode: number) {
    return shutdown ??= (async () => {
      state = "stopping";
      const deadline = setTimeout(() => process.exit(exitCode || 1), 18_000);
      deadline.unref();
      for (const server of dashboards) {
        server.close();
        server.closeAllConnections();
      }
      mcp.server.close();
      mcp.disconnect();
      await bridge.stop();
      await database.close().catch(() => {});
      if (ownsSocket) await unlink(socketPath).catch(() => {});
      process.exit(exitCode);
    })();
  }

  process.on("SIGTERM", () => void shutdownOnce(0));
  process.on("SIGINT", () => void shutdownOnce(0));
  try {
    await database.ready;
    await access(launchMarker);
    await clearStaleSocket(socketPath);
    const mcpListening = once(mcp.server, "listening");
    mcp.server.listen(socketPath);
    await mcpListening;
    ownsSocket = true;
    await chmod(socketPath, 0o600);
    await assets.cleanInterruptedWrites();

    const listen = async (index: number, host: string) => {
      const ready = once(dashboards[index], "listening");
      dashboards[index].listen({ port, host, ipv6Only: host === "::1" });
      await ready;
    };
    await listen(0, "127.0.0.1");
    try { await listen(1, "::1"); }
    catch (error) {
      if (!["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }

    const ffmpeg = (await readFile(join(app, "current", "ffmpeg.path"), "utf8")).trim();
    const bridgeTimeout = setTimeout(() => {
      console.error("Go bridge did not become ready.");
      void shutdownOnce(1);
    }, 15_000);
    bridgeTimeout.unref();
    bridge.start(join(app, "current", "bin", "whatsapp-bridge"), data, ffmpeg, () => {
      clearTimeout(bridgeTimeout);
      if (state !== "starting") return;
      state = "running";
      if (bridge.state === "pairing_required") bridge.pair();
      console.error("WhatsApp MCP ready at " + dashboardURL);
    }, () => {
      console.error("Go bridge exited.");
      void shutdownOnce(1);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error("Port 7865 is already in use.");
    } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("WhatsApp MCP could not initialize:", (error as Error).message);
    }
    const enabled = await access(launchMarker).then(() => true, () => false);
    await shutdownOnce(enabled ? 1 : 0);
  }
}

process.umask(0o077);
void main().catch(() => {
  console.error("WhatsApp MCP could not start. Check the installation.");
  process.exitCode = 1;
});
