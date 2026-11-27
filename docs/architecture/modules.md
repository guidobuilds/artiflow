# Module map

**Status:** target approved; paths below the target sections describe the current
implementation. **Date:** 2026-11-10.

The application currently lives in the root package; the OpenCode plugin has its
own package and lockfile. The existing source and support trees are:

```
apps/api/src/          backend (module boundaries below)
apps/dashboard/   React SPA (own Vite root and index.html; moved 2026-11-10)
packages/domain/  pure shared anchors/markdown helpers (moved 2026-11-10)
brand/            brand guide + logo used by the dashboard
drizzle/          generated SQL migrations + Drizzle snapshots
scripts/          local setup, dev runner, browser E2E probes
test/             unit + HTTP integration suites (Node test runner)
docs/             this documentation + the user runbook
```

## Target workspace

This is the destination for this migration, not a claim that these paths already
exist. Internal package names use `@artiflow/*`; the existing OpenCode package
name remains unchanged.

```text
apps/
  api/                       Bun/Hono core, private
    src/
      app.ts                 createApiApp(deps), no listener or background jobs
      server.ts              resource construction, listener and lifecycle
      http/                  HTTP guards, errors, IDs and body limits
      routes/                HTTP-to-use-case translation
      domain/                application use cases, no Hono/Context
      adapters/              PostgreSQL, S3 and auth implementations
      mcp/                   transport mounting/adaptation, no duplicate use cases
      viewer/                existing server-rendered pages and MCP viewer
  dashboard/                 React/Vite SPA, private; owns index.html and Vite config
packages/
  contracts/                 Zod wire schemas and inferred DTOs
  domain/                    pure shared anchors and Markdown operations, private
  sdk/                       fetch client for /api/v1; compiled JS + declarations
  mcp-server/                transport-agnostic MCP tool logic behind McpBackend ports
  mcp-apps/                  MCP Apps viewer document + host-fallback helpers
  plugin-core/               harness-agnostic plugin runtime: OAuth client, associations,
                             tools mapping, skills base, runConformance kit
plugins/
  opencode/                  existing plugin; workspace enrollment is install-gated
```

`docs/`, `drizzle/`, `docker/`, `scripts/`, `skills/`, `test/` and `brand/` are
support trees, not runtime packages. Keep migrations and environment files at the
root. Keep the existing tests together to avoid changing test ownership/semantics
alongside the move; real-app contract and composition tests join that suite.

No standalone MCP app, MCP server/apps package, plugin-core, UI kit, new plugin or
connector is introduced. Those future consumption boundaries do not justify
placeholder packages. The mock landing under `site/` is removed; the web workspace
that will publish the site and docs is planned, and this map gives it no path yet.
See [deployment topologies](README.md#deployment-topologies)
for what is and is not delivered.

### Move map

| Current source                       | Destination                                                                   | Necessary consumers                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/web/` and root HTML/Vite        | `apps/dashboard/src/` and app-local entrypoints                               | DONE 2026-11-10: npm scripts, TS aliases, Docker web build, test source paths and site token import |
| `src/web/comment-anchors.ts`         | `packages/domain/src/comment-anchors.ts`                                      | DONE 2026-11-10: API, dashboard and tests; server-to-web imports removed                            |
| `apps/api/src/artifacts/markdown.ts` | `packages/domain/src/markdown.ts`                                             | DONE 2026-11-10: API and tests; Node-only decoding kept out of browser entrypoints                  |
| `src/api/`                           | `apps/api/src/`                                                               | DONE 2026-11-10: scripts, tests, Docker API/migrator, Drizzle schema paths and docs                 |
| root TS settings                     | `tsconfig.base.json` plus per-app/package configs                             | keep tests/tooling separate from app compilation and plugin settings                                |
| `plugins/opencode/`                  | same path, DONE 2026-11-10: enrolled as a workspace after clean-install proof | single root lockfile; CI caches one lock; preflight resolves through the root install               |

The physical move precedes internal API reorganization. Use `git mv`, preserve
source content, and include only indispensable path/config rewiring in the same
verified commit. Refactors, DTO changes and error behavior belong to later cuts.

## Target dependency rules

| Consumer           | Allowed internal dependencies                    | Forbidden                                                |
| ------------------ | ------------------------------------------------ | -------------------------------------------------------- |
| `contracts`        | none; Zod is external                            | any app, SDK, domain or plugin                           |
| shared `domain`    | contract types if needed                         | Hono, I/O, UI and app internals                          |
| `sdk`              | `contracts`                                      | API internals, database, storage and UI                  |
| `dashboard`        | `sdk`, `contracts`, browser-safe domain subpaths | API/plugin internals, pg, AWS SDK, server-only Node APIs |
| `api`              | `contracts`, shared `domain`                     | dashboard or plugin internals                            |
| `plugins/opencode` | public contracts/SDK where needed                | app internals and other plugin internals                 |

Read arrows as “consumer imports dependency”. Within the API, routes and MCP
adapters call shared use cases; use cases do not import Hono/Context. Only
`adapters/` imports pg/AWS SDK. Keep authorization differences between transports
explicit; sharing a use case must not broaden access. Pure shared domain is not
the home for the API's persistence-dependent orchestration.

Enforce the rules with declared dependencies, explicit `package.json` exports and
`check-boundaries` in CI. Hoisting alone does **not** prevent undeclared
imports, so check relative paths, aliases, package names and reexports as well.
Negative tests must demonstrate that a forbidden edge fails the check. Do not
substitute TS path aliases for actual runtime package resolution.

`scripts/check-boundaries.mjs` enforces today's edges: the dashboard may not
import API sources, server-only modules (`node:fs`, `node:child_process`,
`node:net`, `pg`, `@aws-sdk/*`) or anything outside itself and
`@artiflow/domain`; packages may not import apps, Hono, pg, the AWS SDK or
`node:http`; the API may not import dashboard/plugin internals or legacy
`src/web`; the plugin may not import app internals. It resolves relative paths,
the dashboard `@/` alias and `@artiflow/*` package names, reports `file:line`,
and accepts `--root <dir>` so negative tests can run it against a sandbox.

Contracts define wire shapes once, not UI view models or database rows. Handlers
use `satisfies`; dashboard/SDK parse with the same schemas before presentation
mapping. Preserve distinct HTTP and MCP projections where their protocols differ.
The SDK has injectable fetch/token retrieval and must run against both the real
app's fetch and a network URL. Its endpoints/scopes/token policy requires separate
approval before implementation.

## 1. API modules

`apps/api/src` is internally layered (2026-11-10):

```text
http/       one glosa: guard, uuid, session, error body, Rollback<T>, body limits
routes/     HTTP-to-use-case translation (library, editing, sharing, comments);
            routes/v1/scopes.ts maps every /api/v1 method+path to its scope
domain/     application use cases (commits, commit-flow, staging, gc, deletion); no Hono
adapters/   postgres/ (pg, Drizzle schemas, migration guard) and storage/ (S3); the only
            modules importing pg or the AWS SDK
mcp/        mount + backend adapter (apps/api owns transport/auth and the viewer HTML);
            the tool logic lives in packages/mcp-server behind the McpBackend
            port — embedded adapter here, standalone SDK adapter planned
viewer/     server-rendered viewer pages
auth.ts, oauth.ts, config.ts   cross-cutting identity/config at the root
app.ts      createApiApp(deps): composition without listener or background jobs
server.ts   config load, resource construction, listener, GC, shutdown
```

`app.ts` owns the mount order (health -> auth -> sharing/editing/comments/share-viewer -> library -> MCP) and is what contract tests compose via `app.fetch` with stubbed process edges. `requestId` and the sanitized `onError` (500 `{error: internal_error, requestId}`) run before any mount; body limits are declared once per surface (`http/body-limit.ts`: document-save at the schema cap, comments 64 KiB, MCP 2 MiB) and read only the Content-Length header, preserving MCP auth-before-read. Unknown transaction failures classify as internal errors, never conflicts.

### Bootstrap and configuration

| File                     | Responsibility                                                                                                                                                                  | Depends on       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `apps/api/src/server.ts` | Loads config, builds pool/storage, calls `createApiApp`, serves, starts the staging GC, handles SIGINT/SIGTERM.                                                                 | app.ts           |
| `apps/api/src/app.ts`    | `createApiApp(deps)`: pure composition, mounted in a deliberate order; also installs requestId + sanitized onError and per-surface body limits.                                 | every API module |
| `apps/api/src/config.ts` | Parses and validates all environment variables. Never echoes a rejected value; fails at startup with variable names only. Derives loopback-safe defaults and the public origin. | —                |

### Identity and OAuth

| File                    | Responsibility                                                                                                                                                                                                                                     | Depends on                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `apps/api/src/auth.ts`  | Builds the Better Auth instance (Drizzle adapter, no telemetry, no logger, no cookie cache) and mounts `/api/auth/*` behind a cookie-CSRF guard. Adds `/api/auth/capabilities`, OAuth discovery paths and the required-`resource` authorize guard. | config, db, oauth             |
| `apps/api/src/oauth.ts` | Public issuer/resource derivation, scope list, and the `mcp()` + `jwt()` plugins. Dynamic client registration, token lifetimes, refresh rotation, consent/login page pointers.                                                                     | config                        |
| `apps/api/src/mcp.ts`   | Bearer-only MCP transport at `/mcp`. Verifies tokens through `requireMcpAuth`, maps claims to `{ userId, scopes }`, enforces a Host/Origin allowlist and builds one server/transport per request (stateless).                                      | auth, injected server factory |

`createArtifactTools` is the only identity consumer: it never reads a client-supplied
owner id, and it re-checks the scope on every tool call.

### Artifact domain

| File                                    | Responsibility                                                                                                                                                                                                                                                                                           | Depends on                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `apps/api/src/artifacts/staging.ts`     | Persistent upload staging metadata: create upload, put/list chunks, abort, complete, delete expired. Returns discriminated unions, never throws for expected failures. Ownership failures read as `not_found`.                                                                                           | PostgreSQL                                  |
| `apps/api/src/artifacts/s3.ts`          | The only module that moves bytes. Writes each revision body under its own key `artifacts/<revision id>`, staging chunks at `staging/<sha256>`, reads with a cap and re-hashes, idempotent deletes.                                                                                                       | S3 client, schema caps                      |
| `apps/api/src/artifacts/commits.ts`     | Revision pointer repository. Creates an artifact + first revision, performs compare-and-set on `currentRevisionId`, soft-deletes. Uses explicit Drizzle transactions with refusal-triggered rollback.                                                                                                    | PostgreSQL                                  |
| `apps/api/src/artifacts/commit-flow.ts` | Orchestrates commit: preflight, hash whole body, store bytes, complete upload, insert revision + pointer. Defines the failure order and which failures leave orphans.                                                                                                                                    | staging, s3, commits, markdown              |
| `apps/api/src/artifacts/gc.ts`          | Two sweeps on one discipline (one at a time, unref'd timers). Staging GC collects chunk bytes no open/unexpired upload needs and removes expired rows only after their digests resolve, every 15 min. Revision sweep deletes `artifacts/` objects no revision row names and older than 24 h, once a day. | PostgreSQL, s3                              |
| `apps/api/src/artifacts/markdown.ts`    | Pure markdown line model: 1-indexed line ops with exact-text expectations, UTF-8 strict decoding. No I/O.                                                                                                                                                                                                | —                                           |
| `apps/api/src/artifact-tools.ts`        | Registers the MCP tools (`artifact_start_upload`, `artifact_put_chunk`, `artifact_commit`, `artifact_get`, markdown read/edit, five comment tools). Validates base64, computes digests server-side, binds work to verified claims.                                                                       | staging, s3, commits, commit-flow, markdown |

### HTTP surfaces

| File                                           | Responsibility                                                                                                                                                                                                                  | Depends on                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/api/src/library.ts`                      | Owner reads (`GET /api/artifacts`, `/:id`, `/shared`), the owner rename (`PATCH /api/artifacts/:id/metadata`), the owner/recipient viewer (`GET /artifact/:id`), and the owner delete route. One last-registered 405 catch-all. | db, auth, storage, deletion, viewer/prepare, viewer/views/* |
| `apps/api/src/sharing.ts`                      | Owner-only grant CRUD (`/shares`) and public-link management (`/links`), plus the session-free public viewer (`GET /share/:token`) and its `?meta=1` payload. Exports the single read predicate used by every delivery path.    | db, auth, storage, viewer/prepare, viewer/views/*           |
| `apps/api/src/editing.ts`                      | Markdown autosave (`PUT /document`), document read, revision history and restore. A save lands as an operation batch on the draft sequence; a whole revision is written only when a snapshot freezes.                           | db, auth, storage, commits, documents, markdown             |
| `apps/api/src/comments.ts`                     | Anchored comment threads. One access gate, artifact row lock for mutations, validates the quoted source slice under the lock.                                                                                                   | db, auth, storage, markdown, `web/comment-anchors`          |
| `apps/api/src/deletion.ts`                     | Soft delete first, then best-effort removal of the artifact's own revision keys. No reference query: a key belongs to one revision of one artifact. Never fails a completed deletion because storage failed.                    | commits, s3, PostgreSQL                                     |
| `apps/api/src/viewer/prepare.ts`               | `prepareViewer`: the one place that projects ownership, computes access once and decides audience, chrome, entitlements, comments plan and refresh plan.                                                                        | db, comments repos, assets, model                           |
| `apps/api/src/viewer/model.ts`                 | The viewer vocabulary — `ViewerModel`, audience, chrome, actions, comments and management plans — and `RefreshPlan`.                                                                                                            | assets, comments-data                                       |
| `apps/api/src/viewer/artifact.ts`              | The outer document, its regions (bar, frame, comments host, data islands) and its one policy: CSP, sandbox value, headers and the refresh script.                                                                               | assets, chrome, model                                       |
| `apps/api/src/viewer/chrome/theme.ts`          | Tokens and chrome CSS, the 404 page, the attribute and JSON escapers.                                                                                                                                                           | —                                                           |
| `apps/api/src/viewer/chrome/bar.ts`            | The one bar, for every chrome level.                                                                                                                                                                                            | theme, model                                                |
| `apps/api/src/viewer/chrome/panel.ts`          | The comments host and its CSS.                                                                                                                                                                                                  | —                                                           |
| `apps/api/src/viewer/views/html.ts`            | The format view for a sandboxed HTML page.                                                                                                                                                                                      | artifact                                                    |
| `apps/api/src/viewer/views/markdown.ts`        | The format view for a document: server-rendered GFM (`html:false`) in the page itself, not in a frame.                                                                                                                          | markdown-it, artifact, chrome                               |
| `apps/api/src/viewer/views/scene.ts`           | The format view for a canvas or a deck; `views/canvas-controller.ts` and `views/deck-controller.ts` carry the two scene scripts.                                                                                                | domain scene, artifact                                      |
| `apps/api/src/viewer/{html,markdown,scene}.ts` | Thin re-export surfaces kept so importers did not move at once.                                                                                                                                                                 | model, chrome, artifact, views                              |

### Viewer

Routes only read bytes, refuse, call `prepareViewer` and then a view. `prepareViewer`
computes access once and returns a `ViewerModel` that already carries the chrome
level, the entitlements, the comments plan, the management plan and the refresh
plan, so no view decides who may see what.

Two rules hold for the surface:

- Bar controls are addressed by `data-control` (`focus`, `actions`, `menu`) and
  never by CSS class, so an island can mount into a bar it does not own.
- A view must not import another view. `views/html.ts`, `views/markdown.ts` and
  `views/scene.ts` each reach the shared regions through `artifact.ts` and
  `chrome/`.

### Persistence

| File                                           | Responsibility                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/src/db/client.ts`                    | Builds the `pg` pool (max 4, 3 s connect timeout, 10 s idle) and a Drizzle instance typed with `appSchema` (auth + product tables), exported as `AppDb`. Exposes `check()` (`SELECT 1`) and `close()`. |
| `apps/api/src/db/schema.ts`                    | Better Auth core tables: `user`, `session`, `account`, `verification`.                                                                                                                                 |
| `apps/api/src/db/oauth-schema.ts`              | OAuth/JWT plugin tables: clients, resources, client-resource links, refresh/access tokens, consents, assertions, `jwks`.                                                                               |
| `apps/api/src/db/auth-schema.ts`               | Runtime aggregate handed to Better Auth. The base schema never imports OAuth, avoiding a circular init.                                                                                                |
| `apps/api/src/db/artifact-schema.ts`           | Product tables and the single source of truth for caps (`16 MiB`, `1 MiB`, `60 min`) and enums. CHECK constraints enforce digest shape, size caps and roles.                                           |
| `apps/api/src/adapters/postgres/db/migrate.ts` | Applies Drizzle migrations and reports the target. Refuses to run against an unintended database unless explicitly allowed.                                                                            |
| `apps/api/src/db/migration-target.ts`          | The guard: only the owned local database (loopback, specific port/name) is allowed by default; anything else needs `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1`.                                                  |

### Persistence strategy

Product repositories query the typed `AppDb` from `apps/api/src/db/client.ts`;
transactional operations receive its `AppTx` handle. Every product query belongs
in a repository: HTTP routes and MCP tools consume the same operations, including
`comments-repo.ts`, rather than duplicating transport-specific persistence.
Better Auth still receives only the auth-only aggregate in `auth-schema.ts`;
product tables are not exposed to its adapter.

Prefer Drizzle builders. Reserve typed `sql` fragments for CAS
(`IS NOT DISTINCT FROM`), database-clock expressions and constructs without
builders. Transactions stay explicit; expected refusals that require rollback
throw inside the transaction and are mapped back to domain results outside it.

## 2. Web modules

### Entry and shell

| File                                                                       | Responsibility                                                                                                                                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/main.tsx`                                              | Manual pathname routing: `/`, `/library`, `/edit/:uuid`, `/login`, `/consent`, `/connect`, `/account`, else branded 404. Renders the provider stack (theme, tooltip, toast). |
| `apps/dashboard/src/components/app/app-shell.tsx`                          | 248 px sidebar shell, navigations, account slot, session read with redirect. Also exports `BareShell` (OAuth/404) and `PageHeader`.                                          |
| `apps/dashboard/src/components/app/account-menu.tsx`, `theme-provider.tsx` | Account row/menu and theme persistence.                                                                                                                                      |
| `apps/dashboard/src/styles/tokens.css`, `globals.css`                      | Brand tokens (warm terminal / Studio) and Tailwind layer.                                                                                                                    |

### Pages

| File                                                                              | Responsibility                                                                                                                           |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `LibraryPage.tsx`                                                                 | Owned + shared lists, filters, grid/list layout, sort, keyboard selection, command palette, onboarding, share/delete modals.             |
| `EditorPage.tsx`                                                                  | TipTap markdown editor: autosave state machine, version history/restore, comment markers, selection composer, read-only/conflict states. |
| `AuthScreen.tsx`, `LoginPage.tsx`, `ConsentPage.tsx`                              | Sign-up/in plus OAuth login continuation and consent.                                                                                    |
| `ConnectPage.tsx`, `OnboardingSteps.tsx`                                          | "Connect an agent" instructions and first-run steps.                                                                                     |
| `AccountPage.tsx`, `NotFoundPage.tsx`                                             | Account summary and branded 404.                                                                                                         |
| `CommandPalette.tsx`, `ShareModal.tsx`, `DeleteModal.tsx`, `components/comments/` | Interaction surfaces.                                                                                                                    |

### Client data layer

| File                 | Responsibility                                                                                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-client.ts`     | 550-line DOM-free HTTP client: auth, session, capabilities, OAuth continuation/consent, library fetch/parse, share/link/delete management, delete double-confirm, one-time token state. Hand-written runtime validators; no shared schema with the server. |
| `editor-api.ts`      | Document read/save/history/restore and artifact-open decision (markdown → editor, HTML → viewer).                                                                                                                                                          |
| `comments-api.ts`    | Comment list/create/resolve/delete with strict parsing.                                                                                                                                                                                                    |
| `editor-autosave.ts` | Debounced save state machine (saved/saving/unsaved/conflict/readonly), retry and reload semantics.                                                                                                                                                         |
| `comment-anchors.ts` | **Cross-boundary pure module**: maps rendered TipTap selections to 1-indexed source anchors and computes comment decorations. Imported by both the SPA and the API (`artifact-tools.ts`, `comments.ts`).                                                   |
| `components/ui/*`    | shadcn-style primitives (dialog, menu, tooltip, button, input, toast, icon, card, collection…).                                                                                                                                                            |

## 3. Support trees

| Tree       | Contents                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/` | `local.mjs` (`.env.local` generation + external service check), `auth-env.mjs`, `dev.mjs` (API + Vite, port checks, shutdown), and the browser/E2E probe (`e2e-full-cycle.mjs`). |
| `drizzle/` | 10 forward migrations (auth → OAuth → artifacts → staging → indexes → sharing/links → checks → comments) + Drizzle snapshots.                                                    |
| `test/`    | 43 files: pure unit tests, HTTP integration tests (real server), OAuth/auth suites (real PostgreSQL), Chrome-free UI assertions, schema/migration checks.                        |
| `tmp/`     | Local scratch material and historical skills; not part of the runtime.                                                                                                           |

## 4. Dependency direction

Rules the code mostly follows:

```
server.ts ──▶ http adapters ──▶ domain/application ──▶ repositories ──▶ pg / s3
    │                │
    └──────────────▶ config, auth, oauth
```

Allowed:

- HTTP adapters may call application services and repositories.
- Application services call repositories.
- Repositories call only `pg` / S3 / pure helpers.

The former server-to-web import of `comment-anchors` is resolved: API, dashboard
and tests consume `@artiflow/domain` instead. The API tree now lives in `apps/api/src`;
remaining structure work is the target-internal layering (http/routes/domain/adapters).

## 5. What is deliberately absent

- **No queue or worker process.** The only background job is the in-process staging GC.
- **No cache layer.** Every request re-reads identity and data; cookie-cache is off.
- **No stateful MCP session.** One transport and one server per request.
- **No upload route in the dashboard.** Content arrives only through MCP, by design.
