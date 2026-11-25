---
title: Data model
description: The PostgreSQL tables behind Artiflow — identity, OAuth, settings and product data — with the invariants and lifecycle rules the code relies on.
sidebar:
  order: 22
---

PostgreSQL is the control plane: identity, OAuth state, instance settings, artifact metadata,
permissions, public-link hashes, comments, and the operation log of editable documents. Artifact
**bytes are never stored in PostgreSQL**; a revision row stores only its storage key and digest.

The schemas live in `apps/api/src/adapters/postgres/db/`, and migrations are generated from them into
`drizzle/` with `bun run db:generate`. Migrations are forward-only and additive.

| Schema file                | Tables                                                          |
| -------------------------- | --------------------------------------------------------------- |
| `schema.ts`                | `user`, `session`, `account`, `verification`, `ssoProvider`     |
| `oauth-schema.ts`          | OAuth provider and JWT tables                                   |
| `settings-schema.ts`       | `instanceSetting`, `instanceSecret`                             |
| `invite-schema.ts`         | `registrationInvite`                                            |
| `password-reset-schema.ts` | `passwordResetToken`                                            |
| `artifact-schema.ts`       | Product tables, plus the caps and enums the application imports |

`auth-schema.ts` aggregates the identity tables for Better Auth's adapter, and `app-schema.ts` merges
that aggregate with the product tables for the typed client.

## Relationships

```text
user ─┬─< session, account, registrationInvite, passwordResetToken
      ├─< artifacts ─┬─< artifactRevisions          (artifacts.currentRevisionId ──> one revision)
      │              ├─< artifactShares >── user     (recipient and granter)
      │              ├─< artifactPublicLinks         (rotatedFromId ──> predecessor link)
      │              ├─< artifactComments            (parentId ──> root comment)
      │              ├─< artifactAssets >── assets
      │              ├── documentDrafts              (one row per editable artifact)
      │              └─< documentOperations
      └─< artifactUploads ─< artifactChunks          (no foreign key to artifacts)
```

Points that need attention:

- `artifacts.currentRevisionId` references `artifactRevisions.id` with `ON DELETE SET NULL`, while
  revisions reference their artifact with `ON DELETE CASCADE`.
- `artifactRevisions.storageKey` is indexed but **not unique**: a key belongs to exactly one revision
  by construction. It is generated before the byte write, never derived from the digest and never
  reused. The index exists because the orphan sweep looks keys up by value.
- `artifactUploads` has no foreign key to `artifacts`. An upload is an owner-scoped staging session that
  becomes an artifact only at commit, so an abandoned upload never blocks or references an artifact row.

## Identity and settings

| Table                | Purpose                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `user`               | Accounts. `email` is unique; `role` is `member` or `administrator`; `status` is `active` or `deactivated`.                     |
| `session`            | Browser sessions; `token` unique, cascade on user delete.                                                                      |
| `account`            | Credentials per provider: the password hash, or a linked Google, GitHub or OIDC identity. `(providerId, accountId)` is unique. |
| `verification`       | Present for Better Auth compatibility; no email delivery is configured.                                                        |
| `ssoProvider`        | The enterprise OIDC connection.                                                                                                |
| `instanceSetting`    | Stored configuration (access methods, password policy, …) as JSON per key, with a revision counter and the last editor.        |
| `instanceSecret`     | Client secrets saved from the interface, encrypted with `ARTIFLOW_SECRET_ENCRYPTION_KEY`.                                      |
| `registrationInvite` | Invitations: normalized email, `sha256` of the token only, expiry, issuer, and the account it created.                         |
| `passwordResetToken` | Reset links: `sha256` of the token only, expiry and issuer.                                                                    |

The OAuth tables (`oauthClient`, `oauthResource`, `oauthClientResource`, `oauthRefreshToken`,
`oauthAccessToken`, `oauthConsent`, `oauthClientAssertion`, `jwks`) hold registered clients, the two
protected resources (`/mcp` and `/api/v1`) with their allowed scopes, rotating refresh tokens, consents
and the signing keys served at `/api/auth/jwks`.

## Product tables

### `artifacts`

| Column              | Meaning                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| `id`                | Canonical lowercase UUID for new artifacts; a few legacy rows are not UUIDs. |
| `ownerId`           | Owner; cascade on account delete.                                            |
| `title`             | Display title; not part of the content hash.                                 |
| `currentRevisionId` | The compare-and-set pointer to the current revision.                         |
| `observedSizeBytes` | Size of the current revision, at most the artifact cap.                      |
| `publishedSeq`      | Last document operation sequence frozen into a revision.                     |
| `kind`              | `html` (default), `markdown`, `canvas` or `deck`, CHECK-enforced.            |
| `deletedAt`         | Soft delete; every delivery path tests it.                                   |

### `artifactRevisions`

One immutable row per revision: `revision` (monotonic per artifact, unique with `artifactId`),
`sizeBytes`, `sha256` (lowercase hex, CHECK-enforced), `storageKey` (`artifacts/<revision id>`),
`formatVersion`, the operation range `seqFrom`–`seqTo` it froze, and an optional `blockIndex`.

### `artifactUploads` and `artifactChunks`

Staging for the chunked MCP transfer. An upload carries a client-supplied id (which makes retries
idempotent), the declared size and digest, a 60-minute expiry and a status (`open`, `complete`,
`aborted`). A chunk carries its index (unique per upload), size (at most 1 MiB) and a digest the server
computed from the received bytes. These rows are **claims**, not content: the whole-artifact digest is
verified against the real bytes at commit.

### `assets` and `artifactAssets`

Raster images uploaded for canvases and decks are stored once per digest under `assets/<sha256>`:
`assets` holds size, content type (PNG, JPEG, WebP or GIF) and key, and `artifactAssets` records which
artifacts reference which asset.

### `documentDrafts` and `documentOperations`

Editable kinds write through an operation log. `documentDrafts` holds one row per artifact with the
current state, its sequence number and format version. `documentOperations` appends every batch with
its `seq`, the `baseSeq` it was built on, the author kind (`person` or `agent`) and id, the result
(`applied` or `rejected`) and an idempotency key. An applied sequence is unique per artifact, and the
idempotency key is globally unique, so a retried batch is recognized instead of applied twice.

### `artifactShares`

A grant from an owner to a registered account: recipient, granter and role (`reader` by default,
`editor` or `commenter`). `(artifactId, sharedWithUserId)` is unique, so a repeated grant is
idempotent in the database. A grant is addressed by the recipient's email, and a self grant is refused
before insert.

### `artifactPublicLinks`

`tokenHash` (`sha256` of the token, unique), `showComments` (off by default), `revokedAt`, and
`rotatedFromId` chaining a successor to its predecessor. There is no expiry column: links live until
revoked. The raw token is never stored, logged or returned after creation.

### `artifactComments`

| Column                     | Meaning                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `parentId`                 | `NULL` for a root; replies cascade with their root.                                                 |
| `anchor`                   | Roots only (CHECK-enforced): `text-range`, `element`, `page-point`, `board-point` or `slide-point`. |
| `revisionId`               | The revision that was current when the root was created.                                            |
| `body`                     | Non-blank, capped in characters; a `text-range` quote has its own cap.                              |
| `resolvedAt`, `resolvedBy` | Set on roots only; cleared on unresolve.                                                            |

The anchor kind must match the document kind: Markdown takes `text-range` (1-indexed lines, UTF-16
columns, end-exclusive, plus the quoted text); HTML takes `element` and `page-point`; a canvas takes
`board-point`, whose node id is resolved against the scene before storage. Anchors are source-based,
not DOM-based, so a comment survives formatting changes and is labelled outdated instead of silently
reattaching.

## Invariants

1. **Ownership first.** Every read and write filters by owner, or by a live grant, before anything
   else. A foreign row is indistinguishable from a missing one.
2. **Soft delete is a delivery filter, never a cascade.** `deletedAt` is tested in every listing,
   viewer and lookup. Shares and links may remain; they grant nothing while the artifact is deleted.
3. **Digests are verified, not trusted.** CHECK constraints reject malformed digests at rest, and every
   read re-hashes the bytes against the revision row.
4. **Caps live in the schema module.** The size caps, staging TTL, comment caps and the kind, role and
   anchor enums are defined in `artifact-schema.ts` and its imports; tests assert them against the
   generated SQL.
5. **A live revision always has its object.** Bytes are written before the row that names them, and a
   restore writes the restored bytes under a fresh key before inserting its own row. No two rows share
   a key, so deleting one artifact's keys can never remove another revision's bytes.
6. **Compare-and-set for concurrency.** A stale expected revision or sequence is refused with the
   current pointer; nothing is overwritten.

## Retention and lifecycle

| Object                   | Lifecycle                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| Upload and chunks        | Rows removed after expiry once their chunk bytes resolve; staging bytes collected by the staging sweep. |
| Revision                 | Immutable; history only grows.                                                                          |
| Artifact                 | Soft delete only; rows and revision metadata are kept.                                                  |
| Deleted artifact's bytes | Its own revision keys are deleted best effort after the soft delete commits.                            |
| Asset                    | Unreferenced asset objects and rows are removed by the daily asset sweep after a 24-hour grace window.  |
| Public link              | Revoked rows are kept for provenance; tokens are hashed.                                                |
| Comment                  | Hard delete; deleting a root cascades its replies.                                                      |
| Account                  | Removed only by `user:purge`, which reassigns or deletes its content.                                   |

There is no hard-delete job for artifacts and no retention policy for old revisions. Unreferenced
revision bytes are reclaimed by a daily sweep (see [Request flows](/docs/contributing/flows/#delete-and-garbage-collection)),
but a soft-deleted artifact keeps its rows, so bytes whose best-effort delete was refused are not
reclaimed until a hard delete exists.
