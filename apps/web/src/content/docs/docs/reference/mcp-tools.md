---
title: MCP tool reference
description: All twelve Artiflow MCP tools with their exact arguments, success payloads, typed errors and limits, checked against the server implementation.
sidebar:
  order: 8
---

Artiflow registers **twelve** MCP tools on one endpoint, `POST /mcp`. This page is the
complete contract: field names, required and optional arguments, defaults, validation, success
payloads, error kinds and limits. It describes the code, not an earlier draft of it.

Configuration, consent and per-client setup are in [Connect an agent](/docs/connect/mcp/).

## Endpoint contract

- `POST` is the only method; `GET` and `DELETE` answer `405` with `Allow: POST`, and a request whose
  `Accept` omits `application/json` or `text/event-stream` answers `406` (`-32000`).
- The transport is Streamable HTTP with one request per call and no session id.
- `Authorization: Bearer` is the only accepted credential; a dashboard cookie gets the RFC 9728
  challenge instead.
- `Host` must be on the instance's exact allowlist, and a present `Origin` must be the public origin,
  otherwise `403`.
- Request bodies are capped at 2 MiB, measured from `Content-Length` before the body is read.

## Scopes and identity

Every call is re-authorized inside the tool, so a transport that accepted the token is not the last
word: a token without a subject is refused with `invalid_token`, and a token missing the scope the
tool needs is refused with `insufficient_scope` naming that scope.

| Scope             | Tools                                                                           |
| ----------------- | ------------------------------------------------------------------------------- |
| `artifacts:write` | the nine mutating tools: upload, commit, write, edit and every comment mutation |
| `artifacts:read`  | `artifact_get`, `artifact_get_markdown`, `artifact_list_comments`               |

The token's subject **is** the owner. No tool accepts an owner or user id, and every artifact,
upload and comment is resolved inside that owner's scope; a foreign row reads as `not_found`
rather than a permission error.

## Result envelope

A successful call returns one text content item holding JSON:

```json
{ "content": [{ "type": "text", "text": "{\"artifactId\":\"…\",\"revisionId\":\"…\"}" }] }
```

`artifact_write` and `artifact_commit` additionally return the same object as `structuredContent`
and carry `_meta.ui.resourceUri` pointing at the viewer resource
`ui://artiflow/artifact-viewer` (`text/html;profile=mcp-app`). Hosts that implement MCP Apps render
the artifact inline from that resource; hosts that do not ignore `_meta` and keep the JSON above,
so nothing breaks when the preview is unavailable.

A refusal is still a tool result, with `isError: true` and a JSON body of the form
`{ "error": "<kind>", "message": "<reason>", …extra }`. Arguments that fail the declared schema
never reach the handler: the protocol layer answers a JSON-RPC error instead, so a typed error is
always about an argument the schema accepts but the operation rejects.

## The thirteen tools

| Tool                         | Scope             | What it does                                            |
| ---------------------------- | ----------------- | ------------------------------------------------------- |
| `artifact_start_upload`      | `artifacts:write` | Declare a staged upload of up to 16 MiB                 |
| `artifact_put_chunk`         | `artifacts:write` | Stage one base64 chunk of up to 1 MiB                   |
| `artifact_commit`            | `artifacts:write` | Verify the staged stream and commit it as an artifact   |
| `artifact_write`             | `artifacts:write` | Write a whole text artifact (≤ 1 MiB) in one call       |
| `artifact_get`               | `artifacts:read`  | Read one revision as base64                             |
| `artifact_update_metadata`   | `artifacts:write` | Rename an artifact: title only, no new revision         |
| `artifact_get_markdown`      | `artifacts:read`  | Read a Markdown document as numbered lines              |
| `artifact_edit_lines`        | `artifacts:write` | Patch a Markdown document by line and commit a revision |
| `artifact_list_comments`     | `artifacts:read`  | List Markdown comment threads with replies              |
| `artifact_add_comment`       | `artifacts:write` | Comment on a source selection                           |
| `artifact_reply_comment`     | `artifacts:write` | Reply to a root comment                                 |
| `artifact_resolve_comment`   | `artifacts:write` | Mark a thread resolved                                  |
| `artifact_unresolve_comment` | `artifacts:write` | Reopen a thread                                         |

## Staged transfer tools

The three-tool upload path, with a worked example, is on
[staged transfers](/docs/reference/mcp-transfers/). Signature summary:

- `artifact_start_upload` — `declaredSizeBytes` (1–16,777,216), `declaredSha256` (64 lowercase hex),
  optional `title` (1–200) and `uploadId` (1–100, default `upload-<uuid>`). Returns
  `{ uploadId, status, declaredSizeBytes, declaredSha256, expiresAt }`. The same `uploadId` with the
  same declaration is idempotent; a different declaration is `conflict` / `upload_declaration_mismatch`.
- `artifact_put_chunk` — `uploadId`, `chunkIndex` (0–15) and `contentBase64` (1–1,398,104 characters,
  decoding to 1–1,048,576 bytes). Returns `{ uploadId, chunkIndex, sizeBytes, sha256, storageKey }`
  with the digest the server computed itself. Byte-identical retries are idempotent; different bytes
  for an already staged index are `conflict` / `chunk_payload_mismatch`.
- `artifact_commit` — `uploadId`, plus optional `artifactId` (canonical lowercase UUID), `title`
  (1–200), `expectedRevisionId` and `kind` (`"html"` default, `"markdown"`). Returns the six
  revision keys shown below. The staged stream is verified before any artifact row is written.

## `artifact_write` — one call, text only

The shortest path from content an agent already holds to a published artifact.

| Field                | Type                     | Required | Rules                                                   |
| -------------------- | ------------------------ | -------- | ------------------------------------------------------- |
| `text`               | string                   | yes      | the whole document; at least 1 character                |
| `kind`               | `"html"` \| `"markdown"` | no       | default `"html"`                                        |
| `artifactId`         | string                   | no       | canonical lowercase UUID; omit to create a new artifact |
| `title`              | string                   | no       | 1–200 characters                                        |
| `expectedRevisionId` | string                   | no       | present = update that revision; absent = create         |

The server encodes `text` as UTF-8 and measures the bytes: more than **1,048,576 bytes** is refused
with `too_large`, carrying `{ maxBytes, observedBytes }`. Larger or binary content goes through
[the staged transfer](/docs/reference/mcp-transfers/).

```json
{
  "text": "<!doctype html>\n<title>Release notes</title>\n<h1>Release notes</h1>\n<p>2026-02-14 — search is faster.</p>",
  "kind": "html",
  "title": "Release notes"
}
```

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "revisionId": "0b7d9c31-2a4e-4d6f-8a19-3c5e7f2b1d84",
  "revisionNumber": 1,
  "sizeBytes": 107,
  "observedSizeBytes": 107,
  "sha256": "af9fb8489b7dd4143a6fa6c831fa868a9244ddfac54274137b455db6a7d4f873"
}
```

Rules worth knowing before you call it:

- `expectedRevisionId` without `artifactId` is `validation` / `artifact_id_required_for_expected_revision`.
- Reusing an `artifactId` that already exists **without** `expectedRevisionId` is
  `concurrent_commit` carrying the live `currentRevisionId`: retry with that value as
  `expectedRevisionId` to append a revision.
- On an update, a supplied `kind` must equal the stored kind, otherwise `conflict` / `kind_mismatch`.
- A non-empty `title` renames the artifact; omitting it keeps the stored title.

## `artifact_update_metadata` — rename without republishing

| Field                | Type   | Required | Rules                                         |
| -------------------- | ------ | -------- | --------------------------------------------- |
| `artifactId`         | string | yes      | canonical lowercase uuid                      |
| `title`              | string | yes      | 1–200 characters, at least one non-whitespace |
| `expectedRevisionId` | string | no       | refuse unless the pointer still matches       |

Returns `{ artifactId, title, currentRevisionId, revisionCount }`: the persisted title plus the
untouched revision pointer and count, so a caller can verify that **no revision was created** and
no byte moved. Renaming keeps share links, access grants and revision history intact. To detect a
concurrent commit instead of reordering title and content changes, pass the `expectedRevisionId`
read from `artifact_get`; a stale pointer refuses with `concurrent_commit` /
`current_revision_changed` carrying the live pointer. Never rename by re-uploading content: that
creates a revision and rewrites bytes for nothing.

| `error`               | `message` (example)                                              | Meaning                    |
| --------------------- | ---------------------------------------------------------------- | -------------------------- |
| `invalid_artifact_id` | `artifactId must be a canonical lowercase uuid (8-4-4-4-12 hex)` | malformed id               |
| `invalid_title`       | `title must contain at least one non-whitespace character`       | blank title                |
| `not_found`           | `artifact_not_visible_to_owner`                                  | missing or foreign         |
| `gone`                | `artifact_deleted`                                               | soft-deleted artifact      |
| `concurrent_commit`   | `current_revision_changed`                                       | stale `expectedRevisionId` |

## `artifact_get` — read one revision

| Field        | Type   | Required | Rules                                           |
| ------------ | ------ | -------- | ----------------------------------------------- |
| `artifactId` | string | yes      | 1–100 characters                                |
| `revisionId` | string | no       | that exact revision; omitted = current revision |

Returns `{ artifactId, revisionId, sha256, sizeBytes, contentBase64 }`. The bytes are re-read from
storage, capped at 16 MiB and re-hashed against the revision digest, so a tampered or truncated
object is a typed error, never content:

| `error`                  | `message` (example)                              | Meaning                                     |
| ------------------------ | ------------------------------------------------ | ------------------------------------------- |
| `not_found`              | `artifact_not_visible_to_owner`                  | missing or foreign artifact                 |
| `not_found`              | `revision_not_found`                             | the artifact has no such revision           |
| `gone`                   | `artifact_deleted`                               | soft-deleted artifact                       |
| `too_large`              | `stored_object_exceeds_read_cap`                 | stored object is larger than the 16 MiB cap |
| `digest_mismatch`        | `stored_bytes_do_not_match_key_digest`           | stored bytes no longer match their digest   |
| `not_found` / `conflict` | `revision_not_stored` / `storage_request_failed` | object storage answer                       |

`artifact_get` and `artifact_get_markdown` do not validate the UUID shape: a malformed id simply
resolves to `not_found`. `artifact_write` and `artifact_commit` do validate it, as do the comment
tools, because an id that cannot be addressed later cannot be managed later either;
`artifact_edit_lines` resolves its id through the same read path and reports `not_found`.

## `artifact_get_markdown` — numbered lines

| Field        | Type    | Required | Rules                      |
| ------------ | ------- | -------- | -------------------------- |
| `artifactId` | string  | yes      | 1–100 characters           |
| `from`       | integer | no       | ≥ 1, default 1             |
| `to`         | integer | no       | ≥ 1, default the last line |

Returns `{ artifactId, revisionId, lineCount, from, to, lines }`, with `lines` 1-indexed from the
whole document. `from` and `to` are clamped to the real document instead of refused, and the reply
reports the range actually served. Lines split on `\n`, so a document ending in a newline has a
final empty line.

Only `markdown` artifacts are readable here: an HTML artifact is opaque bytes and answers
`wrong_kind` / `artifact_is_not_a_markdown_document` with `{ artifactId, kind }`. Bytes that are not
valid UTF-8 answer `not_valid_utf8_markdown`; they are never decoded with replacement characters.
`from` greater than `to` after clamping is `validation` / `empty_line_window`.

## `artifact_edit_lines` — patch a Markdown document

| Field                | Type   | Required | Rules                                  |
| -------------------- | ------ | -------- | -------------------------------------- |
| `artifactId`         | string | yes      | 1–100 characters                       |
| `expectedRevisionId` | string | yes      | must equal the revision the agent read |
| `ops`                | array  | yes      | 1–50 operations, applied in order      |

Each operation is one of:

| Op        | Fields                                                         |
| --------- | -------------------------------------------------------------- |
| `replace` | `from`, `to` (1-indexed, inclusive), optional `expect`, `text` |
| `insert`  | `after` (0 inserts at the top), `text`                         |
| `delete`  | `from`, `to`, optional `expect`                                |

`text` is an array of 1–1000 lines. `expect` is the exact current window of that range: when it does
not match, nothing is written and the refusal carries the live lines so the agent can re-read
without another round trip.

The call is one revision and one transaction: operations apply sequentially against the evolving
document, and the first failure aborts the whole call with no revision created.
`expectedRevisionId` is mandatory, so an edit based on a stale read never clobbers a newer one.

Returns `{ artifactId, revisionId, revisionNumber, lineCount, appliedOps, sha256 }`, where
`lineCount` is the length of the resulting document.

| `error`                | `message`                                               | Extra                                    |
| ---------------------- | ------------------------------------------------------- | ---------------------------------------- |
| `concurrent_edit`      | `document_changed_since_read`                           | `currentRevisionId`                      |
| `expectation_mismatch` | `expected_text_does_not_match_current_lines`            | `opIndex`, `window: { from, to, lines }` |
| `validation`           | `line_range_out_of_bounds`, `insert_after_out_of_range` | `opIndex`                                |
| `validation`           | `bytes_required`                                        | the edit would produce an empty document |
| `too_large`            | `edited_document_exceeds_the_artifact_cap`              | `maxBytes`                               |

Note the kind: a stale pointer on this tool is `concurrent_edit`, while a stale pointer on
`artifact_write` / `artifact_commit` is `concurrent_commit`. Both carry the live revision id.

## Comments

Comments attach to the **current revision of a Markdown document you own**. They never create a
document revision, and the writing tools refuse with `wrong_kind` on HTML artifacts.

An anchor is `{ startLine, startCol, endLine, endCol }`: 1-indexed lines and UTF-16 code-unit
columns, end-exclusive. `quotedText` must equal that slice of the current source exactly, which is
why a stale selection is refused rather than silently re-anchored.

### `artifact_list_comments`

Input `{ artifactId }`. Returns `{ comments: [...] }`, one object per root comment:

```json
{
  "comments": [
    {
      "id": "…",
      "parentId": null,
      "authorId": "…",
      "anchor": { "startLine": 3, "startCol": 1, "endLine": 3, "endCol": 18 },
      "quotedText": "## Release notes",
      "body": "Add the version number here.",
      "resolvedAt": null,
      "createdAt": "2026-02-14T10:00:00.000Z",
      "replies": []
    }
  ]
}
```

Roots come first, each with its replies nested under `replies`. A reply uses exactly the same fields,
sets `parentId` to its root's id, inherits the root's `anchor` and `quotedText`, and never nests
further, so its own `replies` is always empty. `resolvedAt` is an ISO timestamp or `null`.

### `artifact_add_comment`

Input `{ artifactId, anchor, quotedText, body }`, returns `{ id }`.

| Rule   | Value                                                                     |
| ------ | ------------------------------------------------------------------------- |
| `body` | non-blank, at most 4000 Unicode characters                                |
| quote  | non-empty, at most 2000 Unicode characters, must match the current source |
| anchor | safe integers ≥ 1 inside the document; on one line, a non-empty selection |

Refusals: `validation` with `body_required`, `quote_required` or `invalid_anchor`; `too_large` with
`comment_body_exceeds_cap` / `comment_quote_exceeds_cap` and `{ maxCharacters }`; `anchor_mismatch`
when the quote no longer matches; `not_found`, `gone` and `wrong_kind` for the document itself.

### `artifact_reply_comment`

Input `{ artifactId, commentId, body }`, returns `{ id }`. The reply inherits the root's anchor and
quote even if that quote is now stale, because a thread is about the text it was opened on.
Replying to a reply is refused with `nested_reply` and `{ status: 400 }`; an unknown or foreign
`commentId` is `comment_not_found`. A `commentId` that is not a canonical lowercase UUID is
`validation`.

### `artifact_resolve_comment` / `artifact_unresolve_comment`

Input `{ artifactId, commentId }`, returns `{ id }`. Sets or clears `resolvedAt` on a **root**
comment; a reply answers `reply_is_not_root` with `{ status: 400 }`.

## Error kinds

| `error`                   | Typical cause                                                           |
| ------------------------- | ----------------------------------------------------------------------- |
| `invalid_token`           | the access token carries no subject                                     |
| `insufficient_scope`      | the token lacks the scope the tool needs; the message names it          |
| `validation`              | an argument the schema accepted is invalid for the operation            |
| `invalid_artifact_id`     | `artifactId` is not a canonical lowercase UUID                          |
| `not_found`               | missing or foreign artifact, upload, revision or chunk                  |
| `gone`                    | the artifact is soft-deleted                                            |
| `conflict`                | declaration, payload, status, kind or storage state disagrees           |
| `expired`                 | the staging upload is past its TTL                                      |
| `too_large`               | a cap is exceeded; `maxBytes` is included when known                    |
| `digest_mismatch`         | bytes do not hash to the declared or recorded digest                    |
| `chunk_unavailable`       | a staged chunk is missing or fails its recorded digest                  |
| `wrong_kind`              | a Markdown-only tool was called on an HTML artifact                     |
| `not_valid_utf8_markdown` | the bytes cannot be a Markdown document                                 |
| `concurrent_commit`       | the compare-and-set pointer moved (`artifact_write`, `artifact_commit`) |
| `concurrent_edit`         | the compare-and-set pointer moved (`artifact_edit_lines`)               |
| `expectation_mismatch`    | an `expect` guard did not match the live lines                          |
| `comment_not_found`       | unknown or foreign `commentId`                                          |
| `nested_reply`            | replied to a reply                                                      |
| `reply_is_not_root`       | resolved or reopened a reply                                            |
| `storage`                 | a storage write failed; retry the chunk or the commit                   |
| `error`                   | an unexpected transaction failure; not retryable as a conflict          |

## Limits

| Limit                                     | Value                                     |
| ----------------------------------------- | ----------------------------------------- |
| One `artifact_write` call                 | 1,048,576 decoded bytes (1024 KiB)        |
| Largest artifact                          | 16,777,216 bytes (16 MiB)                 |
| Largest staged chunk                      | 1,048,576 decoded bytes, indices `0`–`15` |
| `contentBase64` length                    | at most 1,398,104 characters              |
| Staging TTL                               | 60 minutes from upload creation           |
| Operations per `artifact_edit_lines` call | 50                                        |
| Comment body / quote                      | 4000 / 2000 Unicode characters            |
| MCP request body                          | 2 MiB                                     |

The single-call cap and the artifact cap are different limits on purpose:
`artifact_write` keeps one tool argument bounded to a single chunk, while an artifact itself may
grow to 16 MiB through [the chunk stream](/docs/reference/mcp-transfers/).

## What the tools cannot do

There is no tool to list, search, share, publish or delete artifacts, and none to list revisions or
read artifact metadata. Those are dashboard actions, so an agent can never widen access to an
artifact on its own. Uploads also expose no abort or cleanup tool: an abandoned upload expires after
the TTL.

## Next

- [Staged transfers and compare-and-set commits](/docs/reference/mcp-transfers/) for content above
  1 MiB.
- [Connect an agent](/docs/connect/mcp/) for client configuration and sign-in.
- [Artifacts and revisions](/docs/concepts/artifacts/) for the model behind these tools.
