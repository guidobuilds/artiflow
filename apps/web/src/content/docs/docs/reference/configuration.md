---
title: Configuration
description: Every environment variable an Artiflow instance reads, its default, its validation rule, and what changing the public origin affects.
sidebar:
  order: 2
---

The API process reads its configuration from the environment once, at startup, and validates every
value before it opens a listener. A missing or invalid value stops the process with a message naming
the **variable**, never echoing the value it rejected.

Two repository scripts manage that file locally:

```sh
bun run setup:local    # create .env.local from the tracked template, mode 0600, with a generated auth secret
bun run check:local    # confirm the configured PostgreSQL and S3-compatible endpoints are reachable
```

`setup:local` preserves an existing `.env.local`, refuses a secret shorter than 32 characters instead of
silently replacing it, and never prints a secret. Neither script provisions PostgreSQL or object
storage: the operator supplies both.

## API process variables

These are read by `apps/api/src` (`config.ts` and the scripts it shares).

| Variable                                                                | Required | Default                   | Rule                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                                              | no       | `development`             | `development`, `production` or `test`                                                                                                                                                                                                                                                |
| `DATABASE_URL`                                                          | **yes**  | —                         | `postgres://` or `postgresql://` connection string                                                                                                                                                                                                                                   |
| `ARTIFLOW_AUTH_SECRET`                                                  | **yes**  | —                         | At least 32 characters; keep it stable across restarts or every session is invalidated                                                                                                                                                                                               |
| `ARTIFLOW_SECRET_ENCRYPTION_KEY`                                        | no       | —                         | 32 bytes as base64 (`openssl rand -base64 32`). Protects the credentials the administration surface stores; without it, saving a credential is refused instead of stored unprotected, and keep it stable because a stored credential encrypted under another key cannot be decrypted |
| `ARTIFLOW_S3_ENDPOINT`                                                  | **yes**  | —                         | Absolute `http(s)` URL of the S3-compatible endpoint                                                                                                                                                                                                                                 |
| `ARTIFLOW_S3_BUCKET`                                                    | **yes**  | —                         | Lowercase `[a-z0-9.-]`, 3–63 characters, starting and ending alphanumeric; must already exist and stay private                                                                                                                                                                       |
| `ARTIFLOW_S3_ACCESS_KEY_ID`                                             | **yes**  | —                         | Access key for the private bucket                                                                                                                                                                                                                                                    |
| `ARTIFLOW_S3_SECRET_ACCESS_KEY`                                         | **yes**  | —                         | Secret for the same key                                                                                                                                                                                                                                                              |
| `ARTIFLOW_S3_REGION`                                                    | no       | `us-east-1`               | Any region string your provider expects (`auto` on R2)                                                                                                                                                                                                                               |
| `ARTIFLOW_S3_FORCE_PATH_STYLE`                                          | no       | derived                   | `1` (path style), `0` (virtual-host) or unset: path style when the endpoint host is loopback, virtual-host otherwise                                                                                                                                                                 |
| `ARTIFLOW_PUBLIC_ORIGIN`                                                | no       | `http://127.0.0.1:5173`   | Absolute `http(s)` origin with no path, query or fragment                                                                                                                                                                                                                            |
| `ARTIFLOW_API_HOST`                                                     | no       | `127.0.0.1`               | `127.0.0.1` or `0.0.0.0` only                                                                                                                                                                                                                                                        |
| `ARTIFLOW_API_PORT`                                                     | no       | `8787`                    | Integer 1–65535                                                                                                                                                                                                                                                                      |
| `ARTIFLOW_INTERNAL_ORIGIN`                                              | no       | `http://127.0.0.1:<port>` | Bare `http(s)` origin the process uses to fetch its own JWKS; derived on loopback even when the API binds `0.0.0.0`, so set it behind a sidecar or remapped port                                                                                                                     |
| `ARTIFLOW_ALLOWED_HOSTS`                                                | no       | empty                     | Comma-separated `host[:port]` authorities, no scheme, path or wildcard                                                                                                                                                                                                               |
| `ARTIFLOW_DEMO_AUTH`                                                    | no       | off                       | `1` enables the local demo login; startup fails unless `NODE_ENV=development` **and** the public origin is loopback                                                                                                                                                                  |
| `ARTIFLOW_AUTH_GITHUB_CLIENT_ID` / `ARTIFLOW_AUTH_GITHUB_CLIENT_SECRET` | no       | not configured            | Both or neither: a half-set pair fails startup. Read once, on the first boot of an instance with no stored access configuration                                                                                                                                                      |
| `ARTIFLOW_AUTH_GOOGLE_CLIENT_ID` / `ARTIFLOW_AUTH_GOOGLE_CLIENT_SECRET` | no       | not configured            | Both or neither: a half-set pair fails startup. Read once, on the first boot of an instance with no stored access configuration                                                                                                                                                      |

The four required storage values plus `DATABASE_URL` are reported together when missing, so one run
lists every gap. Errors mention names only: no password, bucket key or credential ever reaches a log or
a response body.

## What the public origin decides

`ARTIFLOW_PUBLIC_ORIGIN` is the single source for every absolute URL the instance publishes:

| Derived value         | Form                                                   |
| --------------------- | ------------------------------------------------------ |
| OAuth issuer          | `<origin>/api/auth`                                    |
| MCP resource          | `<origin>/mcp`                                         |
| API v1 resource       | `<origin>/api/v1`                                      |
| Public link URL       | `<origin>/share/<token>`                               |
| Well-known documents  | `<origin>/.well-known/…`                               |
| Cookie-mutation guard | The exact `Origin` every dashboard mutation must carry |

Changing it re-points discovery, the JWT issuer and every resource identifier at once. Clients
registered and tokens issued under the previous origin stop matching, so treat a change of origin as a
deployment step: re-register clients and re-authenticate them afterwards. Use a bare origin — a value
with a path or query is rejected at startup rather than half-working later.

`ARTIFLOW_ALLOWED_HOSTS` exists for the one case the derived set cannot cover: a proxy that sends a
`Host` header the public origin does not match. The MCP transport compares the raw `Host` header by
string equality, and the trusted set is:

1. the public origin's host and port,
2. every entry in `ARTIFLOW_ALLOWED_HOSTS`,
3. the loopback API authority (`127.0.0.1:8787` by default) — **outside production only**.

## Login availability

Which methods the sign-in page offers is stored configuration, and one deployment gate sits above it:

| Question                                 | Answered by                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Does password authentication exist here? | `NODE_ENV`, never a stored setting: production, or development with the demo login on a loopback origin |
| Is password sign-in offered?             | The stored access document, and the gate above                                                          |
| Are Google and GitHub offered?           | The stored access document                                                                              |
| Is the enterprise connection offered?    | The stored connection document                                                                          |

In production password authentication exists, so an existing account can sign in with it unless an
administrator has switched the method off on `/admin/access`. The stored configuration cannot open a
profile that has no password authentication, so the switch only ever narrows.

The Google and GitHub pairs above are a first-boot seed, not a live switch. On an instance with no
stored access configuration the first start writes them to the database and records that provenance;
after that the variables are never read again, a variable that stays set changes nothing and produces
one warning naming it, and providers are managed on `/admin/access`. A half-set pair still fails
startup, because the configuration parser reads it before the seed decides anything. See
[Administer accounts and sign-in](/docs/self-hosting/administration/#existing-installations-and-the-environment).

Public account creation stays closed in every profile: registration is `false` in
`GET /api/auth/capabilities`, and accounts come only from an operator-issued invitation
(`bun run user:invite EMAIL`) or from just-in-time provisioning through the enterprise connection. The
invitation link opens its own fixed-email form and does not change that flag.

The browser reads the live answer from `GET /api/auth/capabilities` instead of guessing: `emailPassword`
reports whether password sign-in is offered, `socialProviders` lists the enabled providers,
`registration` carries account-creation availability, and an `sso` object appears while the enterprise
connection is published, with the label that connection shows. The sign-in page, the enterprise
connection and the password policy are documented on [Identity providers](/docs/self-hosting/identity-providers/)
and [Administer accounts and sign-in](/docs/self-hosting/administration/).

## Tooling and deployment variables

These are read by repository scripts, the container definitions or the viewer itself, not by the API
configuration:

| Variable                         | Read by                               | Default                 | Purpose                                                                                  |
| -------------------------------- | ------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `ARTIFLOW_DEV_RUNTIME`           | `scripts/dev.mjs`                     | `bun`                   | Runtime for the API in development; `node` is the declared fallback                      |
| `ARTIFLOW_API_PROXY_TARGET`      | `apps/dashboard/vite.config.ts`       | `http://127.0.0.1:8787` | API upstream for the Vite dev server proxy                                               |
| `ARTIFLOW_ALLOW_REMOTE_MIGRATE`  | migration script                      | off                     | `1` is required to migrate a non-loopback database; a loopback target needs nothing      |
| `ARTIFLOW_VERSION`               | `docker-compose.prod.yml` services    | none (**required**)     | Release tag without the leading `v`; pins both GHCR images                               |
| `ARTIFLOW_PROD_ENV_FILE`         | `docker-compose.prod.yml`             | `.env.prod`             | Which env file the production stack loads                                                |
| `ARTIFLOW_SITE_ADDRESS`          | `docker-compose.prod.yml` web service | none (**required**)     | Public DNS name Caddy serves with TLS; `:80` for a smoke test without DNS                |
| `ARTIFLOW_DASHBOARD_DIST`        | `apps/api/src/viewer/assets.ts`       | `apps/dashboard/dist`   | Directory the API reads `.vite/manifest.json` from, to find the viewer's browser bundles |
| `ARTIFLOW_VIEWER_COMMENTS_ASSET` | `apps/api/src/viewer/assets.ts`       | unset                   | Serve this one script URL as the comments bundle; the manifest is not read               |
| `ARTIFLOW_VIEWER_ACTIONS_ASSET`  | `apps/api/src/viewer/assets.ts`       | unset                   | Serve this one script URL as the owner's management bundle; the manifest is not read     |

Nothing here fails a page. When the manifest names no comment bundle, the viewer logs `[viewer] no
comment bundle in <path>; production serves the viewer without comments` and serves the page anyway:
the comments column mounts with no script to fill it, so no thread appears. The same miss for the
management entry logs `... without management` and omits the owner's **Actions** menu entirely. In
development the miss falls back to the Vite dev entries (`/src/viewer-comments.tsx`,
`/src/viewer-actions.tsx`) instead, and `ARTIFLOW_REQUIRE_ASSETS=1` forces the production behaviour. An
explicit comments or actions asset is used as-is, with no stylesheet and no manifest read.

The production compose file also sets `SITE_ADDRESS` and `API_UPSTREAM` for its own web container, and
sets `NODE_ENV=production` plus `ARTIFLOW_API_HOST=0.0.0.0` for the API container. Those three are
compose-owned: do not duplicate them in your env file.

The local integration stack (`docker-compose.yml`, PostgreSQL plus a Garage bucket) ships fixed
credentials that are only ever valid on loopback. They are for the repository's integration tests, not a
starting point for a deployment.

## Secret handling

- `.env.local` is created mode `0600` and is not committed. The tracked template is the only committed
  shape.
- The production env file is `.env.prod` by default: keep it mode `0600` and out of version control.
- Generate `ARTIFLOW_AUTH_SECRET` with `openssl rand -hex 32` (or let `bun run setup:local` generate it).
- A public-link token is not configuration: it is generated per link, shown once, and stored only as a
  SHA-256 hash. See [Share and publish](/docs/guides/sharing/).

## Deliberately not configurable

The following are fixed in code, so no variable exists for them — do not expect to tune them from the
environment:

- OAuth client registration: dynamic registration is on for public clients, and the API v1 resource is
  opt-in per client, never auto-linked.
- Public account creation: sign-up is closed in every profile, and no variable re-enables it. See
  [Install Artiflow](/docs/self-hosting/installation/) for the current sign-in behavior.
- The administrator role and the access configuration: no variable grants the role or enables a method.
  The console grants the role; `/admin/access` decides the methods.
- Session lifetime: seven days with a one-day activity refresh, fixed in code. There is no variable and
  no administration setting for it.
- A purge, a password policy or a stored credential: none of them has a variable.
- Rate limits and request/body caps (see [Limits](/docs/reference/limits/)).
- CORS and browser origins: the single trusted origin is `ARTIFLOW_PUBLIC_ORIGIN`.
- The `/docs` and `/mcp` paths.
