---
title: Canvas
description: What a canvas artifact is, how its scene is shaped, how a person navigates it, and what it does not do yet.
---

A canvas is a design surface: frames that stand for screens, and nodes inside them. It is a third
artifact kind beside [pages](./pages.md) and [Markdown](./markdown.md), and it is **read-only**
today — an agent publishes the scene, a person looks at it and moves between screens.

## What a scene looks like

A scene is versioned JSON. Every frame has an id, a name and a rectangle; every node has an id, a
type and geometry relative to its frame.

```json
{
  "formatVersion": 1,
  "frames": [
    {
      "id": "checkout",
      "name": "Checkout",
      "x": 0,
      "y": 0,
      "w": 375,
      "h": 812,
      "nodes": [
        { "id": "title", "type": "text", "x": 24, "y": 32, "w": 200, "h": 32, "text": "Checkout" },
        { "id": "card", "type": "rect", "x": 24, "y": 80, "w": 327, "h": 120, "fill": "#111613" }
      ]
    }
  ]
}
```

Node types are `rect`, `text`, `image` and `path`. An `image` node carries an `assetId` and no
bytes: images are shown as a labelled placeholder until the asset lane exists, so a missing image is
visible instead of silent.

Ids are stable and unique across the whole scene — a node cannot reuse its frame's id — because
they are what a later phase will anchor comments and edits to.

## What the server refuses

Validation answers with a named reason rather than a screenshot that looks wrong:

- a missing or newer `formatVersion`;
- an unknown node type, or a duplicate id anywhere in the scene;
- a node that sits outside its frame, or a coordinate that is not a finite number;
- a property the renderer cannot honour — `layout`, `constraints`, a component reference — because
  accepting it and ignoring it would be a lie;
- more frames or nodes than the [limits](../reference/limits.md) allow, or nesting deeper than one
  frame level.

An unknown property on a node is preserved rather than dropped, so a scene written by a newer client
survives a reader that does not know that property yet.

## How a person navigates it

One frame is visible at a time, scaled to fit. Move between frames with the arrow keys, page up and
down, home and end, by clicking the frame index, or by opening `?frame=<frame-id>`. Wheel zooms
around the pointer, space-drag or middle-drag pans, and Fit resets the view; zoom and pan belong to
the frame you are looking at.

The document is served into the same sandboxed frame as an HTML artifact: it does not reach the
network, keeps no storage and loads no external font or script.

## What it does not do yet

- **No editor.** A canvas is published whole by an agent; nothing in the dashboard changes it.
- **No comments.** Node anchors arrive with the editing phase. The viewer mounts no comment panel,
  because a point anchor without a node would detach the moment the node moves.
- **No shared layout engine.** Nodes carry absolute geometry. Automatic layout arrives with the
  editor, where the server has to agree with the browser about where things end up.

## Reading it as an agent

`scene_outline` returns the frames only — id, name, node count and bounds — and `scene_read` returns
one frame with its nodes, optionally narrowed by node ids. That is deliberate: a scene of a few
hundred nodes is not something to pull down in full on every turn of a conversation.
