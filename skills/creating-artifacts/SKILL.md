---
name: creating-artifacts
description: How to create, update and develop Artiflow artifacts. Load before writing any artifact content or calling an artifact_* MCP tool — it covers the artifact kinds (html pages, markdown documents, canvases and decks), the viewer's sandbox and CSP, the staged upload flow, markdown line editing, comments, revision updates, limits, and typed errors.
---

# Creating Artiflow artifacts

An Artiflow artifact's kind is chosen when the artifact is created
(via `artifact_write` or `artifact_commit`):

- **`html` (default)** — one complete, self-contained HTML document: the whole
  page — markup, styles, scripts, assets — lives in a single file.
- **`markdown`** — one UTF-8 markdown document (GFM), rendered formatted in its
  own viewer and editable by people in the dashboard. Agents create it once and
  then edit it by line patches instead of re-uploading bytes.
- **`canvas`** — a versioned JSON scene of frames and nodes. The canvas section
  below is the procedure.
- **`deck`** — the same scene, presented as slides. The deck section below is
  the procedure.

Every kind enters the platform only through the MCP tools. This skill is the
creation procedure: how to author for the viewer's sandbox (HTML) or as a
document (markdown), how to ship the bytes, how to edit later, and how to
comment. For what the platform itself can and cannot do (sharing, links,
dashboard, auth), load `using-artiflow`.

## Inline preview in MCP Apps hosts

`artifact_commit` is bound to the MCP Apps resource
`ui://artiflow/artifact-viewer`. Hosts that implement the
`io.modelcontextprotocol/ui` extension (Claude.ai, ChatGPT/Codex, Cursor 2.6+)
render the committed artifact inline right after the commit call: the viewer
reads the `artifactId` from the result's `structuredContent` and fetches the
bytes itself with a proxied `artifact_get`. Hosts without MCP Apps support see
the plain JSON text content exactly as before — nothing changes for them, and
no extra call is needed. The artifact's own sandbox and CSP rules (the section
below) apply unchanged inside that inline preview.

## The viewer decides what you may write

Published artifacts run inside the platform's viewer: an **opaque-origin sandboxed
iframe** (`sandbox="allow-scripts"`, no `allow-same-origin`) governed by the CSP
`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'`.
What that means for the page you write:

- **Nothing external loads. Ever.** `default-src 'none'` blocks every remote
  fetch — scripts, stylesheets, images, fonts, `fetch`/XHR/WebSocket. There is no
  CDN allowlist: inline all CSS and JS, and ship images, icons and fonts as data
  URIs or inline SVG. A page that references a remote host renders with that part
  missing and no visible error.
- **Inline script and style work** (`'unsafe-inline'` on both), so the page's own
  logic and design run normally.
- **The origin is opaque.** `localStorage`, `sessionStorage`, IndexedDB and
  `document.cookie` throw or stay empty — there is no per-viewer persistence.
  State that must survive lives in the page itself and ships as a new revision
  (see "Updating" below).
- **Forms render but never submit** (`form-action 'none'`): handle `submit` in
  script with `preventDefault()` and never point `action` anywhere.
- **No navigation out**: the page cannot navigate the top window or embed other
  sites in frames; `window.print`-style exits and downloads are not part of the
  viewer's contract — build the page as a self-sufficient thing.
- **Set your own `background`.** The viewer's frame paints white behind the page;
  a page without an explicit body background reads as an unstyled default.
- The viewer wraps the page in a top bar (brand + sandbox notice) and offers a
  focus mode (the `F` key toggles it, `Esc` leaves it) — design within a normal
  document flow and don't try to hide or fight the bar.

Write the page the way you would any polished handcrafted page — deliberate
palette, type, spacing — then verify it needs nothing from the network and nothing
from storage.

## Choose the ingestion path: one call or a chunk stream

How the bytes reach the server depends on where the content lives:

- **The content already exists in your context as text** (you just authored the
  page or document): use **`artifact_write`** — one call with the full UTF-8
  `text`, optional `kind` (`"html"` default, `"markdown"`, `"canvas"` or `"deck"`), `title`, and the
  same `artifactId`/`expectedRevisionId` CAS options as `artifact_commit`. The
  server computes the sha256 itself, so there is nothing to declare and no
  digest to get wrong. Text is capped at the artifact_write cap (1024 KiB
  decoded); `artifact_commit` only finalizes a staged stream, so never pair
  `artifact_write` with `artifact_commit`.
- **The content is a file on disk, larger than the write cap, or binary**: use
  the staged upload flow below (`artifact_start_upload` → `artifact_put_chunk`
  → `artifact_commit`), which streams from disk in 1 MiB chunks up to the
  16 MiB artifact cap.

Both paths land in the same revision, kind and viewer-model rules; they differ
only in transport.

## The upload flow — do these in order

Use this staged stream when shipping bytes from disk; the one-call
`artifact_write` above covers everything smaller you can hold as text.

1. **Compose the complete HTML document**, `<!doctype html>` first. Edits after
   commit are new revisions, not patches.
2. **Compute the byte facts over the exact final bytes**: `declaredSizeBytes`
   (decoded size) and `declaredSha256` (hex sha256 of the decoded document —
   never of its base64 encoding).
3. **`artifact_start_upload`** with `declaredSizeBytes` and `declaredSha256`;
   optional `title` and your own `uploadId`. Returns `uploadId` and `expiresAt`.
   Re-sending the same `uploadId` with the same declaration is idempotent — the
   safe retry.
4. **`artifact_put_chunk`** once per chunk: `uploadId`, 0-based `chunkIndex`
   (0..15) and `contentBase64` — at most 1 MiB of **decoded** bytes per chunk, so
   a full artifact is at most 16 chunks. The server decodes and hashes the bytes
   itself; client-declared per-chunk digests are ignored. A byte-identical retry
   of an index is idempotent; different bytes for an already staged index is a
   `conflict`.
5. **`artifact_commit`** with `uploadId`. The server verifies every staged chunk,
   re-assembles, and re-checks the whole-artifact digest against your declaration.
   Options:
   - `kind` — `"html"` (default), `"markdown"`, `"canvas"` or `"deck"`. Choose deliberately: an HTML
     artifact is a self-contained page; a markdown document is prose the user will
     edit and comment on; canvas and deck are scene documents. Only honored when creating; on an update path a supplied
     `kind` must match the artifact or the commit refuses with `kind_mismatch`.
   - omit `artifactId` → a new artifact (the server assigns a UUID);
   - supply `artifactId` → it must be a canonical **lowercase UUID**
     (`8-4-4-4-12` hex); generate one, never a readable name, or the call is
     refused with `invalid_artifact_id` before anything is read;
   - supply `expectedRevisionId` together with an existing `artifactId` → a
     compare-and-set revision on that artifact.
     Returns `artifactId`, `revisionId`, `revisionNumber`, `sizeBytes`, `sha256`.
     Keep and report these ids — there is no list tool to recover them later.
     A `markdown` commit refuses bytes that are not valid UTF-8 text
     (`not_valid_utf8_markdown`) instead of ever storing a binary as a document.
6. **`artifact_get`** (recommended once) with the `artifactId` — read the current
   or a pinned revision (`revisionId`) back as base64 and compare its `sha256`
   with what you sent. Bytes are re-read from storage and re-hashed server-side,
   so a match proves the roundtrip.

## Canvas and deck — design a scene

`canvas` and `deck` are the two design kinds: a versioned JSON scene of frames and nodes instead of
HTML or text. A `deck` is the same scene whose frames are slides, presented one at a time. Publish
with `artifact_write` and the scene as `text`:

```json
{
  "formatVersion": 1,
  "frames": [
    {
      "id": "home",
      "name": "Home",
      "x": 0,
      "y": 0,
      "w": 375,
      "h": 812,
      "nodes": [
        {
          "id": "title",
          "type": "text",
          "x": 24,
          "y": 32,
          "w": 200,
          "h": 32,
          "text": "Checkout",
          "fill": "#f4f4f2",
          "fontSize": 24,
          "fontWeight": 600
        },
        { "id": "card", "type": "rect", "x": 24, "y": 80, "w": 327, "h": 120, "fill": "#111613", "radius": 12 }
      ]
    }
  ]
}
```

Rules the server enforces, refusing the whole scene when one fails:

- node types are `rect`, `text`, `image` and `path`; nothing else exists.
- `x`/`y` are frame-relative and the node must sit entirely inside its frame; `w` and `h` above zero.
- every id is unique across the whole scene and stable, because it is what a comment anchors to.
  Never put a `/` in an id.
- `layout`, `constraints`, `componentId` and unknown node types are refused, not ignored.
- absolute geometry only: there is no auto-layout, so place everything yourself on an 8px scale.
- an `image` node carries an `assetId` and no bytes: upload first with `asset_upload`
  (`contentType`, `contentBase64`; raster only, about 1.5 MiB of raw bytes per call) and use the
  `sha256` it returns. An asset the artifact does not reference renders as a placeholder.
- limits: 200 frames, 2000 nodes, one frame level deep; `artifact_write` takes at most 1 MiB of text.

Read a published scene by outline and by frame, never the whole document:

- `scene_outline` returns frames with id, name, node count and bounds.
- `scene_read` returns one frame with its nodes, optionally narrowed by `nodeIds`; it refuses past
  200 nodes or 64 KiB rather than truncating.

Edit after publishing with one atomic batch instead of republishing:

- `scene_apply` takes `baseSeq` from the read, an `idempotencyKey` and `ops`: `add_frame`,
  `update_frame`, `remove_frame`, `add_node`, `update_node`, `move_node`, `remove_node`,
  `replace_scene`.
- the reply carries the absolute box of every touched node plus the validation verdict: read it
  instead of assuming the result.
- a stale `baseSeq` refuses with the current sequence, and replaying the same key applies once.

Comments on a scene anchor to a node: `board-point` on a canvas, `slide-point` on a deck, both with
the frame id, the `nodeId` and `x`/`y` normalized inside the node. A node the scene does not hold
refuses with `unknown_node`, and a thread whose node is later removed is listed as orphaned.

## Markdown documents — create once, edit by lines

A markdown artifact is a **document, not a page**: write plain GFM (headings,
paragraphs, lists, tables, fenced code, quotes), no front matter, no HTML — raw
HTML in the source is escaped in the viewer and scripts never run. After the
commit with `kind: "markdown"`, do NOT re-upload bytes to change a sentence; use
the line tools:

1. **`artifact_get_markdown`** with the `artifactId` — returns the document as
   1-indexed lines (`lineCount`, `from`, `to`, `lines`), optionally the window
   `[from,to]` with edges clamped to the document. Read the whole document first
   (or the relevant window for large docs) and note the returned `revisionId`.
2. **`artifact_edit_lines`** with the `artifactId`, the `expectedRevisionId` you
   read (required — edits are compare-and-set) and 1–50 ops:
   - `{ "op": "replace", "from": 4, "to": 5, "text": ["| a | b | c |"] }` —
     swaps an inclusive 1-indexed line range;
   - `{ "op": "insert", "after": 3, "text": ["", "new paragraph"] }` — inserts
     after line 3 (`after: 0` inserts at the top);
   - `{ "op": "delete", "from": 7, "to": 9 }` — removes the range.
     Each op may carry `expect`: the exact current lines that must match — if the
     document changed under you, the whole call refuses with `expectation_mismatch`
     and returns the live window, so you re-read and retry without ever writing to
     the wrong place. Ops apply sequentially and atomically: one failed op writes
     nothing. A successful call commits ONE new revision and returns the new
     `revisionId`, `revisionNumber`, `lineCount` and `sha256`.

Editing discipline: one `artifact_edit_lines` call per logical change (or a small
batch of independent ops); always pass `expect` on replaces and deletes; after a
`concurrent_edit` refusal, re-read the document — never retry with a stale
revision id.

## Comments — read and write on markdown documents

People comment on documents from the dashboard; agents can too (owner
connection, full rights):

- **`artifact_list_comments`** — the thread tree: roots with nested replies,
  each with its `anchor` (1-indexed source line/col range), `quotedText`, `body`,
  `resolvedAt`.
- **`artifact_add_comment`** — `{ artifactId, anchor: {startLine, startCol,
endLine, endCol}, quotedText, body }`. The anchor must match the CURRENT
  document: the call refuses (`anchor_mismatch`) if `quotedText` is not the
  exact source substring at that range, so read the document first and anchor to
  what is really there.
- **`artifact_reply_comment`** — `{ artifactId, commentId, body }` replies to a
  root (no nested threads).
- **`artifact_resolve_comment`** / **`artifact_unresolve_comment`** — roots only.

React to `wrong_kind` (the artifact is not markdown), `concurrent_edit` (stale
pointer) and `expectation_mismatch` like any other typed error below.

### Updating an existing artifact

You need the artifact's `artifactId` and its current revision id — both come from
the original commit reply, from a later `artifact_get` / `artifact_get_markdown`,
or from the user.

- **Markdown document** → run `artifact_edit_lines` (see above): line patches,
  one revision per call, no re-upload. This is the expected path for every
  content change on a document.
- **HTML artifact** → run the same upload flow and pass `artifactId` +
  `expectedRevisionId` on commit; the artifact keeps its id and gains a
  revision.

If someone changed it since your read, the compare-and-set fails instead of
clobbering their revision (`concurrent_edit` on markdown, `concurrent_commit`
refusal on HTML): re-read with `artifact_get_markdown` / `artifact_get` and redo
the edit. Never update by guessing an id.

## Hard limits

| Limit                     | Value                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Artifact size             | 16 MiB (16 777 216 bytes) **decoded**, embedded assets included; base64 overhead does not count toward the cap |
| `artifact_write` text cap | 1 MiB (1 048 576 bytes) decoded; larger or binary content uses the staged upload flow                          |
| Chunk size                | 1 MiB (1 048 576 bytes) decoded                                                                                |
| Chunks per upload         | 16 (indices 0..15)                                                                                             |
| Staging TTL               | 60 minutes after `artifact_start_upload`; start over after expiry                                              |
| Title                     | optional, at most 200 characters — set a real, specific name                                                   |

## Errors are typed — react to the kind, don't retry blindly

Errors arrive as `isError: true` replies with a machine-readable `error` kind:

| `error`                   | Meaning                                                                           | What to do                                                                         |
| ------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `insufficient_scope`      | Token lacks the required scope (named in the reply)                               | Re-authenticate requesting that scope; never retry with the same token             |
| `invalid_artifact_id`     | `artifactId` is not a canonical lowercase UUID                                    | Generate a UUID and commit again                                                   |
| `digest_mismatch`         | Assembled bytes don't match `declaredSha256`                                      | Nothing was stored. Recompute the digest over the exact bytes and restart the flow |
| `conflict`                | Staged bytes disagree (per-chunk or `staged_size_mismatch`)                       | Restart the upload with a fresh `uploadId`                                         |
| `chunk_unavailable`       | A staged chunk is missing in storage                                              | Restart the upload                                                                 |
| `too_large`               | Assembled size exceeds the cap                                                    | Split or slim the document — the reply names `maxBytes`                            |
| `not_found`               | Artifact invisible to this owner (foreign, absent, or no such revision)           | Stop: do not retry; confirm the id with the user                                   |
| `gone`                    | Artifact was soft-deleted                                                         | It stays deleted; tell the user                                                    |
| `wrong_kind`              | The tool only works on markdown and the artifact is HTML (or the kind mismatches) | Use the HTML tools for pages; never decode an HTML artifact as a document          |
| `not_valid_utf8_markdown` | Markdown commit received non-UTF-8 bytes                                          | Nothing was stored; send clean UTF-8 text                                          |
| `kind_mismatch`           | Update supplied a `kind` different from the artifact's                            | Commit without `kind`, or match the artifact's kind                                |
| `concurrent_edit`         | The document changed since your read (stale revision id)                          | Re-read with `artifact_get_markdown` and re-apply your edit                        |
| `expectation_mismatch`    | An op's `expect` lines don't match the document                                   | The reply carries the live window; re-anchor your ops to it                        |
| `validation`              | Input failed schema or base64 checks                                              | Fix the input; nothing was stored                                                  |

Idempotency makes retries safe only where stated: same `uploadId` + same
declaration for `start_upload`, byte-identical chunks for `put_chunk`. For
`commit`, a retry after an unclear failure may create a duplicate artifact —
prefer confirming the first attempt with `artifact_get` before re-committing.

## How to behave

- **Pick the kind by intent.** Interactive pages, visualizations, dashboards →
  `html`. Prose the user will read, edit and comment on → `markdown`, then edit
  by line patches instead of re-uploading. Author HTML against the sandbox, not
  around it (check every external reference and storage call before uploading);
  author markdown as clean GFM — raw HTML is escaped and scripts never run.
- **Failures are clean by design.** A digest mismatch or a refused id stores no
  artifact row; abandoned staging is garbage-collected automatically, so a failed
  attempt costs nothing and needs no cleanup call.
- **Keep state yourself.** Persist `artifactId`, `revisionId` and
  `revisionNumber` from each commit in the conversation and give them to the user.
- **Ownership boundaries are absolute.** Only the authenticated owner's artifacts
  are reachable; treat any `not_found` as final.
- **Say what you did.** After committing, one line with the artifact's title, its
  `artifactId`, and anything you could not exercise (for example that a page with
  state needs the user to open it to confirm behavior).
