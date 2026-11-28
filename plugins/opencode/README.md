# Artiflow for OpenCode

The server entry registers the native Artiflow tools — document reads and writes,
line edits, comment reads, scene reads, scene batch apply — a viewer-link helper,
three plugin-scoped skills adapted to those native tools, and the in-product
setup command `/artiflow-setup`. See the user-facing guide at
`apps/web/src/content/docs/docs/connect/opencode.md` for the end-user install
flow; this README documents the package itself. The tools call the instance's
bearer-only public API (`/api/v1`) with an OAuth token bound to that resource;
no MCP connection is configured or required. Configure your own instance; no
origin is built in.

The package exposes `./server`, the prebuilt standalone bundle a host loads,
plus `./server-source` for the TypeScript source the repository develops
against. `./server-standalone` remains as an alias of `./server`. It also
exposes `./gui-experimental`; see below.

## Configuration

The plural `plugins` key is the primary method, user-validated on OpenCode Desktop 2.2.6 and 2.3.0
with zero environment variables set (the plugin loads, the `/artiflow` tab is visible and
`artiflow_write` succeeds):

```json
{
  "plugins": [
    {
      "package": "artiflow-opencode-plugin/server-standalone",
      "options": { "url": "https://artifacts.example.com" }
    }
  ]
}
```

`options.url` configures both the server and GUI parts, so no `ARTIFLOW_URL` is needed when the
options object is used. Alternatively, run `/artiflow-setup <origin>` once in any OpenCode
session: it validates the origin and persists it per plugin, so the server and the Desktop GUI
pick it up without any environment variable. Install, run the command, restart/reload the server
and open `/artiflow`. `options.url` still wins when present. The URL must be an HTTP(S) origin:
credentials, path prefixes, queries and fragments are rejected.

## Tools and authentication

| Tool                     | Action                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `artiflow_get`           | `GET /api/v1/artifacts/:id/bytes` with artifactId and optional revisionId (current revision by default) |
| `artiflow_get_markdown`  | `GET /api/v1/artifacts/:id/document`: numbered lines, optional from/to                                  |
| `artiflow_edit_lines`    | Reads the document, applies bounded line ops and saves it with its `expectedRevisionId`                 |
| `artiflow_list_comments` | `GET /api/v1/artifacts/:id/comments`: threads with anchors and quotes                                   |
| `artiflow_write`         | Creates (`POST /api/v1/artifacts`) or updates one artifact (markdown: document save; HTML: byte CAS)    |
| `artiflow_write_file`    | Reads a local UTF-8 file, then uses the same write path and association recording                       |
| `artiflow_scene_outline` | `GET /api/v1/artifacts/:id/scene/outline`: frame ids, names, bounds and node counts, read-only          |
| `artiflow_scene_read`    | `GET /api/v1/artifacts/:id/scene/read`: one frame by `frameId` or the canvas level, caps `too_large`    |
| `artiflow_scene_apply`   | `POST /api/v1/artifacts/:id/scene/apply`: one batch against `baseSeq`; stale refuses `concurrent_edit`  |
| `artiflow_viewer_url`    | Returns the configured instance's `/artifact/<id>` URL without network access                           |

Replies are the instance's own JSON payloads as text; refusals are typed objects such as
`{ "error": "concurrent_edit", "message": "document_changed_since_read", "currentRevisionId": "…" }`.
There is no MCP envelope. Validation and ownership remain on the instance. No
list/search/share/delete or staged-upload tools exist.
`artiflow_edit_lines` carries a required `expectedRevisionId` and applies
replace/insert/delete ops in order as one new revision; a stale pointer returns
`concurrent_edit` with the live revision, so re-read with `artiflow_get_markdown`
instead of blind-retrying. `artiflow_list_comments` is read-only and creates no
revision. This plugin exposes no comment-writing tool; another client against
the instance API can add or reply to comments.

The three scene tools cover `canvas` and `deck` artifacts, and they read and write
the same scene the dashboard canvas editor does; a deck is authored from this
surface, since the dashboard edits canvases only. Read the frame index with
`artiflow_scene_outline` first: it names the frame ids `artiflow_scene_read`
accepts and the `seq` a batch must match. Read before editing — one frame, or the
canvas level when no `frameId` is given — because a read returns at most 200 nodes
and 64 KiB and refuses with `too_large` instead of truncating.
`artiflow_scene_apply` applies one atomic batch of add/update/move/reorder/remove
operations against the `baseSeq` you read, keyed by an `idempotencyKey`, so a
retried batch replays its `seq` instead of applying twice. A stale `baseSeq`
refuses with `concurrent_edit` and `currentSeq`: re-read with
`artiflow_scene_outline` or `artiflow_scene_read` and rebuild the batch, never
blind-retry. The reply carries the absolute box of every frame node the batch
touched — a loose canvas node is in no box, so read the canvas level to see it —
plus the scene's `violations`; treat a non-empty list as a real defect in the
scene. Uploading an image is not available from this surface: an `image` node
carries an `assetId` and no bytes, and no tool here stores one.

Use inline `artiflow_write` for small payloads. For large HTML/markdown, write a
file with normal file tools first, then call `artiflow_write_file` with, for
example, `{ "path": "page.html", "title": "Demo" }`. Tool arguments cannot carry
very large payloads because of the model output-token limit, while the instance
accepts documents up to its artifact cap. The file must exist on the OpenCode
server; relative paths resolve against its working directory.
`.md` and `.markdown` (case-insensitive) infer markdown, `.canvas` and `.scene.json`
infer canvas, `.deck` infers deck, and `.html`, `.htm` and every other extension infer
html. Optional `kind` overrides that inference with `"html"` (the default), `"markdown"`,
`"canvas"` or `"deck"`; `title`
behaves exactly as for inline writes, and `artifactId` is only used together with
`expectedRevisionId`, which must be the current revision.
Missing files report `Artiflow write_file: file not found: <absolute path>`;
invalid UTF-8 reports `Artiflow write_file: file is not valid UTF-8: <absolute path>`.
Neither error submits a write or changes associations. Instance refusals pass
through unchanged. Both paths resolve the display name from the supplied title
before the HTML title or markdown heading.

The first network call opens the system browser for OAuth consent: dynamic client
registration that requests the API v1 resource (`<origin>/api/v1`), a loopback
callback, PKCE S256 and state verification. Consent times out after three minutes.
Every request carries a bearer token bound to that resource, never a dashboard
cookie. Credentials live in OpenCode plugin storage under the SDK key space
`sdk-auth:<sha256(origin)>`; a token saved by the MCP-era plugin under
`token:<sha256(origin)>` is never read. On HTTP 401, the plugin rotates the
refresh token, persists it before retrying, and retries once. Calls serialize to
avoid refresh replay. A rejected refresh is reported, not automatically retried;
remove that instance's `sdk-auth:<sha256(origin)>` storage entry to reauthenticate.
Storage security is provided by the host; this plugin does not encrypt storage.

## Migration from the MCP-era plugin

- **Silent re-consent, no manual step.** The first tool call or viewer load after
  the upgrade runs the OAuth flow once against the new API resource. MCP-audience
  tokens are not read, so the old `token:<sha256(origin)>` storage entry stays
  orphaned and harmless, and may be deleted.
- **Configuration.** With the plural `plugins` form and `options.url`, no
  environment variable is needed on Desktop 2.2.6/2.3.0. `/artiflow-setup <origin>` persists a
  URL per plugin and works on any install, including fresh string-form installs. String-form
  installs that rely on `ARTIFLOW_URL` keep working unchanged.
- **Tool names and schemas are unchanged** (`artiflow_get`, `artiflow_write`, …).
  Only the transport changed: the tools call the instance's `/api/v1` API instead
  of `/mcp`.
- **The scene tools are new here.** `artiflow_scene_outline`, `artiflow_scene_read`
  and `artiflow_scene_apply` had no MCP-era counterpart in this plugin; they carry
  the same semantics as the MCP `scene_*` tools over `/api/v1`. Image upload stays
  MCP-only, so this plugin does not yet replace every MCP tool: a scene that needs
  an attached picture still needs a client that can store the asset.

## Skills

The server entry adds three plugin-scoped skills bundled in the package
(`plugins/opencode/skills/<name>/SKILL.md`). They describe the plugin's actual
native tool surface (`artiflow_*` on the instance API) — no MCP instructions, no
staged-upload flow — and never fall back to the repository-root canonical
skills, which keep their MCP-consumer content for MCP hosts. Registration needs
no MCP connection and no manual skill installation; a missing bundled skill
fails with an error naming its package path.

## Freshness

Each open artifact viewer tab runs its own metadata read
(`GET /api/v1/artifacts/:id`, the canonical metadata projection) about every
eight seconds while the tab is visible; hidden tabs stop polling instead of
backing off. The reply's revision and digest are what order reloads: a newer
digest reloads only that embed, an identical digest is a no-op, and a reply for
another artifact is refused. Self-populated content never crosses the bridge;
the page itself is server-rendered. Poll failures (including a missing current
revision or an unreadable kind) are logged once per distinct message and do not
close or navigate the tab.

## Experimental Desktop GUI

The package ships `./gui-experimental` as one prebuilt CommonJS file. A compatible
OpenCode Desktop loads this alongside the server plugin; the GUI inherits the
server plugin identity. It is not a standalone browser or CLI extension.

- `/artiflow` opens the configured instance's `/library` in the default browser.

### Native tabs (v9)

- The pinned **Artifacts** host tab lists this session's associations. Grid is
  the default; the Grid/List choice persists in plugin storage. Cards show the
  kind icon, name, kind, write action and relative time. A dot marks an unopened
  write from the last three minutes. The index never mounts a viewer.
- Click a card or row to select its native artifact tab. OpenCode owns tab
  ordering, keyboard navigation, deduplication, closing and recently-closed
  restore (`⌘⇧T`). Open artifact tabs are reconstructed from the host's persisted
  keys; an association no longer in the cache is marked missing, but can still
  be opened. There is no plugin tab strip or overflow limit.
- A successful `artiflow_write` or `artiflow_write_file` opens and selects a
  new artifact tab with `background: true`, preserving the host's current view
  on narrow screens, plus a created/updated toast. A write to an already-open
  artifact reloads only that embed, without changing the selected tab.
- Each artifact tab shows only its viewer, with the name and kind icon in the
  native tab. Names use non-empty write `title`, otherwise HTML `<title>` or the
  first markdown ATX heading; whitespace is collapsed and names are capped at
  80 characters. Unnamed artifacts fall back to a short ID.
- Viewer URLs include `?embed=1`: a compatible Artiflow instance omits its bar
  entirely, so there is no back link, no repeated title, no version badge and no
  viewer controls, and it ships no comment surface either. Normal
  browser URLs remain unchanged. Loading, errors, missing artifacts and sign-in
  guidance appear as one-line banners inside artifact tabs only.
- Navigation is not automatically recovered. When the artifact is not being
  viewed, a compact **↻ Reload artifact** action fetches a fresh token and reloads
  that tab in place. A reload always acts: without a usable credential the tab
  states that no plugin credential is available and keeps the sign-in and retry
  actions instead of appearing to do nothing. Ordinary off-origin navigation and
  popups are blocked; external identity-provider navigation is allowed during
  explicit sign-in.
  Reads and line edits do not add associations. Use `/artiflow` for the
  instance's full library.
- Associations persist per session (latest first, deduplicated by artifact ID,
  at most 20). A later write refreshes the entry's revision and timestamp;
  if no name or kind can be resolved, the previous values are preserved.
  HTML uses the host globe icon, markdown the document icon, and older entries
  without kind (or unknown kinds) a generic square.
- Settings → Artiflow documents `url`; configuration guidance stays there,
  not in the conversation panel. No origin is supplied by default.

Both parts reuse the same origin validation and options precedence, and the GUI resolves the
origin through the server part's `config.url` RPC (options → persisted URL → local fallback), so
`ARTIFLOW_URL` no longer needs to reach the Desktop main process. Restart the OpenCode server
after changing configuration so dependent tools reload. Embeds use the
persistent browser partition `persist:artiflow`: cookies survive artifact changes
and Desktop restarts. The panel obtains the current OAuth access token through
the `viewer.token` RPC, proves it with a read of `/api/v1/artifacts`, and refreshes
rejected/expired credentials through
the same serialized, persist-before-retry path as server tools. That RPC answers
`null` rather than failing when no credential survives the silent refresh: only
an explicit sign-in may open a browser, so the value is always `null` or a token
and never an RPC error. Only the access
token crosses the bridge, never the refresh token. Initial artifact loads and
plugin-triggered returns from login use `Authorization: Bearer <token>` via
Electron's `loadURL` extra headers. With viewer bearer support on the instance,
the artifact displays with **zero extra clicks** after the agent's OAuth consent.

The native embed stays hidden until `did-navigate` reports the main-frame HTTP
outcome: 2xx–3xx artifact responses reveal it, 401 or an unsolicited login redirect
shows **Sign in to Artiflow**, and 404 shows a distinct missing-artifact message.
No raw 401/404 body is displayed. Each full main-frame navigation closes the gate
again; in-page navigation cannot turn an unknown HTTP outcome into success.
If there are no stored credentials (or no usable refresh path), the panel starts
in the sign-in fallback without loading the artifact, and says so as a missing
plugin credential rather than a page error. A bearer 401 also uses this
fallback, including instances that have not deployed viewer bearer support.
**Sign in to Artiflow** drives the plugin's own consent flow through the
`viewer.consent` RPC: dynamic client registration, PKCE and the loopback
listener, the same flow a server tool uses. It answers with the new access token
or with a reason, so a failed consent is a banner instead of an error page, and
the tab then reloads silently with the same `/api/v1` bearer the tools use.
**Use dashboard sign-in** remains as an explicit last resort: it loads the
instance's cookie login in the same view, and after login the panel resumes the
artifact. Browser cookies remain available for that fallback. Token-bridge or
refresh failures are reported as viewer states rather than exposing a stale
token. Keep server and Desktop configured to the same instance origin.

## Limitations

The GUI is experimental, can break between OpenCode releases, and requires a
recent OpenCode Desktop supporting the SDK 2.2.5 GUI declarations. Embed loading,
cookies, native visibility/occlusion, cleanup, and slash-command dispatch require
validation in the real Desktop host; they are not covered by simulated GUI tests.
RPC events are live-only: missed events do not replay or auto-open the panel.
The panel re-fetches stored associations on load, enter/focus and reconnection
without changing tab selection. In-flight snapshots cannot replace a newer live
write. Tabs in a pane share one mounted renderer; dragging ordinary tabs into
another pane can fork that renderer, as with the host browser. Each artifact has
its own native embed, gated by that pane's `usePanel().visible()` and HTTP-ready
state (DOM hiding alone is insufficient). Switching tabs hides, but does not
navigate or dispose, other embeds. Closing a tab disposes its native embed;
restoring it creates a new one. Real Desktop pane-drag/occlusion testing remains
required.
Only sessions in open shell tabs on the Desktop's own server are auto-opened;
remote-server sessions are not bridged by this GUI. Associations track this
plugin's `artiflow_write` and `artiflow_write_file` calls only, not writes made by
another client through the instance's MCP endpoint or staged uploads. Embeds are keyed by window, session key and artifact tab;
the association list persists
in server plugin storage under `assoc:<sessionID>` (not namespaced by instance URL).
After changing the configured instance, old associations may point to missing
artifacts; configure server and Desktop to use the same instance.
`/artiflow` is supplied by the Desktop GUI, not by the server-only/CLI entry.
OpenWork inherits this integration only where its host supports that SDK.

## Development

After dependencies are available, run from the repository root:

```sh
node --test test/opencode-plugin*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p plugins/opencode/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.api.json
(cd plugins/opencode && bun run build)
(cd plugins/opencode && node scripts/build-server.mjs)
```

The committed tsconfig uses normal package resolution. For offline verification
against extracted SDK tarballs, use a disposable tsconfig with `paths` mappings
to the real SDK declarations, not local substitute interfaces. SDK transitive
declarations must also be available for a fully checked host boundary.

`./server` resolves to `dist/server.mjs`, so a real host loads one
self-contained entry; `./server-source` resolves to `src/index.ts` and only loads
inside this workspace, where the `@artiflow/*` packages are linked.

Install development dependencies for this workspace from the repository root with
`bun install --frozen-lockfile`. Bun does not run dependency lifecycle scripts
unless the package is trusted, so Electron stays types-only. The Vite SDK helper
compiles Solid JSX, externalizes host-provided modules and inlines chunks into
`dist/gui-experimental.cjs`. `scripts/build-server.mjs` bundles the server entry
with esbuild into `dist/server.mjs`, inlining `@artiflow/*`, zod and the rest
while keeping `@opencode/plugin`, `effect` and node builtins external: the host
loader provides those, and a bundled Effect would fork the host's schemas and
fibers. The build fails on any other external specifier. Both builds are
deterministic: rebuilding from unchanged sources reproduces the same bytes. Only
the file whose sources changed needs rebuilding; a server-only change leaves
`dist/gui-experimental.cjs` untouched.

`dist/` is not tracked in git. The package builds at publish time:
`prepublishOnly` runs both builds before npm assembles the tarball, so a
published package always ships fresh artifacts built
from the sources it was published with. Consuming the plugin from a checkout
therefore requires a build after cloning; from the repository root run
`npm run build:plugin` (or the two plugin scripts directly). The focused plugin
tests rebuild whichever bundle they need when `dist/` is missing, so they pass
from a clean checkout. Package `files` still includes `dist`: it filters the
tarball, not git. `npm pack` alone does not build anything (npm only runs
`prepublishOnly` on `npm publish`); build first or use
`npm publish --dry-run` to check what a publish would ship.

A standalone tarball comes from the pack flow:

```sh
(cd plugins/opencode && npm pack)
```

The skill files are tracked package sources; `prepack` verifies they exist and
stay plugin-scoped (it refuses a tarball with MCP or staged-upload markers).
The tarball
contains `dist/server.mjs`, `dist/gui-experimental.cjs`, the plugin-scoped
skills, the
sources and the README; a clean install resolves nothing but the host modules
listed above. Pure association/reducer, RPC-schema, session-matching,
native-tab reconstruction/refetch, main-process lifecycle, freshness, packaging
and GUI URL/config tests run in the focused suite above.
