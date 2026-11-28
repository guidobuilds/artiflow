---
name: creating-artifacts
description: How to create, update and develop Artiflow artifacts in OpenCode. Load before writing any artifact content — it covers the artifact kinds (html pages, markdown documents, canvases and decks), the viewer's sandbox and CSP, choosing artiflow_write or artiflow_write_file, markdown line editing with artiflow_get_markdown and artiflow_edit_lines, scene reads and batch apply with artiflow_scene_outline, artiflow_scene_read and artiflow_scene_apply, read-only comments, revision updates, limits and typed errors.
---

# Creating Artiflow artifacts in OpenCode

An Artiflow artifact's kind is chosen when the artifact is created
(with `artiflow_write` or `artiflow_write_file`):

- **`html` (default)** — one complete, self-contained HTML document: the whole
  page — markup, styles, scripts, assets — lives in a single file.
- **`markdown`** — one UTF-8 markdown document (GFM), rendered formatted in its
  own viewer and editable by people in the dashboard. Create it once and then
  edit it by line patches instead of re-sending bytes.
- **`canvas`** — a versioned JSON scene of frames and nodes. The canvas section
  below is the procedure.
- **`deck`** — the same scene, presented as slides. The deck section below is
  the procedure.

Content enters the instance through the plugin's native tools: `artiflow_write`
and `artiflow_write_file` write, `artiflow_get` and `artiflow_get_markdown`
read, `artiflow_edit_lines` patches a document, `artiflow_scene_outline`,
`artiflow_scene_read` and `artiflow_scene_apply` read a scene and apply batches
of scene operations, `artiflow_list_comments` reads comment threads, and
`artiflow_viewer_url` returns a link a person can open.
Every tool calls the instance's `/api/v1` API with the OAuth the plugin already
holds, so nothing has to be connected or configured first. This skill is the
creation procedure: how to author for the viewer's sandbox (HTML) or as a
document (markdown), how to ship the bytes, how to edit later, and how to read
comments. For what the platform itself can and cannot do (sharing, links,
dashboard, auth), load `using-artiflow`.

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
  (see "Updating an existing artifact" below).
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

## Choose the write path: one call or one file

Where the bytes live decides the tool:

- **The content already exists in your context as text** (you just authored the
  page or document): use **`artiflow_write`** — one call with the full UTF-8
  `text`, optional `kind` (`"html"` default, `"markdown"`, `"canvas"` or `"deck"`), `title`, and the
  same `artifactId`/`expectedRevisionId` compare-and-set options as every other
  update. The server computes the sha256 itself, so there is nothing to declare
  and no digest to get wrong. Text is capped at the inline write cap
  (1024 KiB decoded).
- **The content is a file on disk or larger than the inline cap**: use
  **`artiflow_write_file`** — write the complete document to a local file with
  your normal file tools, then pass that file's `path` instead of its contents.
  Relative paths resolve against the OpenCode server's working directory, and the
  file must exist there as valid UTF-8. `.md` and `.markdown` infer `markdown`,
  `.canvas` and `.scene.json` infer `canvas`, `.deck` infers `deck`, and `.html`,
  `.htm` and every other extension infer `html`. `kind` overrides that inference
  with `"html"` (default), `"markdown"`, `"canvas"` or `"deck"`.
  A missing file or invalid UTF-8 is a tool error and submits nothing.

Both paths land in the same revision, kind and viewer-model rules; they differ
only in where the bytes are read from. An artifact is always written in one
call — there is no partial or resumable upload path, and never send one artifact
through both tools at once.

## Canvas and deck — design artifacts

`canvas` and `deck` are the two design kinds: a versioned JSON scene of frames and nodes instead of
HTML or markdown. A `deck` is the same scene whose frames are slides. Write one through the same write
path as any artifact, as a `.canvas` file whose content is the scene:

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
- an `image` node carries an `assetId` and no bytes; attaching an image is not available from this
  surface yet, so a scene published here shows a labelled placeholder.
- limits: 200 frames, 2000 nodes, one frame level deep.

## Reading and editing a scene

The three scene tools work on a `canvas` or `deck` artifact's current scene. Read,
then batch, then re-read:

1. **`artiflow_scene_outline`** with the `artifactId` — one entry per frame (`id`,
   `name`, `nodeCount`, `bbox`), the loose-node count and the scene's `seq`. Read
   it first: it names the frame ids `artiflow_scene_read` accepts and the sequence
   a batch has to match. Read-only, so it creates no revision.
2. **`artiflow_scene_read`** with the `artifactId` and either a `frameId` (that
   frame with its nodes and its `bbox`) or no `frameId` (the canvas level: the
   loose nodes that belong to no frame). `nodeIds` narrows either reply. One read
   returns at most 200 nodes and 64 KiB and refuses with `too_large` instead of
   truncating — read one frame at a time rather than the whole scene.
3. **`artiflow_scene_apply`** with the `artifactId`, the `baseSeq` you just read,
   an `idempotencyKey` you choose, and 1–50 ops applied in order as one atomic
   batch: `add_frame`, `update_frame`, `remove_frame`, `add_node`, `update_node`,
   `move_node`, `reorder_node`, `remove_node`, the five canvas-level equivalents
   (`add_canvas_node` through `remove_canvas_node`) and `replace_scene`. One
   failed op changes nothing.

Editing discipline: read before every batch, pass the `seq` you read as `baseSeq`,
and reuse one `idempotencyKey` when you retry a batch you are not sure arrived —
the same key replays the same `seq` instead of applying twice. A `concurrent_edit`
refusal carries `currentSeq`: that is someone else's newer scene, so re-read with
`artiflow_scene_outline` or `artiflow_scene_read` and rebuild the batch against
it. Never retry blind. The reply carries the absolute box of every node the batch
touched inside a frame, plus the scene engine's `violations`; a loose canvas node
is in no box, so read the canvas level to see it. Treat a non-empty `violations`
as a real defect in the scene you are about to report as done, not as a warning to
mention in passing.

Ids stay stable because comments anchor to them, so never rename a frame or node
id to tidy it up. Uploading an image is not available from this surface: an
`image` node carries an `assetId` and no bytes, so a node can only point at a
picture another client stored earlier, and a scene that references a missing one
shows a labelled placeholder. The dashboard still has its own canvas editor,
where a person moves, resizes, adds and deletes nodes and posts node-anchored
comments; your batch and their edit are the same scene, which is why every batch
takes a sequence.

## Markdown documents — create once, edit by lines

A markdown artifact is a **document, not a page**: write plain GFM (headings,
paragraphs, lists, tables, fenced code, quotes), no front matter, no HTML — raw
HTML in the source is escaped in the viewer and scripts never run. After the
write with `kind: "markdown"`, do NOT re-send bytes to change a sentence; use
the line tools:

1. **`artiflow_get_markdown`** with the `artifactId` — returns the document as
   1-indexed lines (`lineCount`, `from`, `to`, `lines`), optionally the window
   `[from,to]` with edges clamped to the document. Read the whole document first
   (or the relevant window for large docs) and note the returned `revisionId`.
2. **`artiflow_edit_lines`** with the `artifactId`, the `expectedRevisionId` you
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

Editing discipline: one `artiflow_edit_lines` call per logical change (or a small
batch of independent ops); always pass `expect` on replaces and deletes; after a
`concurrent_edit` refusal, re-read the document — never retry with a stale
revision id.

## Comments are read-only here

People comment on documents from the dashboard; **`artiflow_list_comments`** is
the only comment tool the plugin has, and it is read-only: the thread tree with
roots, nested replies, each root's `anchor` (1-indexed source line/col range),
`quotedText`, `body` and `resolvedAt`. It creates no revision. Results reflect
the latest document state, so anchors and quotes can be stale after edits —
treat ambiguity as uncertainty, do not guess. The plugin cannot add, reply to or
resolve comments: point the user at the dashboard and never claim you wrote one.

## Updating an existing artifact

You need the artifact's `artifactId` and its current revision id — both come from
the original write reply, from a later `artiflow_get` / `artiflow_get_markdown`,
or from the user.

- **Markdown document** → run `artiflow_edit_lines` (see above): line patches,
  one revision per call, no re-send. This is the expected path for every content
  change on a document.
- **HTML artifact** → write the new page and pass `artifactId` +
  `expectedRevisionId` to `artiflow_write` or `artiflow_write_file`; the artifact
  keeps its id and gains a revision.

A supplied `kind` must match the artifact on an update or the call refuses with
`kind_mismatch`. If someone changed it since your read, the compare-and-set fails
instead of clobbering their revision (`concurrent_edit` on markdown,
`concurrent_commit` on a whole-document write): re-read and redo the edit. Never
update by guessing an id.

## Hard limits

| Limit                   | Value                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| Artifact size           | 16 MiB (16 777 216 bytes) **decoded**, embedded assets included                |
| Inline `artiflow_write` | 1 MiB (1 048 576 bytes) decoded text; larger content goes through a local file |
| `artiflow_edit_lines`   | 1–50 ops per call                                                              |
| `artiflow_scene_read`   | 200 nodes and 64 KiB per read; 1–50 ops per `artiflow_scene_apply`             |
| Title                   | optional, at most 200 characters — set a real, specific name                   |
| Artifact id             | canonical lowercase UUID (`8-4-4-4-12` hex) when you supply one                |

## Errors are typed — react to the kind, don't retry blindly

Refusals arrive as `{ "error": "...", "message": "..." }` payloads from the
instance:

| `error`                | Meaning                                                                 | What to do                                                            |
| ---------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `insufficient_scope`   | The OAuth grant lacks the required scope                                | Re-authenticate in the panel; never retry with the same token         |
| `invalid_artifact_id`  | `artifactId` is not a canonical lowercase UUID                          | Reuse the id from the write reply, never a readable name              |
| `too_large`            | The document exceeds its cap, or a scene read exceeds the window        | Slim it, or read one frame at a time; the reply names `maxBytes`      |
| `not_found`            | Artifact invisible to this owner (foreign, absent, or no such revision) | Stop: do not retry; confirm the id with the user                      |
| `gone`                 | Artifact was soft-deleted                                               | It stays deleted; tell the user                                       |
| `wrong_kind`           | The tool works on another artifact kind (a document tool on HTML)       | Use the path for the artifact kind; never reinterpret its bytes       |
| `kind_mismatch`        | An update supplied a `kind` different from the artifact's               | Omit `kind`, or match the artifact's kind                             |
| `concurrent_edit`      | The document or scene changed since your read (stale id or `baseSeq`)   | Re-read the document or scene, then rebuild the edit or batch         |
| `concurrent_commit`    | A whole-document update lost the compare-and-set race                   | Re-read with `artiflow_get` and write again from the current revision |
| `expectation_mismatch` | An op's `expect` lines don't match the document                         | The reply carries the live window; re-anchor your ops to it           |
| `invalid_operation`    | A scene op was rejected; the batch applied nothing                      | Fix the op at `opIndex`, whose reason the reply names                 |
| `unknown_frame`        | The scene does not hold that `frameId`                                  | Re-read the frame index with `artiflow_scene_outline`                 |
| `unknown_node`         | The scene does not hold that node id                                    | Re-read the frame or canvas level before addressing it                |
| `invalid_scene`        | The stored bytes are not a valid scene                                  | The scene tools cannot edit it; rewrite it with `artiflow_write`      |
| `validation`           | Input failed schema or encoding checks                                  | Fix the input; nothing was stored                                     |

A refused write stores no artifact row, so a failed attempt costs nothing and
needs no cleanup call. Never blind-retry a refusal: read the current state first.

## How to behave

- **Pick the kind by intent.** Interactive pages, visualizations, dashboards →
  `html`. Prose the user will read, edit and comment on → `markdown`, then edit
  by line patches instead of re-sending. A screen system with frames → a `canvas`
  or `deck` scene, written once and then read and batch-edited with the scene
  tools. Author HTML against the sandbox, not around it (check every external
  reference and storage call before writing); author markdown as clean GFM — raw
  HTML is escaped and scripts never run.
- **Keep state yourself.** Record `artifactId`, `revisionId` and
  `revisionNumber` from each write reply in the conversation and give them to the
  user. For a scene, record the `seq` you last read.
- **Ownership boundaries are absolute.** Only the authenticated owner's artifacts
  are reachable; treat any `not_found` as final.
- **Say what you did.** After writing, one line with the artifact's title, its
  `artifactId`, and anything you could not exercise (for example that a page with
  state needs the user to open it to confirm behavior).
