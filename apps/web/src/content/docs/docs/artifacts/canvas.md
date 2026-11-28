---
title: Canvas
description: What a canvas artifact is, how its scene is shaped, how a person navigates and edits it, and what it does not do yet.
---

A canvas is a **Design**: the artifact that gathers the proposals of a piece of work, opened as a design
surface of frames that stand for screens, with nodes inside them. An agent publishes the scene, and a
person opens it in the dashboard to move between frames and edit nodes. A [Page](/docs/concepts/artifacts/)
and a Markdown document are the other outputs; a [deck](/docs/artifacts/deck/) is this same scene presented as slides.

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
bytes: the picture is uploaded once, stored by its digest and referenced from as many documents as
need it. An `assetId` the document does not reference is drawn as a labelled placeholder, so a
missing image is visible instead of silent.

Ids are stable and unique across the whole scene — a node cannot reuse its frame's id — because
they are what comments and edits anchor to.

## What the server refuses

Validation answers with a named reason rather than a screenshot that looks wrong:

- a missing or newer `formatVersion`;
- an unknown node type, or a duplicate id anywhere in the scene;
- a coordinate that is not a finite number, or a node of zero or negative size;
- a coordinate that places a node outside its frame is allowed: a node may sit anywhere, including at a
  negative coordinate, and the frame no longer clips it;
- a property the renderer cannot honour — `layout`, `constraints`, a component reference — because
  accepting it and ignoring it would be a lie;
- more frames or nodes than the [limits](/docs/reference/limits/) allow, or nesting deeper than one
  frame level.

An unknown property on a node is preserved rather than dropped, so a scene written by a newer client
survives a reader that does not know that property yet.

## How a person navigates it

From the dashboard, a canvas opens in an editor that speaks the same language as the viewer: one frame
at a time, zoom to fit, drag to move, handles to resize, and a save that sends the sequence it read.

The editor keeps the surface as large as the window allows. The top bar holds the artiflow mark (back to
the library), the document name and its save state. The name opens the document menu: Share, Open in
viewer, Reload from server and Delete. Over the surface float the frames chip (top left), the edit pill
(bottom centre), the zoom (bottom right) and a `?` button (bottom left) that lists every shortcut. The chip
expands into the frame list, with the active frame's layers and the canvas-level nodes under it. The pill
adds text and rectangles and deletes the selection. With more than one node selected, it also shows the
count and the front and back actions. The text inspector opens on the right only while a text node is
selected.

In the read-only viewer, one frame is visible at a time, scaled to fit. Move between frames with the arrow keys, page up and
down, home and end, by clicking the frame index, or by opening `?frame=<frame-id>`. Wheel zooms
around the pointer, space-drag or middle-drag pans, and Fit resets the view; zoom and pan belong to
the frame you are looking at.

The document is served into the same sandboxed frame as an HTML artifact: it does not reach the
network, keeps no storage and loads no external font or script.

## What it does not do yet

- **Editing is young.** A person can move, resize, add, retype and delete nodes and save with the
  sequence it read. Reordering is expressible as `reorder_node`, but the editor still has no z-order
  control.
- **Comments anchor to nodes, and only where they can be shown.** A thread carries the node and a point
  inside it, so a pin follows the node when it moves; a thread whose node is gone is listed as orphaned
  instead of drawn at a stale position. The dashboard editor and the owner's viewer show them; a public
  link does not, yet.
- **No shared layout engine.** Nodes carry absolute geometry. Automatic layout arrives with the
  editor, where the server has to agree with the browser about where things end up.
- **No vector images.** PNG, JPEG, WebP and GIF are accepted; SVG is refused, because it is a
  document that can carry script and serving it from our origin deserves its own decision.

## Reading it as an agent

`scene_outline` returns the frames only — id, name, node count and bounds — and `scene_read` returns
one frame with its nodes, optionally narrowed by node ids. That is deliberate: a scene of a few
hundred nodes is not something to pull down in full on every turn of a conversation. Both read the
current draft when there is one, so an agent sees what it just changed.

`scene_apply` is the write tool: a batch of id-addressed operations against a base sequence, atomic,
and its answer carries the absolute box of every node the batch touched plus any violation the final
validation found — the closest thing to eyes an agent gets without a renderer.
