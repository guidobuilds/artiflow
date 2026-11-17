# Artiflow agent skills

The canonical skill content lives in this directory and is the **single source
of truth** for every harness integration. Harness-specific adapters (OpenCode
plugin, Claude Desktop MCPB, Cursor plugin) package or copy this content; they
never fork it.

| Skill                                                        | Purpose                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`creating-artifacts/SKILL.md`](creating-artifacts/SKILL.md) | Creation procedure: artifact kinds, the viewer sandbox and CSP, the staged upload flow, markdown line editing, comments, revisions, limits, typed errors. Load before writing artifact content or calling `artifact_*` tools. |
| [`using-artiflow/SKILL.md`](using-artiflow/SKILL.md)         | Platform capability map: what Artiflow can and cannot do (sharing, links, auth, scopes). Load when deciding how to fulfil a request that involves the platform.                                                               |

## Installing into a harness

Skills are plain `SKILL.md` folders; every harness below discovers them from a
conventional directory. Copy (or symlink) the two folders as a unit.

| Harness                     | Install location                                                                                                        | How                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **OpenCode**                | `.opencode/skills/` (project) or `~/.config/opencode/skills/` (global); also reads `.claude/` and `.agents/` skill dirs | Copy the folders; skills advertise via description and load on demand. Documented in opencode skills docs. |
| **Pi**                      | `~/.pi/agent/skills/` (user), `.pi/skills/` (project), or `.agents/skills/`                                             | `pi install` from a package/Git URL, or copy the folders. Documented in the pi packages/skills docs.       |
| **OpenWork**                | Inherits OpenCode                                                                                                       | Install as OpenCode (OpenWork manages OpenCode plugins/skills).                                            |
| **Codex CLI**               | Codex skill directories                                                                                                 | Install via `$skill-installer` or copy into the Codex skills folder.                                       |
| **Gemini CLI**              | Via an extension bundling instructions                                                                                  | Package the folders in a `gemini-extension.json` extension (extensions bundle instructions and commands).  |
| **Cursor**                  | Bundled inside an agent plugin (marketplace, 2.5+)                                                                      | Plugin packages carry skills; standalone skill paths are plugin-package territory.                         |
| **Claude Desktop / Cowork** | Cowork plugins bundle skills with connectors (research preview)                                                         | Distribution is plugin packaging. Claude Code uses `~/.claude/skills/`.                                    |

Two rules for every installer:

1. Copy the folders verbatim; never edit skill content per harness. Harness
   differences belong in the installer or the plugin manifest.
2. Skills teach behavior only. They never embed an instance URL, credentials,
   or tool-call short-circuits — the MCP server owns the domain logic (L0).
   Instance configuration is harness config, not skill content.

## Keeping content canonical

- Fix skills here, then re-run the per-harness install (copy step) — treat any
  harness-local copy as build output.
- When a tool changes (`artifact_*` surface, limits, errors), update
  `creating-artifacts` in the same change; the skill is the agent-facing
  contract mirror of `src/api/artifact-tools.ts`.
