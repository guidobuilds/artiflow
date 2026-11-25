---
title: Module map
description: Where each responsibility lives in the Artiflow workspace, and the import boundaries that check-boundaries enforces between apps and packages.
sidebar:
  order: 21
---

Artiflow is one Bun workspace with a single root install and lockfile. Apps are deployable; packages
are shared code consumed through `@artiflow/*` names; the rest are support trees. Read
[Architecture overview](/docs/contributing/architecture/) first for how the pieces fit at runtime.

## Workspace layout

```text
apps/
  api/            Bun + Hono API, MCP mount, collaboration socket, server-rendered viewers
  dashboard/      React SPA (Vite), library, editors, account and administration screens
  web/            this documentation site and the landing page (Astro + Starlight)
packages/
  contracts/      Zod wire schemas and inferred types shared by API, dashboard and SDK
  domain/         pure shared logic: kinds, Markdown lines, comment anchors, document and scene operations
  sdk/            typed fetch client for /api/v1, injectable fetch and token provider
  mcp-server/     transport-agnostic MCP tool logic behind the McpBackend port
  mcp-apps/       MCP Apps viewer document and host-capability helpers
  plugin-core/    harness-agnostic plugin runtime: OAuth client, associations, tool mapping, conformance kit
plugins/
  opencode/       the OpenCode plugin
skills/           canonical SKILL.md content every harness integration packages
drizzle/          generated, forward-only SQL migrations and snapshots
docker/           API and web images, the Caddyfile, the Garage config and the security sandbox
scripts/          local setup, dev runner, repository checks, integration runner, sandbox runner
test/             the root suite: unit tests and service-gated integration suites
brand/            brand guide and logo assets
```

## API (`apps/api/src`)

| Path                                                        | Responsibility                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server.ts`                                                 | Loads config, builds the pool and S3 client, serves `createApiApp`, attaches the collaboration socket, starts the GC loops, handles shutdown.    |
| `app.ts`                                                    | `createApiApp(deps)`: request id, sanitized `onError`, per-surface body limits and the mount order. No listener, no background jobs.             |
| `config.ts`                                                 | Parses and validates every environment variable once; a refusal names the variable, never its value.                                             |
| `auth.ts`, `oauth.ts`                                       | Better Auth instance, `/api/auth/*` behind the cookie CSRF guard, the OAuth provider, scopes, discovery and the required-`resource` guard.       |
| `http/`                                                     | Shared HTTP pieces: body limits, the admin guard, the request principal for bearer routes.                                                       |
| `routes/`                                                   | HTTP-to-use-case translation: library, sharing, editing, scene, comments, assets, health, account sessions, admin, and `v1/` with its scope map. |
| `mcp/`                                                      | MCP mount (bearer verification, Host/Origin allowlist) and the backend adapter that implements the `McpBackend` port.                            |
| `viewer/`                                                   | Server-rendered viewer pages, the CSP and sandbox policy, the HTML comment bridge, the comments data island.                                     |
| `domain/`                                                   | Use cases with no Hono: commits, commit flow, staging, documents, deletion and the three GC sweeps.                                              |
| `adapters/postgres/`                                        | Drizzle schemas, the typed client, the migrator and its target guard, the comments repository. The only place `pg` is imported.                  |
| `adapters/storage/`                                         | The S3 client and every byte operation. The only place the AWS SDK is imported.                                                                  |
| `collab/`                                                   | Live collaboration: Yjs rooms, the WebSocket at `/api/collab`, and the flush that turns room state into document operations.                     |
| `identity/`, `admin/`                                       | Roles, account status, SSO resolution, and the administration use cases (users, sessions, invitations, reset links, purge).                      |
| `settings/`                                                 | The stored instance configuration, encrypted secrets, access methods and the SSO connection.                                                     |
| `invites/`, `password-reset/`, `password-policy/`, `login/` | Invitation and reset tokens, the password policy and its hook, the emergency login fallback lock.                                                |
| `commands/`                                                 | The console operator commands (`admin:*`, `user:*`), documented in [Console commands](/docs/reference/console-commands/).                        |
| `logging/`                                                  | The closed set of structured administration events.                                                                                              |

### Persistence strategy

Product repositories query the typed database from `apps/api/src/adapters/postgres/db/client.ts`;
transactional operations receive its transaction handle. HTTP routes and MCP tools consume the same
operations instead of duplicating SQL per transport. Better Auth receives only the auth aggregate
(`auth-schema.ts`); product tables are not exposed to its adapter.

Prefer Drizzle builders. Keep typed `sql` fragments for compare-and-set (`IS NOT DISTINCT FROM`),
database-clock expressions and constructs without a builder. Transactions stay explicit: an expected
refusal that needs a rollback throws inside the transaction and is mapped back to a domain result
outside it.

## Dashboard (`apps/dashboard/src`)

| Path                                                   | Responsibility                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `main.tsx`, `router.tsx`, `route-guards.ts`            | Entry point and TanStack Router routes, including the session and administrator guards.                          |
| `query/`                                               | TanStack Query client, keys and the queries for session, library, shares and comments.                           |
| `*Page.tsx`                                            | One screen each: library, Markdown editor, canvas editor, login, register, reset, consent, account, admin pages. |
| `*-client.ts`, `*-api.ts`                              | Typed HTTP clients for auth, editing, scenes, comments, sessions and each admin area.                            |
| `editor-autosave.ts`, `scene-autosave.ts`, `collab.ts` | Save state machines and the live-collaboration client.                                                           |
| `viewer-comments.tsx` and `comment-*.ts`               | The comment margin bundle used by the viewers, and thread layout and navigation.                                 |
| `components/`                                          | `app/` shells and account pieces, `comments/` margin, `ui/` primitives.                                          |

Loads belong in TanStack Query: `bun run check:effects` rejects a `fetch` or HTTP client call inside a
`useEffect` or `useLayoutEffect`.

## Import boundaries

`scripts/check-boundaries.mjs` runs in `bun run build` and in CI. It resolves relative paths, the
dashboard `@/` alias and `@artiflow/*` names, reports `file:line`, and accepts `--root <dir>` so its
negative tests run against a sandbox.

| Area                 | May import                                              | Must not import                                                                                |
| -------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `apps/dashboard`     | its own sources, `@artiflow/domain`, `contracts`, `sdk` | anything else in the repo; `pg`, `@aws-sdk/*`, `node:fs`, `node:net`, `node:child_process`     |
| `packages/contracts` | nothing internal                                        | any other package or app; `hono`, `pg`, `@aws-sdk/*`, `node:http`                              |
| `packages/sdk`       | `contracts`                                             | anything else; `hono`, `pg`, `@aws-sdk/*`, `node:http`                                         |
| other packages       | other packages                                          | app code; `hono`, `pg`, `@aws-sdk/*`, `node:http` (stricter lists for `domain` and `mcp-apps`) |
| `apps/api`           | packages                                                | dashboard or plugin code                                                                       |
| `plugins/opencode`   | packages                                                | app internals                                                                                  |

Hoisting alone does not stop undeclared imports, which is why the check exists; do not substitute a
TypeScript path alias for real package resolution. Within the API, only `adapters/` imports `pg` or
the AWS SDK, and use cases in `domain/` never import Hono.

## What is deliberately absent

- **No queue or worker process.** The background jobs are the in-process GC sweeps.
- **No cache layer.** Every request re-reads identity and data; Better Auth's cookie cache is off.
- **No stateful MCP session.** One transport and one server per request.
- **No upload route in the dashboard.** New content arrives through MCP or `/api/v1`.
