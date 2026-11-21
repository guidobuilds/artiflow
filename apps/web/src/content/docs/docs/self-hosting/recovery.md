---
title: Recover access and remove a person
description: Console commands for an instance with no administrator, what deactivating does that purging does not, how to purge an account with or without its content, and what each choice takes with it.
sidebar:
  order: 12
---

Two situations need a procedure rather than a page of settings: nobody can administer the instance
any more, and a person has to lose access now. Both end with something irreversible or nearly so, so
this page lists the commands, what each one refuses, and exactly what it destroys.

Everything here runs from the repository root, in the same `bun run <name>` style as the deployment
scripts, wherever the API configuration exists — in the production stack that is the `api` service:

```sh
bun run admin:list
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api bun run admin:list
```

Each command loads the full API configuration, so `DATABASE_URL` and the `ARTIFLOW_S3_*` values have
to be present, exactly as for the API process. They exit `0` on success, and `1` with one line on
standard error on refusal, never a stack trace. `--help` on any of them prints its usage.

| Command                     | What it does                                                   | What it prints                            |
| --------------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| `admin:list`                | Lists every administrator                                      | One email per line, sorted; nothing at all |
| `admin:grant EMAIL`         | Makes an existing account an administrator                     | One log line                              |
| `admin:revoke EMAIL`        | Returns an administrator to the member role                    | One log line                              |
| `user:deactivate EMAIL`     | Cuts the access of an account                                  | One log line                              |
| `user:activate EMAIL`       | Brings a deactivated account back                              | One log line                              |
| `user:invite EMAIL`         | Prints a single-use registration link, valid 24 hours          | The link                                  |
| `user:reset-password EMAIL` | Prints a single-use password reset link, valid 1 hour          | The link                                  |
| `user:purge EMAIL …`        | Deletes an account, with or without its content                | One log line                              |

The two commands that print a link write their record line to standard error instead, so a caller
that redirects standard output keeps the link and the operator keeps the record. Neither `admin:list`
nor a refusal records anything.

## An instance with no administrator

Nothing protects the last administrator: an administrator can demote themselves, deactivate every
administrator, or be purged, and the instance ends up with none. The interface cannot fix that,
because every administrative route needs an administrator. The console can.

1. Confirm the state — an empty answer with exit status `0` means the instance has no administrator:

   ```sh
   bun run admin:list
   ```

2. Grant the role to an account that already exists:

   ```sh
   bun run admin:grant person@example.com
   ```

3. If that person has no account yet, invite them first, let them complete the invitation, then grant:

   ```sh
   bun run user:invite person@example.com
   bun run admin:grant person@example.com
   ```

`admin:grant` never creates an account. An unknown address is refused with a message that names
`user:invite`, because only the invitation path lets the person choose a password. It also refuses a
malformed address, a missing or extra argument, and any flag. The role is written in one transaction
with its log line, which carries `actorRole: "console"` and the granted account's identifier — so a
recovery is traceable without any administrator having done it.

A grant does not reactivate. If the address belongs to a deactivated account, the role is stored and
the account still cannot sign in; grant an active account, sign in, and reactivate the other one from
the users directory.

`admin:revoke` is the reverse: it refuses an unknown address and an account that is not an
administrator, and it leaves the account otherwise untouched — the person keeps their content, their
sessions and their ability to sign in as a member. Use it when someone should stop administering
without losing their own artifacts.

## A person who must lose access today

Deactivate the account from `/admin/users`: open the row, press **Deactivate account** and confirm the
dialog that states the consequences. The same change is one console command when the interface is not
an option:

```sh
bun run user:deactivate person@example.com
```

Both paths run the same operation, so the console is not a weaker version of the interface. It takes
effect immediately and in one transaction:

- Every sign-in is blocked — password, social and the enterprise connection.
- Every open browser session is deleted, so the next request from any of those browsers is signed out.
- Every agent token issued to the account is revoked, access and refresh alike, so an MCP or API client
  stops working rather than continuing until expiry.
- Every public link to that person's artifacts is revoked, so anyone holding one loses access.

Nothing is deleted: the artifacts, revisions, comments and share grants keep their rows, and the
people those artifacts were shared with keep reading them. A deactivated account also cannot be named
as the recipient of a new share; the share dialog refuses it exactly like an address that holds no
account. See [Administer accounts and sign-in](/docs/self-hosting/administration/#deactivate-and-reactivate)
for the dialog and its wording.

`user:deactivate` takes an address and nothing else. An unknown address is refused with
`no account exists for that address`, and an account that is already deactivated with
`that account is already deactivated; nothing changed`. Either way the refusal writes one line to
standard error, nothing to standard output, and exits `1`, and it changes nothing and records nothing
in the administration log. The applied change writes one `user.deactivated` line naming the console as
the actor and the account as the subject, exactly as the interface does.

If that person is the only administrator, granting the role to someone else first keeps the instance
administrable — or accept that you are recovering from the console afterwards, as above.

### Bring a deactivated account back

```sh
bun run user:activate person@example.com
```

This clears the deactivated state and lets the person sign in again with the methods the instance
allows. It restores neither the sessions that ended nor the public links that were revoked, and it
does not restore the revoked agent tokens: the person signs in again, and a public link that is still
needed has to be published again. Their artifacts and the grants on them were never touched, so a
reactivated account returns to everything it was already given.

An unknown address and an account that is already active are refused — the second with
`that account is already active; nothing changed` — with one line on standard error, exit status `1`,
and nothing written to the database or to the log. The applied change writes one `user.reactivated`
line.

## Deactivate or purge

|                                    | Deactivate                    | Purge                                        |
| ---------------------------------- | ----------------------------- | -------------------------------------------- |
| Account row                        | Kept, marked deactivated      | Deleted                                      |
| Sign-in and sessions               | Blocked, sessions deleted     | Impossible, sessions deleted                 |
| Agent tokens                       | Revoked                       | Deleted                                      |
| Public links of its artifacts      | Revoked                       | Kept if the artifacts are reassigned         |
| Artifacts, revisions, comments     | Kept                          | Reassigned to another account, or deleted    |
| Pending invitations and reset links | Kept                         | Deleted                                      |
| Reversible                         | Yes, by reactivating          | No                                           |
| Where                              | `/admin/users`, `user:deactivate` | Console only                             |

Reactivating restores sign-in and nothing else: the sessions that ended stay ended, the revoked public
links stay revoked, and the person needs a new link if one is still in use. Their artifacts and the
grants on them were never touched.

## Purge an account

The command takes an address and exactly one content choice, and it is never reachable from the
interface:

```sh
bun run user:purge person@example.com --reassign-to owner@example.com
bun run user:purge person@example.com --delete-content
```

- **`--reassign-to EMAIL`** hands the person's artifacts to another existing account before the account
  row goes, and moves the authorship of their comments and the issuer of the grants they made with it.
  The artifacts, their revisions, their public links and the grants they carried keep working for the
  people they were shared with, now owned by the target.
- **`--delete-content`** deletes the person's artifacts, which cascades to their revisions, comments,
  public links and the grants on them. The revision rows carry the storage keys, so the bytes become
  unreferenced and the instance's revision sweep removes them later; nothing reads them in the
  meantime.

Without `--yes` the command asks on standard error for the address to be typed again and refuses an
empty or different answer; `--yes` skips the prompt for non-interactive use. The account and the
reassignment target are resolved before the confirmation is asked, so you are never asked to confirm a
purge that cannot run. Every refusal writes one line on standard error, nothing on standard output, and
exits `1`: the usage line, an unknown flag, two addresses, a malformed address, a malformed
reassignment target, neither or both content choices, an unknown address, an unknown reassignment
target, the account named as its own target, and an unconfirmed purge. The applied purge writes one
`user.purged` line with `actorRole: "console"`.

### What a purge takes with it

Both content choices remove the same account records: the account row, every identity it holds
(password, Google, GitHub and the enterprise connection), its sessions, the access tokens, refresh
tokens and consents issued to it, its pending password reset links, the invitations addressed to it or
bound to it, and the share grants it held as a recipient. An OAuth client it created survives, owned by
nobody. Comments it resolved keep their rows with the resolver cleared.

The two choices differ on the content, and the difference is larger than "the artifacts":

- **With `--reassign-to`** the comments the person wrote keep their rows and their authorship moves to
  the target, including the ones written on other people's artifacts. The grants they issued on other
  people's artifacts keep working, under the target as their issuer.
- **With `--delete-content`** the comments the person wrote are deleted too, because authorship
  cascades with the account — including comments on artifacts that belong to somebody else. The grants
  they issued on other people's artifacts are deleted with them, and those recipients lose the access
  those grants gave them.

Neither choice can be undone. Take a database snapshot before purging, or use deactivation when the
question is access rather than the existence of the account.

After a purge the address belongs to nobody, so it can be invited again as a new account, with no
memory of the old one. A person who is leaving and may come back is a deactivation; a person who must
not exist on the instance any more is a purge.

## What the console cannot do

- Change access methods, the password policy or the enterprise connection. Those are interface
  settings, and no command writes them; an instance whose last enabled method was disabled cannot be
  recovered from the console.
- Close a single session, or all sessions of one account. Deactivating an account closes every session
  it holds, and no command closes one without the others.
- Rotate the secret-encryption key. Keep it stable and backed up alongside the database: a
  credential that can no longer be decrypted stops working, and re-entering it is the only way back.
- Recover a deleted account, restore a revoked link or restore ended sessions. Activating an account
  is not a rollback: it restores sign-in and nothing else.

## Next

[Administer accounts and sign-in](/docs/self-hosting/administration/) covers the everyday surface, and
[Identity providers](/docs/self-hosting/identity-providers/) covers the connection and its refusals.
