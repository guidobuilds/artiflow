---
title: Install Artiflow
description: Run Artiflow on a dedicated hostname, with externally managed PostgreSQL and private S3-compatible storage, then verify the instance before connecting an agent.
sidebar:
  order: 8
---

Artiflow is self-hosted: one organization runs one instance on one public origin, with its own
database and bucket. This page covers both supported shapes, the local development instance and the
production stack on a VPS, and ends with the checks that prove an instance is ready.

## What you provide

The application never creates, provisions or owns PostgreSQL or object storage. Both are external
services with credentials you supply.

| Requirement                               | Why                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Dedicated hostname                        | Artiflow owns the whole origin: the dashboard, `/mcp`, `/api`, discovery and viewer routes share it.    |
| DNS record + ports 80/443                 | Caddy obtains and renews the TLS certificate over ACME and serves all traffic on 443.                   |
| PostgreSQL 16                             | Metadata: users, sessions, artifacts, revisions, grants, links and comments.                            |
| Private S3-compatible bucket              | Artifact bytes, one object per revision under `artifacts/<revision id>`. The bucket must already exist. |
| Docker + Compose v2                       | Only for the production containers and the disposable integration-test stack.                           |
| Bun `>=1.2` (verified on 1.3.10)          | Package manager, repository scripts and the API runtime.                                                |
| Node.js `>=24.0.0` (verified on v24.17.0) | The Vite dev server, repository scripts and the `node --test` runner.                                   |

Use a hostname such as `artifacts.example.com`, not a path prefix. `ARTIFLOW_PUBLIC_ORIGIN` must be a
bare origin; mounting the application under `example.com/artiflow/` is not supported, because the
OAuth issuer and every viewer URL derive from that origin. Agents paste the origin plus `/mcp`:

```text
https://artifacts.example.com/mcp
```

## Local instance

Local development uses the same external services. The Vite dev server listens on `5173` and proxies
`/api`, `/mcp`, `/.well-known`, `/share` and `/artifact` to the API on `8787`.

```sh
bun install           # pinned workspace dependencies from bun.lock
bun run setup:local   # creates .env.local (mode 0600) and the auth secret
# edit .env.local: DATABASE_URL and ARTIFLOW_S3_*
bun run check:local   # SELECT 1 and HeadBucket; creates nothing
bun run db:migrate    # additive migrations, safe to re-run
bun run dev
```

Open <http://127.0.0.1:5173/>. Use that exact IPv4 address: on some machines `localhost` resolves to an
unrelated IPv6 listener.

The local demo profile — in-browser account creation and the demo sign-in — exists only in
development: `NODE_ENV=development`, `ARTIFLOW_DEMO_AUTH=1` and a loopback `ARTIFLOW_PUBLIC_ORIGIN`
must all agree, and any other combination is refused at startup. Do not carry that profile to a
server. Production still signs in with email/password, but only for accounts created through
invitations.

## Production instance

`docker-compose.prod.yml` runs three containers:

| Service   | Role                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `migrate` | One-shot: applies Drizzle migrations to the external database, then exits successfully.              |
| `api`     | Bun/Hono API plus MCP. No published ports; only the web container reaches it on the private network. |
| `web`     | Caddy 2: the only public ports (80/443), TLS, static dashboard, reverse proxy to `api`.              |

PostgreSQL and the bucket stay outside the stack, so the containers hold no application state.

1. Point an `A`/`AAAA` record for the hostname at the server and open ports 80 and 443.
2. Install Docker with Compose v2, then clone this repository on the server.
3. Create the environment file and keep it private:

   ```sh
   cp env.prod.example .env.prod
   chmod 600 .env.prod
   openssl rand -hex 32   # use the output as ARTIFLOW_AUTH_SECRET
   ```

4. Fill every value in `.env.prod`:

   | Variable                        | Value                                                                                            |
   | ------------------------------- | ------------------------------------------------------------------------------------------------ |
   | `ARTIFLOW_SITE_ADDRESS`         | Public hostname for Caddy, e.g. `artifacts.example.com`; use `:80` for a DNS-less smoke test.    |
   | `ARTIFLOW_PUBLIC_ORIGIN`        | `https://` plus that hostname, with no trailing path.                                            |
   | `ARTIFLOW_AUTH_SECRET`          | At least 32 characters; the value printed by `openssl rand -hex 32`.                             |
   | `DATABASE_URL`                  | `postgres://` URL of the external database, with `?sslmode=require` when the server demands TLS. |
   | `ARTIFLOW_S3_ENDPOINT`          | Absolute `http(s)` URL of the storage provider.                                                  |
   | `ARTIFLOW_S3_BUCKET`            | Existing private bucket, lowercase, 3–63 characters.                                             |
   | `ARTIFLOW_S3_ACCESS_KEY_ID`     | Credential with access to that bucket.                                                           |
   | `ARTIFLOW_S3_SECRET_ACCESS_KEY` | Matching secret.                                                                                 |
   | `ARTIFLOW_S3_REGION`            | Provider region; `auto` for Cloudflare R2.                                                       |
   | `ARTIFLOW_S3_FORCE_PATH_STYLE`  | `1` for R2 and most non-AWS providers, `0` for virtual-host style.                               |

   Optional entries in the same file: `ARTIFLOW_ALLOWED_HOSTS` (extra `host[:port]` authorities the
   MCP endpoint trusts), `ARTIFLOW_INTERNAL_ORIGIN` (origin the API uses for its own JWKS fetch), and
   a complete `ARTIFLOW_AUTH_GITHUB_*` or `ARTIFLOW_AUTH_GOOGLE_*` pair. The pair is adopted on the
   first boot of an instance with no stored access configuration; after that the variables are
   ignored and the providers are managed on `/admin/access`. Add a credential pair before the first
   start, or from the interface afterwards. `ARTIFLOW_PROD_ENV_FILE` selects a different env file name
   instead of `.env.prod`.

5. Deploy:

   ```sh
   bun run deploy:up      # build images, migrate, start the stack
   bun run deploy:logs    # follow container logs
   bun run deploy:down    # stop the containers and the stack network
   ```

`deploy:up` runs the migration container with `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1`, the explicit opt-in
that lets migrations target the externally managed database. The API starts only after that container
exits successfully. Invalid configuration fails startup and names the variable, never its value.

### Proxy and Host headers

TLS and the reverse proxy are Caddy's job, and Caddy passes the original `Host` through. This matters:
the MCP transport's DNS-rebinding guard trusts only the public origin host, the loopback API authority
(outside production) and any `ARTIFLOW_ALLOWED_HOSTS` entries. Browser origins stay restricted to
`ARTIFLOW_PUBLIC_ORIGIN`. If you put another proxy in front and it rewrites `Host`, declare the
authority it sends or `/mcp` answers `403`.

## Verify the instance

```sh
curl -sS https://artifacts.example.com/api/health
# {"status":"ok","checks":{"database":"ok","storage":"ok"}}
```

`/api/health` is `200` only when both probes pass (`SELECT 1` and `HeadBucket`) and `503` with
`"status":"degraded"` when one is unavailable. The body reports statuses only, never connection
details.

Discovery is public and needs no session:

```sh
curl -sS https://artifacts.example.com/.well-known/oauth-protected-resource
curl -sS https://artifacts.example.com/.well-known/oauth-authorization-server/api/auth
```

An unauthenticated MCP request must answer `401` with a `WWW-Authenticate` bearer challenge that
points back at the resource metadata; a client then registers itself and completes consent in the
browser:

```sh
curl -sS -o /dev/null -D - -X POST https://artifacts.example.com/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

Finally [connect an agent](/docs/connect/mcp/) to `https://artifacts.example.com/mcp`, approve the
consent screen, and publish one artifact with [the quickstart](/docs/start/quickstart/).

## Sign-in on a self-hosted instance

Password authentication exists in production, so an existing account can sign in without an external
identity provider. What the sign-in page offers is stored configuration, though: an administrator can
switch the password method off, add Google or GitHub, and publish a single enterprise connection. See
[Administer accounts and sign-in](/docs/self-hosting/administration/#access-methods) and
[Identity providers](/docs/self-hosting/identity-providers/).

Public account creation is closed in every profile: the API refuses
`POST /api/auth/sign-up/email`, and a configured social provider will not create a new account,
while signing in to an existing account — email/password or a linked social account — keeps
working. The dashboard also stops offering its "Create an account" entry, but the refusal does not
depend on it.

A new account comes only from an invitation the operator issues with
`bun run user:invite person@example.com`. That command prints a single-use URL, valid for 24 hours,
that opens a form with the email address fixed; the person chooses a name and password, and then signs
in with the normal password form. Only a SHA-256 digest of the invitation token is stored, no email is
sent, and possession of the link is not treated as mailbox proof. See
[operate and upgrade](/docs/self-hosting/operations/#invitation-only-registration) for the exact
invocations and refusal rules. No social provider creates an account on its own: a configured provider
only signs in to an existing linked account. Rotating `ARTIFLOW_AUTH_SECRET` invalidates existing
sessions and tokens; see [operate and upgrade](/docs/self-hosting/operations/).

Changing `ARTIFLOW_PUBLIC_ORIGIN` moves the OAuth issuer and every resource identifier. Clients
registered and tokens issued under the previous origin stop matching, so re-register and
re-authenticate each harness after the change.

## Scope of what is verified

The production compose file, images and reverse-proxy contract exist in the repository, but a
fresh-machine production bootstrap was **not** run end to end while this page was written. Treat the
first deployment as a rehearsal against a disposable database and bucket, verify the checks above,
and only then point the real hostname and data at it.

The docs site is not part of that stack: `deploy:up` builds the API and the dashboard. Building the
documentation is a separate static output (`bun run web:build`), with no server runtime and no
requirement on the instance database.

## Next

[Operate and upgrade](/docs/self-hosting/operations/) covers health, upgrades, backups and restore.
