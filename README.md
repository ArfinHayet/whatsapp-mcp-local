# WhatsApp MCP Local

A single-owner macOS service with a Go WhatsApp bridge, a Node.js MCP server, and a dashboard at **http://localhost:7865**. Use it with Codex Desktop, Claude Desktop, Hermes, or another local stdio MCP client.

## Install

On macOS 15 or later, clone the repository and run setup as your regular Mac user.

```sh
git clone https://github.com/ArfinHayet/whatsapp-mcp-local.git
cd whatsapp-mcp-local
./setup
```

Setup downloads checksum-pinned Node and Go runtimes, installs the locked npm and Go dependencies, builds the app, and prompts for your administrator password to register the LaunchDaemon. It needs internet access during setup and uses port 7865. GitHub access is required to clone this private repository. The installed service uses SQLite and has no application login.

When WhatsApp MCP is already running, `./setup` opens the dashboard in your default browser. Run `./setup --upgrade` to install a new version.

Setup opens the dashboard in your default browser once the local service is ready. On your phone, go to **WhatsApp → Linked Devices → Link a Device** and scan the QR. Pair as a fresh linked device. The bridge saves the session and imports the chats and messages WhatsApp supplies through linked-device sync.

Choose your agent under **Agent setup**, copy its configuration, and merge it into the agent’s settings. See [agent setup](docs/agent-setup.md). Close the browser and Terminal whenever you’re done. The service continues running in the background.

## Daily use

- **Files** accepts uploads up to 20 MiB. Copy the uploaded file’s ID into an agent request that uses `send_file` or `send_audio_message`. Uploaded and downloaded assets are saved under the installed app’s `data/assets` directory.
- **Restart service** restarts the Node server and Go bridge and reconnects the saved WhatsApp session.
- **Stop service** stops both processes and persists the stopped state through reboots. The open tab displays the start command. Once the server exits, reloading the dashboard shows a connection error until you start it again.
- For voice notes, Ogg Opus files work directly. For common formats that need conversion, install FFmpeg and run `./setup --upgrade` so the bridge can find it. Some media containers require seeking during conversion. If FFmpeg rejects one, convert it to Ogg Opus before uploading.

Run the installed CLI from any directory.

```sh
"/Library/Application Support/WhatsApp MCP/bin/whatsapp-mcp" status
"/Library/Application Support/WhatsApp MCP/bin/whatsapp-mcp" start
"/Library/Application Support/WhatsApp MCP/bin/whatsapp-mcp" restart
"/Library/Application Support/WhatsApp MCP/bin/whatsapp-mcp" stop
```

Starting a stopped system job can request administrator approval. Startup happens before desktop login once macOS starts its system services. On a FileVault-protected Mac waiting for disk unlock, the job starts after unlock.

## Privacy and delivery

The dashboard listens on loopback. The agent relay connects through a private Unix socket. Treat the unauthenticated browser dashboard as available to other local programs on the Mac, and keep the QR and stored files private. The app uses your internet connection to communicate with WhatsApp.

The app tracks each send in SQLite. If the bridge is interrupted after a send begins, the operation can return `unknown`. Ask the agent to check `get_operation_status` and the destination chat before retrying. Startup expires pending commands from the prior instance.

See [service and data](docs/service-and-data.md) for logs, backups, upgrades, re-pairing, and uninstall. The source is adapted from [WhatsApp MCP Cloud](https://github.com/ArfinHayet/whatsapp-mcp-cloud) and [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp), with the included MIT license.
