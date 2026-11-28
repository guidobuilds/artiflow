# Artiflow local runbook

This is the local development runbook for `127.0.0.1`. PostgreSQL and
S3-compatible object storage are external services. For the deployment
profiles (development over HTTP vs production over HTTPS), the environment that
changes between them, the sign-in model and the OAuth-origin caveat, read
[deployment-guide.md](deployment-guide.md).

## 1. What this is

Artiflow is an MCP-first platform for self-contained HTML artifacts and markdown
documents.

- **Agents write content** through the MCP endpoint at
  `http://127.0.0.1:5173/mcp`. There is no upload form and no dashboard upload
  route.
- **Humans manage access** at `/library`: list, share, publish links, edit
  markdown, comment and delete. The dashboard never accepts content.
- **Private by default.** Metadata lives in PostgreSQL, bytes in a private
  S3-compatible bucket. Viewers escape HTML bytes into the `srcdoc` of an iframe
  with `sandbox="allow-scripts"` and `default-src 'none'` (the served page adds
  `connect-src 'self'` for its own metadata poll; the artifact frame inherits it
  but stays an opaque origin, so it sends no cookies); HTML never executes on the
  application origin.

| Port | Service        | Entry point                        |
| ---- | -------------- | ---------------------------------- |
| 5173 | UI (Vite)      | `http://127.0.0.1:5173/`           |
| 8787 | API (Bun/Hono) | `http://127.0.0.1:8787/api/health` |

Use the literal IPv4 address `127.0.0.1`: on some machines `localhost` resolves to
an unrelated IPv6 listener.

## 2. First run

Requirements: Bun `>=1.2` (verified on 1.3.10) runs the API locally and inside the
production image and is the package manager; Node.js `>=24.0.0` runs the Vite dev
server, the repository scripts and the test runner. You also need a PostgreSQL 16
database and role, a private S3-compatible bucket, and Docker only for the
integration stack or the published production images.

```sh
bun install           # pinned workspace dependencies from bun.lock
bun run setup:local   # creates .env.local (mode 0600) and the auth secret
# edit .env.local: DATABASE_URL and ARTIFLOW_S3_*
bun run check:local   # SELECT 1 + HeadBucket; creates nothing
bun run db:migrate    # additive and idempotent
bun run dev           # API on 8787, UI on 5173
```

`bun run dev` runs the API on Bun and the Vite dev server on Node; it prints the
chosen API runtime on startup, and `ps` shows the binary on the API pid. Set
`ARTIFLOW_DEV_RUNTIME=node` to run the API on the declared Node fallback.

`dev` refuses to start if either port is taken, and `Ctrl+C` stops only its child
processes. Check readiness:

```sh
curl -s http://127.0.0.1:8787/api/health
# {"status":"ok","checks":{"database":"ok","storage":"ok"}}
```

`/api/health` is 200 only when both probes pass and 503 with `"status":"degraded"`
otherwise. Registration is closed in every profile, so the first account comes from the
console: `bun run user:invite you@example.com` prints a single-use URL that expires in
24 hours, and `bun run admin:grant you@example.com` makes that account an
administrator once it exists, which is what opens the administration surfaces under
`/admin` on `http://127.0.0.1:5173/`.

All local secrets live in `.env.local` (mode `0600`, git-ignored): database URL,
S3 credentials and auth signing secret. Never commit, print or paste them; service
credentials belong to the external provider.

### Integration suite

`docker-compose.yml` provides a disposable PostgreSQL 16 + Garage stack. Its
images must already be local and its public credentials are test-only. Run from
the repository root without exported application variables:

```sh
docker compose up -d --wait garage postgres
node --env-file=test/integration-config.example apps/api/src/adapters/postgres/db/migrate.ts
bun run test:integration
docker compose down
```

Loopback ports: PostgreSQL `54329`, Garage S3 `9001`. Garage's `--default-bucket`
creates the bucket named in the Compose file; the app still never creates one.
Never point this stack at real data. `test:auth` and `test:oauth` use `.env.local`
and a disposable database.

`bun run test:integration` fails when a variable from
`test/integration-config.example` is missing and when any test skips. CI runs
this sequence in the `integration` job of
[`.github/workflows/verify.yml`](../.github/workflows/verify.yml): it pulls the
pinned images (the Compose file itself refuses to pull), starts the stack, waits
until `SELECT 1` and `HeadBucket` succeed, migrates, then runs the suite. The
security-sandbox reproducer is not part of that job: it still expects the viewer
body to equal the stored HTML, and the frame now also carries the comment bridge,
so a run exits 3.

## 3. Creating artifacts via MCP

| Purpose                                | URL                                                   |
| -------------------------------------- | ----------------------------------------------------- |
| MCP endpoint (also the OAuth resource) | `http://127.0.0.1:5173/mcp`                           |
| OAuth issuer                           | `http://127.0.0.1:5173/api/auth`                      |
| Dynamic client registration (RFC 7591) | `http://127.0.0.1:5173/api/auth/oauth2/register`      |
| Owner-authorized client creation       | `http://127.0.0.1:5173/api/auth/oauth2/create-client` |

### Get a token

Generic MCP clients need no manual setup: discovery advertises registration, so
the client self-registers a public native client and opens the browser for
sign-in and consent. Manual registration still works for confidential clients:

```http
POST /api/auth/oauth2/create-client
Origin: http://127.0.0.1:5173
Content-Type: application/json

{"redirect_uris":["http://127.0.0.1:PORT/callback"],"client_name":"Local agent",
 "application_type":"native","token_endpoint_auth_method":"client_secret_basic"}
```

Then run authorization code + PKCE `S256`: `GET /api/auth/oauth2/authorize` with
`response_type=code`, `client_id`, `redirect_uri`, `code_challenge`,
`code_challenge_method=S256`, `resource=http://127.0.0.1:5173/mcp` and the needed
scopes (a missing `resource` is `400 invalid_target`); sign in and consent; then
`POST /api/auth/oauth2/token` with the code and `code_verifier`.

Scopes: `artifacts:read`, `artifacts:write`, `offline_access`. Access tokens are
900-second JWTs; refresh tokens rotate strictly and a replay revokes the family.
Send `Authorization: Bearer <token>` on every `/mcp` request.

Transport rules: `POST` only (`405` otherwise), `Accept` must include both
`application/json` and `text/event-stream` (`406` otherwise), a foreign `Host` or
`Origin` is refused (`403`), and a dashboard cookie alone is not accepted.

### Tool flow

`artifact_write` sends a whole text artifact in one call (at most 1 MiB decoded);
use the staged stream for larger or binary payloads.

| Step | Tool                    | Notes                                                                                                                                                                                   |
| ---- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `artifact_start_upload` | `declaredSizeBytes`, `declaredSha256`; returns `uploadId`, `expiresAt`. Idempotent per declaration.                                                                                     |
| 2    | `artifact_put_chunk`    | One base64 chunk per call, ≤ 1 MiB decoded; idempotent per byte-identical chunk.                                                                                                        |
| 3    | `artifact_commit`       | Verifies chunks and the whole-artifact digest, then creates the artifact or a CAS revision with `expectedRevisionId`. Optional `kind` (`html` default, `markdown`, `canvas` or `deck`). |
| 4    | `artifact_get`          | Reads the current or a pinned revision as base64; requires `artifacts:read`.                                                                                                            |

`artifact_write` takes `text`, `kind`, optional `title`, and the same
`artifactId`/`expectedRevisionId` CAS rules as `artifact_commit`; it returns the
same commit fields and binds the MCP Apps viewer. The two ingestion paths never
mix. `artifactId` must be a canonical lowercase UUID (`invalid_artifact_id`).

Limits: 16 MiB decoded per artifact, 1 MiB per chunk, staging TTL 60 minutes. A
digest mismatch stores no row (`digest_mismatch`). Hosts that implement MCP Apps
(SEP-1865) render the commit inline from `ui://artiflow/artifact-viewer` through
a host-proxied `artifact_get`; other hosts keep the plain JSON result.

### Markdown documents

`kind: "markdown"` requires valid UTF-8 (`not_valid_utf8_markdown`) and a matching
`kind` on update (`kind_mismatch`). `artifact_get_markdown` returns 1-indexed
lines; `artifact_edit_lines` applies 1–50 replace/insert/delete ops against a
required `expectedRevisionId` (`concurrent_edit` when stale,
`expectation_mismatch` when an `expect` fails).

### MCP comments

The five tools require canonical lowercase UUIDs. A new root carries the anchor, and the anchor kind is
gated per artifact kind — Markdown takes `text-range`, HTML `element` and `page-point`, a canvas
`board-point` or `artboard-point` — so an anchor the document kind does not accept refuses with
`unsupported_anchor_kind`. An `artboard-point` names a frame, the source revision it pinned and the
element selection; it refuses with `unknown_frame`, `unknown_source`, `revision_mismatch` or
`source_unavailable` before any source bytes are read:

- `artifact_list_comments` (read) returns roots with nested `replies`, anchors,
  quotes, bodies and resolved timestamps.
- `artifact_add_comment` (write) uses 1-indexed lines and UTF-16 columns,
  end-exclusive; a non-matching quote refuses with `anchor_mismatch`.
- `artifact_reply_comment` (write) inherits the root anchor and quote
  (`nested_reply` for replies to replies).
- `artifact_resolve_comment` / `artifact_unresolve_comment` (write) affect roots
  only (`reply_is_not_root`).

Body/quote caps are 4,000/2,000 characters (`too_large`); missing or foreign
comments refuse with `comment_not_found`.

### Editing API

Cookie routes under `/api/artifacts/:id` for browser editing. The owner and shared
editors (`role = 'editor'`) can write; any grant can read. Mutations need the
exact `Origin` and a JSON body, and every content write appends a revision through
the same CAS.

| Route                            | Purpose                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET .../document`               | Stored markdown + `revisionId`, `revisionNumber`, `title`; `409 wrong_kind` for HTML.                                                                                                                   |
| `PUT .../document`               | Autosave `{ text, expectedSeq }` (legacy `expectedRevisionId` still accepted); stale → `409 concurrent_edit`, a pending draft without a sequence → `409 sequence_required`, oversize → `413 too_large`. |
| `GET .../revisions`              | History, newest first (max 200).                                                                                                                                                                        |
| `POST .../revisions/:id/restore` | Applies the pinned revision's bytes as a `replace_document` operation and publishes it (`restoredFrom`).                                                                                                |
| `PATCH .../metadata`             | Rename with `{ title }`: `400 title_required`, `400 title_too_long` above 200 characters, `413 too_large` above 64 KiB, `404 not_found` for a foreign, deleted or unknown id.                           |

`PATCH .../metadata` is the one write here that appends no revision: it changes the
title and its timestamp only, so the current pointer, links and comment threads
keep working. It takes a session cookie and nothing else — the route has no bearer
path — and it is mounted only when the API knows its public origin, because it
runs the same `Origin` + JSON guard as every cookie mutation. `404 not_found` is
deliberate for a foreign or deleted artifact: the answer cannot tell a caller
that an id exists elsewhere.

### Staging garbage collection

The API sweeps ~15 seconds after start and every 15 minutes. It deletes
`staging/<sha256>` objects not referenced by an open, unexpired upload and never
touches `artifacts/` bodies or open uploads. An orphan key with no claim rows (a
crash between the S3 put and the claim insert) is invisible to this sweep. Each
run logs `[staging-gc] expiredUploads=N candidates=M deleted=K failed=F`.

### Revision orphan sweep

Revision bodies have their own sweep; the staging sweep never touches them. The
revision sweep runs ~60 seconds after start and then once a day, and it deletes an
`artifacts/<revision id>` object only when no `artifactRevisions` row names it **and**
the provider's `LastModified` is older than 24 hours, so a commit that has written
bytes but not yet its revision row is never raced. Staging chunks and foreign keys
are never candidates. Each run examines at most 2,000 keys in pages of 200; the cap is
a bound, not a persisted cursor, so a later run restarts from the beginning of the
listing. It never writes, updates or deletes a row, and it never reads bytes. Each run
logs `[revision-gc] examined=N candidates=M deleted=K failed=F listFailed=true|false`.

A soft delete removes the artifact's own revision objects best effort. If one of those
deletes is refused, the bytes stay and the sweep will not collect them either: the
soft-deleted artifact keeps its revision rows, which name those keys. Only a hard
delete would change that, and none exists.

## 4. Dashboard

Sign in at `http://127.0.0.1:5173/`, then open `/library`.

- **Owned** lists up to 100 artifacts; **Shared with me** lists up to 200 grants,
  read-only and marked with the owner's email.
- **Share** grants read-only access by email to a registered account; revocable.
- **Links** creates public URLs `http://127.0.0.1:5173/share/<token>`. The raw
  token is shown once; rotate replaces it and revokes the old one; links never
  expire. At most 200 links per artifact.
- **Delete** requires two presses. It is a soft delete; the artifact stops
  resolving immediately and its own revision objects are deleted best effort.

### Administration

An administrator reaches `/admin/users`, `/admin/access`, `/admin/sso`,
`/admin/password-policy` and `/admin/invitations` from the account menu of the
library; every `/api/admin/*` route sits behind one server-side guard. The
console counterpart is `bun run admin:grant|admin:revoke|admin:list` plus
`user:invite`, `user:reset-password` and `user:purge`, run with the API's
environment loaded.

The rules and refusals live in
[authentication and access](architecture/authentication-and-access.md). The
operator documentation is `apps/web/src/content/docs/docs/self-hosting/administration.md`
(surfaces, access methods, policy, invitations, sessions, the administration log),
`.../identity-providers.md` (the OIDC connection, Entra ID tenant pinning, Google
and GitHub restrictions, the emergency fallback) and `.../recovery.md` (no
administrator, deactivate versus purge, offboarding).

### Comments and editor

Open a markdown document at `/edit/:id`. Select text and use **Comment**; Enter
sends, Shift+Enter inserts a newline, Escape cancels. The **Comments** icon
toggles the side panel, where threads can be resolved and outdated ranges are
shown. Public `/share/:token` pages are read-only and have no comments.

The API under `/api/artifacts/:id/comments` enforces the same permissions: the
owner, editors and commenters can create and resolve, readers are read-only,
strangers get `404`, anonymous `401`, HTML `409 wrong_kind`. Deleting a root
cascades its replies.

The editor autosaves 1.5 seconds after typing and exposes version history and
restore (a new revision, never a rewrite). A concurrent edit stops autosave and
keeps local text; **Reload from server** discards it only after confirmation.

## 5. Known limits

- Two legacy artifacts (`first-artifact`, `i5d-disposable-01`) have non-UUID ids:
  readable, not deletable from the dashboard.
- No rate limiting on `/share`; public links rely on 256-bit tokens.
- Storage failures on the public path answer the same `404` as a missing artifact.
- Recipient metadata is owner-only; recipients use the shared listing and viewer.
- Access tokens are self-contained 900-second JWTs and cannot be revoked one by
  one, but deactivating an account revokes every token issued to it and both
  bearer surfaces refuse it from the next request.
- Public links never expire; revoke or rotate them.

External services are a prerequisite, not a product limit: `bun run check:local`
reports what is missing.

## 6. Troubleshooting

Start with `/api/health` (200 = database + storage OK; 503 = one failed).

- **Port in use:** `bun run dev` refuses to start (`5173`/`8787`).
- **Wrong API runtime:** the startup line `[dev] api runtime: …` names it;
  `ARTIFLOW_DEV_RUNTIME=bun|node` pins it (default `bun`).
- **Stale pid file:** `.runtime/artiflow-dev.pid` can lag; trust `ps`.
- **Services unreachable:** run `bun run check:local`.

| Status | Meaning                                                                     |
| ------ | --------------------------------------------------------------------------- |
| `401`  | Missing/invalid bearer token, or no session on a dashboard route.           |
| `403`  | Foreign/missing `Origin`; foreign `Host`/`Origin` at `/mcp`; missing scope. |
| `404`  | Not owned, missing or deleted (deliberately identical).                     |
| `405`  | Method not allowed (`Allow: POST` on `/mcp`).                               |
| `406`  | `/mcp` `Accept` missing `application/json` or `text/event-stream`.          |
| `415`  | Cookie mutation without a JSON body.                                        |

Behind a proxy, preserve the public `Host`; the allowlist also accepts the
loopback API authority and MCP verification makes a loopback JWKS self-call.

## 7. Verification summary

Verified against a live local deployment with a real browser:

| Proven                                                                                  | Evidence                                                                                                        |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Full product loop (health, signup, PKCE, MCP tools, commit, read, share, links, delete) | `scripts/e2e-full-cycle.mjs`                                                                                    |
| OAuth, sessions, MCP transport and tools                                                | `bun run test:oauth`, `bun run test:auth`, `test/mcp-http.integration.ts`, `test/artifact-tools.integration.ts` |
| Library HTTP, shares, links and deletion                                                | `test/library-http.integration.ts`, `test/i5b*.test.ts`                                                         |
| Unit/UI suites without services                                                         | `bun run test`                                                                                                  |

`bun run test` runs every `*.test.ts`; integration suites self-skip without
services.
`bun run test:integration` loads the test config and runs `*.integration.ts`,
plus each `*.test.ts` that reads a variable from it, serially against the Docker
stack. A missing variable or a
skipped test fails that command, and the `integration` CI job runs it the same
way.
