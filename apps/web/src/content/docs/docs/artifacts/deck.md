---
title: Deck
description: What a deck artifact is, how its slides work, how it is presented, and what it does not do yet.
---

A deck is the [canvas](./canvas.md) scene format with an order and a way to present it: the frames are
slides, in array order. There is no second document format to learn — a scene that works as a canvas
works as a deck.

## What is different from a canvas

- **One slide at a time, with a counter.** The viewer shows `3 / 12` and nothing else competes for the
  screen.
- **Navigation built for presenting.** Forward and back with the arrow keys, page up and down, space and
  shift-space, by clicking the controls, or by opening `?frame=<slide-id>`. The index strip exists but
  starts hidden behind a toggle, because a presentation is not a workspace.
- **No zoom or pan.** A slide is meant to fit the screen; scaling is automatic. A canvas keeps both.
- **Comments use the slide anchor.** A thread carries the slide, the node and a point normalized inside
  that node, so a pin follows the node when it moves.

## What a deck shares with a canvas

The scene format and its validator, the image lane and its one-origin policy, the sandbox, the
operation log, the draft and the published snapshot, and the agent tools: a deck is published and
edited by the same `scene_apply` / `scene_outline` / `scene_read` path a canvas uses.

## What it does not do yet

- **No editor screen.** A person can present a deck and an agent can edit it by operation, but the
  dashboard screen for editing a deck is not there.
- **No PDF export.** Export needs a decision: this stack has no headless browser, so producing a PDF
  means either a new dependency or the browser's own print.
- **No transitions, templates or speaker notes.** Slides are frames, nothing more.
