---
title: Integration tests and the sandbox
description: Run Artiflow's integration suites against a disposable PostgreSQL and Garage stack, know which suite proves what, and use the isolated security sandbox.
sidebar:
  order: 12
---

[Development setup](/docs/contributing/development/#tests-and-checks) lists every check. This page
covers the two that need real services: the integration suites, and the disposable security sandbox
that reruns them in an isolated network namespace. Never point either at data you care about: they
write to the database and bucket they are given.

## The integration stack

`docker-compose.yml` defines a disposable PostgreSQL 16 and Garage (S3-compatible) stack with
test-only public credentials. Its images must already be local — the file sets `pull_policy: never` —
so pull them once with `docker pull postgres:16-alpine dxflrs/garage:v2.4.1`. Run from the repository
root, without exported application variables:

```sh
docker compose up -d --wait garage postgres
node --env-file=test/integration-config.example scripts/wait-integration-services.mjs
node --env-file=test/integration-config.example apps/api/src/adapters/postgres/db/migrate.ts
bun run test:integration
docker compose down --volumes
```

The stack listens on loopback only: PostgreSQL on `54329`, Garage S3 on `9001`. Garage's default
bucket is created by the Compose file; the application itself still never creates one.

`bun run test:integration` runs every `test/*.integration.ts` plus each `test/*.test.ts` that reads a
variable from `test/integration-config.example`, serially. It **fails** when a declared variable is
missing or blank and when any test skips: a skip is not a pass. Pass `--file <path>` (repeatable) to
run a narrower selection. `bun run test:auth` and `bun run test:oauth` read `.env.local` instead, so
point them at a disposable database.

In CI, the `integration` job of `.github/workflows/verify.yml` runs the same sequence: it pulls the
pinned images, starts the stack, waits until `SELECT 1` and `HeadBucket` succeed, migrates, runs the
suites and tears the stack down.

## What proves what

| Area                                                               | Evidence                                                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Full product loop: health, sign-in, PKCE, MCP, read, share, delete | `scripts/e2e-full-cycle.mjs` against a running local instance                                                   |
| OAuth, sessions, MCP transport and tools                           | `bun run test:oauth`, `bun run test:auth`, `test/mcp-http.integration.ts`, `test/artifact-tools.integration.ts` |
| Public API v1 under resource-bound tokens                          | `test/v1-bearer.integration.ts`                                                                                 |
| Library routes, shares, links and deletion                         | `test/library-http.integration.ts`, `test/i5b*.test.ts`, `test/i5c2-shared.test.ts`                             |
| Editing, restore and comments                                      | `test/editing-http.integration.ts`, `test/comments-http.integration.ts`                                         |
| The documented quickstart, replayed over MCP                       | `test/docs-quickstart.integration.ts`                                                                           |
| Unit and UI suites with no services                                | `bun run test`                                                                                                  |

The `i5b*` and `i5c2` file names come from earlier internal work units, not from issues.

## The security sandbox

`scripts/security-sandbox.mjs` runs a target inside throwaway Docker containers with their own
PostgreSQL and Garage, real HTTP and a read-only payload. It changes no product code and is not a CI
job.

| Mode                   | Command                                                 | Target                                                                                                     |
| ---------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `reproducer` (default) | `node scripts/security-sandbox.mjs`                     | `docker/security-sandbox/reproducer.integration.ts`: a delete interleaved with a commit of identical bytes |
| `integration`          | `node scripts/security-sandbox.mjs --suite integration` | Ten integration suites that read the per-revision key contract, one `node --test` process per file         |

The reproducer pauses one owner's `DELETE` after the soft delete commits, lets a second owner commit
the same bytes and read them, then resumes the delete. It asserts that the two revisions have distinct
keys, that the survivor still serves its exact original HTML, and that only the deleted artifact's key
disappears from the bucket. It lives outside `test/` because it needs a paused delete and real
services, so `bun run test:integration` stays green on a normal checkout.

**Known state:** a reproducer run on the current tree exits `3`. Its control test requires
`GET /artifact/:id` to return the stored HTML byte for byte, and the viewer now appends the comment
bridge inside the frame, so the control fails before the race is evaluated. Accepting the bridge in
the harness is a separate change.

### Running it

1. `node scripts/security-sandbox.mjs --preflight [--suite integration]` — static checks only, no
   container: local images, architecture, Node major, payload allowlist, `node_modules` symlinks, module
   resolution, the target environment against `test/integration-config.example`, and disk headroom.
2. `node scripts/security-sandbox.mjs --dry-run [--suite integration]` — preflight plus the exact
   `docker` commands the run would execute, with every mount and every `--env`. Review this before a run.
3. Run it, optionally with `--timeout-seconds=<n>` (default 600 for the reproducer, 2400 for the suites)
   and `--evidence-dir <absolute path>`.
4. Read the exit code, the TAP output and the retained evidence.

Prerequisites: Docker 24+ with `node:24-bookworm-slim`, `postgres:16-alpine` and
`dxflrs/garage:v2.4.1` already local (nothing is ever pulled), host Node 24+ for the runner, and at
least `--min-free-gb` (default 5) of free disk.

### Exit codes

| Code | Meaning                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| `2`  | Accepted: reproducer control and race passed, or every selected suite ran and passed with no skip          |
| `3`  | Unexpected target failure: a race regression (`GUI598_INVARIANT_REGRESSED`), a red control, a failed suite |
| `4`  | Preflight or setup refused the run; zero target tests executed; nothing retried                            |
| `5`  | Usage error                                                                                                |
| `6`  | Wall-clock limit reached; target killed and run-owned containers removed                                   |
| `7`  | Cleanup incomplete; the remaining containers are listed by exact name                                      |
| `8`  | Evidence incomplete: a suite or reproducer test skipped, which is never a pass                             |

A completed run never exits `0`; `0` is reserved for `--help`, `--preflight` and `--dry-run`. In
integration mode the bootstrap prints one `[bootstrap] suite result …` line per suite and a
`[bootstrap] suite summary …` line, which is the only thing the runner classifies.

### Isolation

| Control       | Implementation                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network       | A `--network none` anchor container that PostgreSQL, Garage and the target join, so only loopback exists. `docker/security-sandbox/netns.mjs` decides loopback-only from routes and addresses, not interface names. |
| Environment   | An explicit `-e` allowlist with fictitious values; no ambient host environment, no `.env` file, no host credential.                                                                                                 |
| Code          | Read-only root filesystem and read-only bind mounts of an allowlisted payload; the whole `test/` directory is never mounted.                                                                                        |
| Writes        | Bounded tmpfs only; no named volume and no host directory.                                                                                                                                                          |
| Privileges    | `--cap-drop ALL`, `no-new-privileges` and non-root for the target and Garage; PostgreSQL keeps only the capabilities its entrypoint needs.                                                                          |
| Host surfaces | No Docker socket, `.git`, `.env*` or home directory; preflight refuses a payload that would ship them.                                                                                                              |
| Resources     | Target: 1 CPU, 1 GiB, 256 pids, 64 MiB max file size and the wall-clock limit. Services: 0.5 CPU and a memory cap each.                                                                                             |

Sign-in in the target uses the local demo profile, so `NODE_ENV=development`, `ARTIFLOW_DEMO_AUTH=1`
and `ARTIFLOW_PUBLIC_ORIGIN=http://127.0.0.1:5173` move together; dropping one turns every test into a
fixture failure. These are profile values, not credentials, and public sign-up stays closed: the
fixture inserts accounts and only the sign-in route runs.

### Evidence and cleanup

Containers are destroyed after every attempt, so the runner writes `gui598-<run-id>.log` (capped at
512 KiB) and `gui598-<run-id>.json` (the verdict) to a host directory cleanup never touches: a fresh
temporary directory by default, or `--evidence-dir`, which must not exist yet and must be outside the
worktree. Both files are created exclusively with mode `0600`. Delete the directory yourself once the
result has been read.

A `SIGKILL` of the runner cannot be trapped and may leave containers named `gui598-sandbox-<run-id>-*`.
Remove them by exact id only: `docker ps -a --filter "name=gui598-sandbox-"`, then `docker rm -f <id>`.
The runner never prunes and never removes a container it did not create.
