# Contributing to Artiflow

This page covers how to change Artiflow: local setup, branches, commits, checks
and pull requests. If something here contradicts the code, the code wins — open an
issue so the document can be fixed.

## Before you start

- Bun `>=1.2` (verified on 1.3.10) — the only package manager and the API
  runtime: `bun run dev` starts the API on Bun and the production API image runs
  `bun apps/api/src/server.ts`. `bun.lock` is the single lockfile; do not add
  `package-lock.json`.
- Node.js `>=24.0.0` (verified on v24.17.0) — the runtime for the Vite dev server,
  the repository scripts and the test runner.
- A reachable **PostgreSQL 16** database and role.
- A private **S3-compatible bucket** and credentials.
- Docker only for the integration test stack or the production images.

This repository runs the application only. PostgreSQL and object storage are
external services that you provide; nothing here creates or provisions them.

Read, in this order:

- [`README.md`](README.md) — requirements, quick path and deployment overview.
- [`docs/runbook.md`](docs/runbook.md) — first run, MCP flow and troubleshooting.
- [`docs/architecture/README.md`](docs/architecture/README.md) — how the system is
  put together.

## Get the project running

From a clean clone:

```sh
bun install           # pinned workspace dependencies from bun.lock
bun run setup:local   # create .env.local (mode 0600) and the auth secret
# edit .env.local: DATABASE_URL and ARTIFLOW_S3_*
bun run check:local   # SELECT 1 + HeadBucket against your services
bun run db:migrate    # additive and idempotent
bun run dev
```

`bun install` covers the whole workspace, the OpenCode plugin included: its
dependencies resolve from the root install. The app runs without the plugin, but
`bun run typecheck`, `bun run build` and the plugin tests reach that source tree
and need its type dependencies. `bun run setup:plugin` is the frozen-lockfile
form of the same install, which is what CI runs.

Open <http://127.0.0.1:5173/>. Use that exact IPv4 address: on some machines
`localhost` resolves to an unrelated IPv6 listener and shows a different
application.

`bun run dev` owns only the API and UI child processes. If a port is already in
use it refuses to start instead of guessing.

## Branches

Name every branch with one of these prefixes:

| Prefix      | Use it for                                    |
| ----------- | --------------------------------------------- |
| `feature/`  | New features or functionality                 |
| `bugfix/`   | Fixing bugs in the code                       |
| `hotfix/`   | Urgent patches, usually applied to production |
| `design/`   | User interface or user experience updates     |
| `refactor/` | Improving structure without changing behavior |
| `test/`     | Writing or improving automated tests          |
| `doc/`      | Documentation updates                         |

Add a short description after the prefix, for example
`feature/artifact-search` or `doc/contributing-guide`. Branch from `main`, keep
the branch short-lived and never commit directly to `main`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>
```

Examples:

```
feat(mcp): add one-call direct text ingestion
fix(api): keep public viewers unchanged in embed mode
refactor(db): migrate the staging repository to Drizzle
docs(architecture): document the OpenCode plugin roadmap
```

- **Types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
- **Scopes in use include:** `api`, `web`, `db`, `mcp`, `docs`, `test`,
  `scripts`, `deploy`, `site`, `opencode-plugin`, `skills`, `architecture`.
  The scope is optional.
- **Subject:** imperative mood, no trailing period.
- **Body:** explain _why_ the change is needed and what alternatives you rejected.
  Do not narrate the diff; the code already shows what changed.

## Run the checks before opening a PR

CI runs on every pull request in the `verify` workflow. The `verify` job runs the
commands below. The `integration` job starts the Compose stack, migrates, and runs
`bun run test:integration`. Keep both green before pushing.

```sh
bun run test        # test suite; no services required
bun run typecheck   # API TypeScript project + the dashboard workspace project
bun run build       # Vite production build + API type check
```

### Runtime: Bun for the API, Node for the tooling

`bun run dev` runs the API under Bun and the Vite dev server under Node. Override
the API runtime with `ARTIFLOW_DEV_RUNTIME=bun|node` (default `bun`); Node is the
declared fallback when Bun is missing. The script logs the chosen runtime and
`ps` shows it on the API pid.

The test suite still runs on `node --test` (`bun run test`). `bun test` is not
adopted: on Bun 1.3.10 the `node:test` shim ignores the `{ skip }` test option, so
the 80 environment-gated tests execute and fail, `t.mock.timers` raises
`NotImplementedError`, and `node:module` does not export
`stripTypeScriptTypes`. The suite is green on Node (334 pass / 0 fail / 80 skip),
so the runner stays there; migrate it only when Bun closes those three gaps.

The workflow installs the workspace (including the plugin) once via
`bun install --frozen-lockfile` before typechecking: the API project includes the
plugin tests, and without the plugin's type dependencies a clean clone would
fail there.

Formatting and lint use a ratchet: CI checks only the files a pull request
changes, so the existing codebase can be paid down gradually without a
repository-wide reformat.

```sh
bun run check:changed  # prettier --check + oxlint on files changed vs origin/main
bun run check:hygiene  # no tracked file matches .gitignore
bun run check:comments # scripts/check-comments.mjs
bun run check:effects  # scripts/check-effect-fetches.mjs
bun run format         # rewrite every supported file with prettier
bun run lint           # whole repository; warnings are allowed while debt is paid
```

Pass a base ref explicitly when `origin/main` is not the right comparison, for
example `node scripts/check-changed.mjs HEAD^`. Do not reformat unrelated files
in the same pull request.

The `verify` workflow also audits dependencies on every push and pull request.
The step runs after `bun install --frozen-lockfile` and audits the resolved tree:
`bun run audit` (`scripts/audit.mjs`) reads `bun audit --json` and fails on any
high or critical advisory that is not listed in `scripts/audit-allowlist.json`.
Each allowlist entry names the package, the GHSA id, why the risk is accepted and
a `reviewBy` date. The date is a reminder, not a gate: once it passes the audit
only warns, so an advisory without a patched release never blocks every pull
request. Remove the entry when a patch lands. The MCP transport is Hono
(`@hono/node-server`, `apps/api/src/mcp/mount.ts`), so the MCP SDK's
`express`/`body-parser` subtree is not on the HTTP path today.

The integration suites talk to real PostgreSQL and S3, so they need a disposable
database and bucket:

| Command                    | Needs                                  | Run it when you change                         |
| -------------------------- | -------------------------------------- | ---------------------------------------------- |
| `bun run test:integration` | PostgreSQL + S3 (Docker Compose stack) | Persistence, storage, MCP tools or HTTP routes |
| `bun run test:auth`        | Disposable PostgreSQL                  | Auth or session handling                       |
| `bun run test:oauth`       | Disposable PostgreSQL                  | OAuth discovery, DCR, PKCE or consent          |

`bun run test:integration` loads `test/integration-config.example` and runs every
`test/*.test.ts` and `test/*.integration.ts` serially. It exits non-zero when any
variable in that file is missing and when any test skips. A skip is not a pass:
the suite did not prove the invariant. The same rule is what the `integration`
job enforces.

The self-contained stack and the exact sequence are in
[`docs/runbook.md`](docs/runbook.md#integration-suite). Never point these
commands at a database or bucket that holds real data. The security-sandbox
reproducer is not a CI step: its control test still requires the viewer body to
be the stored HTML byte for byte, and the viewer now appends the comment bridge
inside the frame, so the run exits 3 before the race says anything. Updating
that harness is a separate change. `--suite integration` is not a CI step
either; the `integration` job already runs those suites.

## Pull requests

### Link issues when required

Bug fixes, chores and tests must reference an existing issue. Documentation,
refactor and feature PRs are exempt from the linked-issue check. When required,
write `Fixes #123` or `Closes #123` in the PR description.

Before implementing new functionality, open a feature request that describes the
problem, why it belongs in Artiflow and your proposed approach. Wait for design
approval before opening the implementation PR.

Base the branch on `main`.

### Keep it focused

- Keep PRs small and focused.
- Explain the problem and why the change fixes it.
- Check whether the functionality already exists.
- For UI changes, include before-and-after screenshots or video.
- For logic changes, explain what you tested and how a reviewer can verify it.

### Keep it brief

Long, AI-generated PR descriptions and issues may be ignored. Write a short
explanation in your own words. If the change cannot be explained briefly, the PR
may be too large.

### Use conventional titles

PR titles follow `type(scope): summary`. Supported types are `feat`, `fix`,
`docs`, `chore`, `refactor` and `test`. The scope is optional.

Examples:

- `docs: update contributing guide`
- `fix(api): restore viewer scroll position`
- `feat(web): add workspace search`

## Code style and decisions

- **Comments:** `bun run check:comments` (`scripts/check-comments.mjs`).
- **Dashboard effects:** `bun run check:effects` (`scripts/check-effect-fetches.mjs`) fails when a
  `useEffect` or `useLayoutEffect` in `apps/dashboard` calls `fetch` or an HTTP client function
  (`get…`, `list…`, `read…`, `save…`, and the same prefixes). Load that data with TanStack Query.
- **Persistence:** product queries belong in repositories that receive the typed
  `AppDb`/`AppTx` from `apps/api/src/db/client.ts`. HTTP routes and MCP tools consume
  the same operations instead of duplicating SQL. Prefer Drizzle builders; keep
  typed `sql` fragments for CAS, database-clock expressions and constructs
  without a builder. See [`docs/architecture/modules.md`](docs/architecture/modules.md).
- **Errors:** configuration and migration failures are explicit error classes
  (`ConfigError`, `MigrationTargetError`). Expected domain refusals are mapped to
  typed results at the transaction boundary, not thrown through the HTTP layer.
- **Security:** the invariants are in
  [`docs/architecture/README.md` §7](docs/architecture/README.md#7-security-model-summary).
  Artifact bytes never execute on the application origin, and permissions are
  checked before any byte is read. Do not relax those guards to make a feature
  easier.

## Migrations

- Migrations are additive: new tables, columns, indexes and CHECKs. There are no
  down migrations.
- Generate them with `bun run db:generate`; commit the SQL under `drizzle/`.
- Apply them with `bun run db:migrate`. Re-running is a no-op.
- A non-loopback target requires `ARTIFLOW_ALLOW_REMOTE_MIGRATE=1`. Do not set it
  for a shared database you do not own.
- The repository never creates roles, databases, buckets, ACLs or bucket policies.

## Secrets and environment

- `.env.local` is git-ignored and created with mode `0600` by
  `bun run setup:local`. It holds the database URL, the S3 credentials and the
  auth signing secret.
- Never commit, print, paste or replace generated values with personal
  credentials. Use `bun run setup:auth` if you need to regenerate the auth secret.
- Production configuration lives in `.env.prod` (also git-ignored, mode `0600`).
  Service credentials belong in the external provider.
- The credentials in `test/integration-config.example` are public, loopback-only
  values for the disposable stack. Never reuse them outside it.

## Update the documentation

Documentation is part of the change, not a follow-up:

- `README.md` — user-facing setup, requirements or deployment behavior.
- `docs/runbook.md` — how to operate, verify or troubleshoot the system.
- `docs/architecture/*` — module boundaries, data model, flows or invariants.
- `docs/README.md` — the documentation index and planned site navigation.

If a statement in the docs is no longer true after your change, fix it in the same
PR.
