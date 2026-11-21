# Authentication and access management

Preimplementation design for instance-level user administration and authentication:
administrator role, administrable access methods, user lifecycle, invitations, sessions,
password policy and one enterprise OIDC connection. It states what we build and why, and
what we deliberately do not build. Status: implemented, except where a section records that
the shipped build does something narrower than the design.

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
| `access.sso`      | The single connection: issuer, client id, scopes, policy     |
| `password.policy` | Minimum length and the four composition requirements        |
| `sessions.policy` | Session lifetime and idle refresh, declared in the store but not read or written by any endpoint in this build |
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

**Administration endpoints.** `access.methods` is written and read through two routes behind
the administrator guard:

- `GET /api/admin/access` answers `{ revision, passwordEnabled, providers: { google, github },
  provenance }`, where each provider carries `{ enabled, clientId, credentialConfigured }`.
  Presence is answered by a row lookup; the credential value and the ciphertext never appear.
  When the document is absent the answer is the environment-adopted state the first-boot seed
  would write, with `revision: null`.
- `PUT /api/admin/access` takes the same shape plus an optional `clientSecret` per provider,
  requires the public origin like every cookie mutation, and answers the refreshed
  configuration. A supplied credential is encrypted and stored in the same transaction that
  writes the document, so a write that loses the revision race leaves no secret behind. A
  provider may be enabled only with a non-blank `clientId` and either an already stored
  credential or a supplied one; otherwise the request is refused with
  `provider_client_id_required` or `provider_credential_required` and nothing is stored.
  Supplying a credential while `ARTIFLOW_SECRET_ENCRYPTION_KEY` is unset is refused with
  `secret_encryption_unconfigured`, and a `revision` that no longer matches answers
  `revision_conflict` (409). The document records `provenance.source = "administrator"` once
  the administration owns it.

Each applied change emits one `access.methods.updated` event with the actor, the settings key
and the outcome; a refused change emits nothing.

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

**Snapshot.** `readAccessSnapshot` turns `access.methods`, the password minimum from
`password.policy` (section 11) and the credentials the access document names into a frozen
value: password enablement, `passwordMinLength`, and one `{ clientId, clientSecret }` entry
per provider that is enabled, carries a `clientId` and whose named credential decrypts. A
provider that is enabled but unusable — blank fields, no stored credential, a credential
encrypted under an unknown key, a credential that fails authentication — is left out of the
snapshot and listed as degraded; the boot and the request that triggered the rebuild both
continue. Nothing in the snapshot is logged, and the document is never rewritten with a
secret.

**Refresh.** The holder reads one revision signal for the whole settings table before each
authenticated operation: `readSettingsRevision` in `apps/api/src/settings/store.ts` answers
the number of writes applied to `instanceSetting`, which grows by one on every insert and on
every update, so a change to any settings document is a new revision and nothing has to be
probed key by key. An unchanged revision returns the current instance, so repeated requests
cost one aggregate row and no build; a changed revision builds once, and concurrent requests
at that revision share the build instead of racing. A build that fails, or a revision that
cannot be read at all, leaves the last good instance in force. When a document does not exist
yet — first boot before the compatibility seed, or a process that runs without the settings
layer — the snapshot derived from the environment (section 6) stays in force and the seeded
default policy supplies the password minimum.

The environment keeps owning two things the swap must not touch: the cookie secret and
prefix, and the profile gate that decides whether password login is allowed at all. The
effective password login is that gate combined with the stored `password.enabled`, so a
stored enablement never opens a profile the process already closed.

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
`access.methods.github.clientSecret` and `access.sso.clientSecret`), so a secret is
addressable by the setting that uses it and a rotation can find every stored value. The
setting document holds only that name; it never holds the plaintext or the ciphertext.
Presence is answered by whether the row exists, without decrypting it into a returned value.

- **Absent key.** If no secret has ever been stored, the SSO surface reports that
  encryption is unconfigured and refuses to save; the rest of the instance works. If a
  stored secret can no longer be decrypted — no key, or a different one — the provider or
  connection that names it is left out of the sign-in snapshot and the rest of the instance
  keeps serving, so sign-in through it stops while the document still reads enabled; the
  credential has to be entered again under the key in force. A first-boot seed that finds
  provider variables but no key refuses to write anything rather than storing them
  unprotected, and startup fails with the reason.
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
1 h expiry respectively. `registrationInvite` gains `createdBy`, `userId` and `revokedAt`;
`passwordResetToken` gains `createdBy`. Migration 0018 adds all four as nullable columns, so
applying it leaves every existing row unattributed and never fails on one. `createdBy` is the
account that issued the link (`null` for the console commands and for every row written before
the migration) and references `user` with `on delete set null`, so removing an administrator
never removes an invitation. `userId` binds an invitation to the account it was issued for and
references `user` with `on delete cascade`, so purging that account takes its pending invitation
with it.

**Administration endpoints.** All of them sit behind the administrator guard, and every mutation
also behind the cookie mutation guard:

- `GET /api/admin/invitations` answers `{ invitations }` with the pending ones — not consumed,
  not revoked, not expired — ordered by expiry. A row carries `id`, `email`, `expiresAt`,
  `createdAt` and `issuedBy` (`{ id, name, email }`, or `null` for a link the console issued).
  No read ever returns a link or a hash: the link is answered once, by the call that creates it,
  and never afterwards.
- `POST /api/admin/invitations` takes `{ email }` and answers `{ invitation, link, reactivated }`.
  A malformed address answers `400 invalid_email` and an address that already holds an active
  account `409 email_in_use`, both without writing anything. An address that holds a deactivated
  account is reactivated through the same conditional write as the status endpoint, so it records
  its own `user.reactivated` event, and the invitation is issued on that same account with
  `reactivated: true`; a second account for the address is never created. Completing such an
  invitation sets that account's password — which is what `userId` is for — and leaves its name
  unchanged; an invitation with no bound account keeps refusing an address that gained an account
  after issuance, exactly as before.
- `POST /api/admin/invitations/:id/revoke` answers `{ invitation: { id, revokedAt } }`. The write is
  conditional on the row still being pending, so two concurrent revocations apply exactly once.
- `POST /api/admin/invitations/:id/regenerate` revokes the previous invitation and inserts the new
  one in the same transaction, and answers `{ invitation, link }` for the new row. The previous
  link stops working the moment that transaction commits.
- `POST /api/admin/reset-links` takes `{ email }` and answers `{ link, expiresAt }` for an existing
  active account, replacing any pending reset link of that account. An address with no account
  answers `404 user_not_found` and a deactivated account `409 account_deactivated`, so a reset
  link is never the way back into a deactivated account; a malformed address answers
  `400 invalid_email`.

Refusals are named and stable: `invitation_not_found` (404) and `invitation_consumed`,
`invitation_expired` and `invitation_revoked` (409) for revoke and regenerate, `invalid_email`
(400), `email_in_use` and `account_deactivated` (409), `user_not_found` (404). The public preview
and completion keep their single generic refusal, so whoever holds a link cannot learn whether it
was revoked, consumed, expired or never existed.

Each applied operation emits one event naming the actor and the subject: `invitation.created`,
`invitation.revoked` and `invitation.regenerated` with the invitation id, and
`password.reset.issued` with the account id. `invitation.regenerated` names the invitation it
created; the revocation it performs belongs to the same operation and carries no second line. A
refused operation records nothing and writes nothing, and no event or stored row carries a link
or a token.

The console commands speak the same tables, so a link they print is pending in the administration
list and completes the same way; the only difference is that `issuedBy` is `null`.

Changing an email does not require verification (functional specification) and does not
touch linked identities: `account` rows are keyed by `(providerId, accountId)`, not by email,
so the invariant holds by construction. It is written to the audit log with both values.

The user directory is read and edited through two routes behind the administrator guard:

- `GET /api/admin/users?page=&pageSize=&search=&role=&status=` answers `{ users, total, page,
  pageSize }`. A row carries `id`, `name`, `email`, `role`, `status` (the stored account status,
  `active` or `deactivated`), `accessMethods` (the
  `providerId` of every `account` row of that person, credential included) and
  `lastActivityAt` (the newest `session.updatedAt`, `null` when the person never signed in).
  Pages default to 20 rows and are capped at 100; `search` is a case-insensitive substring
  match over name and email, `role` filters on the stored role, `status` filters on the stored
  account status (`active` or `deactivated`), both filters combine with each other and with
  `search`, and a page past the end answers an empty list with the real total rather than an
  error. The page and the total are
  two statements, and the access methods and last activity are aggregated inside the page
  statement, so the number of queries does not grow with the rows returned.
- `PATCH /api/admin/users/:id` takes `{ name, email }`, requires the public origin like every
  cookie mutation, and answers `{ user }` with the updated row. The name is trimmed, the
  address is canonicalized exactly as the invitation flow does, and `account` rows are never
  touched. A blank name answers `invalid_name` and a malformed address `invalid_email` (400),
  an address another account already holds answers `email_in_use` (409), and both refusals
  leave the stored row untouched. Every applied edit emits one `user.updated` event naming
  the actor and the affected person, with `emailBefore` and `emailAfter` when the address
  changed.

## 9. Sessions, deactivation and revocation (D6, D7)

**Decision.** Session lifetime is the library's own, 7 days with a 1-day activity refresh. The
session cookie keeps `httpOnly`, `sameSite=lax` and the `artiflow` prefix. `sessions.policy` is
declared in the store for the later configurable version, but no endpoint or page reads or
writes it in this build, so the lifetime is fixed in code.

Deactivation writes `user.status = 'deactivated'`, `deactivated_at` and `deactivated_by`,
deletes that user's `session` rows, revokes the refresh tokens issued to that account, and
revokes their public artifact links, all in one transaction. `user.status` is a two-value
column defaulting to `active`, so applying the migration deactivates nobody and every
existing account keeps working. Three guarantees keep it closed:

- **No new session.** A `databaseHooks.session.create.before` check rejects session creation
  for a non-active user. Credential sign-in, social sign-in, SSO and any future method all
  end in a session creation, so this is the single choke point that no route can bypass.
- **No live session.** Deleting the rows is sufficient because sessions are database-backed;
  there is no cookie cache (`session.cookieCache.enabled: false` today, and it stays off).
- **No surviving bearer token.** Access tokens are signed JWTs with a fifteen-minute lifetime
  that outlive the session, so both bearer surfaces — `/mcp` and `/api/v1` — resolve the
  token's subject against `user.status` after the signature check and refuse anything but an
  active account with `401 invalid_token`. A token that carries no subject resolves to no
  account, so it is refused the same way instead of skipping the check. The refresh tokens
  issued to that account are revoked in the same transaction as the status, so no new access
  token can be minted. Revocation is per account: it touches only rows whose user id is the
  account being deactivated, so a row that names no account and every row of another account
  keep their state.

`requireAdministrator` also refuses a non-active account, so an administrator loses the
administration namespace at the same moment as everything else.

Reactivation clears the status, `deactivated_at` and `deactivated_by`, and restores neither
sessions, nor revoked public links, nor revoked tokens.

**Endpoint.** `POST /api/admin/users/:id/status` takes `{ status: "active" | "deactivated" }`,
requires the public origin like every cookie mutation, and answers `{ user: { id, status } }`.
A target state the account already holds answers `409 status_unchanged` and changes nothing;
the status write is conditional on the state the transition read, so two concurrent requests
for the same transition apply exactly once and the losing writer changes nothing, records
nothing and answers that same `409`. An unknown subject answers `404 user_not_found` and a
body that names no known state `400 invalid_body`. Each applied change emits one
`user.deactivated` or `user.reactivated` event naming the actor and the person; a refusal
emits nothing. Nothing on this path deletes content: artifacts, revisions, comments and the
share grants the person issued keep their rows, and the people they shared with keep reading
them.

A deactivated account is not an available recipient: resolving an address for a new share only
answers an active account, so sharing with a deactivated person is refused exactly like an
address that holds no account, with `recipient_not_found`. The rule bounds who a new grant may
name and nothing else — a grant made before the deactivation keeps its row and keeps reading the
artifact, so a reactivated account returns to the artifacts it was already given without a new
share.

Both session surfaces are listings over the same table, and neither ever returns `session.token`
to the browser or to the log. A listed session carries `id` (the row identifier, safe to show),
`startedAt` (the row's `createdAt`), `lastUsedAt` (the row's `updatedAt`), `ipAddress` and
`userAgent` (`null` when neither was recorded) and `current`, true for the single row behind the
caller's own cookie. Closing a session deletes its row: sessions are database-backed with no
cookie cache, so the cookie stops resolving on the next request, and closing the cookie's own
session ends that session too.

**Administration endpoints.** All of them sit behind the administrator guard, and the two
mutations also behind the cookie mutation guard:

- `GET /api/admin/users/:id/sessions` answers `{ sessions }`, with `current` true only when a
  listed row belongs to the calling administrator's own account. An unknown account answers
  `404 user_not_found`.
- `POST /api/admin/users/:id/sessions/:sessionId/revoke` answers `{ session: { id } }` and deletes
  the row, scoped to that account. An unknown session, or a session of a different account,
  answers `404 session_not_found` and changes nothing.
- `POST /api/admin/users/:id/sessions/revoke` deletes every session of the account and answers
  `{ revoked }` with the number of closed rows; an unknown account answers `404 user_not_found`.

Each applied closure emits one event naming the actor and the subject account:
`session.revoked` also names the closed session's id, and `sessions.revoked` covers the closure of
all of them. A closure that closes no row records nothing, and no event carries a token.

**Account endpoints.** A member manages their own sessions on a namespace separate from the
administration one; the reads need a session cookie and the mutations require the public origin
like every cookie mutation:

- `GET /api/account/sessions` answers `{ sessions }` for the calling account, with `current` true
  for the session behind the cookie that answered.
- `POST /api/account/sessions/:id/revoke` answers `{ session: { id } }`. A session of another
  account is refused exactly like one that does not exist — `404 session_not_found`, never `403` —
  so the answer never confirms that somebody else's session exists.
- `POST /api/account/sessions/revoke-others` closes every session of the account except the one
  behind the cookie and answers `{ revoked }`.

An anonymous caller answers `401 sign_in_required`. Self-service closures are not administrative
operations and record no event. Closing the current session returns the member to the login page.

**Account surface.** `/account` lists the sessions of the person who is signed in, under a Sessions
heading: each row shows when it started, when it was last used, the address and the browser when the
server recorded them, and the row behind this browser is marked as the current one. The address is
shown as stored and the browser is described from the recorded agent, never echoed raw; no row, no
answer and nothing the page keeps carries a session token. Closing one session asks first, in a
dialog that names what it does: for another session, that the browser holding it has to sign in again
while this one stays signed in; for the current one, that this browser is signed out and returned to
`/login`. Closing every other session states how many rows it closed and leaves this browser signed
in. The page then reads the list again, because the stored rows are what it shows. A session that
vanished between the read and the action answers `session_not_found`; the page reports it plainly and
reads the list again instead of guessing, and a read that fails after a list has loaded keeps that
list on screen under the failure.

## 10. Access methods and the SSO login (D10, D11)

**Administration surface.** The administration routes sit under one shell: a header that
names the area, navigation between Users, Access and Invitations, and a single refusal
screen. It has no entry in the member navigation and shares the session, the deployment
and the administrator guard with the rest of the product. The only entry point is the
account menu of the member product, where account-level actions already live, and it is
rendered only when the session payload carries the administrator role; that copy is
presentation, the guard is the authorization. A session that is not signed in is sent to
`/login` with a return path, and a signed-in member receives the refusal as a plain
message with a way back to the library, never an empty shell.

`/admin/access` edits `access.methods`. The page reads
`GET /api/admin/access` and writes the whole document through `PUT /api/admin/access`,
showing password enablement, each provider's enablement, its `clientId`, and whether a
credential is stored. A stored credential is rendered as presence only: the credential
field is empty, can replace the stored value, and is never prefilled or displayed.
Every refusal of section 4 is rendered in its own words, and a `revision_conflict`
reloads the stored document and asks the administrator to review it before saving again.

`/admin/users` is the directory of section 8. Search, the role filter, the status filter
and the page are server-side: the page sends `page`, `pageSize`, `search`, `role` and
`status` to `GET /api/admin/users` and never loads the whole directory to filter it
locally. A row
shows name, email, role, status, access methods and last activity, and the footer shows the total
with the page it belongs to. An empty answer names the next step instead of showing a
blank table: the console command that issues the first invitation, or the filter to
clear. Editing sends `PATCH /api/admin/users/:id` with the name and the email, states
that no verification is required in this version, and replaces the edited row with the
answered row instead of reloading the page. The role toggle uses
`POST /api/admin/users/:id/role` and reads its `changed` flag, so a no-op says so. Each
named refusal of the edit and of the role change — `invalid_name`, `invalid_email`,
`email_in_use`, `user_not_found` — is rendered in its own words, and the raw code is
never shown.

The edit panel holds one source of truth per row: the draft keeps the name and the email
being typed and nothing else, and the committed role is read from the row itself, so a
save cannot leave a second, stale copy of the role in the form.

Lifecycle controls sit in the same panel. Deactivating is confirmed before it happens, in
a dialog that states the consequences rather than asking a bare yes: no sign-in by any
method, the open sessions end, the public links to that person's artifacts are revoked,
and nothing is deleted, so the artifacts, comments and shares keep their rows and the
people they were shared with keep reading them. Reactivating says the opposite is not
true either: it restores access, not the sessions that ended and not the links that were
revoked. Each control sends the status the administrator chose to
`POST /api/admin/users/:id/status` and renders `status_unchanged`, `user_not_found`,
`invalid_body` and the guard's own refusals in their own words, never as a raw code. The
directory is then read again, because the stored state, not the button, is what the page
shows.

A read that fails after a page has already loaded keeps that page on screen and reports
the failure above it, naming the table as the last page that loaded. It never swaps a
table the administrator is reading for the refusal screen, and it never shows the refusal
screen with the rows still behind it: the refusal screen belongs to the state before the
first successful read.

`GET /api/admin/users` answers the stored status on every row, so the table carries a
status column beside the role and the edit panel shows the same value it acts on. That
column and the status filter read the same field, and the lifecycle control is one toggle
driven by the row: it offers only the status the account does not hold, so an
administrator cannot ask for a transition the account already stands in and cannot reach
the `status_unchanged` refusal from the interface. Both directions keep the confirmation
that states the consequences before anything is sent.

`/admin/invitations` is the surface for section 8: an address field issues through
`POST /api/admin/invitations`, and the pending list shows each row's email, its issuer
(`issuedBy`, or the console when the row carries none), the day it was issued and the day
it expires. Every row carries revoke and regenerate, sent to
`POST /api/admin/invitations/:id/revoke` and `.../regenerate`; the page then reads the
list again instead of editing it locally, because the stored rows are what it shows.

A link is a bearer credential, so the page keeps it in component state only, for the
moment of the call that created it: the answer to issuing or regenerating renders once
with a copy action and the statement that it cannot be seen again, and dismissing it, or
reloading at any point, leaves nothing behind. No link, hash or cookie is written to
`localStorage`, `sessionStorage`, the URL or the console. Issuing for an address that held
a deactivated account states that the account is active again and that this invitation
sets its password, so the reactivation the server performed is never silent.

`/admin/users` also issues reset links for the account open in the edit panel, through
`POST /api/admin/reset-links`, with the same one-time reveal and the statement that only
an active account can receive one. `user_not_found`, `account_deactivated`,
`invalid_email` and the guard's refusals render in their own words, so a deactivated
account is never reported as a missing one.

The sessions of that account open from the same panel, through `Open sessions`, which reads
`GET /api/admin/users/:id/sessions` and renders the rows of section 9: started, last used, address,
browser, and `current` marked as the administrator's own session when the account being read is the
caller's. Closing one row and closing all of them each ask first, in a dialog that states what it
does — the browser holding that session needs a new sign-in, the account, its password and everything
it owns stay as they are, and, for the caller's own session, this browser returns to the login screen.
The panel reads the list again after every closure, reports a session that vanished plainly and then
refreshes, and never renders a session token or writes one to storage.

**Decision.** The single connection is a row managed through `@better-auth/sso` (1.7.x, the
same release line as `better-auth`), configured to make the library's defaults safe for
this product:

- `providersLimit: () => 0` — only our administration API registers the connection; the
  library's self-service registration is closed.
- `domainVerification` disabled — an SMB cannot publish a DNS TXT record, and the trusted
  matrix below replaces it.
- `disableImplicitSignUp` permanently on — `resolveUser` provisions and links, so the library's
  own sign-up path never runs — and `resolveUser` implementing our own trust rules instead of the
  library's domain-only linking.
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

The pinned tenant is derived from the saved issuer in one place, `ssoPinnedTenant` in
`apps/api/src/settings/sso-connection.ts`: the last path segment once a version segment such as
`v2.0` is dropped, lower-cased. So `https://login.microsoftonline.com/<tenant>/v2.0`,
`https://sts.windows.net/<tenant>/` and `https://idp.example.test/tenant-a` all name their
tenant, and the `tid` claim of the verified ID token is compared against that value. A token
whose `iss` is not the saved issuer, whose `tid` names another tenant, or whose `tid` arrives
while the issuer names no tenant at all, is refused with `sso_tenant_mismatch` before the
account is looked up, so an allowed domain never rescues it. An issuer with no tenant segment
(`https://idp.example.test`) pins the issuer alone and accepts a token only when it asserts no
tenant: a claim that could not be checked against anything fails closed. SAML identities carry
no ID token, so they are pinned by their assertion issuer only; this product registers OIDC
providers exclusively.

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

**SSO-only login and the fallback.** `/login` renders what
`GET /api/auth/capabilities` answers and nothing else: the password form only when password login
is enabled, and one action per enabled social provider. While the connection is enabled the page
renders one primary area labelled with the administrator's display name and asks for no email
first, and the conventional methods are not rendered at all. A URL parameter (`?fallback=1`,
resolved in section 15) reveals them, under copy that states the alternative is emergency access
for administrators and that opening the page grants nothing by itself. The server does not trust
the parameter, and nothing on the server authorizes an action from a query parameter, so knowing
it reveals buttons and grants nothing: a refused administrator-only sign-in is answered and
rendered as an ordinary rejected credential, in the same words every other failed password check
receives, and the copy never suggests otherwise. A connection published with
`fallbackAvailable: false` promises no alternative and renders none.

Signing in through the connection is one action labelled with the administrator's display name and
asking for no email, and it starts the flow: the page sends `providerId` and the path it should
come back to, `POST /api/auth/sign-in/sso` answers the authorization URL, and the browser leaves
for the identity provider. The action renders only while the connection is published; an
instance without one keeps the methods it answered. The MCP continuation form on `/login`
offers the same action and passes its own query as the callback, so the pending authorization
survives the round trip and the process resumes where it stopped. A refusal that comes back from
the provider lands on the page that can state it, and the copy is chosen by the refusal code —
`login-methods.ts` keeps `ssoFailure` beside `loginSurface`, so the page never renders text the
identity provider supplied. The rules sit in one pure function,
`apps/dashboard/src/login-methods.ts`, over the answered capabilities and the query, so the
page holds no second copy of them: until the read answers no method is rendered, and a failed
read states that the methods could not be loaded instead of falling back to the conventional
form the instance may have locked.

The provider is registered from the stored document, never from a row of its own. Every build
of the auth instance of section 5 turns one enabled, locally valid document into the library's
`defaultSSO` provider — pinned issuer, its discovery address, the client id, the decrypted
credential and the scopes — and the plugin's own self-service routes are disabled and its
provider limit is zero, so nothing but our administration API can publish a connection. The
document decides everything: a change to it is a new revision, so the rebuilt instance carries
the new provider without a restart, and an absent, disabled or locally unusable document
registers nothing and leaves the instance answering exactly as before. The connection is
therefore the only source of truth: the library's provider table is created by its own migration
(`drizzle/0019_reflective_matthew_murdock.sql`) and declared to the adapter the auth instance
receives, but nothing writes it while the document is the configuration. The plugin's own
provider reads and writes stay disabled, so a row in that table can never become a second,
divergent answer to what the connection is.

Two consequences are pinned here. The identity provider's origin joins the instance's trusted
origins while a connection is registered, because the library fetches discovery, the JWKS and
the user information endpoint through the same origin allowlist that guards redirects;
save-time validation of section 10 is what makes that substitution acceptable. And the issued
ID token is the trust evidence: `resolveUser` reads the verified token's `email_verified` claim,
never the unverified user information response, and the pinning rules of the next subsection
build on that claim only.

**The refusal matrix as implemented.** `apps/api/src/identity/sso-resolution.ts` answers with
one named code per refusal, and the login page renders each in its own words through
`ssoFailure`, never text the identity provider supplied:

| Situation                                                                 | Refusal                    |
| ------------------------------------------------------------------------- | -------------------------- |
| a first sign-in while just-in-time provisioning is off                    | `sso_account_unknown`      |
| a matched account that is deactivated                                     | `sso_account_deactivated`  |
| an existing account with an unverified claim and a foreign domain          | `sso_email_unverified`     |
| an address or an enterprise identity bound to another account              | `sso_identity_conflict`    |
| a first sign-in on a domain outside the allowlist, without explicit acceptance | `sso_domain_not_allowed` |
| a token from another tenant, or from an issuer this build did not pin      | `sso_tenant_mismatch`      |

The domain refusal names the fix it needs: the administrator can allow the domain or turn the
explicit any-account acceptance on. Every refusal leaves the stored rows untouched: no account,
no identity and no session is written, and the account that matched a refused sign-in keeps its
status and its address. Nothing in the matrix reactivates an account or edits a profile.

**Who writes the rows.** The resolver owns provisioning and linking, and the library's own
sign-up path stays closed: `disableImplicitSignUp: true` is on whatever the JIT switch says, so
the library can never create an account from a provider profile. A created account is written
inside the resolver with the address lower-cased, `status: active`, `role: member` and
`emailVerified` taken from the verified claim, and its identity row is written beside it under
the same rules. The role is never read from a provider claim, so an administrator-ish `role`,
`groups` or `roles` claim grants nothing. A linked account keeps the address and the profile it
had: the resolver answers `link` with `profile: "preserve"`, and the account is matched on the
lower-cased address, so a provider that answers in another case neither duplicates the account
nor rewrites the stored one.

**Concurrency.** `user.email` and the pair `(providerId, accountId)` of the account table are
unique, and both writes are `insert … on conflict do nothing`: a losing racer reads the row the
winner committed and resolves to the same account instead of creating a second one. Two
simultaneous first sign-ins for the same address and identity therefore end with one account,
one identity row and two sessions, never two accounts. The identity row is written before the
library finalizes the sign-in, so the library always finds the account it must bind and never
creates a second one of its own.

The server decides in two places, both inside the auth instance built from the snapshot, so a
configuration change reaches them through the rebuild of section 5:

- `GET /api/auth/capabilities` publishes the login surface. `emailPassword`, `registration`
  and `socialProviders` stay as they were, and only while the connection is enabled an `sso`
  object is added with `displayName`, `fallbackAvailable` and
  `fallbackAdministratorsOnly: true`. An absent or disabled connection publishes no `sso` key
  at all, so an instance without SSO answers exactly the shape it answered before. The read
  never carries a client id, a credential, a secret name or the issuer.
- `apps/api/src/login/fallback-lock.ts` is a plugin with one `hooks.before` and one
  `hooks.after`. With the connection enabled and password login effectively available, the
  `before` hook on `/sign-in/email` resolves the submitted address to an active administrator
  and otherwise throws the library's own `INVALID_EMAIL_OR_PASSWORD` refusal: a member, an
  unknown address, a deactivated account and a wrong password are answered byte for byte the
  same, and no session is created. With the connection enabled, the `after` hook on
  `/sign-in/social` and `/callback/:id` inspects the session the flow just created; when its
  account is not an active administrator it expires the session cookies, deletes the session
  row and clears the request's new-session record before the response leaves, so the redirect
  that follows carries no usable credential.

Neither point can be bypassed from outside the instance. Both hooks run inside the auth
handler, on the only routes that create a password or a social session — sign-up is closed —
and after the app-level JSON and origin guards, which leave no form-encoded body the hooks
would fail to read. Underneath them the session-creation hook of section 9 still refuses a
non-active account, and the agent surfaces of section 9 resolve a bearer token against the
same account row. The SSO callback is deliberately outside both matchers: it is the primary
path, not the alternative.

**The connection document.** `access.sso` holds one document, written only through the
administration routes of the next subsection and read leniently everywhere else:

| Field               | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `enabled`           | Whether the connection is published to the login surface               |
| `displayName`       | The label the sign-in page shows                                       |
| `issuer`            | The concrete HTTPS issuer of the application registration              |
| `clientId`          | The non-secret client id                                               |
| `clientSecretName`  | The name of the encrypted credential row, `access.sso.clientSecret`    |
| `scopes`            | Requested scopes; `openid`, `profile` and `email` by default           |
| `jitProvisioning`   | Whether a first authorized sign-in creates a member account            |
| `allowedDomains`    | The bare hostnames the domain barrier admits                            |
| `acceptAnyAccount`  | Explicit acceptance of every account the provider authenticates        |
| `provenance`        | Which administrator wrote it and when                                   |

The credential itself is a row of `instanceSecret` (section 7) and never appears in the
document. A read answers `credentialConfigured` from that row's existence, so presence is
visible and the value never is.

`apps/api/src/settings/sso-connection.ts` owns the lenient read: the connection counts as
enabled only when the stored document is an object whose `enabled` is literally `true`, the
display name is its non-blank `displayName` string, and every other field falls back to the
default of the table above. An absent, malformed or disabled document means SSO is off, and a
document written before this deliverable keeps working. A connection enabled without a display
name still locks the alternative methods: the lock fails closed and only the label is missing.

**Save-time validation.** `PUT /api/admin/sso` refuses a document the instance could not
safely publish, and each refusal is a named code the surface renders in its own words:

| Refusal                                                                                  | Rule                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sso_issuer_insecure`                                                                    | The issuer must be HTTPS.                                                                                                                                                                                                                                                                           |
| `sso_issuer_invalid`                                                                     | The issuer must be one concrete URL, without template placeholders, query or fragment.                                                                                                                                                                                                              |
| `sso_issuer_templated`                                                                   | The authority is multi-tenant — `/common`, `/organizations`, `/consumers`, or a discovery document advertising a `{tenantid}` issuer — so it does not name the authorized tenant. The message asks for a single-tenant registration or the tenant-scoped issuer.                                     |
| `sso_discovery_unreachable`                                                              | Discovery at `<issuer>/.well-known/openid-configuration` failed, timed out or answered an error status. A network failure is a refusal, never a success.                                                                                                                                            |
| `sso_discovery_invalid`                                                                  | The answer is not JSON or carries no `issuer`.                                                                                                                                                                                                                                                      |
| `sso_issuer_mismatch`                                                                    | The advertised issuer differs from the address given.                                                                                                                                                                                                                                               |
| `sso_display_name_required`, `sso_client_id_required`, `sso_credential_required`          | An enabled connection needs its label, its client id and either a stored credential or a supplied one.                                                                                                                                                                                              |
| `sso_scopes_invalid`                                                                     | At least one requested scope.                                                                                                                                                                                                                                                                        |
| `sso_domain_required`                                                                    | Just-in-time provisioning needs at least one allowed domain, and the any-account flag does not lift that requirement: the tenant is the first barrier and the domain list narrows it.                                                                                                                |
| `sso_domain_invalid`                                                                     | Domains are bare hostnames — no scheme, path, wildcard or address — normalized to lower case and de-duplicated.                                                                                                                                                                                     |
| `secret_encryption_unconfigured`                                                         | A credential cannot be stored without `ARTIFLOW_SECRET_ENCRYPTION_KEY`.                                                                                                                                                                                                                              |

Nothing but the code leaves the server: the discovery body, an advertised metadata field, a
token and the credential are never logged and never returned. A refused save stores no
document, no credential and records no event; an applied change stores the credential and the
document in one transaction and emits exactly one `access.sso.updated` event.

**Readiness rule.** Enabling the connection publishes a login surface, so it is allowed only
while this build can start that sign-in: `SSO_SIGN_IN_AVAILABLE` is `true` in
`apps/api/src/settings/sso-connection.ts`, the write path accepts `enabled: true` once the field
and discovery checks have passed, and the read publishes `readiness: { signInAvailable: true }`.
The constant is checked after the field and discovery validations so a document that cannot sign
anyone in is still refused for its own reason, and it exists because the sequencing hazard is
real: publishing a connection nobody can use locks every non-administrator out of password and
social sign-in.

**Endpoints and page.** `GET /api/admin/sso` answers the document, `credentialConfigured`,
the redirect URI the administrator registers at the identity provider
(`<public origin>/api/auth/sso/callback/artiflow`, derived in one place so the provider
registration of the sign-in deliverable cannot drift from it) and the readiness state.
`PUT /api/admin/sso` writes it with the revision check, answering `revision_conflict` (409)
when another administrator saved first. Both sit behind the administrator guard, the cookie
mutation guard and the JSON content-type guard. `/admin/sso` renders inside the administration
shell and is reached from `/admin/access`, so the shell keeps its four sections: every field,
the readiness statement, the redirect URI with a copy action, each refusal in its own words,
the any-account warning whenever that flag is on, and the domain list edited row by row
rather than as free text.

**Agent and MCP continuity.** A login started by an MCP client already carries its pending
authorization as `oauth_query` through the dashboard sign-in. The SSO redirect must preserve
it too, including the consent decision, so the original process resumes after the IdP
round-trip. This is a test, not an assumption.

## 11. Password policy (D8)

**Decision.** `password.policy` holds `{ minLength: 12, requireUppercase: true,
requireLowercase: true, requireNumber: true, requireSymbol: true }` by default. The schema and
that default live in `packages/contracts`, the document in `apps/api/src/settings/store.ts`,
and the first boot writes it when absent (`apps/api/src/password-policy/seed.ts`, called by
`apps/api/src/server.ts` beside the access seed, so a stored document always exists once the
API has served a request).

One module, `apps/api/src/password-policy/policy.ts`, exposes
`validatePassword(password, policy)` returning the ordered list of missing requirements with
one bounded sentence per requirement, plus the same list for a policy read from the store. The
order is fixed — `minLength`, `maxLength`, `uppercase`, `lowercase`, `number`, `symbol` — so the
interface can render the answer as it arrives. The ceiling is the library's own 128 and is not
configurable.

Every entry point that sets a password calls it:

- `apps/api/src/password-policy/hook.ts`, installed as the library's `hooks.before`, for
  `/sign-up/email`, `/reset-password` and `/change-password`. The `/sign-up/email` branch is
  skipped while the library's public sign-up is closed, because no password is set there and
  the refusal stays the library's own `EMAIL_PASSWORD_SIGN_UP_DISABLED`;
- `apps/api/src/invites/plugin.ts`, before the invitation is consumed and before hashing;
- `apps/api/src/password-reset/plugin.ts`, after the link is proven usable and before it is
  consumed, so a refused password never spends the link and an unusable link keeps answering
  its own generic refusal whatever the password looks like.

`minPasswordLength` is also set in the library's own password configuration, so the library's
built-in length check agrees with our validator instead of refusing a password our policy
accepts. That value comes from the build, not from the request: `readAccessSnapshot` carries
the stored minimum as `passwordMinLength`, `createAuthFromSnapshot` passes it once, and a
policy change reaches the library through the rebuild in section 5 — the settings revision
moves, the next request builds an instance with the new floor, and every following request
uses that instance. No request writes the library configuration, so two concurrent requests
cannot mutate shared process state and the mirrored minimum cannot disagree with the policy
the request was judged against. Failures answer the
same list the interface renders (`missing` beside `code` and `message`), so a caller that
bypasses the UI receives exactly what the UI would have said. Changing the policy never touches
stored hashes: a password that was set under an older policy keeps working and no reset is
forced.

**Endpoints.** `GET /api/auth/password-policy` is the public read a form uses before someone
chooses a password: the policy fields, the ceiling and one `{ requirement, message }` per
active rule, with `cache-control: no-store`. It needs no session and carries no credential.
`GET /api/admin/password-policy` answers `{ revision, policy }` behind the administrator guard,
with the seeded default and `revision: null` when nothing is stored yet, and
`PUT /api/admin/password-policy` takes `{ revision, policy }`, requires the public origin like
every cookie mutation, answers the refreshed document, refuses a stale revision with
`revision_conflict` (409) and a document outside the schema with `invalid_body` (400), and
leaves the stored document untouched on either refusal. Each applied change emits one
`password.policy.updated` event carrying the actor and the settings key; a refused change emits
nothing. `/admin/password-policy` edits it in the administration shell, renders the revision and
the rule in effect, and reloads the stored document on a conflict before asking for a retry.

## 12. Structured logging (D12)

**Decision.** A JSON-lines logger writes one object per line, to stdout except where a command
answers data on stdout itself (see the console issuance note below), with a fixed shape:
`ts`, `level`, `event`, `actorId`, `actorRole`, and exactly one subject of the change —
`subjectId`, `settingKey`, or `subjectId` plus `sessionId` — and then `outcome` and, when the
request carried one, `requestId`. A `user.updated` line that moved the address adds
`emailBefore` and `emailAfter`. `event` is a closed union declared in
`apps/api/src/logging/admin-events.ts`, so an unregistered event is a type error rather than
a typo in production: `role.granted`, `role.revoked`, `user.registered`, `user.updated`,
`user.deactivated`, `user.reactivated`, `user.purged`, `session.revoked`, `sessions.revoked`,
`invitation.created`, `invitation.revoked`, `invitation.regenerated`,
`password.reset.issued`, `access.methods.updated`, `access.sso.updated`,
`password.policy.updated` and `login.fallback.used`.

Every named operation of the specification emits exactly one line, written by the change it
records:

| Operation                        | Event                                                       | Written from                                 |
| -------------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| Sign-up through an invitation    | `user.registered`                                           | the registration completion endpoint         |
| Name and email edit              | `user.updated`                                              | `apps/api/src/admin/users.ts`                |
| Role change                      | `role.granted`, `role.revoked`                              | role endpoint, `admin:grant`, `admin:revoke` |
| Activation and deactivation      | `user.reactivated`, `user.deactivated`                      | `apps/api/src/admin/lifecycle.ts`            |
| Session closing                  | `session.revoked`, `sessions.revoked`                       | `apps/api/src/admin/sessions.ts`             |
| Invitation issuance              | `invitation.created`, `invitation.revoked`, `invitation.regenerated` | `apps/api/src/admin/invitations.ts` |
| Reset issuance                   | `password.reset.issued`                                     | `apps/api/src/admin/reset-links.ts`          |
| Access method change             | `access.methods.updated`                                    | `PUT /api/admin/access`                      |
| Password policy change           | `password.policy.updated`                                   | `PUT /api/admin/password-policy`             |
| SSO connection and JIT change    | `access.sso.updated`                                        | `PUT /api/admin/sso`                         |
| Purge                            | `user.purged`                                               | `apps/api/src/admin/purge.ts`                |
| Emergency fallback               | `login.fallback.used`                                       | the lock's two enforcement points            |

The event is written inside the transaction that performs the change when the change owns
one (role, edit, lifecycle, sessions, invitations, purge) and immediately after the write
commits when it does not (the two settings documents, reset issuance, registration
completion, the fallback attempt, which records an authentication decision rather than a
write). A refused operation records nothing: the guards answer before any line, and the
conditional writes that lose a race emit nothing. `user.registered` names the account that
completed an invitation, resolved from the consumed invitation rather than from the request
body, so a completion that only sets a password on a reactivated account records the same
single line.

The fallback line names the account that attempted it and its stored role, with `outcome`
`applied` when the lock admitted the attempt and `refused` when it did not. An attempt for an
address that holds no account is recorded with `actorId` and `subjectId` `unattributed` and
`actorRole` `anonymous`; the attempted address itself is never written. The social branch is
recorded by an after-hook that reads the freshly created session before the lock destroys it,
so an admitted and a refused social attempt are the same closed line as the password ones.

There is no `body`, `token`, `link` or secret field in the shape, the only address it ever carries
is the pair on a `user.updated` line that moved one, and every line is
built from a typed object rather than from a request, which is what makes redaction structural
instead of a filter that can be forgotten: the invitation and reset issuance lines carry the
invitation or account identifier, never the link that was answered once, and the registration
and fallback lines are built from an identifier looked up from the token, never from the token.
Levels come from the environment; the default keeps informational events. There is no audit UI
and no export, per the specification.

**Console issuance.** `user:invite` and `user:reset-password` answer the link as their only stdout
line, so their audit line goes to stderr instead: a caller that redirects stdout keeps the link
untouched while the operator keeps the record. The line is the same closed shape and carries
`actorId` and `actorRole` `console`, the event — `invitation.created` with the invitation id, or
`password.reset.issued` with the account id — and `outcome` `applied`. It never carries the
address, the token or the link. A refusal keeps writing its message to stderr and records
nothing. Regeneration and revocation, reached from the administration surface, are unchanged and
keep writing to stdout.

## 13. Operations (D13)

Console commands keep the existing `bun run <name>` and `apps/api/src/commands/` style, print
to stdout, and exit non-zero on refusal:

| Command                                          | Purpose                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `admin:grant EMAIL`                              | Make an existing account an administrator (first admin, recovery) |
| `admin:revoke EMAIL`                             | Return an administrator to the member role                        |
| `admin:list`                                     | Print administrator emails in order; exit 0 when there is none    |
| `user:purge EMAIL --reassign-to EMAIL`           | Delete the account, reassigning its artifacts                     |
| `user:purge EMAIL --delete-content`              | Delete the account and its artifacts                              |
| `user:deactivate EMAIL`                          | Cut the access of an account without deleting anything            |
| `user:activate EMAIL`                            | Bring a deactivated account back                                  |
| `user:invite EMAIL`, `user:reset-password EMAIL` | Unchanged; one event on stderr                                    |

`user:deactivate` and `user:activate` call the same lifecycle functions as
`POST /api/admin/users/:id/status`, so the console applies the transaction of section 9 and not a
weaker version of it: one transaction that writes the status, deletes the sessions of the account,
revokes the tokens issued to it and revokes the public links of the artifacts it owns, with one
`user.deactivated` line; `user:activate` clears the status, `deactivated_at` and `deactivated_by` in
one transaction with one `user.reactivated` line and restores neither sessions nor links. Both
resolve the address first and refuse an unknown one with `no account exists for that address`; a
transition to the state the account already holds is refused with its own message (`already
deactivated`, `already active`). Every refusal writes one line to stderr, nothing to stdout, changes
nothing and records nothing. The applied line names the console as the actor and carries
`actorRole: "console"`, like the role changes, and never names a token or a link.

Nothing on either path deletes content: artifacts, revisions, comments and share grants keep their
rows, and the only console operation that removes a person is the purge below.

`admin:grant` never creates an account: an unknown address is refused with a message that names
`user:invite` (resolved decision 7). `admin:revoke` refuses an unknown address and an account that
is not an administrator. `admin:list` prints one email per administrator, sorted by address, and
exits 0 with no output when the instance has none. Each role change writes one structured event
with `actorRole: "console"`, so a recovery is traceable without an account (section 12).

### The purge command

`bun run user:purge EMAIL (--reassign-to EMAIL | --delete-content) [--yes]`. Exactly one content
choice is required. Without `--yes` the command asks for the address to be typed again on stderr
and refuses an empty or different answer; `--yes` skips the prompt for non-interactive use. Each
refusal writes one line to stderr, nothing to stdout, and exits 1: the usage line (no address, an
unknown flag, two addresses), `not a valid email address`, `not a valid email address` for
`--reassign-to`, `choose exactly one content choice`, `--reassign-to and --delete-content cannot be
combined`, `no account exists for that address`, `no account exists for the reassignment target`,
the reassignment target being the same account, and the purge not being confirmed. The account and
the target are resolved before the confirmation is asked, so an operator is never asked to confirm
a purge that cannot run. The applied purge writes one `user.purged` line with `actorRole: "console"`.
It is never exposed in the interface: no administration route deletes or purges an account.

Both content choices remove the same set of rows: `session`, `account` (every identity),
`oauthAccessToken`, `oauthRefreshToken`, `oauthConsent`, the person's owning reference on
`oauthClient` (the client itself survives, owned by nobody), `passwordResetToken`, the
`registrationInvite` rows addressed to them or bound to them, `artifactShares` they held, and the
`user` row last. `ssoProvider`, `artifactUploads` and the invitations they issued follow the
schema's cascades and `on delete set null` rules; a comment they resolved keeps its row with
`resolvedBy` cleared.

- **`--reassign-to EMAIL`** moves `artifacts.ownerId`, `artifactComments.authorId` and
  `artifactShares.grantedByUserId` to the target before the account row goes, so the artifacts,
  their revisions, their comments, their public links and the grants they carried keep working for
  the people they were shared with. Nothing is deleted on this path except the account and what
  belongs to it alone.
- **`--delete-content`** deletes the `artifacts` rows of the person, which cascades to
  `artifactRevisions`, `artifactComments`, `artifactShares` and `artifactPublicLinks`. It also
  takes the comments the person wrote on other people's artifacts and the grants they issued
  there, because `artifactComments.authorId` and `artifactShares.grantedByUserId` are
  `on delete cascade` and only the reassignment path moves them. The revision
  rows carry the storage keys, so the bytes become unreferenced and the revision-orphan sweep of
  section 4 removes them; nothing reads them in the meantime.

Neither path is reachable from the administration namespace, and the deletion path never runs
when the reassignment flag was given.

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

The discovery document is answered by a stub installed on the API suite's own event loop, so
the save-time validation is exercised without reaching a network and a failing discovery is
reproduced exactly rather than hoped for.

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
2. **Session lifetime — 7 days with a 1-day activity refresh**, today's library default. A
   `sessions.policy` document is declared for a later release; this build does not read it, so
   the lifetime is not yet configurable.
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
