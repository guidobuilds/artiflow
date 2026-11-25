---
title: Connect an agent
description: Add an Artiflow instance to an MCP client, understand the OAuth flow, and configure OpenCode, OpenWork, Claude Code, Codex, Cursor or any other Streamable HTTP host.
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
      "artiflow": { "type": "remote", "url": "https://artifacts.example.com/mcp" },
    },
  },
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

### Claude Code

```sh
claude mcp add --transport http artiflow https://artifacts.example.com/mcp
```

Run `/mcp` inside Claude Code and follow the sign-in prompt the first time a tool needs access.

### Codex — `~/.codex/config.toml`

```toml
[mcp_servers.artiflow]
url = "https://artifacts.example.com/mcp"
```

Then sign in once from the terminal:

```sh
codex mcp login artiflow
```

### Cursor — `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "artiflow": { "url": "https://artifacts.example.com/mcp" }
  }
}
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

### Cloud-hosted agents need a public origin

Some clients connect from the provider's infrastructure, not from your machine: ChatGPT in developer
mode and remote connectors in Claude, for example. Those cannot see an instance that only answers on
`127.0.0.1` or a private network. They need the instance on a public HTTPS origin with a valid
certificate — the topology in [Install Artiflow](/docs/self-hosting/installation/) — and whatever
enablement the provider itself requires for custom connectors on your account or organization.
Clients that run as a local process, such as OpenCode, Cursor or Claude Code, reach a private instance
as long as your machine can.

Each client registers its own OAuth client on first connect, so access can be revoked per client, and
one client can hold tokens for several instances, such as a work and a personal one.

## What the agent can do

The MCP server exposes artifact creation and reading, Markdown line editing, and comments with
generic anchors. It has **no** tool to list, search, share, publish or delete artifacts: those are
dashboard actions, so an agent cannot widen access on its own.

## Comments

`artifact_list_comments` returns the roots of a document with their ordered replies. Each comment
reports its author as `{ id, name, image }` and never an email address.

`artifact_add_comment` adds a root at a discriminated anchor:

| Kind         | Anchor                                                                                | Document |
| ------------ | ------------------------------------------------------------------------------------- | -------- |
| `text-range` | `{kind, startLine, startCol, endLine, endCol, quotedText}` — 1-indexed, end-exclusive | Markdown |
| `element`    | `{kind, selector, point:{x,y} in 0–1, textHint (≤120 chars), viewportWidth}`          | HTML     |
| `page-point` | `{kind, x in 0–1, y in pixels, viewportWidth}`                                        | HTML     |

A `text-range` quote must match the current source exactly, or the call refuses with
`anchor_mismatch`; `element` and `page-point` anchors are validated for shape only and positioned by
the client. An anchor the document kind does not accept refuses with `validation`
(`unsupported_anchor_kind`). A root without an anchor is refused, and replies carry no anchor at all.

`artifact_reply_comment` takes only a body and inherits its root's context; replying to a reply
refuses with `nested_reply`. `artifact_resolve_comment` and `artifact_unresolve_comment` act on roots
only and record who resolved the thread. Comments never create document revisions.

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
