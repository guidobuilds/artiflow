# Artiflow

Artiflow is a private library for self-contained HTML artifacts and Markdown
documents created over MCP: agents write content through authenticated MCP tools,
and owners manage access (sharing, public links, deletion) from a browser
dashboard.

This repository runs the **application only**. PostgreSQL and S3-compatible
object storage are external services that you provide and operate; the
application never starts, creates, provisions or owns them. The one exception is
the disposable loopback test stack in `docker-compose.yml` (PostgreSQL +
Garage), which serves the integration suites and never touches real data.

## Requirements

- Bun `>=1.2` (verified on 1.3.10) — the only package manager and the API
  runtime, in development (`bun run dev`) and in production (the API image).
  `bun.lock` is the single lockfile; there is no `package-lock.json`.
- Node.js `>=24.0.0` (verified on v24.17.0) — the runtime for the Vite dev server,
  the repository scripts and the test runner (`node --test`; see
  [`CONTRIBUTING.md`](CONTRIBUTING.md) for why the suite stays on Node).
- A reachable **PostgreSQL 16** database and role.
- A private **S3-compatible bucket** and credentials (AWS S3, Cloudflare R2,
  MinIO, Ceph, or any compatible provider).
- Docker for the integration-test stack or the production images.

## Quick path

1. `bun install` — install the pinned workspace dependencies from `bun.lock`,
   including the OpenCode plugin workspace: its dependencies resolve from the
   root `node_modules`, so `test`, `typecheck` and `build` load
   `plugins/opencode/`. `bun run setup:plugin` runs the same install with
   `--frozen-lockfile`, as CI does.
2. `bun run setup:local` — create `.env.local` from `.env.example` (mode `0600`)
   and generate `ARTIFLOW_AUTH_SECRET`. If the file already exists, it is
   preserved and the secret is added only when missing. An older `.env.local`
   without the secret can also be fixed with `bun run setup:auth`.
3. Edit `.env.local` and point it at your services:
   - `DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DBNAME`
   - `ARTIFLOW_S3_ENDPOINT`, `ARTIFLOW_S3_BUCKET`,
     `ARTIFLOW_S3_ACCESS_KEY_ID`, `ARTIFLOW_S3_SECRET_ACCESS_KEY`
   - `ARTIFLOW_S3_REGION` and `ARTIFLOW_S3_FORCE_PATH_STYLE` when needed.
4. `bun run check:local` — runs `SELECT 1` and `HeadBucket` against the
   configured services. It never creates anything.
5. `bun run db:migrate` — apply the additive migrations to that database.
   Running it again is a no-op.
6. `bun run test` — test suite (no services required).
7. `bun run typecheck` — API and web TypeScript checks.
8. `bun run build` — Vite production build plus API type check.
9. `bun run dev`, then open <http://127.0.0.1:5173/>.
10. Create a local account in the browser (development loopback only), then
    follow `docs/runbook.md` to create artifacts over MCP and manage them.

Use that exact IPv4 address. `localhost` can resolve to an unrelated IPv6
listener on some machines and show a different application.

`bun run test:auth` and `bun run test:oauth` run real HTTP integration suites
against an isolated PostgreSQL database. Point `DATABASE_URL` at a disposable
database you control before running them.

## External services

### PostgreSQL

- Any PostgreSQL 16 server reachable from the API process.
- The URL must use `postgres://` or `postgresql://`.
- Add `?sslmode=require` (or `verify-full`) when the server requires TLS.
- `bun run db:migrate` refuses a non-loopback host unless
  `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1` is set explicitly. The production
  `migrate` container sets it because the managed database is the intended
  target.
- The app never creates roles or databases.

### S3-compatible object storage

- The bucket must already exist and stay private.
- The app never creates buckets, ACLs or bucket policies.
- Revision bytes use one key per revision (`artifacts/<revision id>`); staging bytes
  use `staging/<sha256>`.
- Use `ARTIFLOW_S3_FORCE_PATH_STYLE=1` for R2 and most non-AWS providers.
- `ARTIFLOW_S3_ENDPOINT` must be an absolute `http(s)` URL. Use HTTPS in
  production.

## Production deployment (VPS)

For the full self-hosted topology (dedicated subdomain, proxy Host
requirements, harness connection, cloud-agent prerequisites and a pre-flight
checklist) read [docs/deployment-guide.md](docs/deployment-guide.md).

The production stack is three containers: `migrate` (one-shot), `api`, and `web`
(Caddy serving the built frontend, reverse-proxying the API and terminating TLS).
PostgreSQL is an external managed database and object storage is an external
S3-compatible bucket (for example Cloudflare R2).

1. Point a DNS `A`/`AAAA` record for your domain at the VPS; open ports 80 and 443.
2. Install Docker and clone this repository on the VPS.
3. `cp env.prod.example .env.prod`, fill every value, `chmod 600 .env.prod`.
   Generate the auth secret with `openssl rand -hex 32`.
4. Make sure the external database and bucket exist, then fill the connection
   entries in `.env.prod`.
5. `bun run deploy:up` — builds both images, applies migrations to the external
   database (guarded by the explicit `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1` opt-in)
   and starts the stack. Caddy obtains and renews the TLS certificate.
6. `bun run deploy:logs` to watch, `bun run deploy:down` to stop. Upgrades are
   `git pull && bun run deploy:up` (migrations re-run as a no-op when applied).

## Local ports

| Port | Service        | Notes                                                     |
| ---- | -------------- | --------------------------------------------------------- |
| 5173 | UI (Vite)      | `http://127.0.0.1:5173/`, same-origin `/api` proxy        |
| 8787 | API (Bun/Hono) | `GET /api/health` reports the database and storage probes |

PostgreSQL and object storage listen wherever your provider exposes them; this
repository does not publish or manage those ports.

Approved stack: React/Vite/TypeScript, Bun/Hono, official MCP SDK, PostgreSQL with
Drizzle, private S3-compatible object storage and Better Auth. Google/GitHub
sign-in are optional per deployment; the local email/password form is
development-only.

## Auth and database foundation

The migration creates the Better Auth `user`, `session`, `account` and
`verification` tables plus the OAuth/JWT and artifact tables, and is tracked in
`drizzle.__drizzle_migrations`.

The API mounts the real Better Auth handler at `/api/auth/*` and serves a public,
uncached `GET /api/auth/capabilities` with exactly one boolean. The browser form appears
only when the server's own development guard enables email/password, so a production
build served by a development API still behaves correctly. Auth does not depend on S3,
so health can stay degraded while sessions still work.

### Sign in with a local account

- Signed out, the panel offers **Create account** (name, email, password) or **Sign in**.
- Signed in, it shows the real name and email from the session and a **Sign out** button.
- Passwords are throwaway values of at least 8 characters. No email is sent and no
  provider (Google, GitHub) is connected unless you configure one, so there are no
  social buttons by default.
- Nothing is written to browser storage: the HttpOnly cookie is carried by the browser
  and identity is re-read from `GET /api/auth/get-session` after every mutation.

Email/password is enabled in production, or in development when
`NODE_ENV=development`, `ARTIFLOW_DEMO_AUTH=1` and a loopback
`ARTIFLOW_PUBLIC_ORIGIN` all agree.
Base URL and trusted origin are fixed to that public origin, so the browser uses
the Vite `/api` proxy. Mutations require the exact `Origin` and JSON; session reads may
omit `Origin`. CSRF/origin checks, HttpOnly, `SameSite=Lax` and `Path=/` stay on,
cookie-cached sessions and telemetry stay off.

## Current checkpoint

- `bun run check:local` validates the configured PostgreSQL and S3 bucket
  (`SELECT 1` + `HeadBucket`).
- The API answers `GET /api/health` with HTTP 200 when both probes pass and 503
  when either external service is unavailable.
- `/api/auth/*` is mounted and the browser sign-in/sign-out flow works for
  development loopback. Public sign-up is closed: a new account comes only from
  `bun run user:invite EMAIL`, which prints a single-use `/register#token=…`
  link that opens a form with the email address fixed. Artifacts persist in the
  configured PostgreSQL + bucket;
  MCP tools are live at `/mcp` (bearer-only, OAuth 2.1 with PKCE and browser
  consent); the dashboard lists, views (sandboxed), shares, publishes links,
  edits markdown and deletes artifacts. Hosts that implement MCP Apps
  (SEP-1865) render committed artifacts inline through the
  `ui://artiflow/artifact-viewer` resource; text-only clients keep the
  plain JSON result.
- Known limits are documented honestly in `docs/runbook.md` (legacy non-UUID
  artifacts, no `/share` rate limiting, development-only cookies). Staged-chunk
  garbage is collected automatically every 15 minutes.
- The remaining local driver (`scripts/e2e-full-cycle.mjs`) is a manual probe
  against a running local stack, not a self-contained suite. It creates its
  throwaway accounts through that same command plus
  `POST /api/auth/registration/complete` and an ordinary sign-in
  (`scripts/fixture-accounts.mjs`), never through public sign-up. It therefore
  needs the API environment the operator command validates (`DATABASE_URL` and
  the `ARTIFLOW_S3_*` names), the same public origin, and `bun` on `PATH` or
  `ARTIFLOW_BUN`; because the `user:invite` alias runs `bun` itself, the helper
  also puts the selected executable's directory on the child `PATH`.

## Secrets

`setup:local` creates `.env.local` with mode `0600`, and the file is git-ignored.
It never prints values. Never commit, paste or replace generated values with
personal credentials. Service credentials belong in the external provider, not
in this repository.

## Documentation

The documentation site lives in [`apps/web`](apps/web/README.md) and targets
<https://artiflow.dev/docs>:

- [Quickstart](https://artiflow.dev/docs/start/quickstart/) — connect an agent,
  publish a first page, share it.
- [Install Artiflow](https://artiflow.dev/docs/self-hosting/installation/) and
  [Operate and upgrade](https://artiflow.dev/docs/self-hosting/operations/) —
  self-hosting, verification, upgrades, backups and restore.
- [Development setup](https://artiflow.dev/docs/contributing/development/) —
  toolchain, code layout, tests and how to add a page.

Repository-facing notes stay in `docs/` (start with
[`docs/architecture/README.md`](docs/architecture/README.md) and
[`docs/runbook.md`](docs/runbook.md)); [`CONTRIBUTING.md`](CONTRIBUTING.md) remains
the contribution entry point.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request: it covers
local setup, branch and commit conventions, the checks to run (tests, typecheck,
build), migrations and secrets.

## License

Artiflow is released under the [MIT License](LICENSE).

## Agent skills

`skills/` holds the canonical agent skills (`creating-artifacts`,
`using-artiflow`) that every harness integration installs or packages — see
[`skills/README.md`](skills/README.md) for the per-harness install matrix.

## Not implemented

- Dashboard upload routes: content is created through MCP only, by design.
- Production hardening: `/share` has no rate limiting. The
  `docker-compose.prod.yml` path exists but a fresh-machine production run has
  not been verified end to end.
- Local service provisioning for the application: PostgreSQL and object storage
  are external by design. The Compose stack is test-only.

## Next step

Read `docs/runbook.md`: it covers first run, the MCP tool flow (PKCE + consent +
bearer tokens), dashboard management (share by email, public links, double-confirm
deletion) and troubleshooting. The architecture docs start at
`docs/architecture/README.md`.
