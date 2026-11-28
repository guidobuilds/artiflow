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

## Live artboards

A frame can point at an existing Page instead of holding nodes, so a Design compares real proposals
without copying them:

```json
{
  "id": "proposal-a",
  "name": "Proposal A",
  "x": 0,
  "y": 0,
  "w": 390,
  "h": 640,
  "nodes": [],
  "source": {
    "artifactId": "0d5b0f6a-3f2b-4b4a-9a44-6a2f4a1f7c11",
    "revisionId": "8f0d9c2e-51a4-4cbb-9a0e-2f3c4d5e6f70",
    "mode": "fluid"
  }
}
```

- The reference is **pinned to one revision**. Publishing a newer revision of the page does not
  change the artboard: the person updates it on purpose, per artboard, with the editor's
  “Update to latest revision” action (or with one `update_frame` from `scene_apply`).
- Pointing at a page grants nobody access. The Design revalidates read access every time someone
  opens it and draws “This proposal is not available to you.” instead of the content.
- `mode` is `fixed` (the page draws at the frame's width) or `fluid` (the page reflows at the
  viewport the person picks — 390 or 1280 — inside the same frame box). The page is never scaled
  as an image.
- The linked page keeps its own viewer and link; the artboard never rewrites it.
- An artboard frame carries no loose nodes, and its box (`x`, `y`, `w`, `h`) is still its place and
  size on the canvas.

Rendering resolves the source for the person opening the Design, so the web viewer, the editor and
the agent host all show the same pinned revision — or the same unavailable state. The referenced page
is inlined as a sealed document: it carries the same document policy the standalone page viewer
applies (`default-src 'none'`, no framing, no eval), so it cannot reach the network even though a
`data:` document inherits no policy from its parent. A page that pulls images or scripts from a URL
therefore draws them as missing inside a Design; only self-contained pages compare faithfully.

## Focus, Play and connected screens

A Design is looked at in three modes over the same document:

- **Canvas** places and compares artboards.
- **Focus** fills the view with one artboard at 390 or 1280, without the canvas chrome. Going back
  returns to the same place of the canvas, with the same frame selected. A fixed artboard keeps the
  width it was authored with; a fluid one offers 390 and 1280.
- **Play** runs one artboard at a time, follows the connections the design declared, and shows no
  editing tools, notes or guides.

The mode travels in the viewer URL, so a link opens the same starting point for anyone who can read
the Design:

```
/artifact/<design-id>?frame=<frame-id>&view=focus&width=390
/artifact/<design-id>?frame=<frame-id>&view=play&width=1280
```

`view` accepts `focus` or `play`; `width` accepts `390` or `1280`; `frame` is a frame id of that
Design. An unknown value, or a frame the Design does not hold, falls back to the canvas with no
other effect. Play needs a frame that is a live artboard. The editor's artboard card links to both
modes for that artboard, and `scene_read` gives the frame ids to build the same link from a chat.
The link points at the screen it names: walking the prototype inside Play does not rewrite it, so a
link always opens the same starting point.

### How a page connects to another screen

Artboards run sealed: they have scripts and nothing else — no network, no same-origin access, no
top navigation. They reach another screen with one message to the container:

```html
<script>
  parent.postMessage(
    {
      channel: "artiflow-play",
      version: 1,
      kind: "navigate",
      frame: "<frame-id of the destination artboard>",
      state: { plan: "pro" },
    },
    "*",
  );
</script>
```

The container accepts a message only when all of this holds, and otherwise does nothing at all:

- it arrives in Play, from the artboard currently being played;
- `channel` is `artiflow-play`, `version` is `1` and `kind` is `navigate`;
- `frame` is the id of another frame of the **same** Design, and that frame is a live artboard;
- `state`, when present, is a JSON object of at most 2048 characters.

Navigation never depends on the order of the frames on the canvas: it is the connection the page
declares, or nothing.

The destination artboard receives the decision the flow carried:

```js
window.addEventListener("message", (event) => {
  const data = event.data;
  if (data === null || typeof data !== "object") return;
  if (data.channel !== "artiflow-play" || data.kind !== "enter") return;
  document.querySelector("#plan").textContent = data.state?.plan ?? "free";
});
```

That is the whole state contract: a screen that needs to remember something either owns it (the
whole flow lives in one artboard) or passes it to the next screen in the navigation message. There is
no per-screen state store.

## What the server refuses

Validation answers with a named reason rather than a screenshot that looks wrong:

- a missing or newer `formatVersion`;
- an unknown node type, or a duplicate id anywhere in the scene;
- a coordinate that is not a finite number, or a node of zero or negative size;
- a coordinate that places a node outside its frame is allowed: a node may sit anywhere, including at a
  negative coordinate, and the frame no longer clips it;
- a property the renderer cannot honour — `layout`, `constraints`, a component reference — because
  accepting it and ignoring it would be a lie;
- a `source` that is not a canonical artifact and revision id with `mode` set to `fixed` or `fluid`,
  or a frame that carries both a `source` and nodes;
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
the frame you are looking at. Each live artboard also offers Focus and Play, and both keep the
canvas where it was when the person comes back.

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
  editor, where the server has to agree with the browser about where things end up. A live artboard
  is the exception: its page is laid out by the browser at the chosen viewport width, and the editor
  shows it as a card rather than as an editable preview.
- **Connections are declared by the page.** An artboard is a sealed page, so a jump between screens
  is a message the page sends, never a link the Design guesses from the canvas order. A prototype
  that needs to run as one screen with shared state should be authored as one artboard.
- **No vector images.** PNG, JPEG, WebP and GIF are accepted; SVG is refused, because it is a
  document that can carry script and serving it from our origin deserves its own decision.

## Reading it as an agent

`scene_outline` returns the frames only — id, name, node count and bounds — and `scene_read` returns
one frame with its nodes, optionally narrowed by node ids. That is deliberate: a scene of a few
hundred nodes is not something to pull down in full on every turn of a conversation. Both read the
current draft when there is one, so an agent sees what it just changed.

`scene_apply` is the write tool: a batch of id-addressed operations against a base sequence, atomic,
and its answer carries the absolute box of every node the batch touched plus any violation the final
validation found — the closest thing to eyes an agent gets without a renderer. It also answers `url`,
the link that opens the Design.

An artboard is created by adding a frame whose `source` names the page and the revision; `scene_read`
answers that frame with its `source` and a `sourceState` naming the pinned revision number, whether it
is still readable and which revision is the latest, so an agent can decide whether to repin it with
one `update_frame` instead of guessing. Repinning is the same explicit call: publish a revision of the
page, read the new revision id with `artifact_get`, then update that frame's `source.revisionId`.
