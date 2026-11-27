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
2. Install Docker with Compose v2; the host needs no checkout and no toolchain.
3. Download `docker-compose.prod.yml` and `env.prod.example` from the release tag as
   `.env.prod`; fill every value; `chmod 600`.
4. Make sure the external database and bucket already exist.
5. `ARTIFLOW_VERSION` (the tag without the leading `v`, e.g. `0.4.1`) pins the
   `ghcr.io/guidobuilds/artiflow-api` and `ghcr.io/guidobuilds/artiflow-web`
   images; `docker compose --env-file .env.prod -f docker-compose.prod.yml pull`
   then `… up -d` pulls them, runs migrations with
   `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1` and starts the stack; Caddy obtains TLS.
6. Upgrades: bump `ARTIFLOW_VERSION`, `pull`, `up -d`; a rollback is the previous
   version. CI builds the images from semver tags — nothing is built on the host.

## 2. Health and readiness

`GET /api/health`

| Result                                                          | Meaning                                         |
| --------------------------------------------------------------- | ----------------------------------------------- |
| `200 {"status":"ok","checks":{"database":"ok","storage":"ok"}}` | Ready                                           |
| `503 {"status":"degraded", …}`                                  | PostgreSQL `SELECT 1` or S3 `HeadBucket` failed |

Responses are `no-store` and contain no connection details. The production API
container uses it as its healthcheck. There is no separate liveness/readiness
pair, no metrics endpoint and no synthetic check.

`GET /api/version`

| Result                                       | Meaning                                     |
| -------------------------------------------- | ------------------------------------------- |
| `200 {"version":"0.4.1","revision":"<sha>"}` | Release tag and git revision baked at build |

Also `no-store`, and built from `ARTIFLOW_BUILD_VERSION` / `ARTIFLOW_BUILD_REVISION`,
which the release build passes as arguments (`dev` / `unknown` outside a release
image). It is how an operator confirms that the running containers match the pinned
`ARTIFLOW_VERSION`.

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
- Because an image rollback is the supported recovery, migrations must stay
  expand/contract: release N-1 has to keep running on the schema release N
  migrated, so a column or table the previous version reads is removed only in a
  later release.

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
- Structured administration lines: one JSON object per line on stdout for each operation of
  section 12 of [authentication and access](authentication-and-access.md#12-structured-logging-d12)
  — role changes, sign-up, edits, activation, session closing, invitation and reset issuance,
  access and SSO configuration, password policy, purge, and every use of the emergency fallback.
  The shape is closed: no password, token, link, secret or request body ever appears in it,
  `user.updated` carries the address a person moved from and to, and a refused fallback names no
  address at all. The console commands that print a link write their line to stderr instead.
- Better Auth logging disabled; no access log; no metrics or traces.
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
- **Stored credentials:** `ARTIFLOW_SECRET_ENCRYPTION_KEY` protects the client secrets saved from the
  interface. A credential encrypted under another key cannot be decrypted, so the provider or the
  connection it belongs to stops being offered and the credential has to be re-entered; there is no
  rotation command, so keep the key stable and in the same backup as the database.
- **Access configuration:** the social provider pairs are read once, on the first boot of an instance
  with no stored access configuration, and ignored afterwards. Providers, the password policy and the
  enterprise connection change in the administration area, not in the environment.
- **Provider registration:** `/admin/access` shows the JavaScript origin to authorise and one redirect
  URI per social provider, each with a copy action, all derived from `ARTIFLOW_PUBLIC_ORIGIN`. Nothing
  there is derived by hand, and none of it carries a client id or a credential. Because the addresses
  follow that variable, changing it means re-registering both callbacks at Google and GitHub in the same
  deployment step — and an administrator has to reopen the page after the change, since the addresses it
  shows are the configured origin of the process serving it.
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

## 10. Console operator commands

Run from the repository root with the API's environment loaded — `DATABASE_URL` and the
`ARTIFLOW_S3_*` values are required by every command, as they are by the API process — in the same
`bun run <name>` style as the deployment scripts. They print to stdout and exit non-zero on refusal,
with the reason on stderr. What each command does, and what it refuses, is written for operators in
[Recover access and remove a person](https://artiflow.dev/docs/self-hosting/recovery/) and
[Administer accounts and sign-in](https://artiflow.dev/docs/self-hosting/administration/); the
syntax, exit statuses and every refusal of each one are in
[Console commands](https://artiflow.dev/docs/reference/console-commands/). The
behaviour itself is defined in section 13 of
[authentication and access](authentication-and-access.md#13-operations-d13).

| Command                                | Purpose                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `admin:grant EMAIL`                    | Make an existing account an administrator (first administrator, recovery) |
| `admin:revoke EMAIL`                   | Return an administrator to the member role                                |
| `admin:list`                           | Print one email per administrator, sorted; empty and exit 0 when none     |
| `user:invite EMAIL`                    | Print one single-use registration URL                                     |
| `user:reset-password EMAIL`            | Print one single-use password reset URL                                   |
| `user:purge EMAIL --reassign-to EMAIL` | Delete an account, handing its content to another existing account        |
| `user:purge EMAIL --delete-content`    | Delete an account together with its content                               |
| `user:deactivate EMAIL`                | Cut the access of an account without deleting anything                    |
| `user:activate EMAIL`                  | Clear the deactivated state of an account                                 |

`admin:grant` never creates an account: an unknown address is refused and the
message names `user:invite`, because only the invitation path lets the person
choose a password. Nothing protects the last administrator, so an instance can
be left with none and recovered with `admin:grant`. Each role change writes one
structured event line with `actorRole: "console"` and `outcome: "applied"`; the
event shape carries no secret, token or link, and `admin:list` records nothing.

`user:deactivate` and `user:activate` call the same lifecycle functions as
`POST /api/admin/users/:id/status`, so the console applies the whole transaction of
section 9: the status, the deletion of the account's sessions, the revocation of the
tokens issued to it and the revocation of the public links of the artifacts it owns,
with one `user.deactivated` line; activation clears the status with one
`user.reactivated` line and restores neither sessions nor links. Both refuse an
unknown address and a transition to the state the account already holds, with one
line on stderr and exit status 1, changing nothing and recording nothing. Nothing on
either path deletes content: the artifacts, revisions, comments and share grants keep
their rows, and `user:purge` is the only console operation that removes a person.

`user:purge` takes the address and exactly one content choice, and asks for the
address to be typed again unless `--yes` is passed. It refuses an unknown
address, an unknown reassignment target, the account itself as its own target,
neither or both content choices, and an unconfirmed or mismatched confirmation,
with the reason on stderr and exit status 1. It removes the account row, its
identities, sessions, issued tokens, pending invitation and reset links and the
share grants it held as a recipient. With `--reassign-to` the artifacts and their
revisions, public links, comments and grants follow the target, and the comments
and grants the person wrote on other people's artifacts keep working under the
target as their author and issuer; with `--delete-content` the artifacts go with
their comments, links and grants, and the comments the person wrote elsewhere and
the grants they issued there go with them. The purge writes one `user.purged`
line and is never reachable from the interface.

## 11. Capacity notes

- One API process holds at most 4 PostgreSQL connections.
- The staging GC and HTTP requests share that pool.
- Artifact cap 16 MiB, chunk cap 1 MiB, so a maximum upload is 16 chunks.
- Library reads are capped at 100 owned / 200 shared; there is no pagination.
- Revision history reads are capped at 200.
- No response compression at the API (Caddy `encode` handles the SPA/proxy path).
