---
title: Architecture overview
description: How Artiflow is built — one API, one database, a private bucket — and the boundaries, routes, data planes and security invariants a contributor must keep.
sidebar:
  order: 20
---

Artiflow is a self-hosted library where agents publish pages, Markdown documents, canvases and decks,
and people manage access from a browser. It is a **modular monolith**: one repository, one PostgreSQL
database, one API codebase, and two long-running containers in production plus a one-shot migrator.
There is deliberately no microservice split, no message broker and no external identity service.

This page is the map. [Module map](/docs/contributing/modules/) names the code that owns each part,
[Data model](/docs/contributing/data-model/) describes the tables, and
[Request flows](/docs/contributing/flows/) traces the important requests end to end.

## What the system does

Three jobs, in order of importance:

1. **Receive content from agents.** Agents authenticate with OAuth 2.1 and write through MCP. A
   payload arrives whole or in bounded chunks, and ends as an immutable revision.
2. **Deliver content safely.** Owners and granted recipients open a sandboxed viewer; public links serve
   the same bytes without a session.
3. **Let people manage it.** Sign in, list, share, publish links, edit, comment, restore versions and
   delete.

Artifact bytes never touch PostgreSQL. PostgreSQL holds metadata and permissions; object storage holds
the bytes.

## Consumers and the public boundary

Four kinds of client consume the same core: the dashboard, MCP hosts, harness plugins, and third-party
HTTP or SDK clients. The public application boundary is `/api/v1`: clients never import API internals
or reach its database or storage directly.

- `/api/v1` is bearer-only. It is a second protected resource of the same OAuth provider the MCP flow
  uses, and four scopes — `artifacts:read`, `artifacts:write`, `comments:write`, `shares:manage` — gate
  every request through one table (`apps/api/src/routes/v1/scopes.ts`).
- Bearer requests never fall back to a cookie session and skip the cookie CSRF guard; the dashboard
  keeps its cookie sessions.
- `@artiflow/sdk` is the typed client for that surface, with injectable fetch and token provider.
- Versioned errors carry `{ code, status, requestId }`. Unknown failures are sanitized `500` responses,
  never inferred conflicts, and an unknown artifact kind falls back to an inert representation, never
  executable HTML.

## Deployable units

| Unit           | Path               | Runtime                                | Responsibility                                                                |
| -------------- | ------------------ | -------------------------------------- | ----------------------------------------------------------------------------- |
| API            | `apps/api`         | Bun runs `apps/api/src/server.ts`      | HTTP surfaces, MCP, OAuth, collaboration socket, persistence, server viewers  |
| Dashboard      | `apps/dashboard`   | React SPA built by Vite                | Library, editors, auth and consent screens, account and administration pages  |
| Edge (prod)    | `docker/Caddyfile` | Caddy 2                                | TLS, static dashboard, reverse proxy to the API                               |
| Database       | external           | PostgreSQL 16                          | Identity, OAuth, settings, artifact metadata, shares, links, comments, drafts |
| Object storage | external           | S3-compatible (R2, S3, MinIO, Ceph, …) | Staging chunks, revision bodies and image assets                              |

In production `docker-compose.prod.yml` runs `migrate` (one-shot), `api` and `web` (Caddy plus the
built dashboard). Local development runs the API and the Vite dev server on the host, against the
same kind of external PostgreSQL and bucket. The documentation site in `apps/web` is a separate static
build and is not part of that stack.

## How a request travels

```text
Browser ───────────┐
MCP client ────────┼──▶  Edge (Vite proxy in dev, Caddy in prod)  ──▶  API (Bun + Hono)
SDK / plugin ──────┘          one public origin                          │
                                                                          ├─▶ PostgreSQL  (metadata, permissions)
                                                                          └─▶ S3 bucket   (bytes)
```

The dashboard only talks to the API on its own origin. In development the Vite proxy provides that
origin; in production Caddy does. Both proxy the same paths, and the two definitions
(`apps/dashboard/vite.config.ts` and `docker/Caddyfile`) must stay in sync.

| URL                                                      | Served by | Notes                                                         |
| -------------------------------------------------------- | --------- | ------------------------------------------------------------- |
| `/`, `/library`, `/edit/:id`, `/canvas/:id`, `/login`, … | Dashboard | TanStack Router (`apps/dashboard/src/router.tsx`)             |
| `/admin/*`                                               | Dashboard | Administration screens; every `/api/admin/*` route is guarded |
| `/artifact/:id`                                          | API       | Owner and recipient viewer, server-rendered                   |
| `/share/:token`                                          | API       | Session-free public viewer                                    |
| `/api/health`                                            | API       | PostgreSQL and storage probes                                 |
| `/api/auth/*`                                            | API       | Better Auth handler; cookie mutations are Origin-guarded      |
| `/api/collab`                                            | API       | WebSocket for live collaboration, session-authorized          |
| `/.well-known/oauth-*`                                   | API       | OAuth discovery                                               |
| `/mcp`                                                   | API       | Bearer-only MCP, `POST` only                                  |
| `/api/artifacts*`, `/api/account*`                       | API       | Cookie session                                                |
| `/api/v1/*`                                              | API       | Bearer only, scope-gated, no cookie fallback                  |

## Layering inside the API

```text
server.ts            config, pool, S3 client, listener, collaboration socket, GC loops, shutdown
└─ app.ts            createApiApp(deps): request id, sanitized onError, body limits, mount order
   ├─ routes/        HTTP-to-use-case translation (library, sharing, editing, scene, comments, admin, v1)
   ├─ mcp/           MCP mount and backend adapter; tool logic lives in packages/mcp-server
   ├─ viewer/        server-rendered viewer pages and the HTML comment bridge
   ├─ domain/        use cases: commits, commit flow, staging, documents, deletion, GC — no Hono
   └─ adapters/      postgres/ and storage/: the only modules that import pg or the AWS SDK
```

`app.ts` is pure composition and is what contract tests build with `app.fetch`; `server.ts` owns the
process edges. Dependencies are passed as option objects: there is no service locator and no global
state. Routes and MCP tools call the same operations, and sharing a use case never broadens access:
authorization differences between transports stay explicit.

## Data planes

- **Control plane: PostgreSQL.** Ownership, permissions, revision metadata, compare-and-set pointers,
  grants, public-link hashes, comments, document drafts and operations.
- **Data plane: object storage.** Chunk bytes under `staging/<sha256>`, revision bodies under
  `artifacts/<revision id>`, and raster images under `assets/<sha256>`. A revision key is generated
  before the write and never reused; it does not name the digest, so every read re-hashes the bytes
  and compares them with the revision row's `sha256`.
- **Transactions never span both.** A commit writes bytes first, then metadata. A storage failure
  leaves bytes no row names, and a daily sweep removes them once they are older than 24 hours.

## External dependencies

Everything that can be embedded is: authentication is a library (Better Auth), not a service. At
runtime the API depends on PostgreSQL, the bucket, optional Google, GitHub or OIDC providers for
sign-in, and its own JWKS, which it fetches over loopback (or `ARTIFLOW_INTERNAL_ORIGIN`) to verify
bearer tokens. The dashboard makes only same-origin calls: no analytics, no font CDN. Every variable
is listed in [Configuration](/docs/reference/configuration/).

| Dependency down     | Effect                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| PostgreSQL          | `/api/health` is `503`; sign-in, listings and MCP tools fail; the process stays up                |
| Object storage      | `/api/health` is `503`; commits and reads fail with typed errors; sign-in and metadata still work |
| A sign-in provider  | Only that sign-in path fails                                                                      |
| The JWKS self-fetch | MCP and `/api/v1` bearer verification fail; the dashboard is unaffected                           |

The API retries nothing beyond SDK defaults, buffers at most one bounded artifact in memory, and never
reports success after a storage failure.

## Security model

| Surface         | Identity                               | Guard                                                                                                   |
| --------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Browser API     | HttpOnly session cookie                | Exact `Origin` and a JSON body on every mutation; `SameSite=Lax`; `Secure` over HTTPS; no cookie cache  |
| MCP             | OAuth bearer JWT                       | Audience-bound token (`<origin>/mcp`), per-tool scope check, exact `Host`/`Origin` allowlist, no cookie |
| `/api/v1`       | OAuth bearer JWT                       | Audience-bound token (`<origin>/api/v1`), one scope per method and path                                 |
| OAuth protocol  | PKCE, dynamic registration             | `resource` required at authorize; dynamic registration grants nothing; consent is the human gate        |
| Artifact viewer | Session (owner or recipient) or a link | Permission predicate before any byte is read                                                            |
| Public link     | 32-byte random token                   | Only `sha256(token)` is stored; no expiry by design; rotation revokes the predecessor                   |
| Storage         | S3 credentials                         | Private bucket, no ACL or bucket policy, no public object URL                                           |

**Artifact bytes never execute on the application origin.** HTML is escaped into the `srcdoc` of an
iframe with `sandbox="allow-scripts"` and no `allow-same-origin`, so the frame's origin is opaque: its
requests carry no cookies and it cannot read the parent page. The viewer pages send a restrictive CSP
built from `default-src 'none'`, `base-uri 'none'` and `form-action 'none'`, with `connect-src 'self'`
for the viewer's own freshness poll; every variant is defined once in `apps/api/src/viewer/html.ts`.

Markdown is rendered by markdown-it with `html: false`, so raw HTML in a document is escaped, and link
schemes are validated before rendering. The shared and public Markdown pages render that sanitized
fragment directly in the page — not in a frame — so comment anchors can be measured precisely. The
same CSP applies: scripts are limited to the same-origin `viewer-comments` bundle and the inline
poller, and images to the application origin, which serves the bundled avatars. Author-written image
syntax can therefore make a signed-in reader's browser fetch a same-origin URL; those routes are
read-only GETs.

### The HTML comment bridge

Comment pins on an HTML artifact must sit on its elements, so the viewer injects a small inline bridge
into the `srcdoc` next to the artifact bytes, while the parent page keeps the margin and the threads.

| Direction      | Message              | Fields                                                   |
| -------------- | -------------------- | -------------------------------------------------------- |
| parent → frame | `pins`               | `{ id, number, selector, textHint, x, y, stale }[]`      |
| parent → frame | `mode`               | `{ on: boolean }`                                        |
| parent → frame | `focus`              | `{ id: string \| null }`                                 |
| frame → parent | `geometry`           | `{ id, x, y, visible }`, document-absolute               |
| frame → parent | `scroll`             | `{ y }`, the frame's `scrollY`                           |
| frame → parent | `pick`               | `{ selector, textHint, x, y, viewportWidth, viewportY }` |
| frame → parent | `pin-click`, `ready` | `{ id }` / `{}`                                          |

Every message carries `{ channel, version, nonce }`. Because the frame's origin is `null`, origin is
never used as identity: the parent requires `event.source === iframe.contentWindow`, the exact
per-render nonce, a strict shape check and a per-frame message budget, and silently drops anything
else. The bridge is safe because no comment body, author or quote ever crosses it, the frame can only
report geometry or a clicked element, and it adds no capability the artifact's own scripts lack.
Adding `allow-same-origin` to the sandbox would turn artifact markup into a credentialed same-origin
request channel, so that attribute must stay out.

## Design principles visible in the code

1. **Fail closed.** Ownership failures, shapes outside their caps and missing configuration refuse
   rather than guess. A foreign row is indistinguishable from a missing one.
2. **One source of truth per rule.** The read predicate, the viewer policy, the size caps and the
   migration guard are each defined once.
3. **Immutable history.** Revisions are appended, never rewritten; a restore appends a new revision.
4. **Verify bytes at the edges.** The server hashes what it receives and what it reads; client-declared
   digests are verified, never trusted.
5. **Bounded work.** Caps on artifact, chunk and asset size, a staging TTL, list limits and a small
   connection pool per process. The values are in [Limits](/docs/reference/limits/).

## Known architectural limits

These are documented trade-offs, not accidents.

| Limit                                                                                                        | Why it exists                                                                        |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| An access token is a 900-second JWT and cannot be revoked on its own; the refresh token is the revocable one | Stateless bearer verification. Deactivating an account revokes every token it holds. |
| Public links have no expiry                                                                                  | A 256-bit token is the credential; revocation and rotation are the controls.         |
| Soft-deleted artifacts keep their rows and revision metadata                                                 | Soft delete is the delivery gate; there is no purge job for artifacts yet.           |
| A crash between a staging put and its metadata insert leaves a key no sweep sees                             | The staging sweep is row-driven and does not list the bucket.                        |
| No cache, queue, background worker or distributed lock; the sweeps run in-process                            | Single-instance topology; the sweeps are idempotent.                                 |
| The API must reach its own JWKS over loopback, or through `ARTIFLOW_INTERNAL_ORIGIN`                         | MCP bearer verification fetches the issuer's keys from the running process.          |
