---
name: using-artiflow
description: What Artiflow is and what it can and cannot do. Load when the user asks about Artiflow's capabilities, how artifacts are managed or shared, auth and scopes, or before deciding how to fulfill a request that involves the platform — it maps every capability the platform offers and every one it deliberately does not.
---

# Using Artiflow — the platform and its capabilities

Artiflow is an MCP-first platform for self-contained artifacts of two kinds —
**interactive HTML pages** and **markdown documents** people edit and comment on:
**agents write content through authenticated MCP tools**, and owners manage access
— sharing, public links, deletion — from a browser dashboard. Content enters the
platform through one door only (the MCP tools); everything else the platform does
is reading, sharing, linking, editing and deleting. This skill maps what the
platform can and cannot do. For the creation procedure itself (the upload flow,
the viewer's sandbox, limits and errors), load `creating-artifacts`.

## The capabilities

**Create — MCP tools only.** Eleven tools exist. The byte pipeline is
`artifact_start_upload`, `artifact_put_chunk`, `artifact_commit` (with `kind`:
`"html"` default or `"markdown"`), and `artifact_get` reads revisions. Markdown
documents gain document tools: `artifact_get_markdown` (numbered lines) and
`artifact_edit_lines` (guarded line-patch edits, one revision per call), plus the
comment tools `artifact_list_comments`, `artifact_add_comment`,
`artifact_reply_comment`, `artifact_resolve_comment` and
`artifact_unresolve_comment`. There is no upload form and no dashboard route that
accepts artifact bytes — an agent with the right token is the only programmatic
writer. See `creating-artifacts` for the flows.

**Read revisions.** `artifact_get` returns the current revision or any pinned
revision byte-exact, re-hashed server-side. Revisions are compare-and-set:
committing with `expectedRevisionId` appends a revision to an existing artifact
instead of overwriting blind. Markdown documents read as numbered lines via
`artifact_get_markdown` and edit via `artifact_edit_lines` — every edit appends
a revision.

**View by kind.** HTML artifacts open in the opaque-origin sandboxed iframe
(scripts allowed, no same-origin, no network, no forms). Markdown documents open
in their own rendered viewer (GFM, read-only for visitors) — also sandboxed, with
no scripts at all. Public links render either kind read-only.

**Edit — people in the dashboard.** Markdown documents are editable in the
browser (WYSIWYG with autosave, version history and restore) by the owner and by
shared editors. Comments anchor to text selections, support replies and resolve,
and are visible to everyone who can read the document.

**Library — the dashboard (`/library`).** The signed-in owner sees _Owned_ (up to
100 artifacts, newest first) and _Shared with me_ (up to 200 granted artifacts,
marked with the granting owner's email, read-only, hidden when empty).

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

**Delete.** Two presses in the dashboard (first arms, second sends). Deletion is
a soft delete: the artifact stops resolving at once for the owner, recipients and
public links, and unreferenced blobs are removed best-effort afterwards. A repeat
delete returns `404`.

**Auth — OAuth 2.1 with PKCE and browser consent.** Generic MCP clients
self-register and authenticate through the standard "add server → Authenticate"
flow; sign-in and consent in the browser are always required. Scopes:
`artifacts:write` (the three write-path tools), `artifacts:read` (`artifact_get`)
and `offline_access` (refresh tokens). Access tokens are 900-second JWTs sent as
`Authorization: Bearer` on every `/mcp` request; a dashboard cookie alone is never
accepted at the MCP endpoint. Refresh tokens rotate strictly, and replaying a
refresh token revokes the whole token family.

## What the platform deliberately does not do

An agent asked for any of these should say so and point to the dashboard or a
different tool — not attempt a call:

- **No list or search tool over MCP.** The MCP surface cannot enumerate
  artifacts; only the dashboard library can. Agents must remember the
  `artifactId`/`revisionId` from commit replies.
- **No MCP share, link or delete.** Sharing, links and deletion are
  dashboard-only; no tool exists.
- **No cross-owner access.** Every tool is scoped to the authenticated owner; a
  foreign id is indistinguishable from a missing one.
- **No partial or multi-file uploads.** An artifact is one HTML document or one
  markdown document; there are no asset bundles, no directories, no patch
  uploads for HTML — HTML edits are whole new revisions (markdown edits are line
  patches through `artifact_edit_lines`).
- **No runtime capabilities inside the page.** The viewer grants scripts, inline
  style and nothing else: no network, no storage, no persistence, no backend
  calls. Interactive behavior must live entirely in the page's own code and data.
- **No access-token revocation.** Tokens are short-lived (900 s) self-contained
  JWTs; revoking a refresh token stops future tokens, but issued access tokens
  stay valid until they expire.
- **No rate limiting on `/share`.** Public links rely on 256-bit unguessable
  tokens instead.
- **No recipient-visible metadata.** `GET /api/artifacts/:id` is owner-scoped;
  recipients use the shared listing and the viewer route only.
- **No remote requests from a viewed artifact, ever.** The CSP is
  `default-src 'none'` (plus `connect-src 'self'` on the viewer page itself, which
  polls the artifact's metadata); the document frame inherits the list from an
  opaque origin, so its same-origin calls carry no cookies.

## Known limits (current deployment)

- Two legacy artifacts (`first-artifact`, `i5d-disposable-01`) predate UUID
  validation and cannot be deleted from the dashboard; new artifacts are
  unaffected.
- Storage errors on the public path are invisible: every miss, including a
  storage failure, answers the same `404`.
- Production cookie hardening is not wired (cookies lack the `Secure` flag); the
  deployment is loopback-local.

## How to behave

- **Pick the door by intent.** Creating or updating content → MCP tools
  (`creating-artifacts`). Sharing, links, deletion, browsing the library → tell
  the user it happens in the dashboard at `/library`.
- **Respect the grant roles.** A shared-with-me artifact can be viewed by a
  reader, edited (markdown) by an editor, and commented on by a commenter or
  better — and an agent scoped to one owner cannot read it at all unless the
  grant is theirs. The API, not the client, is the permission authority:
  a `403` is final for that action.
- **Treat ids as the agent's memory.** With no list tool, the ids you report to
  the user after a commit are the only handle either of you has.
- **Be honest about the sandbox.** If a user asks for an artifact that needs
  network data, accounts, persistence or a backend, explain that Artiflow pages
  are self-contained by design and help reshape the request around what the
  sandbox allows.
