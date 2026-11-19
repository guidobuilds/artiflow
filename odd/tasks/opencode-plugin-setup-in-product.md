# OpenCode plugin: in-product setup without env vars

Implement Linear GUI-656 recommendation 1 (research: docs/research/opencode-plugin-one-step-install.md).
User request verbatim: "Debemos realizar todo el proceso para que el plugin de opencode sea MUY facil de instalar por el usuario, entiendo que es mediante npm."

## Specs

- S1: The plugin resolves its instance URL as `ctx.options.url` → URL persisted in server `ctx.storage["url"]` → `process.env.ARTIFLOW_URL`, with the existing strict-origin validation unchanged (`packages/plugin-core/src/core.ts` `instanceUrl`).
- S2: `ARTIFLOW_URL` keeps working as a fallback; existing behavior with only `options.url` or only `ARTIFLOW_URL` must not change.
- S3: Resolution of the stored URL is read at server plugin setup; a stored URL survives restarts (ctx.storage persistence).
- S4: A `/artiflow-setup <origin>` server command validates the origin with the same strict-origin rules and persists it to `ctx.storage["url"]`; it reports success/failure in its prompt output and tells the user a reload/restart applies it to the running server.
- S5: GUI `main` (`plugins/opencode/src/gui-main.ts`) resolves its config through the same chain, reading the stored URL from the server part via `ctx.client.rpc` instead of `process.env.ARTIFLOW_URL`; the Desktop GUI therefore works without `launchctl setenv ARTIFLOW_URL`.
- S6: Tests cover the resolution chain (all three sources, precedence, invalid values), the setup command (valid origin persisted, invalid rejected with no storage write), and the GUI RPC-based config read; tests run through public interfaces.
- S7: `plugins/opencode/README.md` and any docs describing the two env mechanisms are updated to describe the new one-step flow; help text for `/artiflow-setup` explains its behavior.

Non-goals: upstream fixes (drafts in GUI-656), OpenWork UI changes, well-known discovery, GUI Settings page collection UI (follow-up if needed).

## Tasks

- T1: server URL chain + storage persistence (S1, S2, S3) — commit feat(plugin)
- T2: /artiflow-setup command (S4, S7 help text) — commit feat(plugin)
- T3: GUI main RPC-based config (S5) — commit feat(plugin)
- T4: tests (S6) — commit test(plugin) alongside each unit
- T5: docs/README update (S7) — commit docs(plugin)

## Log

- L1: User: "Debemos realizar todo el proceso para que el plugin de opencode sea MUY facil de instalar por el usuario, entiendo que es mediante npm." — research first (GUI-656).
- L2: Research delivered (docs/research/opencode-plugin-one-step-install.md); recommendation 1 = plugin-owned setup state.
- L3: User selected "Implementar recomendación 1" via host-captured prompt, then explicitly confirmed in the chat: "Confirmado: implementar la recomendación 1 y crear el issue en Linear".
- L4: Implementation delivered on Linear GUI-703 (created, In Progress). Commits on feat/opencode-plugin-installer: c2ffb51 (T1+T2: stored-URL source, bootstrap setup-only mode, /artiflow-setup, config.url RPC + tests), 4fddc54 (T3: GUI resolves via config.url RPC + tests), 149cb3f (T5: README + harness-plugins docs), 490dd47 (research + ODD docs). Slice boundary: 854 authored changed lines since origin/main. Verification: 187/187 plugin tests, tsc --noEmit clean, prettier clean on touched files, GUI bundle builds. Native assess: risk medium, reviewDue false (under budget); writer self-verification stands.
