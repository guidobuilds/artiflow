---
title: Operate and upgrade
description: Health checks, upgrades, backups and restore for a self-hosted Artiflow instance whose PostgreSQL and object storage are managed outside the stack.
sidebar:
  order: 9
---

Operating Artiflow is mostly operating two external services. The containers are stateless, PostgreSQL
holds every record, and the private bucket holds every byte. This page covers the routine work:
checking health, applying a release, backing up and restoring, and rotating the signing secret.

## Health and logs

```sh
curl -sS https://artifacts.example.com/api/health
bun run deploy:logs
```

`/api/health` returns `200` with `{"status":"ok","checks":{"database":"ok","storage":"ok"}}` when the
database probe and the bucket probe both pass, and `503` with `"status":"degraded"` when either fails.
It is uncached, reports statuses only, and is the right endpoint for an uptime check. The stack's API
container runs the same probe as its Docker healthcheck every 30 seconds.

The API log includes a staging sweep line every 15 minutes:

```text
[staging-gc] expiredUploads=N candidates=M deleted=K failed=F
```

`failed` above zero means staging objects could not be deleted; check bucket permissions and storage
availability. The sweep only deletes `staging/<sha256>` objects no open or unexpired upload needs.

A second sweep runs once a day, about a minute after start, and logs:

```text
[revision-gc] examined=N candidates=M deleted=K failed=F listFailed=true|false
```

It removes an `artifacts/<revision id>` object only when no revision row names it and the bucket
reports it older than 24 hours, so a commit that has written bytes but not yet its metadata row is
never raced. Each run examines at most 2,000 keys in pages of 200 and keeps no cursor, and it never
touches the database. `listFailed=true` means a listing page could not be read, so the run stopped
early and retried nothing: check bucket permissions and storage availability.

A third sweep applies the same bounds to image assets once a day, about 90 seconds after start:

```text
[asset-gc] examined=N candidates=M deleted=K failed=F kept=K listFailed=true|false
```

It removes an `assets/<sha256>` object older than 24 hours that no artifact references, together with
its row; `kept` counts objects that gained a reference while the sweep ran.

None of the sweeps collects the bytes of a soft-deleted artifact whose best-effort delete was refused:
the kept revision rows still name those keys. The staging sweep is driven by upload rows, so a staging
object whose row was never written (a crash between the put and the insert) is not collected either.

Administration writes one JSON object per line to standard output, and the console commands that print
a link write theirs to standard error so standard output stays the link alone. The event set is closed
in code, every line carries no credential, token, link or request body, and the events are described
for operators in
[Administer accounts and sign-in](/docs/self-hosting/administration/#the-administration-log). Every
command's output, exit status and refusals are in
[Console commands](/docs/reference/console-commands/). Nothing
writes these lines to a file: retention is whatever your container logging keeps.

## Invitation-only registration

Public self-service sign-up is closed, so an account is created only from an invitation the operator
issues. The command runs wherever the API configuration is available; in the production stack that is
the `api` service:

```sh
bun run user:invite person@example.com
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api bun run user:invite person@example.com
```

It prints exactly one URL and nothing else. Hand that URL to the person directly; do not post it in a
shared channel. The link is single use, expires 24 hours after it is issued, and opens a registration
form whose email address is fixed. Only a SHA-256 digest of the token is stored, so a database read
never yields a usable link. The command's syntax, exit status and every refusal are in
[Console commands](/docs/reference/console-commands/).

The URL looks like `https://artifacts.example.com/register#token=…`, and the token travels in the
fragment: the page reads it there and sends it to the API in the request body, so it never appears in a
query string or a server access log. Opening the page only previews the invitation — a load consumes
nothing — and the form shows the fixed email as read-only, asking for a name and a password and
nothing else. Completing it creates the account and the page then signs in through the normal password
login and lands on the library. If the account is created but that automatic sign-in fails, the page
shows the created confirmation with a link to the sign-in form instead of retrying the consumed
invitation; every later attempt with the same link is refused.

Possession of the link is not proof of the mailbox, so the created account keeps
`emailVerified: false`, no email is sent, and there is no SMTP setup or admin panel anywhere in the
flow. Accounts created this way sign in exactly like any other password account.

The command refuses an address that already belongs to an account, exits with status `1` and writes one
line to stderr. It never resets a password and changes no other account. A malformed address, a missing
or extra argument, and any `--force`-style flag are refused the same way. No email is sent: delivering
the link is the operator's job.

It reads the same environment as the API, including the `ARTIFLOW_S3_*` variables that startup
requires, so run it where that environment exists rather than exporting a partial set by hand.

## Password reset

There is no automatic recovery and no public "forgot password" page: an existing account holder gets a
new password only from a link the operator issues. The command runs wherever the API configuration is
available; in the production stack that is the `api` service:

```sh
bun run user:reset-password person@example.com
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api bun run user:reset-password person@example.com
```

It prints exactly one URL and nothing else. Hand that URL to the person out-of-band, exactly as an
invitation is delivered; no email is sent. The link is single use, expires 1 hour after it is issued,
and issuing a new link invalidates the earlier links still pending for that account. Only a SHA-256
digest of the token is stored, so a database read never yields a usable link.

The URL looks like `https://artifacts.example.com/reset-password#token=…`, and the token travels in the
fragment: the page reads it there and sends it to the API in the request body, so it never appears in a
query string or a server access log. Opening the page only previews the link — a load consumes
nothing — and the form shows the account's email as read-only, asking for a new password and its
confirmation under the same password policy as the rest of the application. Completing it changes the
password, invalidates every session that account had open, and shows a confirmation with a link to the
sign-in form. The person is not signed in automatically.

An expired, already used, replaced, tampered or incomplete link all show one generic refusal that asks
for a new link, so the page never reveals which of those happened. The command never creates an account
and never changes a password by itself; an address no account uses is refused with status `1` and one
line on stderr, and a malformed address, a missing or extra argument, and any flag are refused the same
way. Without a valid link there is no way to start the change from the web.

## Upgrades

Migrations are additive and idempotent, and there are no down migrations. The `migrate` container
applies whatever is pending and exits; the API starts only after it succeeds. The migrator is
Drizzle's, the SQL is in `drizzle/`, and applied migrations are tracked in
`drizzle.__drizzle_migrations`.

The migrator refuses any database whose host is not loopback unless `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1`
is set, and opens no connection when it refuses; `deploy:up` sets it for the `migrate` container.
Set it by hand only when the configured database is the one you mean to migrate. There is no shadow
database and no automatic backup before migrating, and a rolling deploy where the previous API keeps
serving during a migration has not been tested.

```sh
git pull
bun run deploy:up
curl -sS https://artifacts.example.com/api/health
```

Re-running `deploy:up` on an unchanged release is a no-op for the database. For a local instance the
same step is `bun run db:migrate`. Run the upgrade against a staging instance, or at least against a
disposable copy of the database and bucket, before applying it to the instance people depend on.

## Backups: you own them

Artiflow has no backup command, no retention policy and no scheduled export. Both backing services are
external and their backup tools are the supported path:

| Data           | Where                        | What to back up                                           |
| -------------- | ---------------------------- | --------------------------------------------------------- |
| Metadata       | External PostgreSQL 16       | Provider snapshots or `pg_dump` of the instance database. |
| Artifact bytes | Private S3-compatible bucket | Every object, versioning or provider replication.         |

Bytes are stored per revision: each revision has one object under `artifacts/<revision id>`, and
identical bytes stored twice occupy two objects. Staging objects under `staging/<sha256>` are
transient and are garbage collected, so they are not a backup source.

Take the database snapshot and the bucket snapshot close together. A database restored to a point
before the bucket contents (or the reverse) references revisions whose bytes are missing, and those
artifacts stop opening even though their metadata exists. Keep bucket backups private; a public copy
defeats the access model.

## Restore

Restore into a new, empty database and bucket instead of overwriting the live pair, then verify before
switching traffic:

1. Provision the replacement database and bucket, and restore both snapshots into them.
2. Keep the bucket private and give the API credentials that only reach it.
3. Point `.env.prod` at the restored pair and run `bun run deploy:up`, so pending migrations apply.
4. Check `/api/health`, open one HTML artifact, one Markdown document and one public share link.
5. Switch DNS or the proxy only when those checks pass.

`bun run deploy:down` stops and removes the containers and the stack network; the database and bucket
are untouched because they live outside the stack. Never point the integration suites at restored or
production data: `test:integration`, `test:auth` and `test:oauth` write to the services they are given.

## Secrets

- `ARTIFLOW_AUTH_SECRET` is at least 32 characters and signs sessions and tokens. Rotating it means
  sessions and refresh tokens issued under the old value stop verifying, so plan for everyone to sign
  in again. `bun run setup:local` and `bun run setup:auth` manage the local file; production keeps the
  value in `.env.prod` (mode `0600`).
- `ARTIFLOW_SECRET_ENCRYPTION_KEY` protects the client secrets stored from the interface. Without it a
  credential cannot be saved; with a different one, a stored credential cannot be decrypted, the
  provider or connection it belongs to stops being offered and the credential has to be re-entered.
  Keep it stable and in the same backup as the database.
- Social providers are optional and the environment is only a seed: the pairs are adopted on the first
  boot of an instance with no stored access configuration, and are ignored afterwards. A half-configured
  pair still fails startup naming the variables. Manage providers on `/admin/access`.
- `.env.prod` is never committed. `bun run setup:local` refuses to read or modify an env file it does
  not own, and the API's configuration errors name variables, never values.

## Shutdown and capacity

On `SIGINT` or `SIGTERM` the API closes its collaboration rooms, stops accepting connections, stops the
sweeps, closes the database pool and exits `0`. There is no timeout on closing open connections, so a
stuck client can delay a restart.

- One API process holds at most 4 PostgreSQL connections, shared by requests and the sweeps.
- The library lists at most 100 owned and 200 shared artifacts, and history at most 200 revisions;
  there is no pagination.
- The API does not compress responses; Caddy's `encode` covers the dashboard and the proxied paths.
- There is no metrics endpoint, no access log in the API or in Caddy, and no trace export: the sweep
  lines, startup lines and the administration events are the log.

## Known limits

- There is no rate limiting on `/share`, and public links never expire. Rotate or revoke a link from
  the dashboard when it should stop working.
- Access tokens are 900-second JWTs. One cannot be revoked in isolation, but deactivating an account
  revokes every token issued to it and both bearer surfaces refuse it from the next request.
- There is no built-in monitoring, alerting or metrics endpoint. The structured administration lines
  are the audit record, and they are as durable as your process logging.
- The production stack does not publish the documentation site, and a fresh-machine production
  bootstrap has not been verified end to end.

## Troubleshooting

| Symptom                                            | Check                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/api/health` is `503`                             | Database and bucket probes; credentials, TLS, bucket name and endpoint reachability.                                            |
| `403` from `/mcp` while the URL works in a browser | The proxy sends a `Host` the origin does not cover. Preserve `Host` or add it to `ARTIFLOW_ALLOWED_HOSTS`.                      |
| `401` on every MCP call                            | Sign-in never completed, or the client discarded its token; re-run the client's login.                                          |
| MCP verification fails although the token is fresh | The API cannot reach its own JWKS over loopback; set `ARTIFLOW_INTERNAL_ORIGIN`.                                                |
| `403` or `415` on a dashboard action               | The page origin must equal `ARTIFLOW_PUBLIC_ORIGIN`, and mutations need `content-type: application/json`.                       |
| `db:migrate` refuses                               | The database is not on loopback; set `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1` only if it is the database you mean.                     |
| `502` from Caddy                                   | The API is not ready yet; check its healthcheck and `bun run deploy:logs`.                                                      |
| MCP client fails after the origin changed          | `ARTIFLOW_PUBLIC_ORIGIN` moved the issuer; re-register the client and authenticate it again.                                    |
| Certificate never issues                           | Ports 80/443 reachable, DNS already pointing at the server, `ARTIFLOW_SITE_ADDRESS` correct.                                    |
| Containers exit after a config change              | Startup names the invalid variable; compare `.env.prod` with the table in [Install Artiflow](/docs/self-hosting/installation/). |

## Next

If the instance is healthy but an agent cannot publish, continue with
[Connect an agent](/docs/connect/mcp/) and [Share and publish](/docs/guides/sharing/). For people
rather than agents, continue with [Administer accounts and sign-in](/docs/self-hosting/administration/),
[Identity providers](/docs/self-hosting/identity-providers/) and
[Recover access and remove a person](/docs/self-hosting/recovery/).
