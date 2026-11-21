---
title: Administer accounts and sign-in
description: The administrator role, the users directory, access methods, the password policy, invitations, reset links, sessions and the administration log — and what each action does not do.
sidebar:
  order: 10
---

An Artiflow instance is administered from inside the product. One role decides who may do it, one
area holds the surfaces, and every action is enforced by the server: hiding a control is never the
control. This page is written for whoever runs the instance, and covers what each action does, what
it deliberately does not do, and which of those effects are reversed by a later action.

The design behind these rules, endpoint by endpoint and table by table, is recorded in the
repository at `docs/architecture/authentication-and-access.md`.

## The administrator role

An account holds one of two roles: `member` or `administrator`. Every account starts as a member —
an invitation sets a password, and just-in-time provisioning through the enterprise connection always
writes a member. Nothing in a provider claim, a group or a `role` field from the identity provider can
grant the role.

- There is no hierarchy between administrators. Any administrator can grant the role, remove it from
  any account including their own, deactivate any account, and manage every setting.
- Nothing protects the last administrator. An instance can end up with none, on purpose or by
  accident, and the console recovers it: see [Recover access](/docs/self-hosting/recovery/).
- The role is read from the database on every administrative request. A copy in the browser session
  decides only whether the entry point is rendered.
- The area is reached from the account menu of the library, under **Administration**, and is offered
  only to an account whose stored role is administrator. A signed-in member who opens `/admin/users`
  directly receives a plain refusal with a way back to the library, and the API refuses the same
  request with `administrator_required`.
- A deactivated administrator loses the area at the same moment as everything else, and a demoted
  administrator loses it on the next request.

## The administration area

| Section                       | Path                      | What it holds                                                      |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------ |
| Users                         | `/admin/users`            | The directory, role, lifecycle, reset links, per-account sessions  |
| Access                        | `/admin/access`           | Which sign-in methods are offered, and their client credentials    |
| Password policy               | `/admin/password-policy`  | What a password must contain when it is set                        |
| Invitations                   | `/admin/invitations`      | Pending registration links, with revoke and regenerate             |
| Enterprise connection         | `/admin/sso`              | The single OIDC connection, reached from **Access**                |

Every write needs a JSON body and an `Origin` matching `ARTIFLOW_PUBLIC_ORIGIN`, like every other
browser mutation. Refusals are named codes with their own wording on the page, never a raw code.

## Users

The directory lists every account on the instance with its name, email, role, stored status, the
sign-in methods it holds — password, Google, GitHub, and its enterprise identity once linked — and
the day it last had a session. Search matches
name and email, and the role and status filters narrow the same read; all three are applied by the
server, with pages of 20 rows. An empty page names the next step instead of showing a blank table,
and a filter that matches nobody says so rather than claiming the instance has no accounts.

### Edit a name or an address

Saving a name or an email address takes effect immediately. No verification of the new mailbox is
required in this version, and the person's linked sign-in methods are untouched: an identity is bound
to an account, not to an address, so changing the address does not unlink Google, GitHub or the
enterprise identity. A blank name, a malformed address and an address another account already holds
are refused with their own wording and leave the stored row as it was. A change of address is
recorded with both values.

### Change a role

The role toggle grants or removes `administrator`. It refuses only an unknown account or a request it
cannot read, so an administrator can demote themselves; the stored role is what the table and the next
request read, and a no-op says that nothing changed. Each applied change writes one log line.

### Deactivate and reactivate

Deactivating is confirmed in a dialog that states the consequences first. It does the following in
one transaction:

- Blocks every new sign-in, by password, by a social provider and through the enterprise connection.
- Ends every open browser session of that account.
- Revokes the agent tokens issued to that account, both the short-lived access tokens and the refresh
  tokens, so an MCP client or an API client stops reading immediately rather than at expiry.
- Revokes the public links to that person's artifacts. Anyone holding one loses access.

It deliberately does not delete anything: the artifacts, revisions, comments and share grants keep
their rows, the people those artifacts were shared with keep reading them, and a deactivated account
cannot be named as the recipient of a new share (the share dialog refuses it exactly like an address
that holds no account).

Reactivating restores the account's ability to sign in with the methods the instance allows. It
restores neither the sessions that ended nor the public links that were revoked, and it does not
restore the agent tokens: the person signs in again, and a public link that is still needed has to be
published again. A reactivated account returns to the artifacts it was already granted, because those
rows were never removed.

Both directions are also console commands, for when the interface is not an option:

```sh
bun run user:deactivate person@example.com
bun run user:activate person@example.com
```

They run the same operation this dialog runs, in the same single transaction, and they refuse an
unknown address and a transition to the state the account already holds. The [Recover access](/docs/self-hosting/recovery/)
page has the refusals and the exit statuses.

### Issue a reset link

**Password reset** issues a single-use link for the account open in the panel. It is shown once, in
the answer that creates it, with a copy action and the statement that it cannot be seen again; a
reload loses it. The link expires one hour after it is issued, and issuing another one replaces any
pending link for that account. Only an active account can receive one: a deactivated account is
refused with its own wording, never reported as a missing account. Reactivate first.

### Read and close sessions

**Open sessions** lists the account's sessions: when each started, when it was last used, the address
and the browser when the server recorded them, and which row is the administrator's own session when
the account being read is the caller's. Closing one row, or closing all of them, asks first in a
dialog that states what happens: the browser holding that session has to sign in again, and the
account, its password and everything it owns stay as they are. Sessions are database-backed, so a
closed session stops resolving on its next request; nothing waits for a cookie to expire.

A session token is never rendered, returned or stored by the page. The
[Sessions](#sessions) section below describes the same list from the account's own point of view.

## Access methods

`/admin/access` decides which methods the sign-in page offers:

| Method          | What an administrator sets                                                |
| --------------- | ------------------------------------------------------------------------- |
| Password        | Enabled or disabled                                                       |
| Google          | Enabled or disabled, its client id, and its client secret                 |
| GitHub          | Enabled or disabled, its client id, and its client secret                 |

Three rules govern what a save stores:

- A stored credential is shown as presence only. The field is empty, prefilled with nothing, and a
  supplied value replaces the stored one. Neither the page nor an answer ever carries the value back.
- Enabling a provider needs a non-blank client id and a stored credential, either already stored or
  supplied in the same save. Enabling without them is refused with its own wording, and nothing is
  stored.
- A supplied credential needs the instance's secret-encryption key. Without it the save is refused
  rather than storing the credential unprotected.

Changes apply without a restart. The server rebuilds its authentication instance from the stored
document on the next request and swaps it atomically, so a sign-in already in flight finishes on the
configuration it started with. Nothing on the page says "restart".

Password sign-in has two gates, and the stored one cannot open the first: the deployment profile
decides whether password authentication exists at all — production and the local demo profile — and
the stored switch decides whether it is offered. Disabling it in production removes the form from the
sign-in page; enabling it in a profile that has no password authentication changes nothing.

### Existing installations and the environment

The two `ARTIFLOW_AUTH_GOOGLE_*` and `ARTIFLOW_AUTH_GITHUB_*` pairs are read once, on the first boot
of an instance that has no stored access configuration, and written to the database with the
provenance "Adopted from the environment". From then on the database is the only source of truth: a
variable that stays set changes nothing and produces one structured warning naming the variable, never
its value. Adding the pair to the environment of an instance that has already booted therefore does
not add a provider — set it here instead. See the variable table in
[Configuration](/docs/reference/configuration/).

The **Provenance** row of the page says which of the two wrote the configuration in force, and the
first change made here moves it to "Set by an administrator".

### When a method silently disappears

A provider that is enabled and carries a client id whose stored credential can no longer be decrypted
— the encryption key changed or was removed — is left out of the sign-in page while the document still
says enabled. The credential state on this page answers whether a row exists, not whether it can be
read. If a provider you enabled stops being offered, check that the encryption key is the one that
stored it and re-enter the credential if it is not.

:::caution
Saving a document with every method disabled leaves no way in through the browser. The console cannot
enable a method; only this page and the database can. Keep at least one method enabled, or disable
password login only while the enterprise connection is published.
:::

## Password policy

The policy is what a password must contain when it is set, at registration through an invitation, at
a password reset and at a password change. It is shown to the person before they choose one, in the
same words the server enforces, and a refusal names every requirement that is missing rather than the
first.

| Rule                 | Default | Range                |
| -------------------- | ------- | -------------------- |
| Minimum length       | 12      | 8 to 128             |
| Uppercase letter     | on      | on or off            |
| Lowercase letter     | on      | on or off            |
| Number               | on      | on or off            |
| Symbol               | on      | on or off            |
| Maximum length       | 128     | not configurable     |

The policy is enforced server-side on every path that sets a password, so a client that bypasses the
interface receives the same list of missing requirements. Changing the policy never touches stored
passwords: a password set under an older policy keeps working and no reset is forced. Reading the
policy in force needs no session, which is what lets the invitation and reset forms state it.

## Invitations and reset links

Invitations create accounts; reset links replace a password. Both are single-use bearer links that
this instance never emails: you hand them over outside Artiflow, and both are shown once, by the call
that creates them.

|                    | Invitation                                   | Reset link                                  |
| ------------------ | -------------------------------------------- | ------------------------------------------- |
| Lifetime           | 24 hours                                     | 1 hour                                      |
| Address            | The one it was issued for, fixed on the form | The account's own address, fixed on the form |
| Sets               | Name and password, creating the account      | A new password                              |
| From the interface | `/admin/invitations`                         | **Password reset** on a user                |
| From the console   | `bun run user:invite EMAIL`                  | `bun run user:reset-password EMAIL`          |
| Refused for        | An address that holds an active account      | A deactivated account, from the interface   |

The invitation page lists what is pending — not consumed, not revoked, not expired — with each row's
address, the administrator who issued it (or "Issued from the console" for a link the console printed),
the day it was issued and the day it expires. **Revoke** kills a link, and **Regenerate** revokes the
previous invitation and creates the new one in one transaction, so the previous link stops working the
moment the new one exists. Neither is available for an invitation that was already used, expired or
revoked, and each refusal says which of those happened.

Issuing an invitation for the address of a deactivated account reactivates that account and binds the
invitation to it: completing it sets a new password and keeps the stored name, and no second account
is ever created for the address. The page states that the account is active again, so the reactivation
is never silent.

The console differs in one respect worth knowing before an incident: `user:invite` refuses any
address that already holds an account, deactivated included, and `user:reset-password` issues a link
for any existing account, deactivated included — a completed reset changes the password of a
deactivated account but grants no access, because the account still cannot create a session. Use the
interface to bring a deactivated person back. The exact console invocations and refusal rules are in
[Operate and upgrade](/docs/self-hosting/operations/#invitation-only-registration).

Possession of a link is not proof of a mailbox, the public preview and completion answer one generic
refusal whatever went wrong with the link, and no email is ever sent.

## Sessions

There are two session surfaces and one table behind them. An account lists its own sessions under
**Sessions** at `/account`: each row shows when it started, when it was last used, the address and the
browser when the server recorded them, and the row behind the current browser is marked. Closing one
session asks first, closing every other session says how many rows it closed, and closing the current
one returns this browser to the sign-in page. An administrator sees the same rows for any account from
the users directory.

Sessions last seven days and are refreshed at most once a day while they are used; that lifetime is
fixed in this build and has no administration setting. Ending a session deletes its row, so the
browser holding it is signed out on its next request. Nothing in either surface returns a session
token. Self-service closures are not administrative operations and record no log line; closures made
by an administrator record one.

## The administration log

Every administrative operation and every use of the emergency fallback writes one JSON object per
line to standard output: a timestamp, a level, one closed event name, the actor, the actor's role, one
subject of the change — an account, a settings key, or an account and a session — an outcome, and a
request identifier when the request carried one. The event set is closed in
code, so an operation without a registered event is a compile error rather than a typo in production.

| Event                                                            | Written when                                        |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| `role.granted`, `role.revoked`                                   | A role changes, from the interface or the console   |
| `user.updated`                                                   | A name or address is saved                          |
| `user.deactivated`, `user.reactivated`                           | A lifecycle change applies                          |
| `user.purged`                                                    | The console purge applies                           |
| `user.registered`                                                | An invitation is completed                          |
| `session.revoked`, `sessions.revoked`                            | An administrator closes one or all sessions         |
| `invitation.created`, `invitation.revoked`, `invitation.regenerated` | An invitation is issued, revoked or regenerated  |
| `password.reset.issued`                                          | A reset link is issued, from the interface or console |
| `access.methods.updated`, `access.sso.updated`, `password.policy.updated` | A settings document is saved              |
| `login.fallback.used`                                            | An emergency sign-in is admitted or refused         |

What the shape cannot carry, because it has no field for it: passwords, tokens, session identifiers as
credentials, invitation or reset links, client secrets, request bodies, and any credential the
provider returned. Invitation and reset lines name the invitation or the account, never the link.
A fallback attempt for an address that holds no account is recorded as `unattributed` with the role
`anonymous`, and the attempted address is never written.

A refused operation records nothing: the guards answer before any line, and a write that loses a race
emits nothing. The two console commands that print a link answer it on standard output, so their log
line goes to standard error instead — a caller that redirects standard output keeps the link and the
operator keeps the record. Nothing writes these lines to a file, there is no audit page in the product
and no export: the record is whatever your container or process logging already keeps. See
[Operate and upgrade](/docs/self-hosting/operations/#health-and-logs) for the rest of the process log.

## What this build does not do

- **No delete or purge from the interface.** No administrative route deletes an account. Deleting is a
  console operation with a content choice; see [Recover access](/docs/self-hosting/recovery/).
- **No session-lifetime setting.** Seven days with a daily refresh, in code.
- **No impersonation.** An administrator cannot act as another account.
- **No account creation.** Invitations and just-in-time provisioning are the only ways in.
- **No audit page, export or retention setting.** The log is a stream.
- **No email.** No invitation, reset link or notification is ever sent by the instance.
- **No SAML connection.** The single connection is OIDC; see
  [Identity providers](/docs/self-hosting/identity-providers/).
- **No password expiry, reuse history or rotation timer.** The policy governs what a new password
  must contain and nothing else.

## Next

[Identity providers](/docs/self-hosting/identity-providers/) covers the enterprise connection and how
to restrict it to your own organisation. [Recover access](/docs/self-hosting/recovery/) covers the
console commands, deactivation versus purge, and offboarding under pressure.
