---
title: Console commands
description: Every operator command on an Artiflow instance — syntax, options, what each one writes to stdout and stderr, its exit codes, and the exact wording of each refusal.
sidebar:
  order: 4
---

An Artiflow instance has eight operator commands. They cover what no page can do: name an
administrator when the instance has none, remove a person from it, and issue a link or change a role
from a shell. Everything else — access methods, the password policy, the enterprise connection,
sessions — is an interface setting, and no command writes it.

This page is the reference: one table, then one section per command with its syntax, an example, what
it writes, and every refusal in its own words. The procedures that use them are in
[Recover access and remove a person](/docs/self-hosting/recovery/), and the everyday surfaces are in
[Administer accounts and sign-in](/docs/self-hosting/administration/).

## The commands

| Command                                                              | Changes                                               | stdout                      | stderr                           |
| -------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------- | -------------------------------- |
| `admin:grant EMAIL`                                                  | An existing account becomes an administrator          | One `role.granted` log line | Nothing                          |
| `admin:revoke EMAIL`                                                 | An administrator returns to the member role           | One `role.revoked` log line | Nothing                          |
| `admin:list`                                                         | Nothing; it reads                                     | One email per administrator | Nothing                          |
| `user:invite EMAIL`                                                  | A pending registration invitation                     | The link, and nothing else  | One `invitation.created` line    |
| `user:reset-password EMAIL`                                          | A pending password reset link, replacing earlier ones | The link, and nothing else  | One `password.reset.issued` line |
| `user:deactivate EMAIL`                                              | The deactivation transaction of the users directory   | One `user.deactivated` line | Nothing                          |
| `user:activate EMAIL`                                                | Clears the deactivated state                          | One `user.reactivated` line | Nothing                          |
| `user:purge EMAIL (--reassign-to EMAIL \| --delete-content) [--yes]` | Deletes the account, with or without its content      | One `user.purged` line      | The confirmation prompt          |

Two behaviours are worth knowing before you reach for one of these under pressure:

- **A command that mints a link or changes a role prints its result.** For a role change the result
  _is_ the audit line, on standard output; for a link command the result is the link, also on standard
  output, and there is no other line there.
- **The two link commands write their audit line to standard error.** `user:invite` and
  `user:reset-password` answer the link as their only stdout line, so a caller that redirects standard
  output keeps the link untouched while the operator keeps the record. Every other command writes no
  audit line to stderr, and a refusal switches them: the reason goes to stderr, stdout stays empty.

## Running a command

Every command is a repository script, runs from the repository root, and loads the full API
configuration. `DATABASE_URL` and the `ARTIFLOW_S3_*` values have to be present exactly as they are for
the API process; a partial set is refused with the configuration message of that command.

In the production stack the container is the `api` service:

```sh
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api bun run admin:list
```

Every command exits `0` on success, and `1` on any refusal. A refusal writes exactly one line to
standard error and nothing to standard output, changes nothing in the database and records nothing in
the administration log. `--help` as the only argument prints the command's usage summary on standard
output and exits `0`; a `--help` anywhere else in the argument list is a usage refusal like any other
unknown argument.

The audit lines are the JSON objects described in
[the administration log](/docs/self-hosting/administration/#the-administration-log). Every console
line names `actorId` and `actorRole` as `console`, so a change made here is attributable without an
administrator account.

## admin:grant

```sh
bun run admin:grant person@example.com
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api bun run admin:grant person@example.com
```

**Syntax.** `bun run admin:grant EMAIL` — one address, no options.

**What it changes.** The stored role of that account becomes `administrator`, in one transaction that
also writes the `role.granted` line. It never creates an account and never changes a status: a grant to
a deactivated account stores the role and the account still cannot sign in. An account that is already
an administrator is left untouched, answers `0` and records nothing.

**Refusals.** Each writes one line to standard error, nothing to standard output, changes nothing, and
exits `1`:

| Condition                                  | Message on standard error                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| No argument, two arguments, or any flag    | `usage: bun run admin:grant EMAIL`                                                              |
| The argument is not an email address       | `admin:grant: the EMAIL argument is not a valid email address.`                                 |
| No account holds that address              | `admin:grant: no account exists for that address; invite it with user:invite first.`            |
| The configuration is incomplete or invalid | `admin:grant: configuration is invalid: <reason>`                                               |
| The database cannot be reached             | `admin:grant: the database is unavailable; check DATABASE_URL and that migrations are applied.` |

## admin:revoke

```sh
bun run admin:revoke person@example.com
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api bun run admin:revoke person@example.com
```

**Syntax.** `bun run admin:revoke EMAIL` — one address, no options.

**What it changes.** The stored role returns to `member`, in one transaction with the `role.revoked`
line. The account keeps everything else: its content, its sessions, its methods, and its ability to
sign in as a member.

**Refusals.** One line to standard error, nothing to standard output, no change, exit `1`:

| Condition                                  | Message on standard error                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| No argument, two arguments, or any flag    | `usage: bun run admin:revoke EMAIL`                                                              |
| The argument is not an email address       | `admin:revoke: the EMAIL argument is not a valid email address.`                                 |
| No account holds that address              | `admin:revoke: no account exists for that address.`                                              |
| The account is not an administrator        | `admin:revoke: that account is not an administrator; nothing to revoke.`                         |
| The configuration is incomplete or invalid | `admin:revoke: configuration is invalid: <reason>`                                               |
| The database cannot be reached             | `admin:revoke: the database is unavailable; check DATABASE_URL and that migrations are applied.` |

## admin:list

```sh
bun run admin:list
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api bun run admin:list
```

**Syntax.** `bun run admin:list` — no arguments, no options.

**What it writes.** One address per line on standard output, sorted by address, and nothing else. An
instance with no administrator prints nothing at all and exits `0`: the empty output _is_ the answer,
and it is the way to confirm an instance that lost its last administrator.

**Refusals.** One line to standard error, exit `1`:

| Condition                                  | Message on standard error                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Any argument or flag                       | `usage: bun run admin:list`                                                                    |
| The configuration is incomplete or invalid | `admin:list: configuration is invalid: <reason>`                                               |
| The database cannot be reached             | `admin:list: the database is unavailable; check DATABASE_URL and that migrations are applied.` |

## user:invite

```sh
bun run user:invite person@example.com
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api bun run user:invite person@example.com
```

**Syntax.** `bun run user:invite EMAIL` — one address, no options. Registration is invitation-only, so
this is the only way an account is created by hand; the enterprise connection may provision one too, and
nothing here sends an email.

**What it changes.** A pending registration invitation for that address, valid 24 hours, stored as a
SHA-256 digest of the token and nothing more.

**What it writes.** Standard error carries one `invitation.created` line naming the invitation
identifier, never the link. Standard output carries exactly one line, the link, and the page that link
opens is described in [Operate and upgrade](/docs/self-hosting/operations/#invitation-only-registration).

**Refusals.** One line to standard error, nothing to standard output, no change, exit `1`:

| Condition                                  | Message on standard error                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| No argument, two arguments, or any flag    | `usage: bun run user:invite EMAIL`                                                              |
| The argument is not an email address       | `invitation: the EMAIL argument is not a valid email address.`                                  |
| An account already holds that address      | `invitation: an account already exists for that address; this command never resets a password.` |
| The configuration is incomplete or invalid | `invitation: configuration is invalid: <reason>`                                                |
| The database cannot be reached             | `invitation: the database is unavailable; check DATABASE_URL and that migrations are applied.`  |

Unlike the invitations page, this command refuses a deactivated account too, because an account is an
account: use the page, which reactivates the account and binds the invitation to it, or
`user:activate` first.

## user:reset-password

```sh
bun run user:reset-password person@example.com
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api bun run user:reset-password person@example.com
```

**Syntax.** `bun run user:reset-password EMAIL` — one address, no options.

**What it changes.** It deletes the pending unconsumed reset links of that account and stores one new
link, valid 1 hour, again as a digest only. It never creates an account and never sets a password: the
person completes the link.

**What it writes.** Standard error carries one `password.reset.issued` line naming the account, never
the link. Standard output carries exactly one line, the link, and the page it opens is described in
[Operate and upgrade](/docs/self-hosting/operations/#password-reset).

**Refusals.** One line to standard error, nothing to standard output, no change, exit `1`:

| Condition                                  | Message on standard error                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| No argument, two arguments, or any flag    | `usage: bun run user:reset-password EMAIL`                                                         |
| The argument is not an email address       | `password-reset: the EMAIL argument is not a valid email address.`                                 |
| No account holds that address              | `password-reset: no account exists for that address; this command never creates an account.`       |
| The configuration is incomplete or invalid | `password-reset: configuration is invalid: <reason>`                                               |
| The database cannot be reached             | `password-reset: the database is unavailable; check DATABASE_URL and that migrations are applied.` |

A deactivated account is accepted here: the link sets a password, and the account still cannot create a
session until it is activated.

## user:deactivate

```sh
bun run user:deactivate person@example.com
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api bun run user:deactivate person@example.com
```

**Syntax.** `bun run user:deactivate EMAIL` — one address, no options. There is no confirmation prompt:
the address is the whole command.

**What it changes.** The same transaction the users directory applies: the account is marked
deactivated, every session it holds is deleted, every agent token issued to it is revoked, and the
public links of the artifacts it owns are revoked. Nothing is deleted, and the account is brought back
with `user:activate`. What that does and does not restore is in
[Recover access](/docs/self-hosting/recovery/#bring-a-deactivated-account-back).

**Refusals.** One line to standard error, nothing to standard output, no change, no log line, exit `1`:

| Condition                                  | Message on standard error                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| No argument, two arguments, or any flag    | `usage: bun run user:deactivate EMAIL`                                                              |
| The argument is not an email address       | `user:deactivate: the EMAIL argument is not a valid email address.`                                 |
| No account holds that address              | `user:deactivate: no account exists for that address.`                                              |
| The account is already deactivated         | `user:deactivate: that account is already deactivated; nothing changed.`                            |
| The configuration is incomplete or invalid | `user:deactivate: configuration is invalid: <reason>`                                               |
| The database cannot be reached             | `user:deactivate: the database is unavailable; check DATABASE_URL and that migrations are applied.` |

## user:activate

```sh
bun run user:activate person@example.com
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api bun run user:activate person@example.com
```

**Syntax.** `bun run user:activate EMAIL` — one address, no options.

**What it changes.** It clears the deactivated state, `deactivated_at` and `deactivated_by` in one
transaction with the `user.reactivated` line. It restores neither the sessions that ended nor the public
links that were revoked nor the revoked agent tokens; the person signs in again.

**Refusals.** One line to standard error, nothing to standard output, no change, no log line, exit `1`:

| Condition                                  | Message on standard error                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| No argument, two arguments, or any flag    | `usage: bun run user:activate EMAIL`                                                              |
| The argument is not an email address       | `user:activate: the EMAIL argument is not a valid email address.`                                 |
| No account holds that address              | `user:activate: no account exists for that address.`                                              |
| The account is already active              | `user:activate: that account is already active; nothing changed.`                                 |
| The configuration is incomplete or invalid | `user:activate: configuration is invalid: <reason>`                                               |
| The database cannot be reached             | `user:activate: the database is unavailable; check DATABASE_URL and that migrations are applied.` |

## user:purge

```sh
bun run user:purge person@example.com --reassign-to owner@example.com
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api bun run user:purge person@example.com --delete-content --yes
```

**Syntax.** `bun run user:purge EMAIL (--reassign-to EMAIL | --delete-content) [--yes]` — one address,
exactly one content choice, and the optional flag that skips the prompt.

**Options.**

| Option                | Meaning                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `--reassign-to EMAIL` | Delete the account and hand its artifacts to another existing account |
| `--delete-content`    | Delete the account together with its artifacts                        |
| `--yes`               | Skip the confirmation prompt, for non-interactive use                 |

**What it changes.** It removes the account row, its identities, its sessions, the tokens and consents
issued to it, its pending reset links, the invitations addressed to or bound to it, and the share grants
it held as a recipient. The two content choices differ in what happens to its artifacts, and the
difference is larger than "the artifacts"; [Recover access](/docs/self-hosting/recovery/#what-a-purge-takes-with-it)
has the list. Nothing can be undone, so take a database snapshot first, or deactivate instead when the
question is access rather than existence.

**The confirmation.** Without `--yes`, the command writes
`user:purge: type <email> to confirm the purge:` to standard error, reads one line from standard input
and refuses an empty or different answer. The account and the reassignment target are resolved before
the prompt, so you are never asked to confirm a purge that cannot run.

**Refusals.** One line to standard error, nothing to standard output, no change, no log line, exit `1`.

| Condition                                                                    | Message on standard error                                                                                                     |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| No address, an unknown flag, two addresses, or `--reassign-to` with no value | `usage: bun run user:purge EMAIL (--reassign-to EMAIL \| --delete-content) [--yes]`                                           |
| The address is not an email address                                          | `user:purge: the EMAIL argument is not a valid email address.`                                                                |
| The reassignment target is not an email address                              | `user:purge: the --reassign-to argument is not a valid email address.`                                                        |
| Neither content choice given                                                 | `user:purge: choose exactly one content choice: --reassign-to EMAIL or --delete-content.`                                     |
| Both content choices given                                                   | `user:purge: --reassign-to and --delete-content cannot be combined; choose one.`                                              |
| No account holds the address                                                 | `user:purge: no account exists for that address.`                                                                             |
| No account holds the reassignment target                                     | `user:purge: no account exists for the reassignment target; nothing was purged.`                                              |
| The reassignment target is the account itself                                | `user:purge: the reassignment target is the same account; nothing was purged.`                                                |
| The prompt was answered with something else                                  | `user:purge: the purge of that account was not confirmed; type the address to confirm or pass --yes for non-interactive use.` |
| The configuration is incomplete or invalid                                   | `user:purge: configuration is invalid: <reason>`                                                                              |
| The database cannot be reached                                               | `user:purge: the database is unavailable; check DATABASE_URL and that migrations are applied.`                                |

The purge is never reachable from the interface: no administrative route deletes an account.

## What no command does

- Change an access method, the password policy or the enterprise connection. Those are settings on
  `/admin/access`, `/admin/password-policy` and `/admin/sso`; an instance whose last enabled method was
  switched off cannot be recovered from the console.
- Close one session, or all sessions of one account. Deactivating closes every session the account
  holds, and no command closes one without the others.
- Rotate `ARTIFLOW_SECRET_ENCRYPTION_KEY`, verify an email address, or unlink a Google, GitHub or
  enterprise identity.
- Restore a deleted account, a revoked public link or an ended session.

## Next

[Recover access and remove a person](/docs/self-hosting/recovery/) is the procedure for an instance
without an administrator and for a person who has to lose access today.
[Operate and upgrade](/docs/self-hosting/operations/) covers the invitation and reset pages these
commands issue links for, and [Social sign-in](/docs/self-hosting/social-sign-in/) covers the methods a
person signs in with afterwards.
