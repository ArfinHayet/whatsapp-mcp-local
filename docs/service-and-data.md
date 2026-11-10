# Service and data

The LaunchDaemon label is `com.whatsapp-mcp.local`. Its executable runs as the regular user selected at setup. Runtime files are installed in `/Library/Application Support/WhatsApp MCP`. The app keeps its own Node runtime and loads no shell profile at boot.

## Diagnostics

```sh
APP="/Library/Application Support/WhatsApp MCP"
"$APP/bin/whatsapp-mcp" status
tail -n 100 "$APP/data/logs/service.log"
launchctl print system/com.whatsapp-mcp.local
lsof -nP -iTCP:7865 -sTCP:LISTEN
```

- If port 7865 is occupied by another app, free the port before starting WhatsApp MCP.
- After a temporary network outage, allow the bridge to reconnect. If the linked device was revoked, open the dashboard and request a new QR.
- After a deliberate stop, run the displayed start command. A local agent connection cannot restart the service.
- If the bridge cannot convert an audio format, use Ogg Opus or install FFmpeg and run `./setup --upgrade`.

## Upgrades and backup

Pull the new code and run `./setup --upgrade`. Setup builds a new release before switching the installed runtime. It stops the app to copy the SQLite databases and their WAL files, when present, into `data/backups`. Uploaded and downloaded files stay in `data/assets`. A deliberate stop stays in effect during an upgrade.

For a manual backup, stop the app before copying its entire `data` directory to a location you control. The backup contains WhatsApp session keys and message history. Keep it private.

## Uninstall

Stop the app first. If the job is registered, unload it, then remove the LaunchDaemon and runtime files. Leave the data directory in place if you want to retain uploads, history, and session keys.

```sh
APP="/Library/Application Support/WhatsApp MCP"
"$APP/bin/whatsapp-mcp" stop
sudo launchctl bootout system/com.whatsapp-mcp.local
sudo rm "/Library/LaunchDaemons/com.whatsapp-mcp.local.plist"
sudo rm -rf "$APP/bin" "$APP/releases" "$APP/current"
```

To remove saved data too, first remove this linked device from WhatsApp on your phone. After backing up any files you want to keep, remove the app directory separately.

## Development checks

Use the versions in `install/runtime-versions.sh`. The dashboard integration test uses port 7865 and an isolated data directory with a simulated bridge. Stop the installed app before running it.

```sh
(cd go && go test ./... && go vet ./...)
npm --prefix server ci
npm --prefix server test
```

To exercise the real Go relay during the dashboard integration test:

```sh
(cd go && go build -o /tmp/whatsapp-mcp-test-relay ./cmd/whatsapp-mcp)
WHATSAPP_TEST_CLI=/tmp/whatsapp-mcp-test-relay npm --prefix server test
```
