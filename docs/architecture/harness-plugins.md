# Harness plugins: one API, per-harness adapters

Design record for the per-harness plugin model. Evidence cutoff: February 2026,
gathered from official documentation; VERIFIED = official docs/source, UNKNOWN =
unestablished. The L0 spike this document proposes is already implemented in
`apps/api/src/mcp-apps-viewer.ts`.

## 1. Premises

- Artiflow is open source and self-hosted. Each organization publishes its own instance
  (`https://artifacts.<org>.com`); users configure that instance URL in their harness.
- One unique interface to Artiflow (MCP + HTTP). Per-harness work is packaging and UX only.
- A feature blocked in one harness never blocks the others; the blocked harness degrades.

## 2. Capability matrix (evidence-backed)

| Harness                            | Knowledge injection                                                                 | MCP client                                     | Inline artifact UI                                                                            | Notes                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Claude Desktop                     | Agent Skills; Cowork plugins (paid preview); MCPB `.mcpb` bundles                   | stdio (MCPB) + remote connectors               | Yes: MCP Apps since 2026-01-26                                                                | No custom artifact-renderer API (UNKNOWN); no sync with native artifacts |
| ChatGPT                            | Custom GPT instructions/knowledge; apps do not inject global skills                 | Developer mode: remote HTTP + OAuth/PKCE + DCR | Yes: Apps SDK (beta, directory review) + MCP Apps rolling                                     | Cloud-originated connections: requires a published HTTPS origin          |
| Cursor                             | Plugins marketplace (2.5): skills + rules + MCP                                     | Local + remote with OAuth                      | VSIX webview panels; MCP Apps from 2.6                                                        | Two complementary integrations: agent plugin + optional VSIX             |
| OpenCode (CLI/Web/Desktop)         | Plugins + SKILL.md (`.opencode`/`.claude`/`.agents`) + `AGENTS.md`                  | Local + remote, full OAuth DCR                 | Desktop: GUI plugin SDK (`./gui-experimental`) with panels and web embeds; CLI: markdown only | GUI part is explicitly experimental; breaks between releases             |
| OpenWork (`different-ai/openwork`) | Inherits OpenCode plugins/skills                                                    | Via OpenCode                                   | Inherits OpenCode Desktop; own panel is markdown/images only                                  | Extension manifest is a draft; design for OpenCode, inherit OpenWork     |
| Pi                                 | `pi install` packages: extensions + SKILL.md; extensions may edit the system prompt | Not in core (extension)                        | No: TUI. `pi-web-ui` exists as a building block for separate apps                             | Strongest native-tools story of the open harnesses                       |
| Codex CLI                          | Skills since Dec 2025; plugins from Mar 2026                                        | Yes                                            | No (terminal)                                                                                 |                                                                          |
| Gemini CLI                         | Extensions bundle MCP + instructions + commands                                     | Streamable HTTP                                | No (terminal)                                                                                 |                                                                          |
| VS Code / Copilot                  | Rules                                                                               | Yes                                            | Yes: MCP Apps stable in 1.109                                                                 | Included for completeness                                                |
| Grok / xAI                         | None at cutoff (UNKNOWN)                                                            | Remote MCP API tools only                      | No                                                                                            | Revisit when a harness exists                                            |

Cross-cutting standards: MCP Apps is a FINAL optional MCP extension (SEP-1865 merged
2026-01-28, SDK `@modelcontextprotocol/ext-apps`); Agent Skills (`SKILL.md`) is the de facto
knowledge-injection format across all of the above.

## 3. Architecture: four layers

```
L0  Core (unique)          MCP tools + MCP Apps resource (ui://artiflow/artifact-viewer)
                           + HTTP API + server-rendered viewers            [exists]
L1  Shared knowledge       One SKILL.md authoring skill + AGENTS.md; identical content
                           everywhere; only the installer differs           [planned]
L2  Viewer shell           Implemented once inside L0's resource: comments, sharing and
                           version switching run via bridge-proxied tool calls; no cookies,
                           no direct network (CSP connect-src 'none')       [partial]
L3  Per-harness adapters   Stateless glue + packaging. Never reimplement validation or
                           domain logic; every adapter calls L0 and passes the instance URL
                           in configuration                                  [this roadmap]
```

Instance configuration rule: no adapter hardcodes an origin. The user provides
`https://artifacts.<org>.com` once per harness config (`mcpServers` entry, MCPB user config,
plugin options/env), and discovery flows from `/.well-known/oauth-protected-resource` (RFC 9728).
Token storage must be namespaced per base URL so two instances can coexist.

## 4. Deployment model (self-hosted, per organization)

| Requirement                                          | Status                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ARTIFLOW_PUBLIC_ORIGIN=https://artifacts.<org>.com` | Supported today; one origin per instance                                      |
| TLS                                                  | Caddy with automatic ACME                                                     |
| OAuth per instance                                   | Issuer derived from the origin; DCR; isolation by deployment, no multitenancy |
| MCP client discovery                                 | RFC 9728 protected-resource metadata; remote harnesses point at the URL       |
| MCP Apps origin                                      | Same instance serves the `ui://` resource; bridge talk uses `connectDomains`  |
| Data isolation                                       | Per-deployment PostgreSQL + S3 bucket                                         |

Deployment gaps to close before claiming "self-host anywhere":

1. MCP bearer verification hardcodes loopback JWKS self-calls; fragile behind
   exotic proxies.
2. Proxy requirement: the DNS-rebinding guard needs the original `Host`; document that a
   proxy rewriting Host to `api:8787` breaks MCP.
3. Path prefixes are unsupported on purpose: publish a dedicated subdomain per organization
   (`artifacts.acme.com/mcp`), never `acme.com/artiflow/`.
4. Cloud harnesses (ChatGPT dev mode, Claude remote connectors) require a public HTTPS
   origin with OAuth; local-only instances work with stdio harnesses only. State this in
   the deployment guide.
5. MCP Apps sandbox auth: the MCP Apps viewer resolves it via bridge-proxied tool calls with
   host-managed credentials; validate per host before promising inline UX.

## 5. Grilling (decisions and resolved risks)

- R1 reachability: resolved by the self-host premise. Each organization publishes its
  instance; cloud harnesses connect to the published origin, local harnesses may reach
  `127.0.0.1`. No tunnel infrastructure is Artiflow's business.
- R2 API stability: Apps SDK is beta with directory review; MCP Apps is an optional
  extension; OpenCode's GUI part is explicitly experimental. Isolate L2 in its own module;
  no shared logic across host adapters.
- R3 duplication: validation and domain logic live only in L0. Precedent in-repo: HTTP and
  MCP share one Drizzle comment repository and the same CAS.
- R4 sandbox: viewer auth is bridge-mediated; cookies and direct fetches are
  avoided by design; `frameDomains` stays blocked by default.
- R5 scope honesty: no custom Claude artifact renderers exist; no Artiflow↔ChatGPT Canvas
  sync exists. Comments/sharing/versioning inside the harness happen through Artiflow's own
  viewer UI, not native host features.

Discarded: custom Claude artifact renderers (no API), Grok/xAI (no harness at cutoff),
OpenWork as a separate target (inherits OpenCode), generic OpenCode Web UI integration
(no third-party UI API verified outside the experimental GUI plugin part).

## 6. Roadmap

1. ~~MCP Apps viewer resource~~ — done (viewer + `_meta.ui.resourceUri` on
   `artifact_commit`/`artifact_write` + unit tests).
2. Shared skill package (L1): authoring skill content once; installers per harness.
3. Per-host validation matrix: real integration checks of the MCP Apps viewer against
   Claude Desktop, ChatGPT, VS Code, Cursor 2.6+ (iframe auth, CSP, localhost vs published
   origin).
4. OpenCode plugin: server tools + skills and an experimental prebuilt Desktop GUI
   (`./gui-experimental`) with `/artiflow`, library and explicit artifact-ID viewer
   embeds. Accepts plugin `options.url`, a URL persisted via `/artiflow-setup <origin>` (per-plugin
   storage, works without any environment variable), or `ARTIFLOW_URL` as last fallback; the GUI
   resolves the origin through the server part's `config.url` RPC, so Desktop needs no
   `launchctl setenv`. Real Desktop validation remains pending. The server-only/CLI entry does not
   provide `/artiflow`.
5. Claude Desktop MCPB: package a local stdio proxy + skill bundle with the instance URL
   as user configuration.
6. Cursor VSIX with a `createWebviewPanel` preview, only if MCP Apps in 2.6 falls short of
   the desired UX.
7. Deployment guide: dedicated-subdomain topology, proxy Host requirement,
   loopback/JWKS constraint, cloud-harness requirements.
