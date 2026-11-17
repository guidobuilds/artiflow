---
title: Connect an agent
description: Add an Artiflow instance to an MCP client, understand the OAuth flow, and configure Claude Code, Cursor, OpenCode, OpenWork, Codex or any other Streamable HTTP host.
sidebar:
  order: 2
---

Artiflow exposes one MCP endpoint per instance:

```text
https://artifacts.example.com/mcp
```

It speaks **Streamable HTTP** and authenticates with **OAuth 2.1**: the client registers itself, opens
your instance in a browser for consent, and then presents bearer tokens it stores itself. There is no
static API key to copy, and the endpoint never accepts a dashboard cookie.

## Client configuration

These are the configurations the dashboard offers on **Connect an agent**, with a placeholder origin.
Replace `https://artifacts.example.com` with your own instance origin.

### Claude Code

```sh
claude mcp add --transport http artiflow https://artifacts.example.com/mcp
```

Run `/mcp` inside Claude Code and follow the sign-in prompt the first time a tool needs access.

### Cursor — `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "artiflow": { "url": "https://artifacts.example.com/mcp" }
  }
}
```

### OpenCode — `opencode.json`

```json
{
  "mcp": {
    "artiflow": { "type": "remote", "url": "https://artifacts.example.com/mcp" }
  }
}
```

### OpenWork — `opencode.jsonc`

OpenWork Desktop is OpenCode-based and edits the same engine config. Open **Library → Advanced settings → Show in Finder** to locate its `opencode.jsonc`, add the same remote entry, and restart OpenWork so the change reaches the app:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "artiflow": { "type": "remote", "url": "https://artifacts.example.com/mcp" }
    }
  }
}
```

No OAuth block is needed: the engine's default remote-MCP behavior registers itself (dynamic
registration, loopback callback, PKCE) and opens your instance's consent page in a browser on the
first tool call. Sign in with your own account — the consent page times out after three minutes,
so complete it promptly.

Prefer this config path over OpenWork's **Library → Add workspace MCP** dialog: that dialog's
"OAuth on this device" panel expects a pasted, pre-registered client id (and secret) and cannot
perform dynamic registration, so against this instance it saves the connection but never reports
the tools as ready.

Version note: this format is confirmed working on OpenWork Desktop 0.18.58; upstream 0.18.67
differences are unknown. When reporting issues, record the app version (Settings → About).

### Codex — `~/.codex/config.toml`

```toml
[mcp_servers.artiflow]
url = "https://artifacts.example.com/mcp"
```

Then sign in once from the terminal:

```sh
codex mcp login artiflow
```

### Any other MCP client

Use Streamable HTTP transport with OAuth authorization and the same URL. Nothing else is required:

```text
Server URL   https://artifacts.example.com/mcp
Auth         OAuth 2.1, approved in the browser
```

## Compatible is not the same as validated

The endpoint, the OAuth flow and the tool behavior are implemented in this codebase and covered by its
server tests. What differs per product is the host: each client renders consent, tool results and inline previews its
own way, and end-to-end validation of every client's UI is still pending. Two
consequences worth planning around:

- **Inline preview is a host capability.** Clients that implement the MCP Apps extension render the
  artifact viewer in the conversation; clients that do not still receive the full JSON result. The
  artifact is published either way, and you open it in the browser.
- **The endpoint trusts only the hosts your operator configured.** A connection error or `403` while
  the same URL opens in a browser usually means the client's host is not in that list.

## What the agent can do

The MCP server exposes artifact creation and reading, Markdown line editing, and Markdown comments. It
has **no** tool to list, search, share, publish or delete artifacts: those are dashboard actions, so an
agent cannot widen access on its own.

## Sign-in and tokens

- The first call that needs access opens your instance's consent page in a browser.
- Approving it grants the client the scopes it asked for: `artifacts:write` to publish,
  `artifacts:read` to read artifacts and Markdown source back.
- The token lives in the client's credential store; it is not your browser session and not a secret you
  paste into a configuration file. A missing, expired or refused token answers `401` with a
  `WWW-Authenticate` challenge, and the client repeats discovery and sign-in.

## Troubleshooting

| Symptom                                        | Likely cause                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `401` before any tool runs                     | Sign-in never completed, or the client discarded its stored token. Re-run the client's login. |
| `insufficient_scope` and nothing published     | Consent approved without `artifacts:write`; re-authenticate and approve the full request.     |
| `403` on connect while the URL works elsewhere | The host the client sends is not in the instance's allowed host list.                         |
| No tools listed at all                         | The entry is not a remote/HTTP MCP server, so the client never requests the tool list.        |
| `too_large` from `artifact_write`              | The document exceeds the single-call cap; see [Limits](/docs/reference/limits/).              |

## Next

[Quickstart](/docs/start/quickstart/) publishes a first page over this connection.
