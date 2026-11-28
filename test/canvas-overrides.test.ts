import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { afterEach, test } from "node:test";

import { SCENE_FORMAT_VERSION, validateScene, type Scene } from "@artiflow/domain/scene";
import { applySceneOperations } from "@artiflow/domain/scene-operations";
import {
  SCENE_MAX_OVERRIDES,
  addFrameOverride,
  elementKeyOf,
  overridesStatusOf,
  patchFrameOverride,
  removeFrameOverride,
  setFrameVariant,
  type SceneFrameOverrides,
} from "@artiflow/domain/scene-overrides";

import { getScene, saveScene } from "../apps/dashboard/src/scene-api.ts";
import { SceneAutosave } from "../apps/dashboard/src/scene-autosave.ts";
import { AUTOSAVE_MS } from "../apps/dashboard/src/editor-autosave.ts";

const SOURCE_ARTIFACT = "0d5b0f6a-3f2b-4b4a-9a44-6a2f4a1f7c11";
const REVISION_ONE = "8f0d9c2e-51a4-4cbb-9a0e-2f3c4d5e6f70";
const REVISION_TWO = "c1b2a3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

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
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const scene = (): Scene => {
  const result = validateScene({
    formatVersion: SCENE_FORMAT_VERSION,
    frames: [
      {
        id: "frame-1",
        name: "Home",
        x: 0,
        y: 0,
        w: 390,
        h: 640,
        nodes: [],
        source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_ONE, mode: "fixed" },
      },
      { id: "frame-2", name: "Notes", x: 430, y: 0, w: 390, h: 640, nodes: [] },
    ],
  });
  assert.equal(result.ok, true, result.ok ? "" : `${result.reason} at ${result.path}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
};

const overridesOf = (value: Scene, frameId = "frame-1"): SceneFrameOverrides | undefined =>
  value.frames.find((frame) => frame.id === frameId)?.overrides;

const targeted = (selector: string) => ({ selector, textHint: "" });

const withOneEdit = (): Scene => addFrameOverride(scene(), "frame-1", targeted("#hero"));

type HistoryStep = { undo: Scene[]; redo: Scene[]; scene: Scene };

const historyModule = async () => {
  const page = readFileSync(new URL("../apps/dashboard/src/CanvasEditorPage.tsx", import.meta.url), "utf8");
  const at = page.indexOf("export const HISTORY_LIMIT");
  const to = page.indexOf("\nconst withoutNodes", at);
  assert.ok(at >= 0 && to > at, "the canvas screen still carries its history region");
  const code = stripTypeScriptTypes(page.slice(at, to), { mode: "strip" });
  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  return (await import(url)) as {
    commitHistory: (undo: Scene[], redo: Scene[], before: Scene) => { undo: Scene[]; redo: Scene[] };
    undoHistory: (undo: Scene[], redo: Scene[], current: Scene) => HistoryStep | null;
    redoHistory: (undo: Scene[], redo: Scene[], current: Scene) => HistoryStep | null;
  };
};

test("editing an artboard element stores a keyed override bound to the pinned revision", () => {
  const next = withOneEdit();
  const stored = overridesOf(next);
  assert.ok(stored !== undefined);
  assert.equal(stored.sourceRevisionId, REVISION_ONE);
  assert.deepEqual(
    stored.entries.map((entry) => entry.key),
    [elementKeyOf(targeted("#hero"))],
  );
  assert.equal(validateScene(next).ok, true, "the produced scene is still a valid document");
  assert.equal(scene().frames[0]?.overrides, undefined, "the scene before the edit is untouched");
});

test("a second edit of the same element reuses its entry and the limit holds", () => {
  const once = withOneEdit();
  assert.equal(overridesOf(addFrameOverride(once, "frame-1", targeted("#hero")))?.entries.length, 1);
  assert.equal(overridesOf(addFrameOverride(scene(), "frame-1", targeted("#other")))?.entries.length, 1);
  const full = Array.from({ length: SCENE_MAX_OVERRIDES }).reduce<Scene>(
    (current, _, index) => addFrameOverride(current, "frame-1", targeted(`#element-${index}`)),
    scene(),
  );
  assert.equal(overridesOf(full)?.entries.length, SCENE_MAX_OVERRIDES);
  assert.equal(
    overridesOf(addFrameOverride(full, "frame-1", targeted("#one-too-many")))?.entries.length,
    SCENE_MAX_OVERRIDES,
    "the editor never grows past the stored limit",
  );
});

test("a frame that is not a live artboard cannot take an override", () => {
  const next = addFrameOverride(scene(), "frame-2", targeted("#hero"));
  assert.equal(overridesOf(next, "frame-2"), undefined);
  assert.equal(overridesOf(next), undefined);
});

test("patching an entry changes text and style without dropping the rest", () => {
  const once = withOneEdit();
  const styled = patchFrameOverride(once, "frame-1", elementKeyOf(targeted("#hero")), {
    text: "Share this version",
    style: { color: "#ff6a2b" },
  });
  const sized = patchFrameOverride(styled, "frame-1", elementKeyOf(targeted("#hero")), { style: { fontSize: 22 } });
  const entry = overridesOf(sized)?.entries[0];
  assert.equal(entry?.text, "Share this version");
  assert.equal(entry?.style?.color, "#ff6a2b");
  assert.equal(entry?.style?.fontSize, 22);
  assert.equal(entry?.selector, "#hero", "the locator survives a style change");
});

test("removing the last edit drops the store but keeps a chosen variant", () => {
  const once = withOneEdit();
  const key = elementKeyOf(targeted("#hero"));
  assert.equal(overridesOf(removeFrameOverride(once, "frame-1", key)), undefined);

  const withVariant = setFrameVariant(once, "frame-1", "compact");
  const emptied = removeFrameOverride(withVariant, "frame-1", key);
  assert.deepEqual(overridesOf(emptied)?.entries, []);
  assert.equal(overridesOf(emptied)?.variant, "compact");
  assert.equal(overridesOf(setFrameVariant(once, "frame-1", null))?.variant, undefined);
});

test("undo reverts the last artboard edit and redo replays it", async () => {
  const history = await historyModule();
  const before = scene();
  const after = withOneEdit();
  const committed = history.commitHistory([], [], before);
  const undone = history.undoHistory(committed.undo, committed.redo, after);
  assert.ok(undone !== null);
  assert.equal(undone.scene.frames[0]?.overrides, undefined, "undo takes the override back out");
  const redone = history.redoHistory([], undone.redo, undone.scene);
  assert.ok(redone !== null);
  assert.equal(redone.scene.frames[0]?.overrides?.entries.length, 1, "redo brings it back");
});

test("the saved scene carries the overrides with the sequence that was read", async () => {
  const calls = useFetch(() =>
    json({ artifactId: "a", seq: 5, publishedSeq: 5, frozen: true, applied: 1, revisionId: "r2" }),
  );
  const edited = withOneEdit();
  const result = await saveScene("a", edited, 4);
  assert.equal(result.ok, true);
  const body = JSON.parse(String(calls[0]?.init.body)) as { scene: Scene; expectedSeq?: number; seq?: number };
  assert.equal(body.scene.frames[0]?.overrides?.entries.length, 1, "the override travels in the saved scene");
  assert.equal(body.scene.frames[0]?.overrides?.sourceRevisionId, REVISION_ONE);
});

test("an override reads back from the stored draft", async () => {
  useFetch(() =>
    json({ kind: "canvas", artifactId: "a", seq: 4, publishedSeq: 2, revisionId: "r1", scene: withOneEdit() }),
  );
  const read = await getScene("a");
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.value.scene.frames[0]?.overrides?.entries.length, 1);
});

test("a sequence conflict keeps the local edit instead of losing it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const edited = withOneEdit();
  const session = new SceneAutosave(
    {
      seq: 4,
      publishedSeq: 2,
      revisionId: "r1",
      scene: scene(),
    },
    async () => ({ ok: false as const, error: "refused", code: "concurrent_edit", signInRequired: false }),
    () => {},
    () => assert.fail("a refused save cannot commit"),
  );
  try {
    session.change(edited);
    t.mock.timers.tick(AUTOSAVE_MS);
    await flush();
    assert.equal(session.state.status, "conflict");
    assert.equal(
      session.state.scene.frames[0]?.overrides?.entries.length,
      1,
      "the override survives the conflict",
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("a new revision marks the edits stale and the next edit rebinds them", () => {
  const edited = withOneEdit();
  const moved = {
    ...edited,
    frames: edited.frames.map((frame) =>
      frame.id === "frame-1"
        ? { ...frame, source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_TWO, mode: "fixed" as const } }
        : frame,
    ),
  };
  assert.equal(overridesStatusOf(moved.frames[0] as never), "stale");
  assert.equal(overridesOf(moved)?.entries.length, 1, "stale keeps the work");

  const rebound = patchFrameOverride(moved, "frame-1", elementKeyOf(targeted("#hero")), { text: "A new heading" });
  assert.equal(overridesOf(rebound)?.sourceRevisionId, REVISION_TWO, "the next edit rebinds to the revision on screen");
  assert.equal(overridesOf(rebound)?.entries.length, 1);
  assert.equal(overridesOf(rebound)?.entries[0]?.text, "A new heading");
  assert.equal(overridesStatusOf(rebound.frames[0] as never), "current");
});

test("a locked proposal refuses the edit the editor would send", () => {
  const edited = withOneEdit();
  const locked = {
    ...edited,
    frames: edited.frames.map((frame) => (frame.id === "frame-1" ? { ...frame, locked: true } : frame)),
  };
  const result = applySceneOperations(locked, [
    {
      op: "update_frame",
      id: "frame-1",
      props: {
        overrides: {
          ...(overridesOf(locked) as SceneFrameOverrides),
          entries: (overridesOf(locked)?.entries ?? []).map((entry) => ({ ...entry, text: "Sneaky" })),
        },
      },
    },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, "frame_locked");
  assert.equal(overridesOf(locked)?.entries[0]?.text, undefined, "nothing was written");
});
