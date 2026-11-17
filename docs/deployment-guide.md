# Self-hosted deployment guide

How an organization publishes its own Artiflow instance so that every harness
— local MCP clients and cloud agents — can connect to it. This guide is the
operational companion of [harness-plugins.md](architecture/harness-plugins.md)
(§4, deployment model).

The model: **one organization = one instance = one public origin**. There is no
multitenancy in the code and none is needed; isolation between organizations is
isolation between deployments (own database, own bucket, own OAuth issuer).

## 1. Topology: a dedicated subdomain

Publish the instance on a **dedicated subdomain**, e.g.:

```
https://artifacts.acme.com        ← public origin
  /mcp          ← MCP endpoint (Streamable HTTP, bearer-only)
  /api/*        ← HTTP API + Better Auth
  /.well-known/*← OAuth discovery (RFC 9728)
  /share/*      ← public link viewer
  /artifact/*   ← owner/recipient viewer
  /             ← dashboard SPA
```

Path prefixes are **not supported on purpose** (`ARTIFLOW_PUBLIC_ORIGIN` is a
bare origin and the OAuth issuer derives from it). Do not mount Artiflow under
`acme.com/artiflow/`; give it the whole subdomain. The subdomain is also what
makes harness configuration a single pasteable URL.

DNS: one `A`/`AAAA`/`CNAME` record for the subdomain pointing at the host (or
load balancer) that runs the `web` container (Caddy). TLS is automatic:
`ARTIFLOW_SITE_ADDRESS=artifacts.acme.com` makes Caddy obtain and renew an
ACME certificate. Ports 80 and 443 must be reachable from the internet for the
ACME challenge and for traffic.

## 2. What runs where

Production runs three containers (`docker-compose.prod.yml`):

| Service         | Publishes                          | Notes                                                                           |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| `web` (Caddy 2) | **80/443 — the only public ports** | TLS, static SPA, reverse proxy to the API                                       |
| `api`           | nothing (internal network)         | Bun 1.3.10 (`bun apps/api/src/server.ts`); reaches Postgres/S3 over the network |
| `migrate`       | nothing                            | One-shot, applies Drizzle migrations at deploy (Bun)                            |

External, provisioned by you **before** the first deploy:

- **PostgreSQL 16** — managed service or self-run. `DATABASE_URL` with
  `sslmode=require` when the server demands TLS. Migrating a remote database
  requires `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1` (the migration guard refuses
  anything that does not look like the owned local database unless you set it).
- **S3-compatible bucket, private** — AWS S3, Cloudflare R2, MinIO, Ceph.
  `ARTIFLOW_S3_FORCE_PATH_STYLE=1` for R2 and most non-AWS providers. The app
  never creates the bucket and never requests ACLs or public object URLs.

Secrets live in the compose env file (`ARTIFLOW_PROD_ENV_FILE`, default
`.env.prod`, mode 0600, never committed). See `env.prod.example` for the full
contract; invalid values fail startup naming the variable only.

### Deployment profiles

The repository runs in three profiles. Only the last one is a public deployment.

| Profile           | Entry point                | Transport                                               | Sign-in                                                     |
| ----------------- | -------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| Local development | `bun run dev`              | `http://127.0.0.1:5173`                                 | Demo email/password, including in-browser account creation  |
| Integration tests | `bun run test:integration` | Disposable loopback Compose stack (PostgreSQL + Garage) | Not used                                                    |
| Production        | `bun run deploy:up`        | `https://artifacts.<org>.com` through Caddy             | Email/password for invited accounts; GitHub/Google optional |

What changes between the local and the production profile:

| Setting                  | Local development          | Production                                                    |
| ------------------------ | -------------------------- | ------------------------------------------------------------- |
| `NODE_ENV`               | `development`              | `production`                                                  |
| `ARTIFLOW_PUBLIC_ORIGIN` | `http://127.0.0.1:5173`    | `https://artifacts.<org>.com`                                 |
| `ARTIFLOW_SITE_ADDRESS`  | not set                    | The public hostname; Caddy obtains and renews the certificate |
| `ARTIFLOW_DEMO_AUTH`     | `1`                        | unset; startup rejects it outside development                 |
| Cookies                  | not `Secure`               | `Secure`, `HttpOnly`, `SameSite=Lax`                          |
| Database TLS             | usually off                | `?sslmode=require` (or `verify-full`)                         |
| S3 endpoint              | `http` allowed on loopback | `https` required                                              |
| Migrations               | loopback target allowed    | `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1` for the one-shot `migrate`  |
| Environment file         | `.env.local`               | `.env.prod`, selected with `ARTIFLOW_PROD_ENV_FILE`           |

The full variable contract, including `ARTIFLOW_ALLOWED_HOSTS`,
`ARTIFLOW_INTERNAL_ORIGIN` and the optional social providers, is in the
[configuration reference](../apps/web/src/content/docs/docs/reference/configuration.md).

### Sign-in per deployment

Public registration is closed in every profile: `POST /api/auth/sign-up/email`
is refused, and a configured social provider signs in an existing account but
never creates one. The operator creates accounts with
`bun run user:invite person@example.com`, and the invited person sets a password
when redeeming the link. Email/password sign-in is therefore required by the
invitation flow and cannot be disabled today; an SSO-only instance depends on
the instance-admin settings work, not on a flag in this repository.

The local demo profile is the exception: `ARTIFLOW_DEMO_AUTH=1` plus a loopback
origin allows in-browser account creation. Any other `NODE_ENV` or a
non-loopback origin is refused at startup.

## 3. Proxy requirements (read before pointing a domain)

The MCP transport's **DNS-rebinding guard is the only Host/Origin protection**
on `/mcp`. Two consequences for any reverse proxy in front:

1. **Preserve `Host` by default.** Caddy's `reverse_proxy` passes the original
   public Host (`artifacts.acme.com`). If your proxy sends a Host the public
   origin does not cover, declare it in `ARTIFLOW_ALLOWED_HOSTS` (comma-separated
   `host[:port]` authorities) or MCP calls get a 403.
2. **Keep the trust set explicit.** The MCP endpoint always trusts the host of
   `ARTIFLOW_PUBLIC_ORIGIN`, adds the loopback API `host:port` authority only
   outside production, and trusts any `ARTIFLOW_ALLOWED_HOSTS` entries. Browser
   origins remain restricted to `ARTIFLOW_PUBLIC_ORIGIN`.

MCP bearer verification fetches `/api/auth/jwks` from
`ARTIFLOW_INTERNAL_ORIGIN` when set; otherwise it uses
`http://127.0.0.1:<port>` with the configured API port. Set the override when
loopback HTTP is unavailable (for example, behind a strict sidecar policy).

## 4. Connecting harnesses (one URL, discovery does the rest)

Users configure **one URL** per harness; everything else is discovered from
`/.well-known/oauth-protected-resource` (RFC 9728). No per-harness credentials
to create by hand: MCP clients register themselves (RFC 7591 DCR) and the user
consents in the browser.

| Harness            | Where the URL goes                                                       | Reaches a private instance?                                         |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| OpenCode           | `opencode.json` `mcpServers` (remote, url)                               | Yes (local process)                                                 |
| Pi                 | via an extension configured with the instance URL                        | Yes                                                                 |
| Cursor             | Settings → MCP → remote server URL                                       | Yes (local process)                                                 |
| VS Code / Copilot  | MCP server config (remote, HTTP)                                         | Yes                                                                 |
| Claude Desktop     | Custom connector (remote) **or** MCPB bundle with the URL as user config | Connector: cloud → needs the public URL anyway; MCPB: local process |
| ChatGPT (dev mode) | Connector settings → remote MCP URL                                      | Cloud → requires the public HTTPS URL                               |
| Gemini CLI         | MCP server config (Streamable HTTP)                                      | Yes                                                                 |

Two OAuth notes:

- Every harness gets its own OAuth client registration on first connect; tokens
  are refresh-rotated. Revoking access is per-client from the instance side.
- Users connecting to **two instances** (e.g. work and personal) is fine: the
  harness namespaces tokens per base URL.

### Changing the public origin

The OAuth issuer, the JWKS and every resource identifier derive from
`ARTIFLOW_PUBLIC_ORIGIN` (see the
[configuration reference](../apps/web/src/content/docs/docs/reference/configuration.md)).
Changing that value invalidates every client registered under the previous
origin and every token issued for it: each harness must be registered and
authenticated again. Treat that as a deployment step, not as a bug, and choose
the final origin before the first production connect.

## 5. Cloud harness requirements (ChatGPT, Claude remote connectors)

Cloud agents connect **from the provider's infrastructure, not from the user's
machine**, so a local-only instance (`127.0.0.1`, LAN-only) is invisible to
them. For ChatGPT developer mode and Claude remote connectors you need:

1. The instance on a **public HTTPS origin** with a valid certificate (this
   guide's topology satisfies it).
2. OAuth 2.1 + PKCE over the public origin (already built in).
3. Provider-side gates: ChatGPT developer mode is per-account; distributing an
   _App_ (with inline UI) goes through OpenAI's directory review. Claude remote
   connectors are configured per user/organization.

Local-only harnesses keep working against a private instance even when it is
never published — that is the MCPB/stdio path.

## 6. Pre-flight checklist

- [ ] DNS record for the dedicated subdomain; 80/443 reachable.
- [ ] `ARTIFLOW_SITE_ADDRESS` set to the public subdomain (ACME on).
- [ ] `ARTIFLOW_PUBLIC_ORIGIN=https://artifacts.<org>.com` (bare origin, matches DNS).
- [ ] Final origin decided: changing it later re-registers every harness (see §4).
- [ ] Postgres reachable, `DATABASE_URL` with TLS if required;
      `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1` set for the deploy.
- [ ] Private bucket created; S3 credentials with least privilege; path style
      configured for non-AWS providers.
- [ ] `ARTIFLOW_AUTH_SECRET` ≥ 32 chars, stored in the env file (0600).
- [ ] Proxy passes the original `Host` (no rewrite) and no extra hop mutates it.
- [ ] `GET /api/health` returns 200 (database + storage probes) after `deploy:up`.
- [ ] MCP smoke: connect one harness to `https://artifacts.<org>.com/mcp`,
      complete OAuth, create one artifact.
