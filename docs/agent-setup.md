# Connect your agent

Use a client running on the same Mac under the user account that installed the service. The dashboard’s **Agent setup** section generates the actual paths for your installation. Merge the single `whatsapp` entry into the existing configuration.

## Codex Desktop

In MCP settings, add a local **STDIO** server named `whatsapp`. Use the command and argument from the dashboard. You can also put the generated TOML in `~/.codex/config.toml`.

```toml
[mcp_servers.whatsapp]
command = "/Library/Application Support/WhatsApp MCP/bin/whatsapp-mcp"
args = ["stdio"]
```

Save and reload the MCP connection. [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp)

## Claude Desktop

Open **Settings → Developer → Edit Config**. On macOS the file is `~/Library/Application Support/Claude/claude_desktop_config.json`. Merge the entry inside `mcpServers`, then quit and relaunch Claude Desktop.

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "/Library/Application Support/WhatsApp MCP/bin/whatsapp-mcp",
      "args": ["stdio"]
    }
  }
}
```

[Claude Desktop local MCP setup](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

## Hermes

Merge the YAML into `~/.hermes/config.yaml` or the active Hermes profile configuration, then reload or restart Hermes.

```yaml
mcp_servers:
  whatsapp:
    command: "/Library/Application Support/WhatsApp MCP/bin/whatsapp-mcp"
    args: ["stdio"]
```

[Hermes MCP configuration](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)

## Verify

Ask the agent to call `get_connection_status` and list up to three chats. These calls do not send messages. If the MCP connection is unavailable after a service restart, reload the agent’s MCP connection. The relay never starts a stopped service.

For a file, upload it on the dashboard and copy its file ID. Resolve the intended contact or group first, then supply the recipient and file ID to the agent. Group names are for lookup. Use the exact JID when sending.
