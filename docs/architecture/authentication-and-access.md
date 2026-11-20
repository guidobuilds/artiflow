# Authentication and access management

Preimplementation design for instance-level user administration and authentication:
administrator role, administrable access methods, user lifecycle, invitations, sessions,
password policy and one enterprise OIDC connection. It states what we build and why, and
what we deliberately do not build. Status: proposed, awaiting approval; no part of it is
implemented yet.

The approved functional specification lives outside this repository (Linear, project
Artiflow). This document answers its preimplementation gate and is subordinate to it: where
they disagree, the functional specification wins and this document is wrong.

## 1. What exists today

Verified against source on 2026-11-20.

- **Library.** `better-auth` 1.7.25 with the Drizzle adapter, plus `@better-auth/mcp` and
  `@better-auth/oauth-provider` for the agent/MCP authorization server
  (`apps/api/src/auth.ts`, `apps/api/src/oauth.ts`).
- **Identity tables.** `user`, `session`, `account`, `verification` in
  `apps/api/src/adapters/postgres/db/schema.ts`; `registrationInvite` and
  `passwordResetToken` in their own schemas; the OAuth server tables in `oauth-schema.ts`.
- **Access methods.** Email/password plus Google and GitHub, the last two only as
  environment variables (`ARTIFLOW_AUTH_GOOGLE_*`, `ARTIFLOW_AUTH_GITHUB_*`, parsed in
  `apps/api/src/config.ts`). All sign-up is disabled: `PUBLIC_REGISTRATION_OPEN = false`
  and `disableSignUp: true` for every social provider. Accounts are created by
  `bun run user:invite` (single-use token, SHA-256 hash, 24 h) or by
  `bun run user:reset-password` (single-use token, 1 h).
- **Authorization.** There is no instance role. `role` exists only as a product concept on
  shares (`reader`/`editor`/`commenter`). API routes authenticate with
  `sessionUserId()` (`apps/api/src/http/index.ts`) or a bearer token with scopes
  (`apps/api/src/mcp/mount.ts`); the dashboard is pathname routing with no guard layer.
- **Gaps for this work.** No administrator role, no runtime-editable configuration, no
  session listing or revocation, no password policy beyond the library's length check, no
  structured logging (only `console.*`), no account deactivation, no SSO, no operations for
  first administrator, recovery or purge.

## 2. Decision summary

| #   | Decision                                                               | Rejected alternative                        |
| --- | ---------------------------------------------------------------------- | ------------------------------------------- |
| D1  | One `role` column, one server-side guard, no hierarchy                 | Permission tables, per-resource ACL         |
| D2  | Per-key typed JSONB settings table with a revision counter             | Single JSON document, wide settings columns |
| D3  | Auth instance rebuilt from a config snapshot, swapped atomically       | Restart to apply, rebuild per request       |
| D4  | Environment is read once to seed the first configuration, then ignored | Environment as a live fallback              |
| D5  | Application-level envelope encryption for provider secrets             | Plaintext columns, disk-encryption only     |
| D6  | Sessions revoked at deactivation, blocked at creation                  | Cookie invalidation only                    |
| D7  | Explicit `status` column, no hard delete from the UI                   | Library-only bans                           |
| D8  | One policy module called from every password-setting entry point       | Client-only validation, library length only |
| D9  | Keep the two token tables, add authorship and admin-facing endpoints   | A single unified link table                 |
| D10 | `@better-auth/sso` for OIDC, with our own trust matrix on top          | Hand-written OIDC client                    |
| D11 | SSO fallback gated by the server, URL parameter only for the UI        | Parameter-gated alternative methods         |
| D12 | JSON-lines logger with an allowlisted, closed event set                | Free-form log lines                         |
| D13 | Console commands in the existing `commands/` style                     | A separate operator CLI binary              |
| D14 | Admin contracts in `packages/contracts`, routes under `/api/admin`     | Reusing the library's admin endpoints as-is |

## 3. Administrator role and authorization (D1)

**Decision.** One column `user.role` with exactly two values, `member` and `administrator`,
defaulting to `member`. Any number of administrators may exist, and nothing protects the
last one: the specification accepts an instance with zero administrators and recovers it
from the console.

Enforcement is a single guard, `requireAdministrator`, mounted on every `/api/admin/*` route.
It resolves the session through `sessionUserId()`, loads the account row, and rejects
everything that is not `role = 'administrator'` and `status = 'active'`. Hiding controls in
the dashboard is presentation only; the guard is the authorization.

The library's admin plugin supplies the primitives we do not want to reimplement —
`listUsers`, `setRole`, `updateUser`, `banUser`, `unbanUser`, `listUserSessions`,
`revokeUserSession` — configured with `adminRoles: ["administrator"]` and
`defaultRole: "member"`. Three of its surfaces are closed on purpose:

- **Impersonation** is disabled. The specification explicitly rules out an administrator
  exploring another person's content, and impersonation is exactly that. If the plugin
  cannot be configured to omit those endpoints, a `hooks.before` guard rejects
  `/admin/impersonate-user` and `/admin/stop-impersonating`.
- **User creation** stays out: accounts are created by invitation (section 8) or JIT
  provisioning (section 10).
- **Role changes** go through our own endpoint so that the change and its audit record are
  one transaction.

The role is read from the database on each administrative request, never from a client
claim. Session payloads may carry `role` for rendering, and that copy is treated as
untrusted.

## 4. Configuration store (D2)

**Decision.** A table `instanceSetting(key text primary key, value jsonb not null,
revision integer not null, updated_at timestamptz, updated_by text)` holds one row per
setting document:

| Key               | Document                                                    |
| ----------------- | ----------------------------------------------------------- |
| `access.methods`  | Password and social provider enablement, with provenance    |
| `access.sso`      | The single connection's non-secret fields and its policy    |
| `password.policy` | Minimum length and the four composition requirements        |
| `sessions.policy` | Session lifetime and idle refresh                           |
| `bootstrap`       | Adoption markers: environment seed time, admin recovery use |

Each document has a Zod schema in `packages/contracts`. Writers reject unknown keys, readers
tolerate them, so a newer version of the application can add a field without a migration and
an older process never crashes on a document it does not fully understand. Updates are
conditional on the current `revision` and increment it, which gives optimistic concurrency
for free and the invalidation signal for D3.

A document never carries a credential. The client secret of a social provider is a row of
`instanceSecret(name text primary key, ciphertext text not null, updated_at timestamptz,
updated_by text)`, and the corresponding provider entry in `access.methods` holds only its
`secretName`. `clientId` stays in the document because it is not secret. Reading or copying a
setting document therefore can never expose a stored secret.

Rejected: a single JSON document (unrelated settings would share one conflict domain and one
audit record); explicit columns (every new option would need a migration, which the
specification forbids as a redesign). Secrets are never stored here — they belong to
section 7.

## 5. Applying configuration without a restart (D3)

**Decision.** `createAuth(snapshot)` becomes a factory over a frozen configuration snapshot.
A process-level holder keeps the current instance and the revision it was built from. Each
request that needs authentication resolves the holder; when the stored revision is newer, a
new instance is built and swapped atomically, while in-flight requests keep the instance
they started with. Nothing restarts, and no request pays for a rebuild it does not need.

Three things must survive a rebuild unchanged, and the design pins them explicitly: the
cookie secret and prefix (`artiflow`, from the environment), the OAuth server's signing keys
(already rows in `jwks`, not in memory), and the agent client registrations (rows in
`oauthClient`). A rebuild only re-reads access methods and policy.

Rejected: requiring a restart (the specification says configuration is modified from the UI),
and rebuilding per request (JWKS and provider metadata churn, latency on every call).

## 6. Environment configuration (D4)

**Decision.** There is no deployment of this product that configures social providers from the
environment, so there is no operator-facing migration flow: no import command, no provenance
notice in the interface, no dual-source precedence rules to reason about.

The variables keep one job, as a compatibility seed. On startup, when `access.methods` does not
exist, the application writes it from the environment pairs it already parses and records
`access.methods.provenance = { source: "environment", at: <timestamp> }`. From then on the
database is the only source of truth: the variables are never read again, and a variable that
remains set produces one structured warning that names it (never its value) and changes
nothing. An installation with no variables gets password access enabled and both social
providers disabled, which is the behaviour it has today.

This keeps a self-hosted installation that followed today's documented variables working
after the upgrade without carrying a migration interface nobody needs. Removing the seed
entirely is the alternative, and it would break those installations for no gain.

## 7. Secret storage and protection (D5)

**Decision.** Secrets are encrypted at the application layer with AES-256-GCM under a key
from `ARTIFLOW_SECRET_ENCRYPTION_KEY` (32 bytes, base64). The stored value carries its key
id: `v1:<keyId>:<iv>:<ciphertext>:<tag>`, base64 for the binary parts. Encryption and
decryption happen in `apps/api/src/settings/secrets.ts` at the boundary of the secret table,
so a caller reads a plaintext value or nothing at all and no plaintext ever reaches disk.

The row itself is `instanceSecret(name text primary key, ciphertext text not null,
updated_at timestamptz, updated_by text)`. A name identifies the secret for the document
that references it (`access.methods.google.clientSecret`,
`access.methods.github.clientSecret`, and later the SSO connection's secret), so a secret is
addressable by the setting that uses it and a rotation can find every stored value. The
setting document holds only that name; it never holds the plaintext or the ciphertext.
Presence is answered by whether the row exists, without decrypting it into a returned value.

- **Absent key.** If no secret has ever been stored, the SSO surface reports that
  encryption is unconfigured and refuses to save; the rest of the instance works. If a
  secret exists and the key is missing, startup fails closed rather than silently dropping
  the connection. A first-boot seed that finds provider variables but no key refuses to
  write anything rather than storing them unprotected.
- **Rotation.** The key id in the ciphertext allows a new key to be introduced and old
  values re-encrypted by a console command later. Rotation is not part of v1's UI; the
  format is chosen so that it does not require a schema change.
- **Never returned.** Read endpoints return `clientId` and `secretConfigured: true|false`.
  No endpoint, error message or log line ever carries the secret; the logging layer of
  section 12 is an allowlist, not a filter, so an unlisted field cannot leak by accident.

Rejected: plaintext columns (the specification refuses unprotected storage), and relying on
disk or database encryption alone (it does not survive a logical backup, and it does not
answer "who can read this row").

## 8. Users, invitations and reset links (D9)

**Decision.** The existing token machinery stays: `registrationInvite` and
`passwordResetToken`, both single-use, both consumed by a conditional update so that two
concurrent completions cannot both succeed, both stored as SHA-256 hashes with a 24 h and
1 h expiry respectively. `registrationInvite` gains `created_by` so the pending-invitation
list can show who issued it; `passwordResetToken` gains it for the same reason.

Added to the existing console commands, the administration surface gains endpoints to issue,
list, revoke and regenerate both kinds. Regeneration is revoke-then-issue inside one
transaction, so the previous link stops working the moment a new one exists. Inviting an
email that belongs to a deactivated account reactivates that account and issues a new
password flow; it never creates a second user.

Changing an email does not require verification (functional specification) and does not
touch linked identities: `account` rows are keyed by `(providerId, accountId)`, not by email,
so the invariant holds by construction. It is written to the audit log with both values.

## 9. Sessions, deactivation and revocation (D6, D7)

**Decision.** Session lifetime becomes explicit: `expiresIn` 7 days, `updateAge` 1 day,
which is today's library default made visible and configurable through
`sessions.policy`. The session cookie keeps `httpOnly`, `sameSite=lax` and the `artiflow`
prefix.

Deactivation writes `user.status = 'deactivated'`, `deactivated_at` and `deactivated_by`,
deletes that user's `session` rows, and revokes their public artifact links, all in one
transaction. Two guarantees keep it closed:

- **No new session.** A `databaseHooks.session.create.before` check rejects session creation
  for a non-active user. Credential sign-in, social sign-in, SSO and any future method all
  end in a session creation, so this is the single choke point that no route can bypass.
- **No live session.** Deleting the rows is sufficient because sessions are database-backed;
  there is no cookie cache (`session.cookieCache.enabled: false` today, and it stays off).

Reactivation clears the status, and restores neither sessions nor revoked public links.

Both session surfaces are listings over the same table: the member's own page uses
`listSessions`/`revokeSession`/`revokeOtherSessions` and marks the current one by id; the
administration surface uses `listUserSessions`/`revokeUserSession` per user. Neither ever
returns `session.token` to the browser. Closing the current session returns the member to
the login page.

## 10. Access methods and the SSO login (D10, D11)

**Decision.** The single connection is a row managed through `@better-auth/sso` (1.7.x, the
same release line as `better-auth`), configured to make the library's defaults safe for
this product:

- `providersLimit: () => 0` — only our administration API registers the connection; the
  library's self-service registration is closed.
- `domainVerification` disabled — an SMB cannot publish a DNS TXT record, and the trusted
  matrix below replaces it.
- `disableImplicitSignUp` bound to the JIT setting, and `resolveUser` implementing our own
  trust rules instead of the library's domain-only linking.
- `guardProviderMutation` rejects an edit that would drop the connection while linked
  identities exist unless the administrator confirmed the impact, which gives the
  specification's confirmation requirement a server-side home.

**Tenant validation.** Saved configuration must name a concrete issuer: HTTPS, without a
`{tenantid}`-style placeholder. The save path runs OIDC discovery and rejects a document
whose issuer is templated, which is exactly how Microsoft's `/common` and `/organizations`
authorities present themselves; the error names the fix (a single-tenant app registration,
or the tenant-scoped issuer URL). At callback, `iss` must equal the pinned issuer, and when
the IdP emits `tid` it must equal the pinned tenant. Domain allowlists are an additional
barrier and never a substitute for this check.

**Claim trust and linking.** `resolveUser` implements the specification's matrix and nothing
more:

| Existing account | IdP evidence                                        | Outcome                                  |
| ---------------- | --------------------------------------------------- | ---------------------------------------- |
| none, JIT on     | domain allowed (or any-account explicitly accepted) | create `member`, `active`                |
| none, JIT off    | —                                                   | reject, tell the person to ask the admin |
| same email       | no other SSO identity, email verified claim         | link                                     |
| same email       | no verified claim, issuer pinned to tenant + domain | link                                     |
| same email       | any other case, or a different SSO identity exists  | reject, point to the administrator       |
| any              | matched account is deactivated                      | reject; SSO never reactivates an account |

A created account is never an administrator.

**SSO-only login and the fallback.** When the connection is enabled, `/login` renders a
single button labelled with the administrator's display name and no email field. A URL
parameter (`?fallback=1`, final name confirmed in section 15) makes the page render the
conventional methods; the server does not trust it. Instead, one `hooks.before` guard covers
`/sign-in/email`, `/sign-in/social` and the SSO callback: with SSO enabled, any
non-SSO method must resolve to an `administrator` and an active account, otherwise it fails
with a generic message. Knowing the parameter therefore reveals buttons and grants nothing.

**Agent and MCP continuity.** A login started by an MCP client already carries its pending
authorization as `oauth_query` through the dashboard sign-in. The SSO redirect must preserve
it too, including the consent decision, so the original process resumes after the IdP
round-trip. This is a test, not an assumption.

## 11. Password policy (D8)

**Decision.** `password.policy` holds `{ minLength: 12, requireUppercase: true,
requireLowercase: true, requireNumber: true, requireSymbol: true }` by default. One module,
`password-policy.ts`, exposes `validate(password, policy)` returning the list of missing
requirements, and every entry point calls it:

- the library's `hooks.before` for `/sign-up/email`, `/reset-password`, `/change-password`;
- the invite-completion and reset-completion endpoints, before hashing.

`minPasswordLength` is also mirrored into the library's own password configuration so both
checks agree. Failures return the same list the interface renders, so a caller that bypasses
the UI receives exactly what the UI would have said. The policy is fetched from a public
endpoint before a form renders, and changing the policy never touches stored hashes.

## 12. Structured logging (D12)

**Decision.** A JSON-lines logger writes one object per line to stdout with a fixed shape:
`ts`, `level`, `event`, `actorId`, `actorRole`, `subjectId`, `settingKey`, `action`,
`outcome`, `reason`, `requestId`, `ip`, `origin`. `event` is a closed union declared in
`packages/contracts`, so an unregistered event is a type error rather than a typo in
production. Administrative mutations, invitation and reset issuance, fallback use, session
revocation, deactivation and purge each emit their event in the same transaction that
performs the change, or immediately after it commits when the transaction cannot carry it.

There is no `body`, `token`, `link` or secret field in the shape, which is what makes
redaction structural instead of a filter that can be forgotten. Levels come from the
environment; the default keeps informational events. There is no audit UI and no export,
per the specification.

## 13. Operations (D13)

Console commands keep the existing `bun run <name>` and `apps/api/src/commands/` style, print
to stdout, and exit non-zero on refusal:

| Command                                          | Purpose                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `admin:grant EMAIL`                              | Make an existing account an administrator (first admin, recovery) |
| `admin:revoke EMAIL`                             | Return an administrator to the member role                        |
| `admin:list`                                     | Print administrator emails in order; exit 0 when there is none    |
| `user:deactivate EMAIL` / `user:activate EMAIL`  | Same semantics as the UI paths, without the UI                    |
| `user:purge EMAIL --reassign-to EMAIL`           | Delete the account, reassigning its artifacts                     |
| `user:purge EMAIL --delete-content`              | Delete the account and its artifacts                              |
| `user:invite EMAIL`, `user:reset-password EMAIL` | Unchanged                                                         |

`admin:grant` never creates an account: an unknown address is refused with a message that names
`user:invite` (resolved decision 7). `admin:revoke` refuses an unknown address and an account that
is not an administrator. `admin:list` prints one email per administrator, sorted by address, and
exits 0 with no output when the instance has none. Each role change writes one structured event
with `actorRole: "console"`, so a recovery is traceable without an account (section 12).

`user:purge` requires exactly one of the two content flags and an interactive confirmation
that repeats the email, plus `--yes` for non-interactive use. It removes identities, sessions,
tokens and the account row so nothing of that person remains usable, and it is never exposed
in the interface.

## 14. Testing strategy

Real Postgres per suite, throwaway database, the existing `test/` conventions: `*.test.ts`
for pure logic, `*.integration.ts` for HTTP and database behaviour, helpers in
`test/helpers/`.

| Layer       | Proves                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | Policy validation, trust matrix, config precedence, secret envelope round-trip, redaction shape                                |
| HTTP + DB   | Every map-row below, including refusals and the state left behind                                                              |
| Fake IdP    | One `test/helpers/oidc.ts` serving discovery, JWKS and token responses with switchable `iss`, `tid`, `email_verified`, `email` |
| UI          | Login rendering with and without SSO, fallback rendering, admin surface gating                                                 |
| Concurrency | Single-use invitation and reset consumption under two parallel completions                                                     |

Each acceptance criterion of the functional specification maps to at least one test: sole
administrator authority and simultaneous administrators; console first-admin and recovery;
invitation single use, expiration and revocation; reactivation of a deactivated account
without duplication; deactivation cutting sessions and revoking public links and
reactivation not restoring them; SSO-only rendering and the administrator-only fallback;
Google and GitHub surviving the upgrade and becoming administrable; policy enforcement with
and without the interface; OIDC configuration and actionable errors; JIT on creating a
member and JIT off refusing; tenant and domain rejection for foreign or personal accounts;
trusted linking preserving content; session closing on both surfaces; sensitive actions
logged without credentials.

## 15. Resolved decisions

Answered before implementation started. The first, second, fourth and fifth came from the
product owner; the rest are technical calls recorded here with their reason.

1. **Dependency — `@better-auth/sso` 1.7.x**, the same release line as `better-auth`. It brings
   OIDC discovery, both client-secret and `private_key_jwt` token authentication, and SAML on
   the same row for the later SAML work. Pinned and upgraded deliberately; a hand-written OIDC
   client was rejected because the trust matrix is the part we must own and the protocol
   plumbing is not.
2. **Session lifetime — 7 days with a 1-day activity refresh**, today's library default made
   explicit and configurable through `sessions.policy`. Shorter and longer options stay
   available per instance without code changes.
3. **Fallback parameter — `?fallback=1`** on `/login`. It only affects rendering; the
   server-side guard of section 10 is what decides whether an alternative method is allowed.
4. **Environment configuration — no migration flow**, because no deployment configures
   providers that way. The first-boot seed described in section 6 stays as a compatibility
   path for self-hosted installations that followed the documented variables.
5. **Deactivation model — our own `user.status`** with date and author. The library's ban stays
   an internal primitive of the admin plugin; reactivation semantics and public-link
   revocation remain ours.
6. **Encryption key — `ARTIFLOW_SECRET_ENCRYPTION_KEY`**, 32 bytes base64, with the SSO surface
   disabled while it is unset and startup failing closed once a secret exists.
7. **`admin:grant` — refuses an unknown email** and points at `user:invite` first. Creating an
   account from the console would duplicate the invitation path with a weaker flow (no
   password chosen by the person, no consent) for no benefit; it stays available by inviting
   and granting immediately after.

## 16. Risks

- **A rebuild-triggered inconsistency.** Applying configuration by swapping the auth instance
  can strand a request in the middle of an OAuth flow. Mitigation: the swap is atomic and
  in-flight requests finish on the instance they started with; a test drives a sign-in across
  a configuration change.
- **Secrets availability.** Losing the encryption key means losing the connection
  configuration and re-entering it. Start-up fails closed rather than degrading silently.
- **Trust matrix regressions.** The linking rules are the security heart of SSO and are
  implemented in one hook. Every row of the matrix gets its own test with the fake IdP.
- **Library coupling.** Using the SSO plugin means tracking its release line; pinning 1.7.x
  and upgrading deliberately is cheaper than owning an OIDC implementation.
- **Purge.** Deleting an account touches owned artifacts, shares, comments and tokens; the
  reference graph must be enumerated against the real schema when that deliverable starts,
  and the reassignment path tested with both kinds of content.
