# Artiflow

Artiflow is a self-hosted library for artifacts: self-contained HTML pages and Markdown documents
that agents write over MCP. Any agent, any model, your server — PostgreSQL holds the metadata, a
private S3-compatible bucket holds the bytes, and a browser dashboard handles access. Nothing is
published to a third-party service, and the dashboard never creates artifacts: agents write, people
decide who reads.

This repository runs the **application only**. PostgreSQL and S3-compatible object storage are
external services that you provide and operate; the application never starts, creates, provisions or
owns them. The one exception is the disposable loopback test stack in `docker-compose.yml`
(PostgreSQL + Garage), which serves the integration suites and never touches real data.

## How it works

- An agent connects to `/mcp` and publishes a page or a document. Every publish appends an immutable
  revision; nothing rewrites history in place.
- The owner opens the artifact in the dashboard, shares it with a person, or turns on a public link.
- The viewer re-checks ownership or an active grant on every request, and serves a page inside a
  sandboxed frame with a strict CSP.

| Who                  | How they get in                   | What they can do                                                      |
| -------------------- | --------------------------------- | --------------------------------------------------------------------- |
| Owner                | Signed-in session on the instance | Read, update through the agent, edit Markdown, comment, share, delete |
| Invited account      | Invitation from the owner         | Read only; the artifact appears under **Shared with me**              |
| Anyone with the link | Owner turns on a public link      | Read the current revision, no account needed                          |

## What you get

- **MCP server** at `/mcp`: bearer-only, OAuth 2.1 with PKCE and browser consent, thirteen tools for
  publishing, reading, renaming, line-editing and commenting.
- **Artifacts**: `html` (one self-contained page, inline CSS and JavaScript run sandboxed) and
  `markdown` (rendered by the viewer, editable in the browser, line-editable over MCP).
- **Revisions**: immutable, digest-verified on every read, restored by appending rather than
  rewriting, and refused when an update names a revision that has moved on.
- **Access**: named shares, revocable public links, embedding with `?embed=1`, and deletion.
- **Dashboard**: library, sandboxed viewer, sharing, public links, Markdown editor with autosave and
  history, comments.
- **HTTP API** at `/api/v1` with scoped bearer tokens, a typed TypeScript SDK, and an OpenCode plugin
  (`artiflow-opencode-plugin`) that wires the tools and skills into that host.
- **MCP Apps hosts** that implement SEP-1865 render committed artifacts inline through the
  `ui://artiflow/artifact-viewer` resource; text-only clients keep the plain JSON result.
- **Self-hosting**: Docker Compose production stack (API + Caddy), additive migrations, documented
  operations.

## Requirements

- Bun `>=1.2` (verified on 1.3.10) — the only package manager and the API runtime, in development
  (`bun run dev`) and in production (the API image). `bun.lock` is the single lockfile; there is no
  `package-lock.json`.
- Node.js `>=24.0.0` (verified on v24.17.0) — the runtime for the Vite dev server, the repository
  scripts and the test runner (`node --test`; see [`CONTRIBUTING.md`](CONTRIBUTING.md) for why the
  suite stays on Node).
- A reachable **PostgreSQL 16** database and role.
- A private **S3-compatible bucket** and credentials (AWS S3, Cloudflare R2, MinIO, Ceph, or any
  compatible provider).
- Docker for the integration-test stack or the production images.

## Quick path

1. `bun install` — install the pinned workspace dependencies from `bun.lock`, including the OpenCode
   plugin workspace: its dependencies resolve from the root `node_modules`, so `test`, `typecheck`
   and `build` load `plugins/opencode/`. `bun run setup:plugin` runs the same install with
   `--frozen-lockfile`, as CI does.
2. `bun run setup:local` — create `.env.local` from `.env.example` (mode `0600`) and generate
   `ARTIFLOW_AUTH_SECRET`. If the file already exists, it is preserved and the secret is added only
   when missing. An older `.env.local` without the secret can also be fixed with `bun run setup:auth`.
3. Edit `.env.local` and point it at your services:
   - `DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DBNAME`
   - `ARTIFLOW_S3_ENDPOINT`, `ARTIFLOW_S3_BUCKET`, `ARTIFLOW_S3_ACCESS_KEY_ID`,
     `ARTIFLOW_S3_SECRET_ACCESS_KEY`
   - `ARTIFLOW_S3_REGION` and `ARTIFLOW_S3_FORCE_PATH_STYLE` when needed.
4. `bun run check:local` — runs `SELECT 1` and `HeadBucket` against the configured services. It never
   creates anything.
5. `bun run db:migrate` — apply the additive migrations to that database. Running it again is a no-op.
6. `bun run test` — test suite (no services required).
7. `bun run typecheck` — API and web TypeScript checks.
8. `bun run build` — Vite production build plus API type check.
9. `bun run dev`, then open <http://127.0.0.1:5173/>.
10. Create a local account in the browser (development loopback only), then follow
    `docs/runbook.md` to create artifacts over MCP and manage them.

Use that exact IPv4 address. `localhost` can resolve to an unrelated IPv6 listener on some machines
and show a different application.

`bun run test:auth` and `bun run test:oauth` run real HTTP integration suites against an isolated
PostgreSQL database. Point `DATABASE_URL` at a disposable database you control before running them.

## External services

### PostgreSQL

- Any PostgreSQL 16 server reachable from the API process.
- The URL must use `postgres://` or `postgresql://`.
- Add `?sslmode=require` (or `verify-full`) when the server requires TLS.
- `bun run db:migrate` refuses a non-loopback host unless `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1` is set
  explicitly. The production `migrate` container sets it because the managed database is the intended
  target.
- The app never creates roles or databases.

### S3-compatible object storage

- The bucket must already exist and stay private.
- The app never creates buckets, ACLs or bucket policies.
- Revision bytes use one key per revision (`artifacts/<revision id>`); staging bytes use
  `staging/<sha256>`.
- Use `ARTIFLOW_S3_FORCE_PATH_STYLE=1` for R2 and most non-AWS providers.
- `ARTIFLOW_S3_ENDPOINT` must be an absolute `http(s)` URL. Use HTTPS in production.

## Production deployment (VPS)

For the full self-hosted topology (dedicated subdomain, proxy Host requirements, harness connection,
cloud-agent prerequisites and a pre-flight checklist) read
[docs/deployment-guide.md](docs/deployment-guide.md).

The production stack is three containers: `migrate` (one-shot), `api`, and `web` (Caddy serving the
built frontend, reverse-proxying the API and terminating TLS). PostgreSQL and object storage are
external services you operate.

1. Point a DNS `A`/`AAAA` record for your domain at the VPS; open ports 80 and 443.
2. Install Docker and clone this repository on the VPS.
3. `cp env.prod.example .env.prod`, fill every value, `chmod 600 .env.prod`. Generate the auth secret
   with `openssl rand -hex 32`.
4. Make sure the external database and bucket exist, then fill the connection entries in `.env.prod`.
5. `bun run deploy:up` — builds both images, applies migrations to the external database (guarded by
   the explicit `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1` opt-in) and starts the stack. Caddy obtains and
   renews the TLS certificate.
6. `bun run deploy:logs` to watch, `bun run deploy:down` to stop. Upgrades are
   `git pull && bun run deploy:up` (migrations re-run as a no-op when applied).

## Local ports

| Port | Service        | Notes                                                     |
| ---- | -------------- | --------------------------------------------------------- |
| 5173 | UI (Vite)      | `http://127.0.0.1:5173/`, same-origin `/api` proxy        |
| 8787 | API (Bun/Hono) | `GET /api/health` reports the database and storage probes |

PostgreSQL and object storage listen wherever your provider exposes them; this repository does not
publish or manage those ports.

Stack: React/Vite/TypeScript, Bun/Hono, the official MCP SDK, PostgreSQL with Drizzle, private
S3-compatible object storage and Better Auth. Google/GitHub sign-in are optional per deployment; the
local email/password form is development-only.

## Accounts and access

Public sign-up is closed. A new account comes from `bun run user:invite EMAIL`, which prints a
single-use `/register#token=…` link that opens a form with the email address fixed. There is no email
provider: the operator delivers the link out of band, and also issues password resets with
`bun run user:reset-password EMAIL`.

The API mounts the real Better Auth handler at `/api/auth/*` and serves a public, uncached
`GET /api/auth/capabilities` reporting whether email/password, public registration and social
providers are enabled, so the browser only offers the forms the server actually supports. Base URL
and trusted origin are fixed to `ARTIFLOW_PUBLIC_ORIGIN`,
so the browser uses the same-origin `/api` proxy. Mutations require the exact `Origin` and JSON;
session reads may omit `Origin`. CSRF/origin checks, HttpOnly, `SameSite=Lax` and `Path=/` stay on,
cookie-cached sessions and telemetry stay off.

MCP clients authenticate with OAuth 2.1 (PKCE, browser consent) or a scoped bearer token from the
dashboard. Both are enforced per tool: `artifacts:write` covers the mutating tools, `artifacts:read`
covers reads.

## Limits

The enforced caps are documented from the running code in
[`apps/web/src/content/docs/docs/reference/limits.md`](apps/web/src/content/docs/docs/reference/limits.md):
16 MiB per artifact, 1 MiB per `artifact_write` call, 1 MiB per staged chunk, 60 minutes per staged
upload, and the per-surface request body caps.

Not available today: Canvas and other artifact kinds, dashboard upload of new content (agents write
only, by design), browser editing or commenting by invited accounts (they read), and rate limiting on
`/share`.

## Documentation

The documentation site lives in [`apps/web`](apps/web/README.md) and targets <https://artiflow.dev>:

- [Quickstart](https://artiflow.dev/docs/start/quickstart/) — connect an agent, publish a first page,
  share it.
- [Connect an agent](https://artiflow.dev/docs/connect/mcp/) — the `/mcp` endpoint, OAuth and client
  configurations.
- [Artifacts and revisions](https://artiflow.dev/docs/concepts/artifacts/) — kinds, access model,
  URLs, limits.
- [Install](https://artiflow.dev/docs/self-hosting/installation/) and
  [operate](https://artiflow.dev/docs/self-hosting/operations/) — self-hosting, verification,
  upgrades, backups and restore.
- [Development setup](https://artiflow.dev/docs/contributing/development/) — toolchain, code layout,
  tests and how to add a page.

Repository-facing notes stay in `docs/` (start with
[`docs/architecture/README.md`](docs/architecture/README.md) and
[`docs/runbook.md`](docs/runbook.md)); [`CONTRIBUTING.md`](CONTRIBUTING.md) remains the contribution
entry point.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request: it covers local setup, branch
and commit conventions, the checks to run (tests, typecheck, build), migrations and secrets.

## Agent skills

`skills/` holds the canonical agent skills (`creating-artifacts`, `using-artiflow`) that every harness
integration installs or packages — see [`skills/README.md`](skills/README.md) for the per-harness
install matrix.

## License

Artiflow is released under the [MIT License](LICENSE).
