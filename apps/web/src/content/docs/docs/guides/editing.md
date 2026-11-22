---
title: Edit and revise
description: Edit Markdown in the browser with live collaboration and autosave, resolve save conflicts, restore versions, comment on selections, edit a canvas, and update HTML pages through the agent.
sidebar:
  order: 6
---

Artifacts are versioned documents, and there are two ways to move one forward: the browser for
Markdown, the agent for everything.

## Open the editor

In the library, choose **Open** on a Markdown artifact, or go to
`https://artifacts.example.com/edit/<artifactId>`. HTML artifacts never open in the editor: their
**Open** action goes to the viewer, and the dashboard answers an editor URL for one with "HTML
artifacts use the viewer, not the markdown editor."

## Autosave

The editor keeps the document in a rich-text surface and saves as you type. The state next to the title
tells you where you are:

| State        | Meaning                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------- |
| **Saved**    | The editor and the artifact are at the same revision                                        |
| **Saving**   | A save is in flight                                                                         |
| **Unsaved**  | Changes exist locally and have not been accepted yet                                        |
| **Conflict** | The artifact moved on while you were editing; the editor turns read-only so nothing is lost |
| **Live**     | The editor is in a live session; edits merge with everyone else's                           |

A **Conflict** means a save arrived with a stale revision: another tab, another browser or the agent
committed first. Reload the document to pick up the current revision and redo the edit against it. The
server refuses the stale write rather than overwriting, which is why history stays linear.

## Live collaboration

Open the same Markdown document twice — another tab, another browser, or a colleague you invited as
`editor` — and the two sessions share one document. You see the other person's changes as they type,
with their cursor and selection in their own colour and their name on it. The status reads **Live**
while the session lasts.

A live session is a convenience, never a requirement: if it cannot connect, the editor falls back to
the autosave described above and says so quietly, so nothing stops you from editing. If the session is
refused — you lost the editor grant, for example — the editor says why and stops writing rather than
retrying.

Underneath, the session is not what is stored. When the document goes quiet, and when the last person
leaves, the server records **one** operation for everything that changed and asks whether a snapshot is
due, so history stays linear and the published artifact stays a canonical, verifiable document. An
agent writing through its tools goes through the same sequence: its change reaches everyone in the
session, and a human edit that raced it is refused instead of being merged silently.

## Version history

Open **Version history** in the editor's top bar to list revisions newest first, with the current one
marked. **Restore** on an older version asks first, then appends its content as a new revision. Earlier
versions stay in the list, so a restore is itself reversible.

## Comments

Select text in the document and open **Comments** to start a thread anchored to that selection:

- The selection is quoted exactly as it appears in the stored source. When the text later changes, the
  thread is marked **Outdated** with "Text changed since this comment" instead of being re-anchored to
  different words.
- Replies attach to the thread root, one level deep.
- Threads can be resolved and unresolved.
- Comment bodies are capped at 4000 characters, quoted selections at 2000.
- Comments never change the document or create a revision.

Only Markdown artifacts accept comments.

## Update through the agent

For HTML there is no dashboard editor, so the agent publishes the new revision. Two calls do the same
for Markdown when the content lives in the conversation:

- Resend the document with `artifact_write`, including `artifactId` and `expectedRevisionId`.
- Or patch lines with `artifact_edit_lines`, which also requires `expectedRevisionId`.

Both refuse a stale revision and return the current revision id, so the agent can re-read and retry
instead of clobbering a browser edit. `artifactId` must be a canonical lowercase UUID; a readable slug
is refused before anything is written.

## What is not editable

- HTML artifact internals in the browser; use the agent.
- Titles, kinds and access settings in the editor; titles travel with a write, and access lives in
  [Share and publish](/docs/guides/sharing/).
