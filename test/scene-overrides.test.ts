import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

import { SCENE_FORMAT_VERSION, canonicalScene, validateScene, type Scene } from "@artiflow/domain/scene";
import { applySceneOperations, diffSceneOperations, type SceneOperation } from "@artiflow/domain/scene-operations";
import {
  SCENE_MAX_OVERRIDES,
  SCENE_MAX_OVERRIDE_TEXT,
  SCENE_VARIANTS,
  appliedOverridesOf,
  elementKeyOf,
  isEditableTarget,
  isSceneOverrideColor,
  overridesStatusOf,
  resolvedStyleOf,
  variantStyleOf,
  type SceneFrameOverrides,
  type SceneOverride,
} from "@artiflow/domain/scene-overrides";
import { overridesBridgeScript } from "../apps/api/src/viewer/overrides-bridge-script.ts";
import { renderSceneDocument, type SceneArtboards } from "../apps/api/src/viewer/scene.ts";

const SOURCE_ARTIFACT = "0d5b0f6a-3f2b-4b4a-9a44-6a2f4a1f7c11";
const REVISION_ONE = "8f0d9c2e-51a4-4cbb-9a0e-2f3c4d5e6f70";
const REVISION_TWO = "c1b2a3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

const overrideEntry = (overrides: Record<string, unknown> = {}): SceneOverride => ({
  key: "node:#hero",
  selector: "#hero",
  textHint: "",
  text: "Share this version",
  style: { color: "#ff6a2b", fontSize: 20, align: "center", spacing: 4 },
  ...overrides,
}) as unknown as SceneOverride;

const frameOverrides = (overrides: Record<string, unknown> = {}): SceneFrameOverrides =>
  ({
    sourceRevisionId: REVISION_ONE,
    entries: [overrideEntry()],
    ...overrides,
  }) as unknown as SceneFrameOverrides;

const artboard = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "a",
  name: "Proposal A",
  x: 0,
  y: 0,
  w: 390,
  h: 640,
  nodes: [],
  source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_ONE, mode: "fixed" },
  ...overrides,
});

const plainFrame = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "b",
  name: "Proposal B",
  x: 430,
  y: 0,
  w: 390,
  h: 640,
  nodes: [],
  ...overrides,
});

const scene = (frames: Record<string, unknown>[] = [artboard()]): Scene => {
  const result = validateScene({ formatVersion: SCENE_FORMAT_VERSION, frames });
  assert.equal(result.ok, true, result.ok ? "" : `${result.reason} at ${result.path}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
};

const refusalOf = (frames: Record<string, unknown>[], pattern: string): { reason: string; path: string } => {
  const result = validateScene({ formatVersion: SCENE_FORMAT_VERSION, frames });
  assert.equal(result.ok, false, "the scene is refused instead of accepted");
  if (result.ok) throw new Error("unreachable");
  assert.match(result.path, new RegExp(pattern));
  return { reason: result.reason, path: result.path };
};

const applied = (operations: SceneOperation[], start: Scene = scene()): Scene => {
  const result = applySceneOperations(start, operations);
  assert.equal(result.ok, true, result.ok ? "" : `${result.reason} at op ${result.opIndex}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value.scene;
};

const pageScriptOf = (sceneValue: Scene, frameId: string): { source: string; overrides: readonly unknown[] } => {
  const frame = sceneValue.frames.find((entry) => entry.id === frameId);
  assert.ok(frame !== undefined);
  const overrides = appliedOverridesOf(frame);
  return { overrides, source: `<html><body></body></html>${overridesBridgeScript({ overrides })}` };
};

const storedOverridesOf = (value: Scene, index = 0): SceneFrameOverrides => {
  const frame = value.frames[index];
  assert.ok(frame?.overrides !== undefined, "the overrides are stored on the frame");
  return frame.overrides;
};

const injectedScriptOf = (rendered: string): string => {
  const start = rendered.indexOf("<script data-artiflow-overrides");
  assert.notEqual(start, -1, "the override script is injected into the sealed page");
  const open = rendered.indexOf(">", start);
  const close = rendered.lastIndexOf("</script>");
  return rendered.slice(open + 1, close);
};

const fakeElement = (tagName: string, textContent: string, id = ""): Record<string, unknown> => {
  const style: Record<string, string> = {};
  const attributes: Record<string, string> = {};
  return {
    tagName,
    id,
    textContent,
    style: { setProperty: (name: string, value: string) => void (style[name] = value) },
    setAttribute: (name: string, value: string) => void (attributes[name] = value),
    writtenStyle: style,
    writtenAttributes: attributes,
  };
};

const applyInSealedFrame = (rendered: string, elements: Record<string, unknown>[]): void => {
  const byId = new Map(elements.filter((element) => element.id).map((element) => [element.id as string, element]));
  const context = createContext({
    document: {
      readyState: "complete",
      documentElement: fakeElement("HTML", ""),
      getElementById: (id: string) => byId.get(id) ?? null,
      querySelectorAll: () => elements,
    },
  });
  runInContext(injectedScriptOf(rendered), context);
};

test("an element key is stable for a selector and for a text hint", () => {
  assert.equal(elementKeyOf({ selector: "#hero", textHint: "" }), "node:#hero");
  assert.equal(elementKeyOf({ selector: "  ", textHint: "  Share this version " }), "text:Share this version");
  assert.equal(isEditableTarget({ selector: "", textHint: "" }), false);
  assert.equal(isEditableTarget({ selector: "", textHint: "Price" }), true);
});

test("overrides are stored on the frame and survive canonical serialization", () => {
  const value = scene([artboard({ overrides: frameOverrides() })]);
  const stored = storedOverridesOf(value);
  assert.equal(stored.sourceRevisionId, REVISION_ONE);
  assert.equal(stored.entries.length, 1);
  assert.equal(stored.entries[0]?.text, "Share this version");
  assert.match(canonicalScene(value), /"overrides"/);
});

test("an override without an artboard source is refused", () => {
  const { reason } = refusalOf([plainFrame({ overrides: frameOverrides() })], "overrides");
  assert.equal(reason, "invalid_override");
});

test("an unknown override property is refused instead of silently stored", () => {
  assert.equal(refusalOf([artboard({ overrides: frameOverrides({ density: 2 }) })], "density").reason, "unsupported_property");
  assert.equal(
    refusalOf([artboard({ overrides: frameOverrides({ entries: [overrideEntry({ weight: 700 })] }) })], "weight")
      .reason,
    "unsupported_property",
  );
  assert.equal(
    refusalOf([
      artboard({ overrides: frameOverrides({ entries: [overrideEntry({ style: { lineHeight: 2 } })] }) }),
    ], "lineHeight").reason,
    "unsupported_property",
  );
});

test("override limits are enforced on text, entry count, font size and spacing", () => {
  const longText = "a".repeat(SCENE_MAX_OVERRIDE_TEXT + 1);
  assert.equal(
    refusalOf([artboard({ overrides: frameOverrides({ entries: [overrideEntry({ text: longText })] }) })], "text")
      .reason,
    "invalid_override",
  );
  const many = Array.from({ length: SCENE_MAX_OVERRIDES + 1 }, (_, index) => {
    const selector = `#hero-${index}`;
    return overrideEntry({ key: elementKeyOf({ selector, textHint: "" }), selector });
  });
  assert.equal(refusalOf([artboard({ overrides: frameOverrides({ entries: many }) })], "entries").reason, "invalid_override");
  assert.equal(
    refusalOf([
      artboard({ overrides: frameOverrides({ entries: [overrideEntry({ style: { fontSize: 900 } })] }) }),
    ], "fontSize").reason,
    "invalid_override",
  );
  assert.equal(
    refusalOf([
      artboard({ overrides: frameOverrides({ entries: [overrideEntry({ style: { spacing: -1 } })] }) }),
    ], "spacing").reason,
    "invalid_override",
  );
});

test("an override key must match its locator and stay unique per frame", () => {
  assert.equal(
    refusalOf([
      artboard({ overrides: frameOverrides({ entries: [overrideEntry({ key: "node:#other" })] }) }),
    ], "key").reason,
    "invalid_override",
  );
  assert.equal(
    refusalOf([
      artboard({
        overrides: frameOverrides({ entries: [overrideEntry(), overrideEntry({ text: "Second" })] }),
      }),
    ], "key").reason,
    "invalid_override",
  );
  assert.equal(
    refusalOf([
      artboard({ overrides: frameOverrides({ entries: [overrideEntry({ selector: "", textHint: "" })] }) }),
    ], "selector").reason,
    "invalid_override",
  );
});

test("a colour that could escape the style attribute is refused", () => {
  for (const color of ["red;}body{display:none", "url(https://example.test/x.png)", "#ff6a2b;background:gold", "rgb(0,0,0);"]) {
    assert.equal(isSceneOverrideColor(color), false, color);
    assert.equal(
      refusalOf([
        artboard({ overrides: frameOverrides({ entries: [overrideEntry({ style: { color } })] }) }),
      ], "color").reason,
      "invalid_override",
      color,
    );
  }
  for (const color of ["#ff6a2b", "#fff", "rgb(255, 106, 43)", "rgba(0,0,0,0.4)", "hsl(12 76% 61%)", "transparent"]) {
    assert.equal(isSceneOverrideColor(color), true, color);
  }
});

test("a variant groups several values and an explicit override wins", () => {
  const variant = variantStyleOf("compact");
  assert.equal(Object.keys(variant).length >= 2, true, "a variant bundles more than one value");
  assert.equal(variant.fontSize, 13);
  assert.equal(variantStyleOf("warm").color, "#ff6a2b");
  assert.equal(variantStyleOf(undefined).fontSize, undefined);
  for (const id of SCENE_VARIANTS) assert.equal(typeof variantStyleOf(id), "object");
  const entry = { key: "node:#hero", selector: "#hero", textHint: "", style: { fontSize: 30 } };
  assert.equal(resolvedStyleOf(entry, "compact").fontSize, 30);
  assert.equal(resolvedStyleOf(entry, "compact").spacing, 0);
});

test("a variant applies to one proposal and leaves the other untouched", () => {
  const bare = (selector: string) =>
    overrideEntry({ key: elementKeyOf({ selector, textHint: "" }), selector, style: undefined });
  const value = scene([
    artboard({ overrides: frameOverrides({ entries: [bare("#hero")], variant: "compact" }) }),
    artboard({
      id: "c",
      name: "Proposal C",
      x: 860,
      overrides: frameOverrides({ entries: [bare("#hero")], variant: "spacious" }),
    }),
  ]);
  const first = appliedOverridesOf(value.frames[0] as never);
  const second = appliedOverridesOf(value.frames[1] as never);
  assert.equal(first[0]?.style.fontSize, 13);
  assert.equal(first[0]?.style.spacing, 0);
  assert.equal(second[0]?.style.fontSize, 17);
  assert.equal(second[0]?.style.spacing, 8);

  const adjusted = applied([
    {
      op: "update_frame",
      id: "c",
      props: { overrides: frameOverrides({ entries: [bare("#hero")], variant: "warm" }) },
    },
  ], value);
  assert.deepEqual(
    appliedOverridesOf(adjusted.frames[0] as never).map((entry) => entry.style),
    first.map((entry) => entry.style),
    "re-tuning one proposal leaves the other proposal alone",
  );
  assert.equal(appliedOverridesOf(adjusted.frames[1] as never)[0]?.style.color, "#ff6a2b");
});

test("a source revision change marks the overrides stale without deleting them", () => {
  const current = scene([artboard({ overrides: frameOverrides() })]);
  assert.equal(overridesStatusOf(current.frames[0] as never), "current");

  const next = applied([
    {
      op: "update_frame",
      id: "a",
      props: { source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_TWO, mode: "fixed" } },
    },
  ], current);
  assert.equal(overridesStatusOf(next.frames[0] as never), "stale");
  assert.equal(appliedOverridesOf(next.frames[0] as never).length, 0, "stale overrides are not applied");
  assert.equal(storedOverridesOf(next).entries.length, 1, "the work is preserved");
  assert.equal(next.frames[0]?.source?.revisionId, REVISION_TWO);
  assert.equal(overridesStatusOf(scene([plainFrame()]).frames[0] as never), "absent");
});

test("an override edit round-trips through the operation diff", () => {
  const before = scene([artboard()]);
  const after = scene([artboard({ overrides: frameOverrides() })]);
  const operations = diffSceneOperations(before, after);
  assert.deepEqual(operations.map((operation) => operation.op), ["update_frame"]);
  const replayed = applied(operations, before);
  assert.equal(canonicalScene(replayed), canonicalScene(after));
});

test("clearing the overrides is an explicit operation", () => {
  const before = scene([artboard({ overrides: frameOverrides() })]);
  const after = scene([artboard()]);
  const operations = diffSceneOperations(before, after);
  assert.deepEqual(operations.map((operation) => operation.op), ["update_frame"]);
  assert.equal(canonicalScene(applied(operations, before)), canonicalScene(after));
});

test("a locked proposal refuses an override edit and keeps the stored work", () => {
  const start = scene([artboard({ overrides: frameOverrides(), locked: true })]);
  const result = applySceneOperations(start, [
    { op: "update_frame", id: "a", props: { overrides: frameOverrides({ entries: [overrideEntry({ text: "Changed" })] }) } },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, "frame_locked");
  assert.equal(storedOverridesOf(start).entries[0]?.text, "Share this version");
});

test("an invalid override is refused by the operation path and stores nothing", () => {
  const start = scene([artboard()]);
  const result = applySceneOperations(start, [
    { op: "update_frame", id: "a", props: { overrides: frameOverrides({ entries: [overrideEntry({ text: "" })] }) } },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, "invalid_override");
  assert.equal(start.frames[0]?.overrides, undefined);
});

test("an override never rewrites the artefact reference of the proposal", () => {
  const next = applied([
    { op: "update_frame", id: "a", props: { overrides: frameOverrides() } },
  ]);
  assert.equal(next.frames[0]?.source?.artifactId, SOURCE_ARTIFACT);
  assert.equal(next.frames[0]?.source?.revisionId, REVISION_ONE);
  assert.equal(next.frames[0]?.nodes.length, 0);
});

test("the injected script applies text and style inside the sealed page", () => {
  const value = scene([artboard({ overrides: frameOverrides({ variant: "compact" }) })]);
  const { source } = pageScriptOf(value, "a");
  const hero = fakeElement("H1", "Choose a version", "hero");
  applyInSealedFrame(source, [hero]);

  assert.equal(hero.textContent, "Share this version");
  assert.equal((hero.writtenStyle as Record<string, string>)["color"], "#ff6a2b");
  assert.equal((hero.writtenStyle as Record<string, string>)["font-size"], "20px");
  assert.equal((hero.writtenStyle as Record<string, string>)["text-align"], "center");
  assert.equal((hero.writtenStyle as Record<string, string>)["letter-spacing"], "4px");
  assert.equal((hero.writtenAttributes as Record<string, string>)["data-artiflow-overridden"], "node:#hero");
});

test("the injected script resolves a text hint and ignores an element it cannot place", () => {
  const hintEntry = overrideEntry({
    key: elementKeyOf({ selector: "", textHint: "Choose a version" }),
    selector: "",
    textHint: "Choose a version",
    text: "Share this version",
    style: { fontSize: 22 },
  });
  const value = scene([artboard({ overrides: frameOverrides({ entries: [hintEntry] }) })]);
  const { source } = pageScriptOf(value, "a");
  const heading = fakeElement("H1", "Choose a version to share");
  const other = fakeElement("P", "Unrelated copy");
  applyInSealedFrame(source, [heading, other]);

  assert.equal(heading.textContent, "Share this version");
  assert.equal((heading.writtenStyle as Record<string, string>)["font-size"], "22px");
  assert.equal(other.textContent, "Unrelated copy");
  assert.equal((other.writtenStyle as Record<string, string>)["font-size"], undefined);

  const missing = fakeElement("P", "Somewhere else");
  applyInSealedFrame(source, [missing]);
  assert.equal(missing.textContent, "Somewhere else", "an element that is not there is not faked");
});

test("the injected script carries no network or parent access", () => {
  const value = scene([artboard({ overrides: frameOverrides() })]);
  const script = injectedScriptOf(pageScriptOf(value, "a").source);
  for (const forbidden of ["fetch(", "XMLHttpRequest", "window.parent", "postMessage", "import(", "eval("])
    assert.equal(script.includes(forbidden), false, forbidden);
});

test("a stale revision injects no override script at all", () => {
  const stale = applied(
    [
      { op: "update_frame", id: "a", props: { overrides: frameOverrides() } },
      {
        op: "update_frame",
        id: "a",
        props: { source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_TWO, mode: "fixed" } },
      },
    ],
  );
  const { overrides } = pageScriptOf(stale, "a");
  assert.deepEqual(overrides, []);
});

const ARTBOARD_CONTENT: SceneArtboards = {
  a: {
    kind: "ready",
    html: '<h1 id="hero">Choose a version</h1><p>Pick one to share.</p>',
    revisionNumber: 3,
    origin: "https://artiflow.test",
  },
};

const sealedPageOf = (value: Scene): string => {
  const document = renderSceneDocument(value, undefined, undefined, [], "canvas", ARTBOARD_CONTENT);
  const at = document.indexOf('data-frame-id="a"');
  assert.ok(at >= 0, "the frame is rendered");
  const section = document.slice(document.lastIndexOf("<section", at), document.indexOf("</section>", at));
  const match = /src="data:text\/html;base64,([A-Za-z0-9+/=]+)"/.exec(section);
  assert.ok(match !== null, "the artboard carries an inline document");
  return Buffer.from(match[1] as string, "base64").toString("utf8");
};

test("the sealed artboard keeps the source html intact and only appends the override script", () => {
  const plain = sealedPageOf(scene([artboard()]));
  const edited = sealedPageOf(scene([artboard({ overrides: frameOverrides() })]));
  assert.equal(plain.includes("data-artiflow-overrides"), false, "an unedited proposal carries no override script");
  assert.equal(edited.startsWith(plain), true, "the original document stays byte-identical as the prefix");
  assert.match(edited, /data-artiflow-overrides/);
  assert.match(edited, /<h1 id="hero">Choose a version<\/h1>/, "the source markup is never rewritten in place");
  assert.equal(scene([artboard()]).frames[0]?.source?.revisionId, REVISION_ONE);
});
