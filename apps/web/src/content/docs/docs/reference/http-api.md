---
title: HTTP API
description: >-
  Every supported /api/v1 route of an Artiflow instance: paths, scopes, request and response
  fields, status codes, and the error model.
sidebar:
  order: 1.5
---

Every Artiflow instance publishes a JSON HTTP API under `/api/v1` on its own origin. Requests
authenticate with an OAuth 2.1 bearer token; there is no static API key, and the API never reads a
dashboard cookie. Use it when an agent, script or CI job has to publish, read, edit or share an artifact
without an MCP client.

The dashboard also talks to `/api/*` (no `/v1`) with its own session cookie. Those routes are internal
to the browser app and are not part of this reference.

## Before the examples

Credentials are covered in [API authentication](/docs/reference/api-authentication/): resource
discovery, client registration, PKCE, token lifetimes and the scope each operation needs. The examples
here assume a token carrying the scope named in the route table, plus two shell variables you set
yourself:

```sh
ARTIFLOW_ORIGIN="https://artifacts.example.com"   # your instance origin, no trailing slash
ARTIFLOW_TOKEN="..."                              # access token obtained by your OAuth client
```

## Quick path

1. Get an access token with `artifacts:write` ([API authentication](/docs/reference/api-authentication/)).
2. `POST /api/v1/artifacts` with the document text.
3. `GET /api/v1/artifacts/{artifactId}` to confirm what was stored.

## Routes

Paths below are relative to `$ARTIFLOW_ORIGIN/api/v1`. `{artifactId}`, `{revisionId}`, `{commentId}`,
`{shareId}` and `{linkId}` are ids copied from a previous response. `HEAD` is accepted wherever `GET` is
and returns the same headers with an empty body.

| Method   | Path                                                     | Scope             | Success |
| -------- | -------------------------------------------------------- | ----------------- | ------- |
| `POST`   | `/artifacts`                                             | `artifacts:write` | `201`   |
| `GET`    | `/artifacts`                                             | `artifacts:read`  | `200`   |
| `GET`    | `/artifacts/shared`                                      | `artifacts:read`  | `200`   |
| `GET`    | `/artifacts/{artifactId}`                                | `artifacts:read`  | `200`   |
| `GET`    | `/artifacts/{artifactId}/bytes`                          | `artifacts:read`  | `200`   |
| `DELETE` | `/artifacts/{artifactId}`                                | `artifacts:write` | `200`   |
| `GET`    | `/artifacts/{artifactId}/document`                       | `artifacts:read`  | `200`   |
| `PUT`    | `/artifacts/{artifactId}/document`                       | `artifacts:write` | `200`   |
| `PUT`    | `/artifacts/{artifactId}`                                | `artifacts:write` | `200`   |
| `GET`    | `/artifacts/{artifactId}/revisions`                      | `artifacts:read`  | `200`   |
| `POST`   | `/artifacts/{artifactId}/revisions/{revisionId}/restore` | `artifacts:write` | `200`   |
| `GET`    | `/artifacts/{artifactId}/comments`                       | `artifacts:read`  | `200`   |
| `POST`   | `/artifacts/{artifactId}/comments`                       | `comments:write`  | `201`   |
| `POST`   | `/artifacts/{artifactId}/comments/{commentId}/resolve`   | `comments:write`  | `200`   |
| `POST`   | `/artifacts/{artifactId}/comments/{commentId}/unresolve` | `comments:write`  | `200`   |
| `DELETE` | `/artifacts/{artifactId}/comments/{commentId}`           | `comments:write`  | `200`   |
| `GET`    | `/artifacts/{artifactId}/shares`                         | `shares:manage`   | `200`   |
| `POST`   | `/artifacts/{artifactId}/shares`                         | `shares:manage`   | `201`   |
| `DELETE` | `/artifacts/{artifactId}/shares/{shareId}`               | `shares:manage`   | `200`   |
| `GET`    | `/artifacts/{artifactId}/links`                          | `shares:manage`   | `200`   |
| `POST`   | `/artifacts/{artifactId}/links`                          | `shares:manage`   | `201`   |
| `POST`   | `/artifacts/{artifactId}/links/{linkId}/rotate`          | `shares:manage`   | `201`   |
| `DELETE` | `/artifacts/{artifactId}/links/{linkId}`                 | `shares:manage`   | `200`   |

Any other method or path under `/api/v1` is `405 {"error":"method_not_allowed"}`, decided before the
credential is even checked. This table is the whole public API: no upload, publish, search, folder,
account or admin route exists here.

## Create an artifact

Creation is API- and MCP-only; the dashboard has no create form. Send the document text directly and
the server hashes and stores the bytes.

```sh
curl -sS -X POST "$ARTIFLOW_ORIGIN/api/v1/artifacts" \
  -H "Authorization: Bearer $ARTIFLOW_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{
  "kind": "html",
  "title": "Release checklist",
  "text": "<!doctype html><html><body style='font-family:sans-serif'><h1>Release checklist</h1><p>Ship it.</p></body></html>"
}
JSON
```

```json
{
  "artifactId": "3f0f0b1e-2b6b-4a5e-9b7b-6a1c2d3e4f50",
  "revisionId": "8c2d4a10-9e3f-4b6a-8f1d-2c3b4a596877",
  "revisionNumber": 1,
  "sizeBytes": 132,
  "observedSizeBytes": 132,
  "sha256": "0b1e...c9a"
}
```

| Field   | Required | Rules                                                                  |
| ------- | -------- | ---------------------------------------------------------------------- |
| `text`  | yes      | Non-empty UTF-8 text, up to 16 MiB (16,777,216 bytes) in this one call |
| `kind`  | no       | `html` (default), `markdown`, `canvas`, or `deck`                      |
| `title` | no       | 1–200 characters                                                       |

This route takes the whole document in one request, so its cap is the artifact cap, not the 1 MiB
single-call cap of the MCP `artifact_write` tool. Larger than the cap, or a declared `Content-Length`
above it, is `413 {"error":"too_large","maxBytes":16777216}`.

Refusals specific to this route:

| Status | Code                      | Cause                                                    |
| ------ | ------------------------- | -------------------------------------------------------- |
| `400`  | `invalid_request`         | Body is not JSON or does not match the schema            |
| `400`  | `text_required`           | `text` is present but encodes to zero bytes              |
| `400`  | `not_valid_utf8_markdown` | `kind: "markdown"` with bytes that are not valid UTF-8   |
| `413`  | `too_large`               | `text` (or the declared length) exceeds the artifact cap |
| `500`  | `error`, `storage`        | The revision could not be persisted                      |

## List and read

`GET /artifacts` returns the artifacts **you own**:

```json
{
  "artifacts": [
    {
      "id": "3f0f0b1e-2b6b-4a5e-9b7b-6a1c2d3e4f50",
      "title": "Release checklist",
      "kind": "html",
      "createdAt": "2025-02-04T09:12:44.001Z",
      "updatedAt": "2025-02-04T09:12:44.001Z",
      "observedSizeBytes": 132,
      "revisionCount": 1,
      "currentRevisionId": "8c2d4a10-9e3f-4b6a-8f1d-2c3b4a596877",
      "sha256": "0b1e...c9a"
    }
  ]
}
```

Newest first, at most 100 rows, no pagination parameters. `title` and `observedSizeBytes` are `null`
until an artifact has one, and `kind` reads `unknown` for a stored value that is not one of the declared
kinds (`html`, `markdown`, `canvas`, `deck`).

`GET /artifacts/shared` lists what other accounts invited you to, at most 200 rows, each row adding
`sharedBy: {"email": "owner@example.com"}`.

`GET /artifacts/{artifactId}` returns one artifact you own:

```json
{
  "id": "3f0f0b1e-2b6b-4a5e-9b7b-6a1c2d3e4f50",
  "title": "Release checklist",
  "createdAt": "2025-02-04T09:12:44.001Z",
  "updatedAt": "2025-02-04T09:12:44.001Z",
  "observedSizeBytes": 132,
  "revision": {
    "id": "8c2d4a10-9e3f-4b6a-8f1d-2c3b4a596877",
    "revisionNumber": 1,
    "sha256": "0b1e...c9a",
    "sizeBytes": 132
  }
}
```

`revision` is `null` when the artifact has no current revision. Detail is owner-only: an artifact
shared with you answers `404 not_found` here, exactly like a missing one, even though its Markdown
source is readable through `/document`.

## Raw bytes

`GET /artifacts/{artifactId}/bytes` returns the artifact's bytes, base64-encoded, after the storage
adapter has re-verified them against the revision's `sha256`. The request sends the same headers as
the create example above, with `GET` on the bytes path:

```json
{
  "artifactId": "3f0f0b1e-2b6b-4a5e-9b7b-6a1c2d3e4f50",
  "revisionId": "8c2d4a10-9e3f-4b6a-8f1d-2c3b4a596877",
  "revisionNumber": 1,
  "kind": "html",
  "sha256": "0b1e...c9a",
  "sizeBytes": 132,
  "contentBase64": "<base64 of the artifact bytes>"
}
```

## HTML byte update

`PUT /artifacts/{artifactId}` is the HTML byte update: the API-client pair of the MCP
`artifact_write` compare-and-set write. The bytes arrive complete in one JSON call, the server
hashes them itself, and a new revision is appended only when the current pointer still matches
`expectedRevisionId` — a stale value is a typed refusal, never a silent overwrite. Send the same
headers as the create example above with `PUT`, and this body:

```json
{
  "expectedRevisionId": "8c2d4a10-9e3f-4b6a-8f1d-2c3b4a596877",
  "kind": "html",
  "text": "<!doctype html><html><body><h1>Release checklist</h1></body></html>"
}
```

| Field                | Required | Rules                                                                 |
| -------------------- | -------- | --------------------------------------------------------------------- |
| `expectedRevisionId` | yes      | The current revision id; a stale value is a refusal, not an overwrite |
| `text`               | yes      | Non-empty UTF-8 text, up to the 16 MiB artifact cap                   |
| `kind`               | yes      | The literal `html` — this route never converts a `markdown` artifact  |
| `title`              | no       | 1–200 characters                                                      |

The answer is the create response shape (`artifactId`, `revisionId`, `revisionNumber`, `sizeBytes`,
`observedSizeBytes`, `sha256`). Its cap is the artifact cap, not the 1 MiB single-call cap of MCP
`artifact_write`.

| Status | Code                            | Cause                                                               |
| ------ | ------------------------------- | ------------------------------------------------------------------- |
| `400`  | `expected_revision_id_required` | `expectedRevisionId` missing or empty                               |
| `400`  | `invalid_request`               | Body is not JSON or does not match the schema                       |
| `404`  | `not_found`, `gone`             | Unknown, foreign or already deleted artifact                        |
| `409`  | `wrong_kind`                    | The artifact is not `html`                                          |
| `409`  | `concurrent_commit`             | `expectedRevisionId` is stale; the body carries `currentRevisionId` |
| `413`  | `too_large`                     | The text (or the declared length) exceeds the artifact cap          |

## Markdown source, revisions and restore

`GET /artifacts/{artifactId}/document` returns the editable source of a `markdown` artifact for its
owner **or** for an account it was shared with:

```json
{
  "artifactId": "3f0f0b1e-2b6b-4a5e-9b7b-6a1c2d3e4f50",
  "title": "Runbook",
  "kind": "markdown",
  "revisionId": "8c2d4a10-9e3f-4b6a-8f1d-2c3b4a596877",
  "revisionNumber": 3,
  "text": "# Runbook\n\nStep one.\n"
}
```

`PUT /artifacts/{artifactId}/document` saves the whole document. It is editor-only (the owner, or a
grant with the `editor` role) and requires the revision you started from, so a stale save never
overwrites newer work:

```sh
curl -sS -X PUT "$ARTIFLOW_ORIGIN/api/v1/artifacts/$ARTIFLOW_ARTIFACT_ID/document" \
  -H "Authorization: Bearer $ARTIFLOW_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{
  "expectedRevisionId": "8c2d4a10-9e3f-4b6a-8f1d-2c3b4a596877",
  "text": "# Runbook\n\nStep one.\nStep two.\n"
}
JSON
```

```json
{
  "artifactId": "3f0f0b1e-2b6b-4a5e-9b7b-6a1c2d3e4f50",
  "revisionId": "aa71f0c4-5b2e-4b0f-9d6f-77e0d1c2b3a4",
  "revisionNumber": 4,
  "sizeBytes": 34,
  "sha256": "5d2c...a710"
}
```

| Status | Code                            | Cause                                                                     |
| ------ | ------------------------------- | ------------------------------------------------------------------------- |
| `400`  | `text_required`                 | `text` missing or empty                                                   |
| `400`  | `expected_revision_id_required` | `expectedRevisionId` missing or empty                                     |
| `403`  | `forbidden`                     | The caller can read but not edit the artifact                             |
| `409`  | `concurrent_edit`               | `expectedRevisionId` is not current; the body carries `currentRevisionId` |
| `409`  | `wrong_kind`                    | The artifact is not `markdown`                                            |
| `409`  | `no_current_revision`           | The artifact has no current revision to base a save on                    |
| `413`  | `too_large`                     | The document exceeds the artifact cap                                     |

`GET /artifacts/{artifactId}/revisions` returns history, newest first, at most 200 rows:
`{"revisions":[{"id":"…","revisionNumber":4,"sizeBytes":34,"createdAt":"…"}]}`.

`POST /artifacts/{artifactId}/revisions/{revisionId}/restore` appends the bytes of an old revision as a
**new** revision under the same rule: body `{"expectedRevisionId":"…"}`, answer
`{"artifactId":"…","revisionId":"…","revisionNumber":5,"restoredFrom":"…","sha256":"…"}`. A restore is
undoable for the same reason, and an old revision id that is not this artifact's answers
`404 revision_not_found`.

### Rename (dashboard route)

Renaming is not one of the `/api/v1` paths above. The dashboard calls
`PATCH /api/artifacts/{artifactId}/metadata` with `{"title":"…"}`, authenticated by the session cookie
and nothing else: the route has no bearer path. Like every cookie mutation it needs the exact `Origin`
and a JSON content type, checked before the session; it is mounted only when the process knows its
public origin, which is what the guard compares against.

```json
{
  "artifactId": "3f0f0b1e-2b6b-4a5e-9b7b-6a1c2d3e4f50",
  "title": "Runbook 2026",
  "currentRevisionId": "8c2d4a10-9e3f-4b6a-8f1d-2c3b4a596877",
  "revisionCount": 4
}
```

| Status | Code                         | Cause                                                |
| ------ | ---------------------------- | ---------------------------------------------------- |
| `400`  | `title_required`             | `title` is missing, not a string, or only whitespace |
| `400`  | `title_too_long`             | More than 200 characters                             |
| `403`  | `origin_not_allowed`         | `Origin` is not the instance origin                  |
| `404`  | `not_found`                  | Unknown, foreign or already deleted artifact         |
| `413`  | `too_large`                  | The body exceeds 64 KB                               |
| `415`  | `json_content_type_required` | The content type is not JSON                         |

Only the title and its timestamp change, so no revision is created and the answer reports the pointer
and count it did not touch: public links and comment threads keep working through a rename. `404`
covers "not yours" and "deleted" as well as "unknown" on purpose, so the answer never confirms that an
id exists on another account.

## Comments

A comment is a generic entity whose anchor is discriminated by `kind`. Markdown accepts
`text-range` anchors, `html` accepts `element` and `page-point`, and `canvas` accepts `board-point`.
An anchor that does not belong to the artifact's kind is refused with `400 unsupported_anchor_kind`.
A scene anchor is resolved against the current scene before it is stored, so a node the scene does not
hold is `400 unknown_node`; a thread whose node is gone is listed with `orphaned: true`. A root comment always carries an
anchor, a reply never does: a root without one is `400 root_requires_anchor` and a reply that sends
one is `400 reply_has_no_anchor`.

| Kind          | Shape                                                                                                     | Document |
| ------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| `text-range`  | `{startLine, startCol, endLine, endCol, quotedText}` — 1-indexed, end-exclusive, over the Markdown source | Markdown |
| `element`     | `{selector, point:{x,y} in 0–1, textHint (≤120 chars), viewportWidth}`                                    | HTML     |
| `page-point`  | `{x in 0–1, y in pixels, viewportWidth}`                                                                  | HTML     |
| `board-point` | `{boardId (frame), nodeId, x, y}` — x and y are fractions of the node's own box                           | Canvas   |
| `slide-point` | `{slideId, nodeId, x, y}` — same rules as `board-point`                                                   | Deck     |

`GET /artifacts/{artifactId}/comments` returns threads for anyone who can read the artifact. The
author is an entity: `{ id, name, image }`, never an email of another participant.

```json
{
  "canComment": true,
  "comments": [
    {
      "id": "0f2b1c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "authorId": "user_owner",
      "author": { "id": "user_owner", "name": "Owner", "image": null },
      "anchor": {
        "kind": "text-range",
        "startLine": 3,
        "startCol": 1,
        "endLine": 3,
        "endCol": 9,
        "quotedText": "Step one."
      },
      "body": "Is this still accurate?",
      "resolvedAt": null,
      "createdAt": "2025-02-04T10:01:00.000Z",
      "canDelete": true,
      "replies": []
    }
  ]
}
```

`POST /artifacts/{artifactId}/comments` accepts
`{"anchor":{"kind":"text-range","startLine":3,"startCol":1,"endLine":3,"endCol":9,"quotedText":"Step one."},"body":"…","expectedRevisionId":"8c2d4a10-9e3f-4b6a-8f1d-2c3b4a596877"}`
for a root, and `{"body":"…","parentId":"…"}` for a reply, answering `201 {"id":"…"}`.

A root must name the revision it was written against: the `revisionId` the viewer page it was written
from was served with, or the one the editor was last saved against. The value has to be the current
revision at insert time, so a comment written against a page that has since been republished is
refused instead of being anchored to text the writer never saw. Replies carry no revision of their own.
`parentId` may only name a root comment: replying to a reply is `400 nested_reply`. `text-range` quotes
are verified against the current revision; `element` and `page-point` anchors are validated for shape
only and evaluated in the client, so they never report staleness from the server.

| Status | Code                                          | Cause                                                                  |
| ------ | --------------------------------------------- | ---------------------------------------------------------------------- |
| `400`  | `body_required`                               | Empty comment body                                                     |
| `400`  | `invalid_anchor`, `anchor_mismatch`           | The anchor is malformed, selects no text, or its quote is not the text |
| `400`  | `unsupported_anchor_kind`                     | The anchor kind does not belong to the artifact's kind                 |
| `400`  | `root_requires_anchor`, `reply_has_no_anchor` | A root omitted its anchor, or a reply sent one                         |
| `400`  | `expected_revision_required`                  | A root omitted `expectedRevisionId` or sent a blank one                |
| `400`  | `nested_reply`                                | `parentId` names a reply                                               |
| `403`  | `forbidden`                                   | The caller cannot comment on this artifact                             |
| `404`  | `comment_not_found`                           | `parentId` is not a comment on this artifact                           |
| `409`  | `no_current_revision`                         | Nothing to anchor against                                              |
| `409`  | `revision_conflict`                           | `expectedRevisionId` is not the current revision; nothing is inserted  |
| `413`  | `too_large`                                   | `body` over 4000 characters or `quotedText` over 2000                  |

Readers keep read access: they list threads but get `403 forbidden` on every write. A comment root
stores the revision it named, which had to be the current one at insert time, and resolving records who
did it.

`POST /artifacts/{artifactId}/comments/{commentId}/resolve` and `…/unresolve` answer `200 {"id":"…"}`;
only a root comment can be resolved (`400 root_required` otherwise). `DELETE
/artifacts/{artifactId}/comments/{commentId}` answers `200 {"id":"…"}` for the artifact owner or the
comment's author (`403 forbidden` for anyone else) and drops a root's replies with it.

### Comments on a public link

A public link carries a `showComments` option, off by default. The owner toggles it with
`PATCH /artifacts/{artifactId}/links/{linkId}` and `{"showComments":true}`; every other caller is
`404`. When the option is on, `GET /share/{token}/comments` serves the threads of an `html` or `markdown`
link read-only, with `canDelete: false`, no private data and no email addresses. When it is off that
path is `404`. A `canvas` or `deck` link answers `404 {"error":"not_found"}` whatever the option
says: a scene mounts no comment surface — no host, no config, no bundle, and no pin on a public link —
and the refusal is byte for byte the answer an unknown token gets, so the path never tells a caller
which link it is. The path is `GET` only; there is no public write route, and no other public path
exposes comments.

## Invitations and public links

`GET /artifacts/{artifactId}/shares` lists invitations, oldest first, at most 200 rows, with
`{"id":"…","sharedWith":{"email":"…"},"createdAt":"…"}` per row and the recipient's user id in
`sharedWithUserId`.

`POST /artifacts/{artifactId}/shares` with `{"email":"teammate@example.com"}` invites an **existing
account** and answers `201 {"id":"…","sharedWith":{"email":"…"},"createdAt":"…"}`.

| Status | Code                  | Cause                                                |
| ------ | --------------------- | ---------------------------------------------------- |
| `400`  | `invalid_email`       | The address is not a plausible email                 |
| `400`  | `invalid_recipient`   | The address belongs to the owner                     |
| `404`  | `recipient_not_found` | No account with that address exists on this instance |
| `404`  | `not_found`           | The artifact is not yours                            |
| `409`  | `already_shared`      | That account already has access                      |

Invitations grant **read** access; this API has no role parameter. `DELETE
/artifacts/{artifactId}/shares/{shareId}` answers `200 {"ok":true}` and the account loses access at
once.

A public link is one URL that anyone can open without an account. Management is owner-only:

```sh
curl -sS -X POST "$ARTIFLOW_ORIGIN/api/v1/artifacts/$ARTIFLOW_ARTIFACT_ID/links" \
  -H "Authorization: Bearer $ARTIFLOW_TOKEN"
```

```json
{
  "id": "6b1f2a3c-4d5e-4f60-8a71-92b3c4d5e6f7",
  "url": "https://artifacts.example.com/share/rT9k…43chars",
  "token": "rT9k…43chars"
}
```

**The token and URL are returned once and are not recoverable.** Only a SHA-256 of the token is stored,
so `GET /artifacts/{artifactId}/links` lists `{"id":"…","createdAt":"…","revokedAt":null}` rows with no
token and no URL. Losing the URL means rotating the link.

- `POST /artifacts/{artifactId}/links` creates a link (`201`, shape above).
- `POST /artifacts/{artifactId}/links/{linkId}/rotate` revokes the old link and returns a successor in
  one step (`201`, same shape).
- `DELETE /artifacts/{artifactId}/links/{linkId}` revokes it (`200 {"ok":true}`, or
  `409 already_revoked`).

Links do not expire on their own, and a link always serves the artifact's current revision. The
browser side of this flow is in [Share and publish](/docs/guides/sharing/).

## Delete an artifact

`DELETE /artifacts/{artifactId}` answers `200 {"ok":true}` for the owner. Deletion is a soft delete that
takes effect on the next request: the artifact disappears from your list, its public links stop
resolving, and it is no longer readable by anyone it was shared with. A malformed, foreign, already
deleted or unknown id is the same `404 not_found`.

## Browser URLs

Two viewer URLs are not part of `/api/v1` but are what you hand to a person:

| URL                                      | Credential                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `$ARTIFLOW_ORIGIN/artifact/{artifactId}` | A dashboard session, **or** a bearer token with `artifacts:read` (`?embed=1` drops the viewer bar) |
| `$ARTIFLOW_ORIGIN/share/{token}`         | None; the token is the whole credential, and the page is `noindex`                                 |

On `/artifact/{artifactId}`, sending an `Authorization` header disables the cookie fallback: an
unverifiable token gets the `401` challenge envelope above, and a verified token without
`artifacts:read` answers `401 {"error":"insufficient_scope"}` with a `WWW-Authenticate: Bearer
error="insufficient_scope", scope="artifacts:read"` header. A request with no header falls back to the
dashboard session, and with no session answers `401 {"error":"unauthorized"}`.

`/share/{token}?meta=1` answers that link's metadata as JSON instead of the page:

```json
{
  "revisionNumber": 4,
  "sha256": "5d2c…a710",
  "sizeBytes": 3481,
  "kind": "html",
  "comments": true
}
```

The five keys are `kind`, `revisionNumber`, `sha256`, `sizeBytes` and `comments`. `comments` is the
effective flag — the link's own option combined with the kind — so a `canvas` or `deck` link reports
`false` whatever the option says. An unknown or revoked token, an artifact without a current revision
and any `meta` value other than `1` are the same `404` page the page itself answers. The response is
`no-store` and `noindex`, and the public viewer polls it to notice a new revision or a link that
stopped resolving.

## Error model

Every response carries an `x-request-id` header — the caller's own value when it sent one, a generated
uuid otherwise. There are two error shapes.

**Route refusals** are a JSON object with an `error` code:

```json
{ "error": "not_found" }
```

Some of them add the field a client needs to recover: `maxBytes` on `too_large`, `currentRevisionId` on
`concurrent_edit`, `reason` on an internal failure. Unknown failures answer
`500 {"error":"internal_error","requestId":"…"}` with no stack trace and no driver text.

**Credential refusals** happen before any route runs and come from the OAuth resource-server challenge:
`401` with a `WWW-Authenticate` header and a JSON-RPC error envelope, which is what an MCP-shaped
client library already understands:

```text
WWW-Authenticate: Bearer resource_metadata="https://artifacts.example.com/.well-known/oauth-protected-resource/api/v1",
  scope="artifacts:read artifacts:write comments:write shares:manage"
```

```json
{ "jsonrpc": "2.0", "error": { "code": -32000, "message": "…" }, "id": null }
```

A missing, malformed, expired or wrong-audience token all land here. A verified token that carries no
subject answers `401 {"error":"invalid_token"}` instead.

| Status | Codes                                                                                                                                                                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `invalid_request`, `text_required`, `expected_revision_id_required`, `body_required`, `quote_required`, `invalid_anchor`, `anchor_mismatch`, `nested_reply`, `root_required`, `invalid_email`, `invalid_recipient`, `invalid_target`, `invalid_grant` (OAuth endpoints) |
| `401`  | `invalid_token`, `unauthorized` (route-level; see the challenge envelope above)                                                                                                                                                                                         |
| `403`  | `insufficient_scope`, `forbidden`                                                                                                                                                                                                                                       |
| `404`  | `not_found`, `recipient_not_found`, `comment_not_found`, `revision_not_found`, `gone`                                                                                                                                                                                   |
| `405`  | `method_not_allowed`                                                                                                                                                                                                                                                    |
| `409`  | `conflict`, `concurrent_edit`, `concurrent_commit`, `wrong_kind`, `no_current_revision`, `already_shared`, `already_revoked`                                                                                                                                            |
| `413`  | `too_large`                                                                                                                                                                                                                                                             |
| `500`  | `internal_error`, `artifact_unavailable`, `error`, `storage`, `gone`, `expired`                                                                                                                                                                                         |

A token that verifies but lacks the scope a route needs is the one challenge the API itself raises:
`403 {"error":"insufficient_scope"}` with the required scope named in the header:

```text
WWW-Authenticate: Bearer realm="api", scope="artifacts:write",
  resource_metadata="https://artifacts.example.com/.well-known/oauth-protected-resource/api/v1"
```

A client should re-read the resource metadata, obtain a token with that scope, and retry. A permission
denial that more scope cannot fix stays a plain `403 forbidden` with no challenge.

Two request rules round this out:

- Send credentials only in `Authorization`. The API refuses any request carrying its internal identity
  header `x-artiflow-principal` with `400 invalid_request`.
- v1 needs no `Origin` header and no exact-origin check; that guard belongs to the cookie surface. JSON
  request bodies still need `Content-Type: application/json`.

## Next

- [API authentication](/docs/reference/api-authentication/) covers discovery, the OAuth 2.1 flow and scopes.
- [Artifacts and revisions](/docs/concepts/artifacts/) explains revisions, kinds and the access model.
- [Share and publish](/docs/guides/sharing/) shows the same invitations and links in the dashboard.
- [Connect an agent](/docs/connect/mcp/) covers the MCP surface, including the write tool whose 1 MiB
  single-call cap differs from this API's artifact cap.
