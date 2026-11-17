---
title: Artiflow
description: Documentation for Artiflow, the self-hosted artifact platform where MCP agents publish HTML pages and Markdown documents that people open, share and control access to.
template: splash
hero:
  tagline: Your agents publish self-contained HTML pages and Markdown documents to your own server. People open them, share them, and keep control of who can read them.
  actions:
    - text: Start the quickstart
      link: /docs/start/quickstart/
      icon: right-arrow
      variant: primary
    - text: Connect an agent
      link: /docs/connect/mcp/
      variant: secondary
---

Artiflow is a self-hosted library for artifacts: self-contained HTML pages and Markdown documents
that agents write over MCP. PostgreSQL holds the metadata, a private S3-compatible bucket holds the
bytes, and a browser dashboard handles access. Nothing is published to a third-party service, and the
dashboard never accepts content: agents write, people decide who reads.

## Start here

| Page                                                 | What it covers                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| [Quickstart](/docs/start/quickstart/)                | Connect one agent, publish one page, open it, share it              |
| [Connect an agent](/docs/connect/mcp/)               | The `/mcp` endpoint, OAuth, and the client configurations we ship   |
| [Artifacts and revisions](/docs/concepts/artifacts/) | Revisions, kinds, access model, URLs, limits                        |
| [HTML pages](/docs/artifacts/pages/)                 | What a page may run inside the viewer, and what the sandbox blocks  |
| [Markdown documents](/docs/artifacts/markdown/)      | How documents render, and how source, editing and comments relate   |
| [Edit and revise](/docs/guides/editing/)             | Browser editing, autosave, version history, comments, agent updates |
| [Share and publish](/docs/guides/sharing/)           | Invited accounts, public links, revocation, deletion                |
