# One-step OpenCode plugin install without environment variables

Research on how `artiflow-opencode-plugin` can reach a one-step install in
OpenCode / OpenCode Desktop / OpenWork, with the instance URL provided without
requiring `ARTIFLOW_URL` in any process environment.

Evidence basis: OpenCode v2.3.0 source (`sst/opencode`), official docs
(opencode.ai), and the local repo state as of this research. Line references
like `plugins/opencode/src/index.ts:15` point into this repository; upstream
paths point at the v2.3.0 tag.

## Problem

After `npm install` of the published package, today's setup requires:

- `opencode service set env ARTIFLOW_URL <url>` for the background server process.
- `launchctl setenv ARTIFLOW_URL <url>` for the OpenCode Desktop GUI process
  (launchd/Finder-launched apps do not inherit shell exports; the CLI `service
set env` only reaches the server process).
- A manually pasted `client_id` in the OpenWork connect dialog.

Two env mechanisms for two processes plus one manual credential — that is the
friction this research attacks.

## Findings per question

### (a) Plugin entry object form — verdict: supported in 2.3.0; the reported failure was a wrong config key

- `packages/schema/src/config/plugin.ts` (v2.3.0): `Entry = {package: String,
options?: Record<String, Unknown>}`; `Plugins = Plugin[]` where `Plugin =
Union([String, Entry])`.
- `packages/core/src/config/normalize.ts` (v2.3.0): the legacy singular
  `plugin` key is decoded with the V1 spec (`String | Tuple([String, Options])`
  in `packages/core/src/v1/config/plugin.ts`), the plural `plugins` key with
  the V2 spec. The literal `skipped malformed recognized value` message is
  emitted by `invalid()` with a `path` (e.g. `$.plugin.0`).
- Conclusion: `plugins: [{package, options}]` is valid in 2.3.0; an **object
  under the singular `plugin` key** is exactly what produces the diagnostic.
  The failing E2E case must be re-run recording the diagnostic `path` — if it
  says `$.plugin.0`, the config used the legacy key (or was written by OpenWork,
  whose UI writes the singular key, see (f)).
- `packages/core/src/plugin/module.ts` forwards `options` to **both** the server
  entry and the GUI bundle (`guiOptions` decoded as `Record(String, Json)`);
  options must be JSON and changes trigger a GUI reload
  (https://opencode.ai/docs/build/plugins/gui/ — "### Options").
- Local evidence: `plugins/opencode/README.md:20-33` documents the working
  plural object form ("user-validated on OpenCode Desktop 2.2.6 and 2.3.0 with
  zero environment variables"); `plugins/opencode/src/index.ts:15` resolves
  `instanceUrl(ctx.options, process.env.ARTIFLOW_URL)`.

### (b) `opencode plugin add` — verdict: exists, cannot carry options

- `packages/cli/src/commands/commands.ts` (v2.3.0): subcommands `list`, `add`,
  `check`, `update`, `remove`; `add` takes one positional package specifier and
  no `--option` flag.
- `packages/cli/src/commands/handlers/plugin/add.ts`: `writePluginConfig`
  appends the bare **string** to `plugins` via `jsonc-parser.modify`.
- Consequence: one command installs the package but can never express
  `options.url`. Docs: https://opencode.ai/docs/plugins/ ("Manage").

### (c) URL without env vars — verdict: viable, best path

- Server-side persisted storage exists per plugin: `ctx.storage`
  (`get/set/remove/scan`, https://opencode.ai/docs/build/plugins/server —
  "### Storage"); namespace prefix is derived per plugin ID
  (`packages/core/src/plugin/host.ts`, `storage(kv, pluginID)`). The plugin
  already uses it for `sdk-auth:*` and `assoc:*`.
- First-run flows: a slash command via `ctx.command.transform(editor.add(...))`
  (server docs "### Commands"), and/or a GUI Settings page +
  `ctx.dialogs.open` that calls the server part over RPC
  (https://opencode.ai/docs/build/plugins/gui/ — "### Settings pages",
  "## Contracts and tokens").
- GUI-side persistence also exists (`Store.global`/`Store.session`, keys
  `plugin.<id>.<key>`; main-process `ctx.storage.store`), but declared stores
  are window-scoped.
- Well-known discovery: Artiflow exposes `/.well-known/oauth-protected-resource`
  and the API/MCP/auth endpoints (`apps/api/src/auth.ts:26-31`,
  `docs/architecture/README.md:204`), but these validate a **known** origin;
  they do not advertise which origin to use. A default-host probe is only
  realistic for local dev (`127.0.0.1:8787` API, `127.0.0.1:5173` UI proxy,
  `docs/architecture/operations.md:14,43`). No `~/.config/artiflow` bootstrap
  file exists (config is env-only, `apps/api/src/config.ts:263-264`); one would
  be a new Artiflow convention.

### (d) Plugin-embedded MCP — verdict: viable but unnecessary

- API (2.3.0): `ctx.mcp.transform((editor) => editor.set(name, {type: "remote",
url}) | editor.update | editor.remove | editor.list/get)` plus
  `ctx.mcp.reload()`; host side decodes `ServerConfig`
  (`packages/core/src/plugin/host.ts`).
- The current plugin deliberately needs no MCP: native `artiflow_*` tools talk
  to `/api/v1` directly (`plugins/opencode/README.md` — Tools; `src/index.ts`).
  Embedding MCP would duplicate the old MCP-era surface.

### (e) Desktop GUI surface — verdict: `launchctl` removable with a plugin change

- The GUI `main` context shares `ctx.options`, `ctx.client` (the OpenCode
  client of the server that runs the plugin) and `ctx.app` with windows
  (GUI docs "## Shared context", "## Main context"); main additionally has
  `ctx.storage.store`, `ctx.log`, `ctx.embeds`, `ctx.windows`.
- Today the GUI reads only `ctx.options` + `process.env.ARTIFLOW_URL`
  (`plugins/opencode/src/gui-main.ts:10`, `gui-core.ts:28-38`). Because `main`
  runs in the Electron process, it can instead read the URL persisted in the
  **server** `ctx.storage` via `ctx.client.rpc` — that bridge is what makes the
  second env mechanism unnecessary.
- Why `launchctl setenv` exists: Desktop is launchd/Finder-launched and does
  not inherit shell env; `opencode service set env` only reaches the
  background server (https://opencode.ai/docs/cli/web/). Two processes, two
  mechanisms — structural, not a plugin bug.

### (f) OpenWork — verdict: its plugin UI is string-only; client_id paste likely a discovery/DCR trace issue

- OpenWork does not load plugins itself; it renders an engine config.
  `apps/server/src/plugins.ts`: `pluginListFromConfig()` reads the **singular**
  `config.plugin` and keeps only strings; `addPlugin` writes
  `{ plugin: [...specs] }`; `apps/server/src/runtime-opencode-config-store.ts` +
  `mergeOpencodeConfigs()` filter persisted `plugin` entries to strings.
- Net effect: installs made through the OpenWork UI can never carry
  `options.url` ⇒ env var required. A hand-written plural `plugins` array with
  objects passes through the merge untouched, but which file/db row the app
  treats as persisted is unverified.
- The connect dialog supports OAuth 2.1 discovery + DCR per its roadmap
  ("Live"), with manual client credentials only as fallback for non-DCR
  servers. Artiflow implements DCR (`packages/plugin-core/src/auth.ts:100-101`;
  `test/oauth-http.integration.ts:166`), so a required paste suggests the
  discovery/DCR trace fails for that instance — needs one observed connect
  trace (local OpenWork matrix is unexecuted:
  `test/openwork/test-workspace/README.md:3-10`, client 0.18.58).

## Ranked approaches

1. **Plugin-owned setup state (recommended).** Extend `instanceUrl`
   (`src/index.ts:15`) to `ctx.options.url` → server `ctx.storage["url"]` →
   `ARTIFLOW_URL`. Provision the URL once via `/artiflow-setup <origin>` and/or
   a GUI Settings page calling the server over RPC; GUI `main` reads the same
   value via `ctx.client.rpc`, eliminating `launchctl`. Install becomes
   `opencode plugin add artiflow-opencode-plugin` and one in-product step.
   Tradeoffs: not zero-touch; storage is per-plugin/per-host (not portable);
   GUI `main` → RPC before the first window is untested; keep strict-origin
   validation in `instanceUrl`.
2. **Object entry in the global `opencode.jsonc`** —
   `plugins: [{package: "artiflow-opencode-plugin", options: {url}}]`.
   Verified against 2.3.0 source and already documented
   (`plugins/opencode/README.md:20-33`). Tradeoffs: manual file edit, not a CLI
   one-step; not expressible through `opencode plugin add` (b) or the OpenWork
   UI (f); options must be JSON. Action: re-run the historically failing case
   and record the diagnostic `path` to close the premise gap in (a).
3. **Localhost auto-discovery + persist.** On first run with nothing
   configured, probe `127.0.0.1:5173`/`:8787` well-known endpoints and persist.
   Only helps local dev installs; adds startup network noise; needs a new
   Artiflow-side discovery convention (e.g. `/.well-known/artiflow`).

## Upstream drafts worth filing

1. **cli: `opencode plugin add <pkg> --option key=value`** — mirror `mcp add
--header/--env`; when any `--option` is given, `writePluginConfig` writes
   `{package, options}` instead of the bare string. Makes option-carrying
   plugins installable in one command.
2. **core/config: accept the V1 `[package, options]` tuple under `plugins`** (or
   emit a rename hint) — extends upstream issue anomalyco/opencode#56258; a
   small schema change in `ConfigPlugin.Plugin` plus a normalize test would
   stop old configs from silently unloading.
3. **core/config: name the offending field in normalization diagnostics** —
   already tracked (anomalyco/opencode#50756, PR #50832); a plugin-specific
   variant: when `plugin.<i>` holds an object, log that object entries belong
   in `plugins`.
4. **desktop: give GUI plugin `main` a supported bridge to the server plugin's
   storage** (or document `ctx.client.rpc` as the supported channel) — lets GUI
   plugin parts drop env-var/`launchctl` workarounds.

## Remaining uncertainty

- Exact reproduction of the original object-form failure: no v2.3.0 path
  rejects `plugins: [{package, options}]`; the diagnostic `path` of the failing
  case must be captured (singular-key or OpenWork-written config is the likely
  cause).
- Whether GUI `main`'s `ctx.client` completes an RPC during app startup before
  any window/server session exists (untested, undocumented).
- Which file/db row OpenWork treats as persisted engine config (only
  `mergeOpencodeConfigs` behavior was read).
- Why OpenWork required a manual `client_id` despite DCR being Live on both
  sides; needs one observed connect trace.
