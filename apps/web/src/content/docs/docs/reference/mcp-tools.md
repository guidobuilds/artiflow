---
title: MCP tool reference
description: All twenty-five Artiflow MCP tools with their exact arguments, success payloads, typed errors and limits, checked against the server implementation.
sidebar:
  order: 8
---

Artiflow registers **twenty-five** MCP tools on one endpoint, `POST /mcp`. This page is the
complete contract: field names, required and optional arguments, defaults, validation, success
payloads, error kinds and limits. It describes the code, not an earlier draft of it.

Thirteen tools move artifact bytes, seven work on a Markdown document in place, three on a canvas
scene, one draws a canvas or deck for a host viewer, and one stores an image by its digest.

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

| Scope             | Tools                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts:write` | the fifteen mutating tools: upload, commit, write, rename, edit, every comment mutation, and every document, scene and asset write                                                                |
| `artifacts:read`  | `artifact_get`, `artifact_get_markdown`, `artifact_get_scene`, `artifact_list_comments`, `document_outline`, `document_read`, `document_query`, `document_diff`, `scene_outline` and `scene_read` |

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

Those two replies also carry `url`: the absolute link that opens the artifact's viewer, so a client
without an inline preview can open what it just created. A Page and a Design share that route —
the viewer decides what to draw from the stored kind — so the link never changes when an artifact is
revised.

`document_create`, `document_apply`, `document_publish`, `scene_apply` and `asset_upload` also return
their payload as `structuredContent`, but carry no viewer `_meta`: there is no artifact page to render
for a draft, a frame list or an image digest.

A refusal is still a tool result, with `isError: true` and a JSON body of the form
`{ "error": "<kind>", "message": "<reason>", …extra }`. Arguments that fail the declared schema
never reach the handler: the protocol layer answers a JSON-RPC error instead, so a typed error is
always about an argument the schema accepts but the operation rejects.

## The twenty-five tools

| Tool                         | Scope             | What it does                                                           |
| ---------------------------- | ----------------- | ---------------------------------------------------------------------- |
| `artifact_start_upload`      | `artifacts:write` | Declare a staged upload of up to 16 MiB                                |
| `artifact_put_chunk`         | `artifacts:write` | Stage one base64 chunk of up to 1 MiB                                  |
| `artifact_commit`            | `artifacts:write` | Verify the staged stream and commit it as an artifact                  |
| `artifact_write`             | `artifacts:write` | Write a whole text artifact (≤ 1 MiB) in one call                      |
| `artifact_get`               | `artifacts:read`  | Read one revision as base64                                            |
| `artifact_update_metadata`   | `artifacts:write` | Rename an artifact: title only, no new revision                        |
| `artifact_get_markdown`      | `artifacts:read`  | Read a Markdown document as numbered lines                             |
| `artifact_get_scene`         | `artifacts:read`  | Render a canvas or deck as one HTML document for a host viewer         |
| `artifact_edit_lines`        | `artifacts:write` | Patch a Markdown document by line and commit a revision                |
| `artifact_list_comments`     | `artifacts:read`  | List Markdown comment threads with replies                             |
| `artifact_add_comment`       | `artifacts:write` | Comment on a source selection                                          |
| `artifact_reply_comment`     | `artifacts:write` | Reply to a root comment                                                |
| `artifact_resolve_comment`   | `artifacts:write` | Mark a thread resolved                                                 |
| `artifact_unresolve_comment` | `artifacts:write` | Reopen a thread                                                        |
| `document_create`            | `artifacts:write` | Create a Markdown document and open its draft sequence                 |
| `document_outline`           | `artifacts:read`  | Outline a document as one entry per block                              |
| `document_read`              | `artifacts:read`  | Read blocks by id or a numbered line window                            |
| `document_query`             | `artifacts:read`  | Find blocks by text, kind, or both                                     |
| `document_diff`              | `artifacts:read`  | Compare two sequences of a document block by block                     |
| `document_apply`             | `artifacts:write` | Apply an atomic batch of typed document operations                     |
| `document_publish`           | `artifacts:write` | Freeze the draft as the published revision                             |
| `scene_outline`              | `artifacts:read`  | Outline a canvas scene as one entry per frame and the loose-node count |
| `scene_read`                 | `artifacts:read`  | Read one frame, or the loose canvas nodes when `frameId` is omitted    |
| `scene_apply`                | `artifacts:write` | Apply an atomic batch of scene operations                              |
| `asset_upload`               | `artifacts:write` | Attach one raster image, stored once by its digest                     |

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
  (1–200), `expectedRevisionId` and `kind` (`"html"` default, `"markdown"`, `"canvas"` or `"deck"`;
  `"html"` commits a Page and `"canvas"` a Design).
  Returns the six revision keys shown below plus `url`, the link that opens the artifact's viewer.
  The staged stream is verified before any artifact row is written.

## `artifact_write` — one call, text only

The shortest path from content an agent already holds to a published artifact.

| Field                | Type                                               | Required | Rules                                                   |
| -------------------- | -------------------------------------------------- | -------- | ------------------------------------------------------- |
| `text`               | string                                             | yes      | the whole document; at least 1 character                |
| `kind`               | `"html"` \| `"markdown"` \| `"canvas"` \| `"deck"` | no       | default `"html"`                                        |
| `artifactId`         | string                                             | no       | canonical lowercase UUID; omit to create a new artifact |
| `title`              | string                                             | no       | 1–200 characters                                        |
| `expectedRevisionId` | string                                             | no       | present = update that revision; absent = create         |

The server encodes `text` as UTF-8 and measures the bytes: more than **1,048,576 bytes** is refused
with `too_large`, carrying `{ maxBytes, observedBytes }`. Larger or binary content goes through
[the staged transfer](/docs/reference/mcp-transfers/).

`canvas` and `deck` artifacts take a scene as their `text`; the [scene tools](#scene-tools) then read
and edit it by operation. The kind commits the output the person asked for, so name it plainly in
the reply: `"html"` is a **Page**, a report, dashboard, demo or tool used directly in its viewer, and
`"canvas"` is a **Design**, the space where mockups, screens and variants are compared and refined.

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
  "sha256": "af9fb8489b7dd4143a6fa6c831fa868a9244ddfac54274137b455db6a7d4f873",
  "url": "https://artifacts.example.com/artifact/6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11"
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

## `artifact_get_scene` — a canvas or deck drawn by the host

| Field        | Type   | Required | Rules            |
| ------------ | ------ | -------- | ---------------- |
| `artifactId` | string | yes      | 1–100 characters |

Returns `{ artifactId, revisionId, kind, documentHtml }`: the canvas or deck's current draft
rendered as one self-contained HTML document, the same document the instance's own viewer serves. A
canvas arrives as one surface holding its frames, with the frame index along the bottom and a fit
control; a deck arrives as one slide at a time with back, forward and the slide list, so a host
presents a deck instead of a scene dump. The document carries no editing control: a canvas or deck is
still edited in the dashboard or by the agent.

Images come from exactly one origin, the instance's own (`ARTIFLOW_PUBLIC_ORIGIN`), and only for a
digest the artifact owns: any other image draws as a placeholder with its digest, so the host never
loads a third party. Only `canvas` and `deck` are readable here — any other kind answers
`wrong_kind` / `artifact_is_not_a_canvas` with `{ artifactId, kind }` — and stored bytes that are not
a scene answer `invalid_scene` with the failing path.

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

## Document tools

The seven document tools read and edit a **Markdown document** in place instead of resending it. They
work on the document's draft, so an agent can change one paragraph of a long document for the cost of
that paragraph.

Three values tie the family together:

- a **block id** from `document_outline` or `document_query`, which `document_read` accepts and
  `append_blocks` can insert after;
- a **sequence** (`seq`), the draft version a read returned, which `document_apply` takes as `baseSeq`;
- the **published pointer**, the revision the viewer and an existing public link serve. `document_apply`
  writes the draft only, and a snapshot freezes it — automatically once 100 operations or ten minutes
  are pending, or at once with `document_publish`.

Only `markdown` accepts these tools: create the document with `document_create`, or with
`artifact_write` / `artifact_commit` and `kind: "markdown"`. Any other kind answers `wrong_kind` /
`artifact_is_not_a_markdown_document` with the stored `kind`, and `document_create` refuses a kind the
agent writes as a whole document with `kind_does_not_accept_text_operations`.

### `document_create` — a document, no upload

| Field   | Type   | Required | Rules                                                   |
| ------- | ------ | -------- | ------------------------------------------------------- |
| `title` | string | yes      | 1–200 characters                                        |
| `kind`  | string | no       | default `"markdown"`; every other kind is refused       |
| `text`  | string | no       | the initial source; omitted or blank starts `# <title>` |

Returns the identity shape `artifact_write` returns plus `seq`, the sequence `document_apply` accepts as
`baseSeq`:

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "revisionId": "0b7d9c31-2a4e-4d6f-8a19-3c5e7f2b1d84",
  "revisionNumber": 1,
  "sizeBytes": 16,
  "observedSizeBytes": 16,
  "sha256": "af9fb8489b7dd4143a6fa6c831fa868a9244ddfac54274137b455db6a7d4f873",
  "seq": 1
}
```

`text` over **1,048,576 bytes** is `too_large` with `{ maxBytes, observedBytes }`: create the document and
append blocks with `document_apply` instead. A refused `kind` answers `wrong_kind` /
`kind_does_not_accept_text_operations` with the `acceptedKinds` list, which is `["markdown"]`.

### `document_outline` — the block index

Input `{ artifactId }`. Returns one entry per block of the current draft and never the text:

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "kind": "markdown",
  "seq": 7,
  "lineCount": 12,
  "blockCount": 3,
  "blocks": [
    { "id": "heading-1-4b1f0c9d2a7e5f63", "kind": "heading", "line": 1, "endLine": 1, "level": 1 },
    { "id": "paragraph-1-9c2e5a70418bd3f2", "kind": "paragraph", "line": 3, "endLine": 3 },
    { "id": "list-item-1-2f7a4c81d05e9b36", "kind": "list-item", "line": 5, "endLine": 6 }
  ]
}
```

`kind` is one of `heading`, `paragraph`, `list-item`, `code-fence`, `table`, and `level` appears on
headings only. An id is derived from the block's kind and its text, so editing a block's text gives it a
new id; `document_diff` pairs the new id with the previous one. The whole index costs one line per
block, so a large document is cheap to outline.

### `document_read` — blocks by id, or lines

| Field        | Type    | Required | Rules                                |
| ------------ | ------- | -------- | ------------------------------------ |
| `artifactId` | string  | yes      | 1–100 characters                     |
| `blockIds`   | array   | no       | 1–20 block ids; complete blocks only |
| `from`       | integer | no       | ≥ 1, clamped to the document         |
| `to`         | integer | no       | ≥ 1, clamped to the document         |

With no arguments it answers the outline projection above. `blockIds` returns those blocks with their
text; `from`/`to` returns numbered lines. Asking for both is `validation` /
`read_is_either_block_ids_or_a_line_range`, because one read is one window.

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "kind": "markdown",
  "seq": 7,
  "blocks": [
    {
      "id": "heading-1-4b1f0c9d2a7e5f63",
      "kind": "heading",
      "line": 1,
      "endLine": 1,
      "level": 1,
      "text": "# Release notes"
    }
  ],
  "sizeBytes": 15
}
```

A line window answers `{ artifactId, kind, seq, lineCount, from, to, lines }`, 1-indexed and clamped
the same way as `artifact_get_markdown`. Both windows are bounded: at most **20 blocks**, **200 lines**
and **65,536 bytes**, and a wider request is refused rather than truncated — `too_large`
`read_window_exceeds_the_line_cap` with `{ maxLines, requestedLines }`, or
`read_window_exceeds_the_byte_cap` with `{ maxBytes, observedBytes }`. An id the document does not hold
is `unknown_block` / `block_not_in_outline` with its `blockId`; a range that is empty after clamping is
`validation` / `empty_line_window`.

### `document_query` — find blocks

| Field        | Type    | Required | Rules                                          |
| ------------ | ------- | -------- | ---------------------------------------------- |
| `artifactId` | string  | yes      | 1–100 characters                               |
| `text`       | string  | no       | case-insensitive substring of the block's text |
| `kind`       | string  | no       | one of the five block kinds                    |
| `limit`      | integer | no       | 1–50, default 50                               |

With neither `text` nor `kind` it answers `validation` / `query_needs_text_or_kind`: a query has to ask
something. The reply carries ids and line numbers only, and `truncated` reports the matches past the cap:

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "seq": 7,
  "matchCount": 2,
  "truncated": false,
  "matches": [
    { "id": "heading-1-4b1f0c9d2a7e5f63", "kind": "heading", "line": 1 },
    { "id": "paragraph-2-5d3a7b10e94c2f68", "kind": "paragraph", "line": 9 }
  ]
}
```

Every id it returns is accepted by `document_read`, which is the whole point: query to locate, read to
fetch.

### `document_diff` — what changed between two sequences

| Field        | Type    | Required | Rules                                   |
| ------------ | ------- | -------- | --------------------------------------- |
| `artifactId` | string  | yes      | 1–100 characters                        |
| `fromSeq`    | integer | yes      | ≥ 0, the sequence you last read         |
| `toSeq`      | integer | no       | ≥ 0, default the current draft sequence |

Answers per block, never the text: `added`, `removed`, `changed` (a new id within one line of a removed
block of the same kind, carrying `fromId` and `fromLine`) or `moved` (same id, new line, carrying
`fromLine`).

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "fromSeq": 6,
  "toSeq": 7,
  "changeCount": 2,
  "truncated": false,
  "changes": [
    {
      "status": "changed",
      "id": "paragraph-2-5d3a7b10e94c2f68",
      "line": 9,
      "fromId": "paragraph-2-1a6f3e80b25d94c7",
      "fromLine": 9
    },
    { "status": "added", "id": "list-item-1-2f7a4c81d05e9b36", "line": 11 }
  ]
}
```

Because `toSeq` defaults to the draft, an edit another author made shows up without reading the document
again. At most **200 changes** are returned and `truncated` reports the rest. `fromSeq` above `toSeq` is
`validation` / `diff_range_is_reversed`; a sequence ahead of the draft is `validation` with the live
`currentSeq`.

### `document_apply` — one atomic batch

| Field            | Type    | Required | Rules                                       |
| ---------------- | ------- | -------- | ------------------------------------------- |
| `artifactId`     | string  | yes      | 1–100 characters                            |
| `baseSeq`        | integer | yes      | ≥ 0, must equal the sequence you read       |
| `idempotencyKey` | string  | yes      | 1–100 characters; the same key applies once |
| `ops`            | array   | yes      | 1–50 operations, applied in order           |

Each operation is one of:

| Op                 | Fields                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `replace_text`     | `find` (non-empty), `replace`, optional `all` and `expectedOccurrences`                   |
| `insert_text`      | `text` (non-empty), optional `at: { line, column }` 1-indexed; omitted appends at the end |
| `delete_range`     | `start` and `end` as `{ line, column }`, 1-indexed, end exclusive                         |
| `append_blocks`    | `text` (non-empty), optional `blockId` to insert after that block instead of at the end   |
| `replace_document` | `text` (non-empty): the escape hatch that replaces the whole document                     |

`replace_text` replaces the first occurrence unless `all` is true. `expectedOccurrences` (≥ 1) refuses
with `occurrence_mismatch` when the live count differs; without `all` it must be `1`.

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "baseSeq": 7,
  "idempotencyKey": "release-notes-2026-02-14-1",
  "ops": [
    { "op": "replace_text", "find": "2026-02-07", "replace": "2026-02-14", "expectedOccurrences": 1 },
    { "op": "append_blocks", "text": "- Search is faster." }
  ]
}
```

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "baseSeq": 7,
  "seq": 8,
  "applied": 2,
  "replayed": false,
  "published": false,
  "revisionId": null
}
```

The batch is all-or-nothing against one sequence: operations apply in order to the evolving document and
the first failure writes nothing.

| `error`              | `message`                                   | Extra                   |
| -------------------- | ------------------------------------------- | ----------------------- |
| `concurrent_edit`    | `base_sequence_is_stale`, `sequence_taken`  | `currentSeq`            |
| `invalid_operation`  | the named reason of the failing operation   | `opIndex`, `currentSeq` |
| `validation`         | an argument the operation cannot use        | `artifactId`            |
| `not_found` / `gone` | the document is missing, foreign or deleted | `artifactId`            |
| `wrong_kind`         | `artifact_is_not_a_markdown_document`       | `kind`                  |

The named operation reasons are `text_not_found`, `occurrence_mismatch`, `position_out_of_bounds`,
`empty_range`, `unknown_block`, `invalid_arguments` and `empty_document`. A replayed key whose first
attempt was refused answers `invalid_operation` / `replayed_rejection` with the sequence it was refused
at, so a retry never applies a batch twice. `published` reports whether this call also froze a snapshot;
`revisionId` names it, and is `null` when the document stayed below the threshold and nothing was
written to storage.

### `document_publish` — freeze the draft now

Input `{ artifactId }`, returns the revision that now holds the draft:

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "revisionId": "0b7d9c31-2a4e-4d6f-8a19-3c5e7f2b1d84",
  "revisionNumber": 5,
  "seqFrom": 8,
  "seqTo": 9
}
```

Publishing always freezes, whatever the operation count and however little time passed since the last
snapshot, so the viewer and a public link serve the edits immediately. A draft with nothing pending is
`nothing_to_publish` / `no_pending_operations`: publishing nothing is not a publish.

## Scene tools

A `canvas` or `deck` artifact renders a **scene**: versioned JSON of frames and nodes. A scene has two
levels: **frames**, each with its own nodes, and the **canvas level**, the loose nodes that belong to no
frame and paint on the board itself. The scene shape, node types and validation rules are on
[Canvas](/docs/artifacts/canvas/).

The scene arrives as artifact bytes — `artifact_write` or `artifact_commit` with `kind: "canvas"` or
`kind: "deck"` and the scene JSON as its content — and the three tools below work on the current draft of
that artifact. `scene_apply` is the only writer. Any other artifact kind refuses with `wrong_kind` /
`artifact_is_not_a_canvas` and its `kind`, and stored bytes that are not a valid scene refuse every scene
read with `invalid_scene`, the failing `path` and the engine's reason (`malformed_scene`,
`unknown_node_type`, `duplicate_id`, `unsupported_property`, `too_deep`,
`node_limit`, `frame_limit`, `missing_format_version` or `unsupported_format_version`).

### `scene_outline` — the frame index

Input `{ artifactId }`. Returns frames only, never the node bodies, plus the loose-node count:

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "revisionId": "0b7d9c31-2a4e-4d6f-8a19-3c5e7f2b1d84",
  "seq": 4,
  "formatVersion": 1,
  "frameCount": 1,
  "looseNodeCount": 2,
  "frames": [{ "id": "checkout", "name": "Checkout", "nodeCount": 2, "bbox": { "x": 0, "y": 0, "w": 375, "h": 812 } }]
}
```

`bbox` is the union of the frame's node boxes in scene coordinates, so an empty frame reports its own
rectangle. `looseNodeCount` is how many nodes sit on the canvas level, the ones that belong to no frame;
the frame entries are unchanged by their presence. The frame ids it returns are what `scene_read`
accepts; `seq` is the sequence `scene_apply` takes as `baseSeq`.

### `scene_read` — one frame, or the canvas level

| Field        | Type   | Required | Rules                                             |
| ------------ | ------ | -------- | ------------------------------------------------- |
| `artifactId` | string | yes      | 1–100 characters                                  |
| `frameId`    | string | no       | 1–200 characters; omit it to read the loose nodes |
| `nodeIds`    | array  | no       | 1–200 node ids; omitted reads every node          |

With a `frameId`, one frame comes back:

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "revisionId": "0b7d9c31-2a4e-4d6f-8a19-3c5e7f2b1d84",
  "seq": 4,
  "frame": {
    "id": "checkout",
    "name": "Checkout",
    "x": 0,
    "y": 0,
    "w": 375,
    "h": 812,
    "bbox": { "x": 24, "y": 32, "w": 327, "h": 168 },
    "nodeCount": 1,
    "nodes": [{ "id": "title", "type": "text", "x": 24, "y": 32, "w": 200, "h": 32, "text": "Checkout" }]
  }
}
```

Without a `frameId`, the canvas level comes back as `canvas`, the same envelope the frame read uses:

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "revisionId": "0b7d9c31-2a4e-4d6f-8a19-3c5e7f2b1d84",
  "seq": 4,
  "canvas": {
    "nodeCount": 1,
    "nodes": [{ "id": "badge", "type": "rect", "x": 320, "y": 24, "w": 40, "h": 40, "fill": "#f59f00" }]
  }
}
```

The canvas level has no id, name, geometry or `bbox`, because a loose node sits at scene coordinates with
nothing around it. `nodeIds` narrows both replies; an id the chosen level does not hold is `unknown_node`
/ `node_not_in_frame` or `node_not_in_scene` with its `nodeId`.

Node geometry is relative to its frame and `bbox` is absolute; a loose node's geometry is already
absolute scene geometry. One read returns at most **200 nodes** and **65,536 bytes** of frame or canvas
JSON; a wider request refuses with `too_large` / `read_window_exceeds_the_node_cap`
(`{ maxNodes, requestedNodes }`) or `read_window_exceeds_the_byte_cap` (`{ maxBytes, observedBytes }`)
instead of truncating. An absent frame id is `unknown_frame` / `frame_not_in_scene`.

### `scene_apply` — one atomic batch of operations

| Field            | Type    | Required | Rules                                       |
| ---------------- | ------- | -------- | ------------------------------------------- |
| `artifactId`     | string  | yes      | 1–100 characters                            |
| `baseSeq`        | integer | yes      | ≥ 0, must equal the sequence you read       |
| `idempotencyKey` | string  | yes      | 1–100 characters; the same key applies once |
| `ops`            | array   | yes      | 1–50 operations, applied in order           |

Each operation is one of:

| Op                    | Fields                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------- |
| `add_frame`           | `frame` with `id`, `name`, `x`, `y`, `w`, `h` and `nodes`                              |
| `update_frame`        | `id`, and `props` with any of `name`, `x`, `y`, `w`, `h`                               |
| `remove_frame`        | `id`                                                                                   |
| `add_node`            | `frameId`, and `node` with `id`, `type`, `x`, `y`, `w`, `h` and its fields             |
| `update_node`         | `id`, and `props` with any node property except `id`                                   |
| `move_node`           | `id`, `x`, `y`, optional `w` and `h`                                                   |
| `reorder_node`        | `id`, and `index` inside its frame (`0` is the back, the last index the front)         |
| `remove_node`         | `id`                                                                                   |
| `add_canvas_node`     | `node` with `id`, `type`, `x`, `y`, `w`, `h` and its fields, added to the canvas level |
| `update_canvas_node`  | `id`, and `props` with any node property except `id`                                   |
| `move_canvas_node`    | `id`, `x`, `y`, optional `w` and `h`                                                   |
| `reorder_canvas_node` | `id`, and `index` on the canvas level (`0` is the back, the last index the front)      |
| `remove_canvas_node`  | `id`                                                                                   |
| `replace_scene`       | `scene`: the escape hatch that replaces the whole scene                                |

Node types and their extra fields are `rect` (`fill`, optional `radius`), `text` (`text`, optional
`style`), `image` (`assetId`) and `path` (`d`, optional `fill`, `stroke`, `strokeWidth`). Geometry is
relative to the frame origin, a node may sit outside its frame at any coordinate, and a batch applies
in order. The `_node` operations address a node inside one frame; the `_canvas_node` operations address a
loose node on the canvas level, whose geometry is scene coordinates and whose order is the canvas
painting order. The five canvas operations are the only way to create, move, restack or delete that
level.

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "baseSeq": 4,
  "idempotencyKey": "checkout-move-card-1",
  "ops": [
    { "op": "update_node", "id": "title", "props": { "text": "Checkout, faster" } },
    { "op": "move_node", "id": "card", "x": 24, "y": 720 }
  ]
}
```

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "baseSeq": 4,
  "seq": 5,
  "applied": 2,
  "replayed": false,
  "published": false,
  "revisionId": null,
  "boxes": [
    { "id": "title", "frameId": "checkout", "x": 24, "y": 32, "w": 200, "h": 32 },
    { "id": "card", "frameId": "checkout", "x": 24, "y": 720, "w": 327, "h": 120 }
  ],
  "violations": []
}
```

`boxes` carries the absolute box of every node the batch touched, in scene order, so the result can be
judged without pixels. Every box names the `frameId` it sits in, so a loose canvas node is reported in no
box at all: it has no frame, and its geometry is already absolute scene geometry. Read the canvas level
with `scene_read` and no `frameId` to see the loose nodes a batch added or changed. `violations` is the
scene engine's report on the final scene and is empty today, because a batch that would leave an invalid
scene refuses instead of being applied.

The failure contract is the one `document_apply` has: `concurrent_edit` with `currentSeq` for a stale
`baseSeq`, and `invalid_operation` with `opIndex`, `currentSeq` and the named reason, the scene unchanged.
The named reasons are `unknown_frame`, `unknown_node`, `invalid_arguments`, `non_finite_number`,
`non_positive_size` and the scene validation reasons listed above. The same `idempotencyKey` replays the
same `seq` once. `published` and `revisionId` mean what they mean on `document_apply`.

## Assets

A scene node of type `image` carries an `assetId` and no bytes: the picture is uploaded once, stored by
its digest and referenced from as many artifacts as need it. `asset_upload` is the only tool that stores
it.

### `asset_upload` — store one raster image

| Field           | Type   | Required | Rules                                                                  |
| --------------- | ------ | -------- | ---------------------------------------------------------------------- |
| `artifactId`    | string | yes      | canonical lowercase UUID of an artifact you own                        |
| `contentType`   | string | yes      | 1–200 characters; `image/png`, `image/jpeg`, `image/webp`, `image/gif` |
| `contentBase64` | string | yes      | the image bytes, base64                                                |

```json
{
  "artifactId": "6f1c3f2e-8f4a-4a1d-9d0e-6b0f3a2c9d11",
  "contentType": "image/png",
  "contentBase64": "iVBORw0KGgoAAAANSUhEUgAAASwAAAEsCAYAAAB5fY51AAAAAXNSR0IArs4c6QAAIABJ…"
}
```

```json
{
  "sha256": "9a3f5c1d7e0b2468ac9f1e3d5b7c20468a0e2f4b6d8c0a2e4f6b8d0c2e4a6f8b",
  "sizeBytes": 18432,
  "contentType": "image/png"
}
```

The reply's `sha256` is the digest a scene's `image` node names as its `assetId`, so the same picture is
stored once however many nodes point at it. The server decodes and hashes the bytes itself: re-sending
identical bytes answers the same digest and stores no second object. Content types are trimmed and
lowercased; **svg is refused on purpose** with `unsupported_content_type` / `content_type_not_raster`,
because it is a document that can carry script. The payload is capped at **1,569,792 raw bytes**
(1,533 KiB) — the most a 2 MiB MCP request body can carry once base64 and the envelope are counted —
and a bigger image is `too_large` with `{ maxBytes, maxEncodedChars, encodedChars }`: downscale it rather
than send it. A failed store is `artifact_unavailable` / `asset_storage_failed`; an `artifactId` that is
not a canonical UUID is `invalid_artifact_id`, and a missing, foreign or deleted one is `not_found` or
`gone`.

## Error kinds

| `error`                    | Typical cause                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `invalid_token`            | the access token carries no subject                                                                   |
| `insufficient_scope`       | the token lacks the scope the tool needs; the message names it                                        |
| `validation`               | an argument the schema accepted is invalid for the operation                                          |
| `invalid_artifact_id`      | `artifactId` is not a canonical lowercase UUID                                                        |
| `not_found`                | missing or foreign artifact, upload, revision or chunk                                                |
| `gone`                     | the artifact is soft-deleted                                                                          |
| `conflict`                 | declaration, payload, status, kind or storage state disagrees                                         |
| `expired`                  | the staging upload is past its TTL                                                                    |
| `too_large`                | a cap is exceeded; `maxBytes` is included when known                                                  |
| `digest_mismatch`          | bytes do not hash to the declared or recorded digest                                                  |
| `chunk_unavailable`        | a staged chunk is missing or fails its recorded digest                                                |
| `wrong_kind`               | a document tool on a non-Markdown artifact, or a scene tool on a non-scene one                        |
| `not_valid_utf8_markdown`  | the bytes cannot be a Markdown document                                                               |
| `concurrent_commit`        | the compare-and-set pointer moved (`artifact_write`, `artifact_commit`)                               |
| `concurrent_edit`          | the revision pointer or draft sequence moved (`artifact_edit_lines`, `document_apply`, `scene_apply`) |
| `expectation_mismatch`     | an `expect` guard did not match the live lines                                                        |
| `invalid_operation`        | a document or scene operation was refused; `opIndex` names it                                         |
| `invalid_scene`            | the stored canvas bytes are not a valid scene; `path` names the failure                               |
| `unknown_block`            | a `blockId` the document does not hold                                                                |
| `unknown_frame`            | a frame id the scene does not hold                                                                    |
| `unknown_node`             | a node id the scene does not hold                                                                     |
| `nothing_to_publish`       | `document_publish` with no operations pending                                                         |
| `unsupported_content_type` | `asset_upload` with a type that is not png, jpeg, webp or gif                                         |
| `artifact_unavailable`     | the asset store failed; retry the upload                                                              |
| `comment_not_found`        | unknown or foreign `commentId`                                                                        |
| `nested_reply`             | replied to a reply                                                                                    |
| `reply_is_not_root`        | resolved or reopened a reply                                                                          |
| `storage`                  | a storage write failed; retry the chunk or the commit                                                 |
| `error`                    | an unexpected transaction failure; not retryable as a conflict                                        |

## Limits

| Limit                                     | Value                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| One `artifact_write` call                 | 1,048,576 decoded bytes (1024 KiB)                                         |
| Largest artifact                          | 16,777,216 bytes (16 MiB)                                                  |
| Largest staged chunk                      | 1,048,576 decoded bytes, indices `0`–`15`                                  |
| `contentBase64` length                    | at most 1,398,104 characters                                               |
| Staging TTL                               | 60 minutes from upload creation                                            |
| Operations per `artifact_edit_lines` call | 50                                                                         |
| One `document_create` call                | 1,048,576 decoded bytes                                                    |
| One `document_read` window                | 20 blocks or 200 lines, and 65,536 bytes                                   |
| One `document_query` reply                | 50 matches                                                                 |
| Changes per `document_diff` reply         | 200                                                                        |
| Operations per `document_apply` call      | 50                                                                         |
| Document snapshot                         | every 100 pending operations or ten minutes; `document_publish` forces one |
| One `scene_read` window                   | 200 nodes or 65,536 bytes of frame or canvas JSON                          |
| Operations per `scene_apply` call         | 50                                                                         |
| One `asset_upload` payload                | 1,569,792 raw bytes (2,093,056 base64 characters)                          |
| Comment body / quote                      | 4000 / 2000 Unicode characters                                             |
| MCP request body                          | 2 MiB                                                                      |

The single-call cap and the artifact cap are different limits on purpose:
`artifact_write` keeps one tool argument bounded to a single chunk, while an artifact itself may
grow to 16 MiB through [the chunk stream](/docs/reference/mcp-transfers/). The instance-wide caps
are collected on [Limits](/docs/reference/limits/).

## What the tools cannot do

There is no tool to list, search, share or delete artifacts, and none to create, revoke or read a public
link: those are dashboard actions, so an agent can never widen access to an artifact on its own.
`document_publish` is not a share — it freezes a document's own draft into a revision that the viewer and
any existing link already serve. No tool lists revisions either; `artifact_get` with `metadataOnly` reads
the metadata of one revision, and nothing enumerates them.

Canvas and deck editing is by operation only. `scene_apply` is the one writer, and it addresses frames
and nodes by id, so every edit needs the id a `scene_outline` or `scene_read` returned. The canvas level
is addressed the same way: a loose node id comes from `scene_read` with no `frameId`, and the five
`_canvas_node` operations create, change, restack and delete it. Scene bytes
carry no image data: `asset_upload` stores the picture once, by digest, and an `image` node names that
digest as its `assetId`.

Uploads also expose no abort or cleanup tool: an abandoned upload expires after the TTL.

## Next

- [Staged transfers and compare-and-set commits](/docs/reference/mcp-transfers/) for content above
  1 MiB.
- [Connect an agent](/docs/connect/mcp/) for client configuration and sign-in.
- [Artifacts and revisions](/docs/concepts/artifacts/) for the model behind these tools.
