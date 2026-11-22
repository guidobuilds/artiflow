import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { openArtifact } from "../apps/dashboard/src/editor-api.ts";
import {
  addNode,
  fitScale,
  getScene,
  moveNode,
  openCanvas,
  rectNode,
  removeNode,
  resizeNode,
  saveScene,
  textNode,
  updateTextNode,
} from "../apps/dashboard/src/scene-api.ts";
import { SceneAutosave } from "../apps/dashboard/src/scene-autosave.ts";
import { AUTOSAVE_MS } from "../apps/dashboard/src/editor-autosave.ts";
import type { Scene } from "@artiflow/domain/scene";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init: RequestInit };
const useFetch = (reply: (call: Call) => Response): Call[] => {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return calls;
};
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const scene = (): Scene => ({
  formatVersion: 1,
  frames: [
    {
      id: "frame-1",
      name: "Home",
      x: 0,
      y: 0,
      w: 800,
      h: 600,
      nodes: [
        { id: "rect-1", type: "rect", x: 40, y: 40, w: 200, h: 120, fill: "#e5e7eb" },
        {
          id: "text-1",
          type: "text",
          x: 40,
          y: 200,
          w: 300,
          h: 60,
          text: "Hello",
          style: { fontSize: 24, fontWeight: 600, color: "#111111" },
        },
      ],
    },
  ],
});
const draft = () => ({
  kind: "canvas",
  artifactId: "a",
  seq: 4,
  publishedSeq: 2,
  revisionId: "r1",
  scene: scene(),
});
const saved = { artifactId: "a", seq: 5, publishedSeq: 5, frozen: true, applied: 1, revisionId: "r2" };
const failure = (code: string) => ({ ok: false as const, error: "refused", code, signInRequired: false });
const markdown = {
  artifactId: "a",
  title: "Notes",
  kind: "markdown",
  revisionId: "r1",
  revisionNumber: 1,
  text: "old",
  seq: 4,
  publishedSeq: 2,
};

const nodeOf = (value: Scene, id: string) => value.frames[0]?.nodes.find((node) => node.id === id);

test("the library sends a canvas to the canvas editor and every other kind keeps its current path", async () => {
  useFetch(() => json(draft()));
  let href = "";
  await openCanvas({ id: "a", viewerHref: "/artifact/a" }, { assign: (url) => (href = url) });
  assert.equal(href, "/canvas/a", "a canvas the caller may edit opens in the canvas editor");

  for (const [status, error] of [
    [403, "forbidden"],
    [409, "wrong_kind"],
    [404, "not_found"],
  ] as const) {
    useFetch(() => json({ error }, status));
    href = "";
    await openCanvas({ id: "a", viewerHref: "/artifact/a" }, { assign: (url) => (href = url) });
    assert.equal(href, "/artifact/a", `a canvas the editor cannot open stays on the viewer (${error})`);
  }

  useFetch(() => json(markdown));
  href = "";
  await openArtifact({ id: "a", viewerHref: "/artifact/a", kind: "markdown" }, { assign: (url) => (href = url) });
  assert.equal(href, "/edit/a", "the markdown editor keeps its route and its read");

  useFetch(() => json({ error: "wrong_kind" }, 409));
  href = "";
  await openArtifact({ id: "a", viewerHref: "/artifact/a", kind: "html" }, { assign: (url) => (href = url) });
  assert.equal(href, "/artifact/a", "a page still never enters an editor");
});

test("the scene client refuses an answer it cannot verify instead of opening half a scene", async () => {
  useFetch(() => json(draft()));
  const read = await getScene("a");
  assert.equal(read.ok, true);
  assert.deepEqual(read.ok && read.value.scene, scene());

  const malformed: [string, unknown][] = [
    ["a scene served without a sequence", { ...draft(), seq: undefined }],
    ["a sequence that is not a whole number", { ...draft(), seq: 1.5 }],
    ["an answer for another kind", { ...draft(), kind: "markdown" }],
    ["an answer with no revision", { ...draft(), revisionId: "" }],
    ["an answer with no artifact", { ...draft(), artifactId: "" }],
    ["a scene with no frames", { ...draft(), scene: { formatVersion: 1 } }],
    [
      "a node outside its frame",
      {
        ...draft(),
        scene: { ...scene(), frames: [{ ...scene().frames[0], nodes: [{ ...scene().frames[0]!.nodes[0], x: 700 }] }] },
      },
    ],
    [
      "a node the format does not know",
      {
        ...draft(),
        scene: {
          ...scene(),
          frames: [{ ...scene().frames[0], nodes: [{ ...scene().frames[0]!.nodes[0], type: "group" }] }],
        },
      },
    ],
    [
      "a duplicated id",
      {
        ...draft(),
        scene: {
          ...scene(),
          frames: [{ ...scene().frames[0], nodes: [scene().frames[0]!.nodes[0], scene().frames[0]!.nodes[0]] }],
        },
      },
    ],
  ];
  for (const [label, body] of malformed) {
    useFetch(() => json(body));
    const result = await getScene("a");
    assert.equal(result.ok, false, label);
    assert.equal(result.ok === false && result.code, "unreadable_answer", label);
  }

  const calls = useFetch(() => json(draft()));
  await getScene("a");
  assert.deepEqual(
    [calls[0]?.url, calls[0]?.init.method, calls[0]?.init.cache, calls[0]?.init.credentials],
    ["/api/artifacts/a/scene", "GET", "no-store", "same-origin"],
  );
});

test("a scene save sends the whole scene against the sequence it read and verifies the answer", async () => {
  const calls = useFetch(() => json(saved));
  const next = moveNode(scene(), "rect-1", 10, 0);
  assert.deepEqual(await saveScene("a", next, 4), { ok: true, value: saved });
  assert.deepEqual([calls[0]?.url, calls[0]?.init.method], ["/api/artifacts/a/scene", "PUT"]);
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { scene: next, expectedSeq: 4 });

  useFetch(() => json({ ...saved, applied: "one" }));
  assert.equal((await saveScene("a", next, 4)).ok, false, "an unverified answer never advances the editor");
  useFetch(() => json({ error: "concurrent_edit" }, 409));
  const conflict = await saveScene("a", next, 4);
  assert.deepEqual(conflict.ok === false && conflict.code, "concurrent_edit");
});

test("dragging and resizing keep a node inside its frame and every other gesture composes a whole scene", () => {
  const moved = moveNode(scene(), "rect-1", 30, 25);
  assert.deepEqual(
    [nodeOf(moved, "rect-1")?.x, nodeOf(moved, "rect-1")?.y],
    [70, 65],
    "a drag moves by its scene distance",
  );
  assert.equal(nodeOf(scene(), "rect-1")?.x, 40, "the scene before the drag is untouched");

  const clamped = moveNode(scene(), "rect-1", -500, 5000);
  assert.deepEqual(
    [nodeOf(clamped, "rect-1")?.x, nodeOf(clamped, "rect-1")?.y],
    [0, 480],
    "a drag past the frame edge stops at the edge instead of producing a scene the server refuses",
  );
  assert.deepEqual(nodeOf(moveNode(scene(), "missing", 10, 10), "rect-1"), nodeOf(scene(), "rect-1"));

  const resized = resizeNode(scene(), "rect-1", 320, 90);
  assert.deepEqual([nodeOf(resized, "rect-1")?.w, nodeOf(resized, "rect-1")?.h], [320, 90]);
  const bounded = resizeNode(scene(), "rect-1", 5000, 0);
  assert.deepEqual(
    [nodeOf(bounded, "rect-1")?.w, nodeOf(bounded, "rect-1")?.h],
    [760, 4],
    "a resize stops at the frame edge and at a size the server still accepts",
  );

  const withText = addNode(scene(), "frame-1", textNode("text-2", 120, 360));
  assert.equal(nodeOf(withText, "text-2")?.type, "text");
  assert.equal(
    addNode(scene(), "frame-1", textNode("text-1", 0, 0)).frames[0]?.nodes.length,
    2,
    "an id that already exists is not added twice",
  );
  assert.equal(removeNode(withText, "text-2").frames[0]?.nodes.length, 2);
  assert.equal(removeNode(scene(), "text-1").frames[0]?.nodes.length, 1);
  assert.equal(removeNode(scene(), "missing").frames[0]?.nodes.length, 2);

  const edited = updateTextNode(scene(), "text-1", { text: "Changed", style: { fontSize: 40, color: "#ff0000" } });
  assert.equal(nodeOf(edited, "text-1")?.type === "text" && nodeOf(edited, "text-1")!.text, "Changed");
  assert.deepEqual(nodeOf(edited, "text-1")?.type === "text" && nodeOf(edited, "text-1")!.style, {
    fontSize: 40,
    fontWeight: 600,
    color: "#ff0000",
  });
  const boundedFont = nodeOf(updateTextNode(scene(), "text-1", { style: { fontSize: 9000 } }), "text-1");
  assert.equal(
    boundedFont?.type === "text" ? boundedFont.style?.fontSize : null,
    400,
    "a font size the server would refuse is clamped before it is sent",
  );
  assert.equal(nodeOf(updateTextNode(scene(), "rect-1", { text: "no" }), "rect-1")?.type, "rect");

  assert.equal(
    Math.round(fitScale({ w: 800, h: 600 }, { w: 1600, h: 1200 }) * 1000) / 1000,
    1.72,
    "fitting uses a margin so the frame never touches the viewport edge",
  );
  assert.equal(fitScale({ w: 800, h: 600 }, { w: 0, h: 0 }), 0.02, "an empty viewport falls back to the smallest zoom");
  assert.equal(rectNode("rect-3", 10, 10).fill.length > 0, true, "a new rectangle arrives with a visible fill");
});

test("a save sends the sequence it read and adopts the sequence the save reports", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: unknown[] = [];
  const session = new SceneAutosave(
    draft(),
    async (next, expectedSeq) => {
      calls.push([next, expectedSeq]);
      return { ok: true, value: saved };
    },
    () => {},
    () => {},
  );
  try {
    const moved = moveNode(scene(), "rect-1", 10, 0);
    session.change(moved);
    t.mock.timers.tick(AUTOSAVE_MS);
    await flush();
    assert.deepEqual(calls, [[moved, 4]], "the save carries the sequence that was read and the whole scene");
    assert.equal(session.state.seq, 5, "the save response advances the remembered sequence");
    assert.equal(session.state.status, "saved");
    assert.equal(session.state.dirty, false);

    const again = moveNode(moved, "rect-1", 10, 0);
    session.change(again);
    t.mock.timers.tick(AUTOSAVE_MS);
    await flush();
    assert.deepEqual(calls[1], [again, 5], "the next save uses the adopted sequence");
  } finally {
    session.dispose();
  }
});

test("a conflict keeps the local scene, stops writing and surfaces the conflict", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const session = new SceneAutosave(
    draft(),
    async () => {
      calls += 1;
      return failure("concurrent_edit");
    },
    () => {},
    () => assert.fail("a refused save cannot commit"),
  );
  try {
    const local = moveNode(scene(), "rect-1", 60, 0);
    session.change(local);
    t.mock.timers.tick(AUTOSAVE_MS);
    await flush();
    assert.deepEqual(
      [session.state.status, session.state.dirty, session.state.seq],
      ["conflict", true, 4],
      "the conflict path keeps the position the person wrote against",
    );
    assert.deepEqual(session.state.scene, local, "the drag is not lost");

    const further = moveNode(local, "rect-1", 20, 0);
    session.change(further);
    assert.deepEqual(session.state.scene, further, "editing continues locally during a conflict");
    t.mock.timers.tick(AUTOSAVE_MS);
    await flush();
    assert.equal(calls, 1, "a conflict stops the writer instead of overwriting the newer version");
    assert.equal(session.state.status, "conflict");
    assert.equal(session.beginReload(), true, "the editor can offer the current version");
  } finally {
    session.dispose();
  }
});

test("the canvas screen wires every required gesture to the scene writer", () => {
  const page = source("../apps/dashboard/src/CanvasEditorPage.tsx");
  const markdown = source("../apps/dashboard/src/EditorPage.tsx");
  assert.match(page, /new SceneAutosave\(/);
  assert.match(page, /saveScene\(/);
  assert.match(page, /moveNode\(/);
  assert.match(page, /resizeNode\(/);
  assert.match(page, /addTextNode\(/);
  assert.match(page, /addRectNode\(/);
  assert.match(page, /removeNode\(/);
  assert.match(page, /updateTextNode\(/);
  assert.match(page, /fitScale\(/);
  assert.match(page, /aria-label="Frames"/);
  assert.match(page, /aria-label="Canvas zoom"/);
  assert.match(page, /event\.key === "ArrowRight"/);
  assert.match(page, /event\.key === "ArrowLeft"/);
  assert.match(page, /event\.key === "Delete"/);
  assert.match(page, /aria-label="Text content"/);
  assert.match(page, /aria-label="Font size"/);
  assert.match(page, /aria-label="Font weight"/);
  assert.match(page, /aria-label="Text colour"/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(page, /replace_scene|add_frame|move_node|update_node/);
  const conflict = /Someone saved a newer version\.[^<]*/.exec(markdown)?.[0];
  assert.ok(conflict, "the markdown editor still carries the conflict message");
  assert.equal(
    page.includes(conflict),
    true,
    "the canvas screen shows the same conflict message instead of inventing its own",
  );
});

test("the canvas route is gated by the registry and leaves the markdown route untouched", () => {
  const main = source("../apps/dashboard/src/main.tsx");
  assert.match(main, /const canvas = \/\^\\\/canvas\\\/\(\[a-f0-9\]\{8\}/);
  assert.match(main, /<CanvasEditorPage artifactId=/);
  assert.match(main, /<EditorPage artifactId=/);
  assert.doesNotMatch(main, /kind === "canvas"/);
  const library = source("../apps/dashboard/src/LibraryPage.tsx");
  assert.match(library, /editsSceneInApp\(artifact\.kind\)/);
  assert.match(library, /openCanvas\(artifact, window\.location\)/);
  assert.match(library, /openArtifact\(artifact, window\.location\)/);
  assert.doesNotMatch(library, /kind === "canvas"/);
});
