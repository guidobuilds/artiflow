---
title: Development setup
description: Run Artiflow locally with Bun and Node, know which tests cover what, and add a documentation page to the Astro + Starlight site.
sidebar:
  order: 10
---

This page gets a contributor from a clone to a running instance, then explains where code lives and
which checks cover what. It complements the repository's `CONTRIBUTING.md`, which owns branch, commit
and pull-request conventions.

## Requirements

| Tool                  | Version                           | Used for                                                 |
| --------------------- | --------------------------------- | -------------------------------------------------------- |
| Bun                   | `>=1.2` (verified on 1.3.10)      | Package manager, repository scripts, the API runtime     |
| Node.js               | `>=24.0.0` (verified on v24.17.0) | Vite dev server, check scripts, the `node --test` runner |
| PostgreSQL 16         | External                          | Metadata and tests that need a database                  |
| S3-compatible storage | External, private bucket          | Artifact bytes                                           |
| Docker                | Optional                          | Disposable integration stack and production images       |

`bun.lock` is the single lockfile; do not add a second package manager's lock file. The workspace
covers `apps/*`, `packages/*` and `plugins/opencode`, and one root install feeds all of them.

## First run

```sh
bun install           # whole workspace, plugin included
bun run setup:local   # .env.local from .env.example (mode 0600) plus the auth secret
# edit .env.local: DATABASE_URL and ARTIFLOW_S3_*
bun run check:local   # SELECT 1 and HeadBucket; creates nothing
bun run db:migrate    # additive and idempotent
bun run dev           # API on 8787, dashboard on 5173
```

Open <http://127.0.0.1:5173/>. `bun run dev` owns only its child processes and refuses to start when
either port is taken; `ARTIFLOW_DEV_RUNTIME=bun|node` picks the API runtime (default `bun`).

## Where the code lives

| Path                           | Responsibility                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `apps/api`                     | Hono API, Better Auth, MCP transport and tools, viewers and HTTP routes.                    |
| `apps/dashboard`               | React SPA for the library, markdown editor, comments, sharing and account screens.          |
| `apps/web`                     | This documentation site: Astro + Starlight, mounted at `/docs`.                             |
| `packages/contracts`           | Zod wire schemas shared by the API, dashboard and SDK.                                      |
| `packages/domain`              | Pure source-coordinate and Markdown line operations.                                        |
| `packages/mcp-server`          | Transport-agnostic MCP tool logic; receives persistence through ports, imports no drivers.  |
| `packages/mcp-apps`            | MCP Apps viewer document and host-capability helpers.                                       |
| `packages/plugin-core`         | Harness-agnostic plugin runtime: OAuth client, associations, tool mapping, conformance kit. |
| `packages/sdk`                 | Typed fetch client over the public HTTP surface, with injectable fetch.                     |
| `plugins/opencode`             | The OpenCode plugin workspace.                                                              |
| `skills`                       | Canonical `SKILL.md` content every harness integration packages.                            |
| `test`                         | Root suite: unit tests plus service-gated integration suites.                               |
| `scripts`, `drizzle`, `docker` | Repository checks, additive migrations, images and the Caddyfile.                           |

The architecture notes under `docs/architecture/` describe current behavior, module boundaries and the
security model; `docs/runbook.md` is the local operations guide. Both are repository-facing, not part of
this site.

## Tests and checks

The root suite runs on Node, not Bun: on Bun 1.3.10 the `node:test` shim ignores `{ skip }`, so
environment-gated suites execute instead of skipping, and `node:module` lacks
`stripTypeScriptTypes`. Keep using `node --test`.

| Command                    | What it runs                                                                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test`             | Every `test/*.test.ts` under `node --test`. Unit and UI tests; no services required, gated suites self-skip.                                                                                                                                  |
| `bun run test:integration` | Every `test/*.integration.ts` and each `test/*.test.ts` that reads a variable from `test/integration-config.example`, serially. Requires the disposable PostgreSQL + Garage stack. Fails if a required variable is missing or any test skips. |
| `bun run test:auth`        | `test/auth-http.integration.ts` against a disposable PostgreSQL.                                                                                                                                                                              |
| `bun run test:oauth`       | `test/oauth-http.integration.ts` against a disposable PostgreSQL.                                                                                                                                                                             |
| `bun run typecheck`        | The API TypeScript project and the dashboard workspace project.                                                                                                                                                                               |
| `bun run build`            | Docs fact and link check, boundary check, comment check, dashboard effect-fetch check, dashboard production build and API type check.                                                                                                         |
| `bun run check:boundaries` | Import boundaries between apps, packages and tests.                                                                                                                                                                                           |
| `bun run check:hygiene`    | Fails when a tracked file matches `.gitignore`.                                                                                                                                                                                               |
| `bun run check:changed`    | Prettier and oxlint on the files changed against `origin/main`. Pass a base ref to compare elsewhere.                                                                                                                                         |
| `bun run check:docs`       | Relative links in the scanned docs resolve, and those docs do not state a tool count or a kind list that contradicts `packages/mcp-server/src/server.ts` and `packages/domain/src/kinds.ts`.                                                  |
| `bun run check:comments`   | `scripts/check-comments.mjs` decides which source comments are allowed.                                                                                                                                                                       |
| `bun run check:effects`    | `scripts/check-effect-fetches.mjs` fails when a dashboard effect calls `fetch` or an HTTP client.                                                                                                                                             |
| `bun run web:verify`       | `astro check`, the docs build, then the built-output verifier; the only docs check that reads `apps/web/dist`.                                                                                                                                |

The integration stack and its exact sequence live in `docs/runbook.md`; never point those commands at
data you care about. The docs site has its own checks:

```sh
node --test test/web-docs.test.ts         # workspace config, sidebar groups and every /docs/ link
node --test test/web-validation.test.ts   # public CLI of the built-output link verifier
node --test test/web-reference.test.ts    # public CLI of the configuration verifier
bun run web:verify                        # astro check, the build, then both verifiers
node scripts/check-docs.mjs               # links, plus tool and kind facts against server.ts and kinds.ts
```

Two commands verify what the sources cannot prove, and `web:verify` runs both
after the build:

| Command                                           | Verifies                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `node apps/web/scripts/check-built.mjs [distDir]` | Routes, assets and `#fragment` targets in the emitted HTML resolve inside `dist`.  |
| `node apps/web/scripts/check-reference.mjs`       | `apps/api/src/config.ts` and `reference/configuration.md` list the same variables. |

A link check over the Markdown sources is not built proof, so only
`check-built.mjs` can prove the links. Both accept `--help` with their exit
codes (`0` clean, `1` problems, `2` usage error or unreadable input);
`check-reference.mjs` also takes `--root <dir>` for another checkout, which is
what the fixture tests use.

The repository's `verify` workflow runs the root checks on every push and pull request
(hygiene, boundaries, docs, comments, dashboard effect fetches, dependency audit, changed-file
formatting, typecheck, tests and build). The same workflow's `integration` job starts the disposable PostgreSQL and Garage
stack, migrates, and runs `bun run test:integration`, which fails when configuration is missing
or any test skips. The security-sandbox reproducer stays out of CI: its control test still
requires the viewer body to be the stored HTML, and the frame now also carries the comment
bridge, so the run exits 3. The workflow builds the documentation site and runs both checks as
its `Web site` step, and deploys nothing: a relative `.md` link or an undocumented variable fails
that pull request instead of the deploy.

The gate audits the resolved tree with bun: after `bun install --frozen-lockfile` it runs
`bun audit --json` through `scripts/audit.mjs` (`bun run audit`) and fails on any high or critical
advisory that is not listed in `scripts/audit-allowlist.json`. Each entry names the package, the GHSA
id, the reason the risk is accepted and a `reviewBy` date. The date only produces a warning, so an
advisory without a patched release never turns the gate red for every pull request; remove the entry
once a patch lands. The MCP transport is Hono (`@hono/node-server`, `apps/api/src/mcp/mount.ts`), so
the MCP SDK's `express`/`body-parser` subtree is not on the HTTP path today, and `body-parser` is
pinned to a patched version regardless.

## Add a documentation page

1. Create the file under `apps/web/src/content/docs/docs/<section>/<page>.md`. Its route is
   `/docs/<section>/<page>/`; `<section>/index.md` becomes the section landing page.
2. Add frontmatter with a `title` and `description`, and `sidebar.order` to position the page
   inside its section. Groups, their labels and their order live in `astro.config.mjs`: each group
   autogenerates one content directory, so a new section directory needs a group entry there.
3. Write internal links as absolute `/docs/...` paths. They must resolve to a real page; the site test
   fails on a link that does not.
4. Describe only what the code supports. If a behavior is partial, future or unverified, say so
   instead of promising it.
5. Run `node --test test/web-docs.test.ts`, `node scripts/check-docs.mjs` and `bun run web:verify`.
   Use `bun run web:dev` to read the page at <http://127.0.0.1:4321/docs/>.

The site is English-only today: no locales are configured, so there are no translated routes to keep
in sync. Search is Starlight's built-in Pagefind index, generated at build time; there is no separate
search service to run.

## Conventions

- `bun run check:comments` (`scripts/check-comments.mjs`) decides which source comments are allowed.
- `bun run check:effects` (`scripts/check-effect-fetches.mjs`) rejects a `fetch` or an HTTP client
  call inside a dashboard `useEffect` or `useLayoutEffect`. Those loads belong in TanStack Query.
- Product queries belong behind repositories that take the typed database from `apps/api/src/db/client.ts`.
  HTTP routes and MCP tools consume the same operations instead of duplicating SQL.
- Security invariants are summarized in `docs/architecture/README.md`; artifact bytes never execute on
  the application origin and permissions are checked before any byte is read.
- Migrations are additive and generated with `bun run db:generate`; never create roles, databases,
  buckets or bucket policies from this repository.
- If a statement in `README.md` or `docs/` stops being true after your change, fix it in the same pull
  request.

## Next

Read `CONTRIBUTING.md` for branches, commit messages and pull-request expectations, then
[Install Artiflow](/docs/self-hosting/installation/) if you are testing a production-like deployment.
