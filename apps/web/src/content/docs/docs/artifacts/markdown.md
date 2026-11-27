---
title: Markdown documents
description: How Artiflow renders Markdown artifacts, what the document viewer shows, and how source, editing and comments relate.
sidebar:
  order: 5
---

Publish with `kind: "markdown"`. The stored bytes must be valid UTF-8 text, and Artiflow keeps the
source rather than a pre-rendered snapshot, which is what makes browser editing and line patches
possible.

## Rendering rules

- Artiflow renders the document on the server and serves the formatted result directly in the viewer
  page, not inside an iframe: the page has to measure selections to place comment anchors.
- There is therefore no `sandbox` attribute around it, and none is needed: `html: false` is what keeps a
  document inert, so the source cannot ship a script, an event handler or an image tag written as raw
  HTML.
- Raw HTML in the source is escaped and appears as text. Markdown cannot be used to inject markup.
- Bare URLs are linkified; `javascript:`, `vbscript:` and `file:` targets are refused.
- Standard blocks render: headings, paragraphs, lists, tables, fenced code, blockquotes, rules and
  links.
- The response policy is `default-src 'none'` with `img-src 'self'`, inline and same-origin scripts
  and styles, and one `connect-src 'self'` for the viewer page's own metadata poll. Because the document
  is part of that page rather than a frame of its own, a same-origin image loads; a remote or `data:`
  image does not, and remote fonts are blocked the same way. Text, tables and code travel well; remote
  images do not.

The public link renders the same document read-only: no editor, a bar with the brand and **Focus** only
(no title, no version, no back link), and the document's comment threads only while the owner's **Show
comments** option is on.

## Source stays the source of truth

The stored Markdown is the artifact, and there are three ways to change it:

| Route          | How                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------- |
| Agent write    | `artifact_write` with `kind: "markdown"`, replacing the whole document                              |
| Browser editor | Owner opens the document from the library; autosave appends revisions                               |
| Line patches   | `artifact_get_markdown` reads numbered lines, `artifact_edit_lines` applies bounded line operations |

Line patches are how an agent edits a long document without resending it. Each call names the revision
it read, applies `replace`/`insert`/`delete` operations (1-indexed, inclusive ranges), and can carry the
exact lines it expects to find: if the text moved, the call refuses with the live window instead of
guessing. One call produces one revision.

## Comments

Markdown documents accept anchored comments. A selection is quoted and bound to its line and column
range, replies stay one level deep under their root, threads can be resolved and unresolved, and
comments never create a revision. Comment bodies are capped at 4000 characters and quoted selections at 2000. HTML pages accept comments too: an anchor there names an element or a point in the page, and the
bridge injected into the page's frame keeps the pin on it.

## Revisions

Every save, patch or restore appends a revision. The editor's version history lists them newest first,
marks the current one, and can restore an older version as a new one. Because the artifact keeps its
history, a public link always shows the current revision and a reader can watch the version badge move.

## Next

[Edit and revise](/docs/guides/editing/) walks through the editor, autosave conflicts, history and
comment threads.
