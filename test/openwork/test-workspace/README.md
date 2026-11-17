# OpenWork test workspace fixture (DRAFT — pending E0)

Status: preparation only. Nothing here has been executed or validated. All
runtime checks are blocked until the E0 isolation controls are recorded,
integrated contract/package commits land, and the staging client identity is
verified. Do not run, build, or launch anything from this directory yet.

The installed local client is OpenWork.app 0.18.58 (com.differentai.openwork);
upstream 0.18.67 is a different version. Any compatibility result must state
which client version produced it.

Contents:

- `workspace.json` — minimal isolated test-workspace configuration draft.
  Field names are provisional until observed against 0.18.58 behavior; they
  are not copied from docs.
- `fixtures.manifest.json` — definitions of the benign seed artifacts
  (one HTML, one Markdown) used by the compatibility acceptance matrix.
  Content is generated at test time from these definitions; no pre-baked
  secrets, tokens, or real user data.
- This README — instructions and guardrails.

Rules for future execution (whoever runs the matrix):

1. Run only inside the verified E0 envelope (isolated network, scratch HOME,
   bounded resources, disposable PG/S3). Worktrees are not a sandbox.
2. No global OpenCode/OpenWork config, org MCP connection, or shared-team
   settings are read or written by this fixture.
3. Staging usage needs a separately assigned scope and a verified test
   environment revision; public-URL fallback must never auto-publish
   private artifacts.
4. OAuth sign-in and any opaque permission approval are human actions;
   agents report them as blockers, never approve them.
5. Outcomes are recorded as observed evidence with the client version, never
   inferred from engine inheritance or documentation.
