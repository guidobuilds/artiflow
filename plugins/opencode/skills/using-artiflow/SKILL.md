---
name: using-artiflow
description: What Artiflow is and what the OpenCode plugin can and cannot do with it. Load when the user asks about Artiflow's capabilities, how artifacts are managed or shared, auth, or before deciding how to fulfil a request that involves the platform — it maps the native artiflow_write, artiflow_write_file, artiflow_get, artiflow_get_markdown, artiflow_edit_lines, artiflow_scene_outline, artiflow_scene_read, artiflow_scene_apply, artiflow_list_comments and artiflow_viewer_url capabilities plus everything the plugin deliberately does not offer.
---

# Using Artiflow — the platform and its capabilities

Artiflow is a self-hosted library for self-contained artifacts — **interactive
HTML pages**, **markdown documents**, **canvases** and **decks**: **agents write
content through the plugin's native tools**, and owners manage access — sharing,
public links, deletion — from a browser dashboard.
Content enters the instance through the plugin's write tools; everything else is
reading, sharing, linking, editing and deleting. This skill maps what the plugin
and the platform can and cannot do. For the creation procedure itself (the
sandbox, the write paths, limits and errors), load `creating-artifacts`.

## The capabilities

**Create and update — native tools.** `artiflow_write` takes UTF-8 text for small
payloads; `artiflow_write_file` reads a local file for large HTML or markdown.
Both accept `kind` (`"html"` default, `"markdown"`, `"canvas"` or `"deck"`), `title`, and the
`artifactId` + `expectedRevisionId` pair that appends a revision instead of
overwriting blind. There is no upload form and no dashboard route that accepts
artifact bytes — an agent with the plugin is the only programmatic writer. See
`creating-artifacts` for the flows.

**Read revisions.** `artiflow_get` returns the current revision or any pinned
`revisionId` byte-exact as base64, re-hashed server-side. Revisions are
compare-and-set: writing with `expectedRevisionId` appends a revision to an
existing artifact. Markdown documents read as numbered lines via
`artiflow_get_markdown` and edit via `artiflow_edit_lines` — every edit appends a
revision, one per call.

**Read and edit scenes.** `artiflow_scene_outline` returns a canvas or deck's
frame index — frame ids, names, node counts and bounds, the loose-node count and
the scene's `seq`. `artiflow_scene_read` returns one frame with its nodes, or the
canvas level when no `frameId` is given, narrowed by `nodeIds` on request; past
200 nodes or 64 KiB it refuses with `too_large` instead of truncating.
`artiflow_scene_apply` applies one atomic batch of id-addressed operations against
the `baseSeq` you read, keyed by an `idempotencyKey` so a retried batch replays
instead of applying twice. A stale `baseSeq` refuses with `concurrent_edit` and
`currentSeq`: re-read and rebuild the batch, never retry blind. The reply carries
the absolute box of every node the batch touched inside a frame, plus the scene's
`violations`, which are the server's own report on the finished scene and not a
formality; a loose canvas node is in no box, so read the canvas level to see it.
Two limits: the dashboard editor writes the same scene, and uploading an image is
not available from this surface.

**Read comments.** `artiflow_list_comments` returns an owned document's comment
threads read-only: roots with ordered nested replies, source anchors, quoted text
and resolution timestamps. It creates no revision. The plugin cannot write
comments; people comment from the dashboard.

**Open what you wrote.** `artiflow_viewer_url` returns the instance's
`/artifact/<id>` URL for an artifact without any network call, so you can hand
the user a link. The OpenCode panel also shows written artifacts.

**View by kind.** HTML artifacts open in the opaque-origin sandboxed iframe
(scripts allowed, no same-origin, no network, no forms). Markdown documents open
in their own rendered viewer (GFM, read-only for visitors) — also sandboxed, with
no scripts at all. Canvases and decks open as a scene. Public links render each kind read-only.

**Edit — people in the dashboard.** Markdown documents are editable in the
browser (WYSIWYG with autosave, version history and restore) by the owner and by
shared editors. Comments anchor to text selections, support replies and resolve,
and are visible to everyone who can read the document.

**Library — the dashboard (`/library`).** The signed-in owner sees _Owned_ (up to
100 artifacts, newest first) and _Shared with me_ (up to 200 granted artifacts,
marked with the granting owner's email, hidden when empty). What the recipient
can do follows the grant role.

**Share by email with roles.** The owner grants a registered account access by
email. Grants carry a role: `reader` (default, view only), `editor` (can edit
markdown documents) or `commenter` (can comment). Self-shares and unknown emails
are typed errors. The grant appears in the recipient's _Shared with me_ at once,
and revoking it stops future reads.

**Public links.** A link serves the artifact at `/share/<token>` to anyone. The
raw token is shown **once**, at creation — copy it immediately; the list
afterwards shows only link ids and timestamps. Links have no expiry; _rotate_
replaces a token and invalidates the old one; _revoke_ kills it. At most 200
links are listed per artifact.

**Rename.** A title is set when an artifact is written. The plugin has no
metadata-only update, so changing only a title ships a new revision — say so
instead of quietly rewriting the bytes for a name.

**Delete.** Two presses in the dashboard (first arms, second sends). Deletion is
a soft delete: the artifact stops resolving at once for the owner, recipients and
public links, and unreferenced blobs are removed best-effort afterwards. A repeat
delete returns `404`.

**Auth.** The plugin talks to the instance's `/api/v1` API as an OAuth 2.1 client
with PKCE and browser consent; the user signs in once in the panel and the grant
covers `artifacts:write` (the write path), `artifacts:read` (the read tools) and
`offline_access` (refresh tokens). Access tokens are 900-second JWTs sent as
`Authorization: Bearer` on every request; refresh tokens rotate strictly, and
replaying one revokes the whole token family. A dashboard cookie is never
accepted by the API.

## What the plugin deliberately does not do

An agent asked for any of these should say so and point to the dashboard or a
different tool — not attempt a call:

- **No list or search tool.** The plugin cannot enumerate artifacts; only the
  dashboard library can. Remember the `artifactId`/`revisionId` from write
  replies — they are the only handle either of you has.
- **No share, link or delete tools.** Sharing, links and deletion are
  dashboard-only; no tool exists.
- **No comment-writing tools.** `artiflow_list_comments` is read-only; adding,
  replying and resolving happen in the dashboard.
- **No image upload.** No tool here stores an image. An `image` scene node carries
  an `assetId` and no bytes, so it can reference a picture only when a client that
  can store the picture put it there first; say so instead of writing bytes into a
  node.
- **No cross-owner access.** Every tool is scoped to the authenticated owner; a
  foreign id is indistinguishable from a missing one.
- **No partial or multi-file writes.** An artifact is one HTML document or one
  markdown document; there are no asset bundles, no directories, no patch
  writes for HTML — HTML changes are whole new revisions (markdown changes are
  line patches through `artiflow_edit_lines`).
- **No runtime capabilities inside the page.** The viewer grants scripts, inline
  style and nothing else: no network, no storage, no persistence, no backend
  calls. Interactive behavior must live entirely in the page's own code and data.
- **No external requests from a viewed artifact, ever.** The CSP is
  `default-src 'none'` — the page is a sealed, self-contained document.

## How to behave

- **Pick the door by intent.** Creating or updating content → the native write
  tools (`creating-artifacts`). Reading or editing a canvas or deck → the scene
  tools: the frame index, then the frame, then one atomic batch. Sharing, links,
  deletion, browsing the library → tell the user it happens in the dashboard at
  `/library`.
- **Respect the grant roles.** A shared-with-me artifact can be viewed by a
  reader, edited (markdown) by an editor, and commented on by a commenter or
  better — and an agent scoped to one owner cannot read it at all unless the
  grant is theirs. The API, not the client, is the permission authority: a `403`
  is final for that action.
- **Treat ids as the agent's memory.** With no list tool, the ids you report to
  the user after a write are the only handle either of you has.
- **Be honest about the sandbox.** If a user asks for an artifact that needs
  network data, accounts, persistence or a backend, explain that Artiflow pages
  are self-contained by design and help reshape the request around what the
  sandbox allows.
