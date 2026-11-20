---
name: opencode-large-artifacts
description: Choose inline or local-file writes for Artiflow in OpenCode. Load before sending a large HTML or markdown artifact, when a write call would carry a very large text payload, or when a write must update an existing artifact — it covers artiflow_write versus artiflow_write_file, path resolution, kind inference, revision updates and viewer links.
---

# Artiflow in OpenCode

Choose the write path by payload size.

- Inline write (`artiflow_write`) is for small HTML or markdown payloads that
  already exist as text.
- For large artifacts, use normal file tools to write a local file first.
- Then call `artiflow_write_file` with its path, not its contents.
- Tool arguments cannot carry very large payloads (model output-token limit).
- Relative paths resolve against the OpenCode server's working directory.
- The file must exist on that server and contain valid UTF-8.
- `.md` and `.markdown` default to markdown; other extensions default to HTML.
- Override `kind` when needed, and supply `title` for a display name.
- Use `artifactId` and `expectedRevisionId` to update an existing artifact.
- Both paths use the same instance validation and automatic panel display.
- The viewer reuses server-tool OAuth automatically; no extra clicks are needed.
- `artiflow_viewer_url` returns a shareable link to an artifact with no network call.
- If credentials are unavailable or the instance rejects viewer bearer auth, click
  Sign in to Artiflow in the panel.
