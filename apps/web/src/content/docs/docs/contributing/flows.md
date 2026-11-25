---
title: Request flows
description: Startup, sign-in, the MCP OAuth handshake, publishing, viewing, sharing, editing, comments, deletion and garbage collection, traced end to end through the Artiflow code.
sidebar:
  order: 23
---

Each flow names the modules that implement it, so a request can be traced without opening every file.
Paths are relative to `apps/api/src` unless they say otherwise.

## Startup and shutdown

1. `server.ts` calls `loadConfig(process.env)` once. A configuration error prints the variable name —
   never the value — and exits with code `1`.
2. It builds the PostgreSQL pool (at most 4 connections) and the S3 client, then `createApiApp` mounts
   every surface in a fixed order and the collaboration socket attaches to the server.
3. Three sweeps start on unref'd timers, one run at a time each: staging after 15 s and then every
   15 minutes, revisions after 60 s and then daily, assets after 90 s and then daily.
4. On `SIGINT` or `SIGTERM` the API closes the collaboration rooms, stops accepting connections, stops
   the sweeps, closes the pool and destroys the S3 client. Shutdown is idempotent and exits `0`. There
   is no timeout on `server.close()`, so a stuck connection can delay it.

Modules: `config.ts`, `server.ts`, `app.ts`, `adapters/postgres/db/client.ts`, `adapters/storage/client.ts`,
`domain/gc.ts`.

## Browser sign-in

```text
Browser ── GET /api/auth/capabilities ──▶ API     which sign-in methods the page offers
Browser ── POST /api/auth/sign-in/email ─▶ API     exact Origin + JSON, then Better Auth
        ◀── 200 + HttpOnly session cookie ──
Browser ── GET /api/auth/get-session ────▶ API     the identity is trusted only after this read
```

The dashboard treats a `200` from a mutation as unproven until `get-session` confirms the identity, and
never stores passwords or tokens in `localStorage`. Public sign-up is closed: accounts come from
invitations. Social and OIDC sign-in only reach an existing or provisioned account, as described in
[Identity providers](/docs/self-hosting/identity-providers/).

Modules: `auth.ts`, `settings/`, `invites/`, `password-policy/`.

## MCP OAuth and a tool call

```text
client ── GET /.well-known/oauth-protected-resource/mcp ──▶ API
client ── POST /api/auth/oauth2/register (public client) ─▶ API      dynamic registration grants nothing
client ── opens /api/auth/oauth2/authorize?…&resource=<origin>/mcp&code_challenge=…
           browser signs in (/login) and approves scopes (/consent)
client ◀── redirect with an authorization code
client ── POST /api/auth/oauth2/token (code + verifier) ───▶ API
client ◀── access JWT (900 s) + refresh token
client ── POST /mcp  Authorization: Bearer … ──────────────▶ verify keys, audience, issuer, Host/Origin
client ◀── JSON-RPC result                                      claims → { userId, scopes }
```

- Authorize refuses a request without `resource` before the provider runs.
- `/mcp` accepts only `Authorization`; a dashboard cookie alone gets the RFC 9728 challenge.
- Refresh tokens rotate strictly and a replay revokes the family. Access tokens live until expiry, but
  a deactivated account is refused from the next request.
- Tool handlers never read an owner id from the client, and re-check the scope on every call.

Modules: `oauth.ts`, `auth.ts`, `mcp/mount.ts`, `mcp/artifact-tools.ts`, `packages/mcp-server`.

## Publish an artifact over MCP

`artifact_write` sends a whole text artifact in one call. Larger or binary payloads use the staged
transfer documented in [MCP transfers](/docs/reference/mcp-transfers/):

```text
artifact_start_upload   insert artifactUploads (open, 60-minute TTL)
artifact_put_chunk ×N   decode base64, hash locally, insert artifactChunks, put staging/<sha256>
artifact_commit         list chunks, check contiguity and declared size
                        read each chunk (cap + re-hash), assemble, verify the whole digest
                        put artifacts/<new revision id>
                        complete the upload
                        create artifact + revision + pointer, or compare-and-set the pointer
```

Failures are ordered so nothing half-written is ever served:

- A preflight refusal writes nothing, and the upload stays retryable.
- A storage failure leaves no revision row, only bytes no row names; the daily revision sweep collects
  them after its grace window.
- A digest mismatch stores no artifact row.
- A lost compare-and-set returns `concurrent_commit` with the current revision id.

A write either names the revision it was built from (`expectedRevisionId`) or names none. With the id
it is compare-and-set, so a moved pointer refuses instead of overwriting. Without it the write is
create-or-refuse, so a second write to an existing artifact id also refuses. There is no
last-writer-wins path: recovery is a re-read, then one more write built on the content the current id
names. Replaying the same stale id keeps refusing.

Modules: `mcp/artifact-tools.ts`, `domain/staging.ts`, `domain/commit-flow.ts`, `domain/commits.ts`,
`adapters/storage/s3.ts`.

## Open an artifact

```text
GET /artifact/:id (session or bearer)
  readable? = live artifact AND (owner OR grant)
  no  → the same branded 404 for missing, foreign and deleted
  yes → read the current revision's key
        HeadObject (size ≤ cap), GetObject (stream, cap, re-hash)
        markdown → markdown-it (html: false), rendered in the page with the comment margin
        html     → escaped into srcdoc of a sandbox="allow-scripts" frame, plus the comment bridge
        canvas / deck → the scene viewer
```

The public path, `GET /share/:token`, resolves `sha256(token)` against a live link and a live
artifact, adds `x-robots-tag: noindex`, and answers every miss with the same 404 page.

Modules: `routes/library.ts`, `routes/sharing.ts`, `viewer/`.

## Share by email and public links

**Grant.** The owner's session, exact `Origin` and a JSON body; the artifact must be live and owned.
The recipient email is normalized and resolved to a registered account: an unknown one is
`404 recipient_not_found`, a self grant `400 invalid_recipient`. The insert relies on
`UNIQUE(artifactId, sharedWithUserId)` to arbitrate races, and revocation deletes the row.

**Public link.** 32 random bytes become a 43-character base64url token; only its `sha256` is stored,
and the URL is returned once. Revoke stamps `revokedAt`; rotate inserts a successor and revokes the
predecessor in one transaction, preserving the chain.

Modules: `routes/sharing.ts`.

## Editing a document

```text
GET /api/artifacts/:id/document          gate: live, owner or role, editable kind
                                         read the draft, else the current snapshot (bytes verified)
  ◀── { text, revisionId, revisionNumber, seq, publishedSeq }
PUT /api/artifacts/:id/document { text, expectedSeq }     autosave, debounced 1.5 s
  expectedSeq and expectedRevisionId together  → 400 unexpected_revision_token
  no expectedSeq while a draft exists          → 409 sequence_required
  expectedSeq ≠ draft seq                      → 409 concurrent_edit { currentSeq, currentRevisionId }
  diff stored text → typed operations; append the operation row and advance the draft in one transaction
  after 100 pending operations or 10 minutes: write the canonical draft under a new key,
  then insert the snapshot and move publishedSeq and the pointer in one transaction
```

A save names exactly one identity: `expectedSeq` writes the draft; a save without it is the
whole-revision path, accepted only for an artifact the operation path never touched. Every
`concurrent_edit` carries the same `{ currentSeq, currentRevisionId }`, and a conflict freezes autosave
in the dashboard while keeping local edits until the person reloads.

**Restore** reads a pinned revision's verified bytes and records them as a `replace_document` operation
plus a new snapshot, so the restore is itself in history. It refuses with
`409 restore_pending_changes` while the draft holds applied operations that are not published yet.

Live collaboration runs over `/api/collab`: Yjs rooms per artifact, authorized by the session, whose
state is flushed back into the same operation path. Agents use the `document_*` and `scene_*` tools
against the same sequence.

Modules: `routes/editing.ts`, `routes/scene.ts`, `domain/documents/service.ts`, `collab/`,
`apps/dashboard/src/editor-autosave.ts`.

## Comments

1. The client maps a selection to an anchor. For Markdown that is 1-indexed source lines and UTF-16
   columns, with the source slice as `quotedText`.
2. `POST /api/artifacts/:id/comments` locks the artifact row, re-reads the **current** revision after the
   lock, validates the anchor against the document kind and the exact quote, then inserts with that
   revision id.
3. Refusals: a stale quote is `400 anchor_mismatch`; an invalid range or shape `400 invalid_anchor`; an
   anchor kind the document does not accept `400 unsupported_anchor_kind`; a root without an anchor
   `400 root_requires_anchor`; a reply with one `400 reply_has_no_anchor`.
4. Replies inherit their root's context; replies to replies are refused. Resolve and unresolve affect
   roots only. Deleting a root cascades its replies.

Comments never create revisions. A reader sees threads and is refused every write. A public link serves
threads read-only through `GET /share/:token/comments`, only while its `showComments` option is on,
with authors reduced to `{ id, name, image }`.

A comment never moves. Staleness is detected by comparing the current source at the recorded
coordinates with the stored quote, so an outdated thread stays at its anchor, labelled outdated,
instead of being relocated to a guess. On HTML, the bridge resolves an `element` anchor by `id`, then a
`data-*` attribute, then a unique text hint, and falls back to the stored `page-point` with an "Element
changed" pin. If the comment store fails while a viewer renders, the page is served without threads
and writing is disabled; the document is never traded for its comments.

Modules: `routes/comments.ts`, `adapters/postgres/comments-repo.ts`, `viewer/comments-data.ts`,
`viewer/html-bridge-script.ts`, `packages/domain/src/comment-anchors.ts`.

## Delete and garbage collection

**Delete** (owner, confirmed twice in the dashboard):

1. Session, `Origin` and JSON; a non-UUID, missing, foreign or already-deleted id is one 404.
2. Stamp `deletedAt`. That is the whole answer: the artifact stops resolving everywhere at once.
3. Best effort, delete the artifact's own revision keys — one per revision, never shared, so no
   reference query is needed. A storage failure is swallowed and leaves bytes the revision sweep will
   not collect, because the kept rows still name them.

**Staging sweep** (every 15 minutes):

1. Snapshot expired, non-complete uploads and their digests **before** deleting rows, since the cascade
   would erase the digest-to-key mapping.
2. Exclude every digest still needed by an open, unexpired upload.
3. Delete `staging/<sha256>` per key with failures isolated, and only then delete the upload rows whose
   digests all resolved.

**Revision sweep** (daily):

1. List `artifacts/` in pages of 200, at most 2,000 keys per run, with no persisted cursor.
2. An object is a candidate only when the bucket's `LastModified` is older than 24 hours **and** no
   `artifactRevisions` row names its key — one row query per page.
3. Delete candidates one by one with failures isolated. The sweep never writes a row.

**Asset sweep** (daily) applies the same bounds to `assets/`. For an object older than 24 hours that
no `artifactAssets` row references, it first drops the `assets` row — re-checking references, and
counting the object as `kept` if one appeared — and only then deletes the object.

Each sweep logs one summary line per run; the formats are in
[Operate and upgrade](/docs/self-hosting/operations/#health-and-logs).

Modules: `domain/deletion.ts`, `domain/gc.ts`, `adapters/storage/s3.ts`.

## Health and degradation

`GET /api/health` runs `SELECT 1` and `HeadBucket` in parallel: both pass is `200 {"status":"ok"}`,
either failing is `503 {"status":"degraded"}`, and the body carries only `ok` or `error` per check.
Auth and metadata keep working while storage is degraded; commits and reads fail closed. The production
API container uses this endpoint as its healthcheck.

Modules: `routes/health.ts`.
