# Operations

This document is the bridge between the architecture and the
[user runbook](../runbook.md). It covers configuration, deployment, health,
migrations, backups and known operational limits.

## 1. Topologies

### Host development loop

```
host:  bun run dev
       ├─ API  127.0.0.1:8787   (bun apps/api/src/server.ts)
       └─ UI   127.0.0.1:5173   (vite, proxies /api,/mcp,/.well-known,/share,/artifact)

external:
  PostgreSQL       host/port/database you control
  S3-compatible    endpoint/bucket you control
```

Requirements: Bun ≥ 1.2 (verified on 1.3.10) as the API runtime (development and
the production image) and the package manager, Node ≥ 24 (verified on 24.17) for
the Vite dev server, the repository scripts and the test runner, an external
PostgreSQL 16 database, and an external private S3-compatible bucket.

```sh
bun install             # pinned workspace dependencies from bun.lock
bun run setup:local     # .env.local from .env.example + ARTIFLOW_AUTH_SECRET
# edit .env.local: DATABASE_URL and ARTIFLOW_S3_*
bun run check:local     # SELECT 1 + HeadBucket, creates nothing
bun run db:migrate
bun run dev
```

`setup:local` never starts, creates or provisions services. `check:local` is the
only preflight and reports database and storage separately.

### Production

```
Internet ── Caddy (web container, 80/443)
              ├─ static SPA from /srv
              └─ reverse proxy /api,/mcp,/.well-known,/share,/artifact → api:8787
api ── external PostgreSQL (DATABASE_URL)
    └─ external S3-compatible bucket (private)
migrate ── runs once before api starts
```

The `api` and `migrate` containers run Bun (`oven/bun:1.3.10`, `bun
apps/api/src/server.ts`); the `web` build stage builds the Vite bundle with Bun and
Caddy serves the static output. No Node runtime ships in either image.

Steps:

1. DNS `A`/`AAAA` for the domain; open 80/443.
2. Install Docker; clone the repo.
3. `cp env.prod.example .env.prod`; fill every value; `chmod 600`.
4. Make sure the external database and bucket already exist.
5. `bun run deploy:up` (builds images, runs migrations with
   `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1`, starts the stack; Caddy obtains TLS).
6. Upgrades: `git pull && bun run deploy:up`.

## 2. Health and readiness

`GET /api/health`

| Result                                                          | Meaning                                         |
| --------------------------------------------------------------- | ----------------------------------------------- |
| `200 {"status":"ok","checks":{"database":"ok","storage":"ok"}}` | Ready                                           |
| `503 {"status":"degraded", …}`                                  | PostgreSQL `SELECT 1` or S3 `HeadBucket` failed |

Responses are `no-store` and contain no connection details. The production API
container uses it as its healthcheck. There is no separate liveness/readiness
pair, no metrics endpoint and no synthetic check.

## 3. Migrations

- Engine: Drizzle migrator, forward-only SQL in `drizzle/`, tracked in
  `drizzle.__drizzle_migrations`.
- Development command: `bun run db:migrate` (`apps/api/src/adapters/postgres/db/migrate.ts`).
- Production: the one-shot `migrate` container runs before the API starts, with
  `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1`.
- Safety guard: `assertMigrationTarget` allows any loopback PostgreSQL URL and
  refuses a non-loopback host unless `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1` is set.
  It does not hardcode a port or database name.
- No down migrations, no shadow database, no automatic backup before migrating.
- Migrations are additive in practice (new tables, indexes and CHECKs); a rolling
  deploy where the old API still serves during a migration has not been tested.

## 4. Garbage collection

Two in-process sweeps share one discipline: one sweep at a time, unref'd timers, a
crash logged and absorbed, and per-key failure isolation.

- Staging GC: first sweep after 15 s, then every 15 min. It is **row-driven**: a
  staging object whose metadata insert never happened is invisible and leaks (known
  limit, tracked separately).
  Log line: `[staging-gc] expiredUploads=N candidates=M deleted=K failed=F`.
- Revision-orphan GC: first sweep after 60 s, then once a day. It lists `artifacts/`
  only and removes an object only when no `artifactRevisions` row names it **and** the
  provider's `LastModified` is older than 24 h, so a commit that wrote bytes but not
  yet its revision row is never raced. Each run examines at most 2,000 keys in pages of
  200; that is a bound, not a persisted cursor. It never writes, updates or deletes a
  row.
  Log line: `[revision-gc] examined=N candidates=M deleted=K failed=F listFailed=true|false`.
- Neither sweep collects the bytes of a soft-deleted artifact whose best-effort delete
  was refused: the retained revision rows still name those keys.

## 5. Shutdown

On `SIGINT`/`SIGTERM` the API stops accepting connections, stops both GC sweeps, closes
the pool and destroys the S3 client. The process exits with code 0. There is no
timeout on `server.close()` and no `unhandledRejection`/`uncaughtException`
handler; a stuck connection can delay shutdown.

## 6. Logging and observability

Current state:

- Startup lines and auth-mode line on stdout (`[api] …`).
- Config failures print a redacted reason and exit 1.
- GC summary once per sweep.
- Better Auth logging disabled; no access log; no request id; no metrics or traces.
- Caddy has no access log configured.

This is sufficient for a single-node self-hosted deployment but not for
production incident response.

## 7. Backups and recovery

Artiflow has two stateful dependencies:

| State                        | Location   | Backup responsibility                          |
| ---------------------------- | ---------- | ---------------------------------------------- |
| Metadata, users, permissions | PostgreSQL | Operator / managed provider (PITR recommended) |
| Artifact and staging bytes   | S3 bucket  | Operator / provider versioning                 |

There is no built-in export or backup command. Two consistency notes:

- Metadata and bytes can be restored independently only with care: a revision row
  without its object is unreadable (`artifact_unavailable`), and an object without
  a row is harmless but counts as garbage.
- A revision key is generated per revision and no longer names the digest, so a
  database restored over newer bytes cannot silently serve another revision's content:
  every read re-hashes the bytes and compares them with the `sha256` on the revision
  row, and a mismatch answers `500 artifact_unavailable`.
- Soft-deleted artifacts remain in the database; restoring a backup can resurrect
  visibility. There is no purge job today.

A recovery drill should verify: restore PostgreSQL, restore the bucket, run health,
open one artifact, run a read and a commit.

## 8. Security operations

- **Secrets:** `.env.local` / `.env.prod`, mode `0600`, git-ignored. Setup scripts
  never print values. Config errors name variables only.
- **Rotation:** changing `ARTIFLOW_AUTH_SECRET` invalidates sessions; changing
  `ARTIFLOW_PUBLIC_ORIGIN` invalidates registered OAuth clients and issued tokens
  (issuer, resource and discovery all move). This is a documented deployment step.
- **Exposure:** the API has no published port in production; only Caddy reaches it.
- **Bucket:** private by default; no public ACL is requested.

## 9. Troubleshooting matrix

| Symptom                           | Likely cause                         | Check                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API exits at boot                 | missing/invalid env                  | the `[api] configuration error` line names the variable                                                                                                                                                                                                                                  |
| `/api/health` 503, database error | PostgreSQL down/unreachable          | `SELECT 1`, `DATABASE_URL`, network                                                                                                                                                                                                                                                      |
| `/api/health` 503, storage error  | bucket missing or credentials wrong  | `HeadBucket`, endpoint, forcePathStyle                                                                                                                                                                                                                                                   |
| `/mcp` 401                        | no/expired bearer token              | discovery metadata, token audience, clock                                                                                                                                                                                                                                                |
| `/mcp` 403                        | foreign `Host`/`Origin`              | the endpoint trusts the public origin host always, the loopback API authority only outside production, and any `ARTIFLOW_ALLOWED_HOSTS` entries; a proxy that rewrites `Host` needs that variable, and a JWKS the process cannot reach through loopback needs `ARTIFLOW_INTERNAL_ORIGIN` |
| 403 on a browser mutation         | wrong/missing `Origin`               | page origin must equal `ARTIFLOW_PUBLIC_ORIGIN`                                                                                                                                                                                                                                          |
| 415 on a browser mutation         | no JSON content type                 | send `content-type: application/json`                                                                                                                                                                                                                                                    |
| 404 everywhere                    | soft-deleted, foreign or non-UUID id | expected: one uniform refusal                                                                                                                                                                                                                                                            |
| commit `digest_mismatch`          | declared digest ≠ assembled bytes    | recompute over decoded bytes                                                                                                                                                                                                                                                             |
| commit `concurrent_commit`        | stale `expectedRevisionId`           | retry with the returned pointer                                                                                                                                                                                                                                                          |
| `db:migrate` refuses              | non-loopback target without opt-in   | set `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1` only if that is the intended database                                                                                                                                                                                                              |
| 502 from Caddy                    | API not ready                        | API healthcheck and `depends_on`                                                                                                                                                                                                                                                         |
| staging objects accumulate        | GC row-driven or storage failures    | GC log line, `failed` count                                                                                                                                                                                                                                                              |

## 10. Capacity notes

- One API process holds at most 4 PostgreSQL connections.
- The staging GC and HTTP requests share that pool.
- Artifact cap 16 MiB, chunk cap 1 MiB, so a maximum upload is 16 chunks.
- Library reads are capped at 100 owned / 200 shared; there is no pagination.
- Revision history reads are capped at 200.
- No response compression at the API (Caddy `encode` handles the SPA/proxy path).
