# MCP agent access

The platform exposes a standards-based Model Context Protocol endpoint so compatible AI agents can inspect and, when explicitly permitted, control the system.

## Connect a client

1. Open **Settings → Operational configuration → MCP agent access**.
2. Select **Generate access token**. The token is shown once; store it in the client that will connect.
3. Leave system mutations and trading actions disabled for read-only access, or enable only the permissions the agent needs and select **Save operational settings**.
4. Copy the endpoint and client configuration from the Settings panel.

The local endpoint is:

```text
http://localhost:4000/mcp
```

A generic Streamable HTTP client configuration is:

```json
{
  "mcpServers": {
    "mt5bot": {
      "type": "http",
      "url": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer mt5mcp_REPLACE_WITH_YOUR_TOKEN"
      }
    }
  }
}
```

Use the same endpoint and bearer header in Claude Code, Codex, Hermes, or another client that supports Streamable HTTP MCP servers and custom headers. Client configuration file locations vary, so the Settings panel provides portable values rather than writing into a specific AI application's files.

Cloud-hosted agents cannot reach `localhost` on your Mac. To connect one, publish the backend through an authenticated HTTPS reverse proxy or private tunnel, then replace the URL above with `https://your-host/mcp`. Never expose the endpoint over public, unencrypted HTTP. Add browser origins in Settings only when a browser-based MCP client requires them; desktop and command-line clients normally do not send an `Origin` header.

Some hosted AI products accept only OAuth-protected remote MCP servers and do not allow a custom bearer header. Those clients need an OAuth authorization layer in front of this endpoint; bearer-header clients connect directly.

## Permission model

| Level | What the agent can do |
| --- | --- |
| MCP enabled | Read system status, trades, strategies, settings summaries, activity, news, and ask the system assistant. |
| Allow system mutations | Pause or stop the bot and enable or disable strategies. Destructive calls still require an exact confirmation phrase. |
| Allow trading actions | Start/reset the bot, change risk limits, run scans, and confirm prepared assistant changes. Existing role, risk, emergency-stop, and live-trading gates still apply. |

Trading permissions never turn on automatically when a token is generated. Keep them disabled unless the connected agent genuinely requires them.

## Published resources and tools

Resources:

- `mt5bot://system/overview`
- `mt5bot://system/settings`
- `mt5bot://system/activity`
- `mt5bot://system/memory`

Read tools:

- `get_system_overview`
- `list_trades`
- `list_strategies`
- `get_system_settings`
- `get_recent_activity`
- `get_trading_memory`
- `get_market_news`
- `ask_system_assistant`

Control tools:

- `confirm_system_change`
- `control_bot`
- `set_strategy_enabled`
- `update_risk_limits`
- `run_market_scan`

## Token security

- Configuration is stored in the database-backed Settings system, not an environment file.
- Only a SHA-256 hash of the token is stored. The full token is shown once.
- Rotating a token immediately invalidates the previous token.
- Revoking access disables the MCP endpoint and invalidates the token.
- The access token belongs to the administrator who generated it, and tool authorization uses that account's current role.
