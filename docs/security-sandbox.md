# Disposable sandbox

`scripts/security-sandbox.mjs` runs one of two targets inside a throwaway Docker setup with a real
isolated PostgreSQL and Garage, real HTTP and a read-only payload. It changes no product code.

| Mode                   | Command                                                 | Target                                                                                                      |
| ---------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `reproducer` (default) | `node scripts/security-sandbox.mjs`                     | `docker/security-sandbox/reproducer.integration.ts`, the interleaving against the per-revision key contract |
| `integration`          | `node scripts/security-sandbox.mjs --suite integration` | the ten repository integration suites that read the per-revision key contract, one file at a time           |

The reproducer run must end with **both** tests passing: exit `2` is the accepted verdict for a
fixed build, and the retained evidence records the interleaving that used to remove bytes a live
artifact still needed. A failing race test is a regression of the fix, never a reproduced bug (exit
`3`). Neither test may skip: a TAP `# SKIP` directive on a reproducer line is exit `8`, incomplete
evidence, exactly as a skipped integration suite is, because a skipped invariant proves nothing.

The reproducer lives at `docker/security-sandbox/reproducer.integration.ts`, not in `test/`: the
sandbox is the only supported way to run it (it needs a real PostgreSQL, a real S3 and a paused
delete), and `bun run test:integration` must stay green on a normal checkout. Neither mode renames
the historical harness `test/i5b4-delete.test.ts` (that name comes from an earlier internal work
unit, I5B-4, not from a Linear issue). Both modes share one isolation model — network namespace,
environment allowlist, read-only mounts, tmpfs scratch, capabilities, resource and wall limits,
cleanup by exact run-owned id and evidence retention — and differ only in the payload files, two
selection values and the target command.

## Integration suite mode

The suites re-baselined for the per-revision key contract have two recorded runs against real
services, and this document re-verifies neither of them: the evidence files live outside the
worktree (see "Retained evidence") and nothing from them is committed. The earlier run used the
seven-suite selection, before the three viewer/share suites joined it: seven suites, 52 tests, zero
skips, exit `2`, target summary `suites=7 passed=7 skipped=0 failed=0 notests=0`. Before it these
suites had only ever skipped on a checkout without services. The current recorded result is the
closing run on the ten-suite selection, which carries those three viewer/share suites whose cleanup
bookkeeping now reads each revision key from its row: ten suites, 86 tests (9/6/4/14/4/7/8/9/14/11
in selection order), zero skips, exit `2`, target summary
`suites=10 passed=10 skipped=0 failed=0 notests=0`. That closing run is the one that proves no
object leaks. `--suite integration` is how a later run reproduces it: the same isolated PostgreSQL
and Garage, the same read-only container, one `node --test` process per suite file, sequentially.

```
node scripts/security-sandbox.mjs --suite integration
```

Selected suites, each mounted as its own file (the whole `test/` directory is never mounted):

| Suite                                        | What it proves                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `test/i5b4-delete.test.ts`                   | owner delete soft-deletes, answers `200 {ok:true}` and removes only that artifact's own revision keys |
| `test/library-http.integration.ts`           | the library routes over real HTTP, read-only and non-mutating, on this run's own database             |
| `test/comments-http.integration.ts`          | comments and editing routes against real PostgreSQL and S3                                            |
| `test/artifact-tools.integration.ts`         | the MCP artifact tools over the bearer-only transport with earned OAuth tokens                        |
| `test/docs-quickstart.integration.ts`        | the documented quickstart payload and viewer/sharing steps replayed over the public MCP transport     |
| `test/editing-http.integration.ts`           | restore reads the pinned revision and stores it under a fresh key of its own                          |
| `test/i5c2-shared.test.ts`                   | the shared-with-me list and the sharing viewer against real services                                  |
| `test/i5b3-share.test.ts`                    | the public `/share/:token` viewer over real HTTP, with each run's revision keys read from their rows  |
| `test/artifact-viewer-bearer.integration.ts` | the cookie and bearer viewer paths, including `embed=1`, over the same composition                    |
| `test/v1-bearer.integration.ts`              | the public API v1 under resource-bound OAuth tokens (DCR, consent, PKCE exchange)                     |

Extra payload those suites read, and nothing else: `test/helpers` (three helper modules: throwaway
databases, OAuth clients, sessions — no secret, no fixture value, no host path),
`apps/dashboard/src/auth-client.ts` (imported by `i5c2-shared`) and
`apps/web/src/content/docs/docs/start/quickstart.md` (the docs suite's fixture). A read-only import
walk over the ten suites resolves 48 modules and leaves that allowlist nowhere; `apps/api`,
`packages`, `drizzle` and `node_modules` cover the rest.

Expected command and verdict:

```
node scripts/security-sandbox.mjs --suite integration [--timeout-seconds=2400]
```

- bootstrap runs the full isolation gate first (sandbox environment profile, scratch HOME/TMPDIR,
  target selection, read-only payload, absent host surfaces, loopback-only namespace, loopback
  fixture endpoints). Nothing from `test/` runs unless every check printed `ok`.
- then it prints one `[bootstrap] suite result <file> verdict=… tests=… pass=… fail=… skipped=…` line
  per suite plus `[bootstrap] suite summary suites= passed= skipped= failed= notests=`.
- the runner reads that summary and nothing else. **Success is exit `2`**: every selected suite ran
  and passed with zero skips.

What counts as success, and what does not:

| Target outcome                             | Runner exit | Reading                                                                         |
| ------------------------------------------ | ----------- | ------------------------------------------------------------------------------- |
| every suite ran and passed, no skip        | `2`         | the suites' own proof against real PostgreSQL/S3                                |
| any suite failed, or reported no tests     | `3`         | a real failure (or a broken selection): keep the evidence, do not report a pass |
| any suite skipped                          | `8`         | evidence incomplete: never a pass, even when no suite failed                    |
| version and selection problems, zero tests | `4`         | preflight or the isolation gate refused the run                                 |
| wall clock, cleanup                        | `6`, `7`    | as in every other mode                                                          |

Skip policy. An integration suite declares a skip when `DATABASE_URL` or the four `ARTIFLOW_S3_*`
variables are missing, so a skip inside the sandbox means the fixture environment was incomplete
rather than a product result. A skip is therefore never reported as a pass: bootstrap counts it,
prints the reason it declared, and the run exits `8` with `"<n> of <m> suites skipped (<file> (<reason>))"`
in the verdict — no invented success. The reproducer follows the same rule on its own TAP output:
it reads the `# SKIP` directive Node appends to a skipped line (`ok 1 - name # SKIP reason`), so a
skipped control or race test is exit `8` with the test named in the verdict instead of a pass.

Target environment. The allowlist carries exactly the variables `test/integration-config.example`
declares, with fictitious values, and preflight re-reads that file and fails if any of its names is
missing from the target environment (the extra sandbox-only values — `PATH`, `HOME`, `TMPDIR`, the
cache paths, `ARTIFLOW_SANDBOX` and the two `ARTIFLOW_SANDBOX_*` selection values — are reported by
the same check). Two values deliberately differ from the example because they are fixture-bound: the
loopback ports (PostgreSQL `5432` and Garage `9000`, which `docker/security-sandbox/garage.toml`
pins, instead of the example's host ports `54329`/`9001`) and the bucket name, which this run's
Garage creates for itself. No suite needs a secret or a non-loopback endpoint; nothing of the sort
is in the allowlist.

## Quick path

1. `node scripts/security-sandbox.mjs --preflight [--suite integration]` — static checks only, no
   container, no pull. Verifies local images, architecture, Node major, payload allowlist,
   `node_modules` symlinks, module resolution, the target environment against
   `test/integration-config.example` and disk headroom.
2. `node scripts/security-sandbox.mjs --dry-run [--suite integration]` — preflight plus the exact
   `docker run`/`create` commands this run would execute, with container names that embed a fresh
   run id. This is the artifact to review before a run: it shows every mount and every `--env`.
3. `node scripts/security-sandbox.mjs` (reproducer) or `node scripts/security-sandbox.mjs --suite
integration` — create, run, remove. The runner writes its own evidence (see below) and prints
   the directory on stdout.
4. Read the verdict, the TAP results and the retained evidence file. Reproducer: exit `2` means
   control and race both passed and the invariant held (the accepted verdict); exit `3` means a race
   regression, or an outcome the runner cannot classify. Integration suites: exit `2` means every
   selected suite ran and passed with no skip; exit `8` means at least one suite skipped, which is
   never a pass.

Nothing is installed, pulled or fetched. Host Node only orchestrates; the target runs the
container's Node.

## Retained evidence (S5)

The containers are destroyed after every attempt, so the runner keeps the attempt outside the
sandbox itself, in a host directory that cleanup never touches:

| File                   | Content                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gui598-<run-id>.log`  | Runner log lines plus the bounded `docker start --attach` capture (TAP output, bootstrap check lines), capped at 512 KiB                                                                                                                   |
| `gui598-<run-id>.json` | Verdict: run id, mode, start/finish, wall seconds, exit code, control and race outcome (reproducer) or the per-suite results (integration), isolation verdict, target exit/oom/timeout, created containers and leftovers, effective limits |

- Default directory: a fresh `mkdtemp` under the OS temp dir, reported on stdout as
  `[sandbox] evidence directory ...`.
- `--evidence-dir <absolute path>`: the directory must not exist yet (it is created exclusively);
  a path inside the repository worktree is refused, and so is an existing directory.
- Both files are created with `O_EXCL` and mode `0600`; nothing is ever overwritten, and the log
  stops growing at its cap (the verdict records `truncated: true`).
- Only values the target already receives are recorded (dummy fixture credentials, ids, TAP
  text). No host credential, no ambient host environment and no `.env` content is written.
- Cleanup deletes container bytes only. The evidence directory survives the run; delete it
  yourself once the result has been read.

## What the reproducer asserts

| Step                                                                        | Public interface                                                                                    | Expected                                                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A writes X, B is a second dummy owner                                       | real commit flow used by the create route                                                           | each revision gets its own `artifacts/<revision id>` key; byte-identical content never shares one |
| A's `DELETE` pauses after the ownership decision and the soft-delete commit | `DELETE /api/artifacts/:id`                                                                         | request held at the injected seam, before the byte delete, not answered                           |
| B writes the same X and reads it before release                             | `GET /artifact/:id`                                                                                 | `200` with the exact original HTML                                                                |
| Both artifacts' keys and the bucket are inspected before release            | one `artifactRevisions` query per artifact plus a bounded `listRevisionKeys` page over `artifacts/` | two distinct keys, both rows carrying the payload's `sha256`, both objects present                |
| A's delete resumes and commits                                              | `DELETE /api/artifacts/:id`                                                                         | `200 {"ok":true}`                                                                                 |
| A is read after deletion                                                    | `GET /artifact/:id`                                                                                 | `404` with the branded not-found page (`NOT_FOUND_PAGE`, `apps/api/src/viewer/html.ts`), not JSON |
| B is read after A's delete                                                  | `GET /artifact/:id`                                                                                 | **GREEN**: `200` with the exact original HTML; A's delete never targeted B's object               |
| Local-delete probe: the bucket is listed again after the delete             | bounded `listRevisionKeys` over `artifacts/`                                                        | A's own key is gone and B's key is still there                                                    |

That last row is the key-level evidence that B's bytes were never a delete target:
`cleanupArtifactBlobs` reads only the deleted artifact's own rows, so the listing must show A's key
removed and B's untouched. The probe prints one bounded line,
`GUI598_LOCAL_DELETE_PROBE aKeyRemoved=… bKeyKept=…`, and runs after the survivor assertions, whose
failure is held until the probe has finished, so a regression still carries the bucket's state. The
`GUI598_INVARIANT_REGRESSED` marker on the survivor and probe messages is what lets the runner name a
regression as a regression instead of as a reproduced bug.

No assertion trusts a generated variable: the two keys are observed both in the persisted revision
rows and in the bucket listing, and readability is always the public viewer route. The same premise
is asserted once in the control test before any delete.

A second test is the existing-behaviour control: when B commits the same bytes _before_ A's delete
reaches the byte delete, B keeps serving the original and only A's key disappears. It must pass too;
a red control is exit `3` (harness or product), never a verdict on the fix.

Both tests encode the post-change contract. On the base commit `3e2fa4c` both owners
shared one content-addressed object (`artifacts/<sha256>`), so the same interleaving removed bytes a
live artifact still needed — the `500 artifact_unavailable` the pre-fix harness reported under its
since-removed `GUI598_EXPECTED_RED` marker. The shipped build stores one object per revision
(`artifacts/<revision id>`) and a delete removes only the deleted artifact's own keys. The
interleaving is unchanged in spirit — pause A's DELETE, commit the identical bytes during the pause, resume, read — and the assertions are now the
fixed invariant: B stays readable with its exact original bytes, and only A's own key disappears.
Cleanup lists the bucket's `artifacts/` keys and deletes them by key, so it no longer rebuilds
`artifacts/<sha256>`.

Product behaviour is asserted through the public HTTP interface only. Two observations are read where
the contract itself lives: the `artifactRevisions` rows that name each revision's key and digest, and
a bounded `listRevisionKeys` page over `artifacts/`. Neither substitutes for a route assertion — the
listing says which objects exist, and the viewer route says whether they are served.

## Isolation

| Control             | Implementation                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network             | `--network none` anchor container; PostgreSQL, Garage and the target join `--network container:<anchor>`, so only loopback exists. No published ports, no bridge, no external route.                                                                                                                                                                                                                |
| Namespace verdict   | `docker/security-sandbox/netns.mjs` decides loopback-only from routes and addresses (`/proc/net/route`, `/proc/net/if_inet6`), not from the interface inventory or a count: a `--network none` namespace always lists the kernel pseudo tunnels (`gre0`, `gretap0`, `erspan0`, `sit0`, `ip6tnl0`, `tunl0`, ...) next to `lo`. A device that is neither `lo` nor a known pseudo tunnel still aborts. |
| Environment         | Explicit `-e` allowlist only (dummy credentials, no ambient host `process.env`); the three login-gate values are described below.                                                                                                                                                                                                                                                                   |
| Code and toolchain  | Read-only container rootfs; the allowlisted payload (reproducer: `apps/api`, `packages`, `drizzle`, the reproducer file, root `package.json`, `node_modules`; integration mode: the same base plus the ten suite files, `apps/dashboard/src/auth-client.ts` and the quickstart page, each a separate file mount) and the bootstrap/tooling files are read-only bind mounts.                         |
| Writes              | Only bounded tmpfs: target `/tmp` 64m + `/scratch` 256m; PostgreSQL data 256m; Garage 192m. No named volume, no host directory.                                                                                                                                                                                                                                                                     |
| Privileges          | Target and Garage: `--cap-drop ALL`, `no-new-privileges`, non-root. PostgreSQL keeps only `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID` for its own entrypoint.                                                                                                                                                                                                                             |
| Host surfaces       | No Docker socket, no `.git`, no `.env*`, no home directory, no host services. Preflight refuses any payload that would ship them.                                                                                                                                                                                                                                                                   |
| Resources           | Target: 1 CPU, 1 GiB memory, 256 pids, 64 MiB max file size, wall clock (`--timeout-seconds`, default 600 for the reproducer and 2400 for the integration suites). Services: 0.5 CPU, 512 MiB / 256 MiB.                                                                                                                                                                                            |
| Trusted preparation | `docker/security-sandbox/bootstrap.mjs` checks the sandbox shape with Node built-ins and only then spawns the test as target-controlled code; the namespace verdict itself is the unit-tested `netns.mjs` predicate (`test/security-sandbox-netns.test.ts`).                                                                                                                                        |

## Login gate the sandbox relies on

The reproducer creates both principals through the real public sign-in route
(`POST /api/auth/sign-in/email`, via `test/helpers/trusted-accounts.ts`), and the integration suites
sign in the same way, so the target environment must satisfy the same gate as the local demo
profile:

| Value                                          | Why it is required                                                                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV=development`                         | `apps/api/src/config.ts` rejects `ARTIFLOW_DEMO_AUTH` in any other environment: production, test and every other profile fail closed.                                               |
| `ARTIFLOW_DEMO_AUTH=1`                         | `emailPasswordEnabled` in `apps/api/src/auth.ts` keeps email/password login disabled without it, and better-auth then answers the sign-in route with `400 EMAIL_PASSWORD_DISABLED`. |
| `ARTIFLOW_PUBLIC_ORIGIN=http://127.0.0.1:5173` | The same gate also demands a loopback origin, and this value is the `origin` header the fixture sends.                                                                              |

All three move together. Dropping any one turns both tests into a fixture failure that says nothing
about the fix; the helper now prints the status and the response body for exactly that reason. These
are fictitious local profile values, not credentials: the sandbox still reads no host `.env` and
forwards no host credential or origin. Public sign-up stays closed
(`PUBLIC_REGISTRATION_OPEN = false`), so the fixture inserts the account row itself and only the
sign-in route runs the gate.

## Limits and non-guarantees

- The host Docker daemon is outside the sandbox. The target cannot reach it (no socket, no
  capabilities), but a compromised daemon is out of scope for this harness.
- Bind mounts are read-only views of repository files; the harness does not copy the 629 MiB
  `node_modules`, it proves at preflight that its symlinks stay inside the repository and that the
  required runtime packages carry no host-platform binaries.
- `SIGKILL` of the runner cannot be trapped. Containers named `gui598-sandbox-<run-id>-*` may then
  remain. Recovery is scoped by exact id, never global:
  `docker ps -a --filter "name=gui598-sandbox-"` and `docker rm -f <exact-id>` per container.
- The runner never runs `docker prune`, never removes a network it did not create (it creates
  none), and never deletes a container it did not track.
- A failed preflight or setup preserves the attempt, executes zero target tests, and does not
  retry automatically.
- The evidence log keeps its 512 KiB cap in both modes, so a very verbose suite run can fill it
  (the verdict records `truncated: true`). The classification never depends on the log: the runner
  reads the suite summary from its own in-memory capture of the target output, and the JSON verdict
  stores that summary per suite.
- The namespace gate accepts a device only if it is `lo` or a known kernel pseudo tunnel. A kernel
  that invents a new pseudo device name would reject a genuine isolated namespace (exit `4`, zero
  tests) instead of passing it silently; the bootstrap line names the offending device, so the
  allowlist in `netns.mjs` is a one-line fix. The gate never accepts on device names alone: a
  default route, a non-loopback IPv4 route or a non-loopback IPv6 address always aborts.
- The retained evidence files are host files under the evidence directory, so they outlive the
  containers by design; deleting them is the operator's step.

## Exit codes

| Code | Meaning                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2`  | Accepted verdict: reproducer invariant held (control and race passed), or every selected integration suite ran and passed with no skip               |
| `3`  | Unexpected target failure: race regression (`GUI598_INVARIANT_REGRESSED`), race failure without that marker, red control, missing test, failed suite |
| `4`  | Preflight or setup failure, including bootstrap isolation exits `10`/`11`; zero target tests executed; attempt preserved, no retry                   |
| `5`  | Usage error                                                                                                                                          |
| `6`  | Wall-clock limit reached; target killed and run-owned containers removed                                                                             |
| `7`  | Cleanup incomplete; remaining containers listed by exact id/name                                                                                     |
| `8`  | Evidence incomplete: at least one selected integration suite, or one reproducer test, skipped; a skip is never a pass                                |

A completed run never exits `0`; `0` is reserved for `--help`, `--preflight` and `--dry-run`.

## Prerequisites

- Docker server 24+ reachable through the local CLI, with these local images (never pulled):
  `node:24-bookworm-slim`, `postgres:16-alpine`, `dxflrs/garage:v2.4.1`.
- Host Node 24+ for the runner (built-ins only).
- Free host disk at least `--min-free-gb` (default 5); the bounded writable footprint is ~1 GiB.

## Independent review before execution

Risk items 2 and 5 of the shared-blob isolation review make an independent isolation review a
prerequisite for the runtime attempt: no target code runs until that review approves the network
namespace, capabilities, mounts, environment and cleanup described above.

## Checklist

- [ ] `--preflight` reports every check `ok` on this host (both modes: the mode changes the payload and
      environment checks, not the isolation ones).
- [ ] `--help` and `--dry-run` show the limits, the evidence default and the exact planned commands.
- [ ] Independent review approved the isolation model.
- [ ] A runtime attempt is classified by exit code: `2` is the acceptance, and a failing test is kept as evidence, never reported as a pass.
- [ ] Integration mode: the suite summary was read and every suite is `passed`; a `skipped` suite is reported as exit `8`, never as a pass.
- [ ] The retained evidence directory and its JSON verdict were read before the result is claimed.
- [ ] `git status --short` shows no scratch or cache path after the run.

## Specs covered

S1 (a Docker setup that creates what it needs and is destroyed afterwards), S4 (disposable
PostgreSQL and S3 with fictitious data, isolated network, read-only code, resource limits,
automatic cleanup, deterministic interleaving on top of the existing harness) and S5 (add the
interleaving without rewriting the historical harness; keep the result outside the
sandbox before destroying it — the runner now writes that evidence itself, see "Retained
evidence"). S3 is answered in the first paragraph, not by renaming the test.

## Shared and public Markdown viewers

The shared (`/artifact/:id`) and public (`/share/:token`) Markdown pages used to serve the
rendered fragment inside `<iframe sandbox="" srcdoc=...>`: a second, script-free frame around
content that already had no script surface. The fragment comes from MarkdownIt with `html: false`,
so raw HTML in the document is escaped and cannot produce a script, an event handler or an image
tag; the only reason the frame existed was defence in depth.

Those pages now render the same sanitized fragment directly in the page so comment anchors can be
measured precisely. The isolation trade is deliberate and bounded:

1. The fragment still cannot introduce script: `html: false` escapes every tag, and link schemes are
   validated before rendering.
2. The page CSP hardens what a future regression could reach: `default-src 'none'` still forbids
   network, frames, fonts and forms; `script-src 'self' 'unsafe-inline'` admits only the same-origin
   hashed bundle and the pre-existing inline poller, so no new inline script is added.
3. The comments bundle is built by Vite as its own entry (`viewer-comments`) and served from the
   dashboard build; it receives a JSON data island the server fills with already-authorized threads
   and never fetches another origin.
4. The public page embeds threads only when the link's `showComments` option is on; the option is off
   by default and the server is the only place that decides.

The HTML viewer keeps its `sandbox="allow-scripts"` frame: those artifacts are executable pages and
the frame is the boundary that keeps them away from the viewer origin.
