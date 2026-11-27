---
title: Artifacts and revisions
description: How Artiflow stores artifacts, what a revision is, which kinds exist today, who can read an artifact, and how its URLs behave.
sidebar:
  order: 3
---

An **artifact** is one published document owned by one account. It has a kind, an optional title, a
stable id, and an ordered list of **revisions**.

## One artifact, many revisions

- A revision is immutable. A write or an edit appends a new revision and moves the artifact's current
  pointer; nothing rewrites history in place.
- Each revision is stored under a key of its own, not under its digest, and the server hashes
  the bytes it receives rather than trusting a digest supplied by the client. Every read re-hashes
  and compares with the digest recorded on the revision.
- An update must name the revision it started from. If the artifact moved on, the write is refused
  with the current revision id instead of overwriting someone else's work.
- Restoring an old revision appends a new revision, so an undo is itself undoable.

## Kinds available today

| Kind             | What you get                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `html` (default) | One self-contained page. Inline CSS and JavaScript run inside a sandboxed frame; comments anchor to an element or a point.                         |
| `markdown`       | UTF-8 text rendered by the viewer, editable in the dashboard, line-editable and commentable over MCP as well.                                      |
| `canvas`         | A versioned JSON scene of frames and nodes, rendered as a navigable document and editable in the dashboard. See [Canvas](/docs/artifacts/canvas/). |
| `deck`           | The same scene format, with slides in order and a presentation view. See [Deck](/docs/artifacts/deck/).                                            |

Canvas and deck comments anchor to a node. See [Canvas](/docs/artifacts/canvas/) and [Deck](/docs/artifacts/deck/).

## Limits

| Limit                       | Value                       |
| --------------------------- | --------------------------- |
| One `artifact_write` call   | 1 MiB of decoded UTF-8 text |
| Largest artifact            | 16 MiB                      |
| Largest staged upload chunk | 1 MiB                       |

Content above the single-call cap is published through the staged upload tools
(`artifact_start_upload`, `artifact_put_chunk`, `artifact_commit`), which need disk access in the client.

## Access model

Artifacts are private to their owner until the owner shares them. Every request re-checks ownership or
an active grant against a live artifact, and a missing, deleted, foreign or revoked target answers the
same not-found page, so the viewer never confirms that an artifact exists.

| Who                  | How they get in                   | What they can do                                                                                                                                                                           |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner                | Signed-in session on the instance | Read, update through the agent, edit where the kind allows, comment, share, delete                                                                                                         |
| Invited account      | Email invitation from the owner   | The grant's role: `reader` views, `commenter` also comments, `editor` also edits kinds the dashboard can edit. A new invitation is a reader. The artifact appears under **Shared with me** |
| Anyone with the link | Owner turns on a public link      | Read the current revision, no account needed                                                                                                                                               |

A grant is `reader`, `commenter` or `editor`. The dashboard invitation creates a reader. An editor can edit kinds the dashboard can edit, and a commenter can comment. A public link stays view-only.

## URLs

| URL                                                   | Serves                                                |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `https://artifacts.example.com/`                      | Library: artifacts you own plus those shared with you |
| `https://artifacts.example.com/artifact/<artifactId>` | Viewer for the owner or an invited account            |
| `https://artifacts.example.com/share/<token>`         | Public link, no session required                      |
| `https://artifacts.example.com/edit/<artifactId>`     | Markdown editor for the owner or an editor grant      |

`/artifact/<id>` accepts an `embed=1` query that serves the document alone: no bar, no comments host,
config or bundle, no bridge or pins, and no owner management. A public link ignores the query and always
serves the artifact's current revision, not the revision that existed when the link was created.

## Titles

`title` is optional and holds 1–200 characters. The viewer bar falls back to "Untitled artifact" when
it is missing, so send a title with every write: the library list and the viewer bar are labelled with
it.

## Next

- [HTML pages](/docs/artifacts/pages/) and [Markdown documents](/docs/artifacts/markdown/) describe what
  each kind can do.
- [Edit and revise](/docs/guides/editing/) covers revisions from both sides.
