import { createServer } from "node:net";

async function free(host) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port: 7865, ipv6Only: host === "::1" }, resolve);
    });
  } catch (error) {
    if (host === "::1" && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) return;
    if (error.code === "EADDRINUSE") {
      console.error("Port 7865 is occupied. Stop the other local service before installing WhatsApp MCP.");
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

await free("127.0.0.1");
if (!process.exitCode) await free("::1");
