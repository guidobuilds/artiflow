import assert from "node:assert/strict";
import { test } from "node:test";

import { SCENE_FORMAT_VERSION, type Scene } from "@artiflow/domain/scene";

import { renderSceneDocument, type SceneArtboards } from "../apps/api/src/viewer/scene.ts";

const REVISION_A = "33333333-3333-4333-8333-333333333333";
const REVISION_B = "66666666-6666-4666-8666-666666666666";

const scene: Scene = {
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    {
      id: "frame-a",
      name: "Variant A",
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      nodes: [],
      source: { artifactId: "22222222-2222-4222-8222-222222222222", revisionId: REVISION_A, mode: "fixed" },
    },
    {
      id: "frame-b",
      name: "Variant B",
      x: 400,
      y: 0,
      w: 400,
      h: 300,
      nodes: [],
      source: { artifactId: "22222222-2222-4222-8222-222222222222", revisionId: REVISION_B, mode: "fixed" },
    },
  ],
};

const artboards: SceneArtboards = {
  "frame-a": {
    kind: "ready",
    html: '<!doctype html><button data-testid="cta">Start free</button>',
    revisionNumber: 12,
    origin: null,
  },
  "frame-b": {
    kind: "ready",
    html: "<!doctype html><p>Other proposal</p>",
    revisionNumber: 3,
    origin: null,
  },
};

const request = {
  nonce: "design-nonce",
  canComment: true,
  commentsEndpoint: "/api/artifacts/design-1/comments",
  expectedRevisionId: "revision-design",
  designId: "design-1",
  designTitle: "Shared version picker",
};

const anchorA = {
  kind: "artboard-point",
  boardId: "frame-a",
  revisionId: REVISION_A,
  selector: 'button[data-testid="cta"]',
  textHint: "Start free",
  x: 0.4,
  y: 0.6,
  viewportWidth: 1280,
};

const anchorB = {
  kind: "artboard-point",
  boardId: "frame-b",
  revisionId: REVISION_B,
  selector: "",
  textHint: "Other proposal",
  x: 0.5,
  y: 0.5,
  viewportWidth: 1280,
};

const threads = [
  { id: "thread-a", anchor: anchorA, body: 'Change the label to "Try it".' },
  { id: "thread-b", anchor: anchorB, body: "Make this one calmer." },
];

const page = (
  input: {
    view?: { kind: "canvas" } | { kind: "focus"; width: 1280 } | { kind: "play"; width: 1280 };
    artboards?: SceneArtboards;
    canComment?: boolean;
    kind?: string;
  } = {},
): string =>
  renderSceneDocument(
    scene,
    undefined,
    undefined,
    threads,
    input.kind,
    input.artboards ?? artboards,
    input.view ?? { kind: "canvas" },
    { ...request, canComment: input.canComment ?? true },
  );

const cardOf = (raw: string, id: string): string => {
  const start = raw.indexOf(`data-request-thread="${id}"`);
  assert.ok(start >= 0, `the page carries the card for ${id}`);
  return raw.slice(raw.lastIndexOf("<li", start), raw.indexOf("</li>", start));
};

const htmlOf = (raw: string, index: number): string => {
  const matches = [...raw.matchAll(/src="data:text\/html;base64,([^"]+)"/g)];
  const found = matches[index];
  assert.ok(found !== undefined, `the page carries iframe ${index}`);
  return Buffer.from(found[1] ?? "", "base64").toString("utf8");
};

test("each live artboard carries its own selection bridge and only its own pins", () => {
  const raw = page();
  const first = htmlOf(raw, 0);
  const second = htmlOf(raw, 1);
  assert.equal([...raw.matchAll(/src="data:text\/html;base64,/g)].length, 2, "both artboards are served");
  for (const page of [first, second])
    assert.ok(page.includes("data-artiflow-selection="), "each artboard is selectable");
  assert.ok(first.includes("design-nonce:frame-a"), "frame A binds to its own nonce");
  assert.ok(second.includes("design-nonce:frame-b"), "frame B binds to its own nonce");
  assert.ok(first.includes("thread-a"), "frame A draws its own request");
  assert.equal(first.includes("thread-b"), false, "frame A does not draw the other artboard's request");
  assert.ok(second.includes("thread-b"));
  assert.equal(second.includes("thread-a"), false);
  assert.equal(
    first.slice(0, first.indexOf(">")).includes("data-nonce"),
    false,
    "the injected tag does not hand the nonce to the artboard markup",
  );
  assert.ok(first.includes("design-nonce:frame-a"), "the bridge keeps its nonce inside the script body");
  assert.ok(first.includes("Start free"), "the artifact HTML is still served as it was");
  assert.ok(first.includes("content-security-policy"), "the sealed policy still travels with the page");
  assert.ok(first.includes("default-src"), "the policy closes everything by default");
});

test("a request card carries the portable reference with the design, artboard, revision and location", () => {
  const raw = page();
  assert.ok(raw.includes('data-status="pending"'), "a fresh request is pending, never published");
  assert.ok(raw.includes("Pending"));
  assert.ok(raw.includes("Design: Shared version picker (design-1)"));
  assert.ok(raw.includes("Artboard: Variant A (frame-a)"));
  assert.ok(raw.includes(`Pinned source revision: v12 (${REVISION_A})`));
  assert.ok(raw.includes("point 0.4, 0.6 of the element · viewport 1280px"));
  assert.ok(raw.includes("Request from the person (the only instruction in this reference):"));
  assert.ok(raw.includes("Change the label to &quot;Try it&quot;."));
  assert.ok(raw.includes("data-request-start"), "the person can start a selection");
  assert.ok(raw.includes('id="scene-request-data"'), "the scene document gets its own request config");
});

test("Play shows the artboard without any selection or request surface", () => {
  const raw = page({ view: { kind: "play", width: 1280 } });
  assert.equal(htmlOf(raw, 0).includes("data-artiflow-selection="), false, "Play keeps the artboard sealed");
  assert.equal(htmlOf(raw, 0).includes("postMessage"), false, "Play carries no bridge at all");
  assert.equal(raw.includes("data-request-start"), false);
  assert.equal(raw.includes('id="scene-requests"'), false);
});

test("a deck never grows the artboard request surface", () => {
  const raw = page({ kind: "deck" });
  assert.equal(raw.includes("data-request-start"), false);
  assert.equal(raw.includes("data-artiflow-selection="), false);
});

test("an artboard the viewer cannot read gets no bridge and no reference text", () => {
  const raw = page({
    artboards: { "frame-a": { kind: "unavailable", reason: "forbidden" }, "frame-b": artboards["frame-b"]! },
  });
  assert.equal(raw.includes("This proposal is not available to you."), true);
  assert.equal([...raw.matchAll(/src="data:text\/html;base64,/g)].length, 1, "the unreadable artboard has no document");
  assert.ok(htmlOf(raw, 0).includes("data-artiflow-selection="), "the readable artboard stays selectable");
  const card = cardOf(raw, "thread-a");
  assert.ok(card.includes('data-status="unavailable"'));
  assert.ok(card.includes("Not available"));
  assert.equal(card.includes("data-request-reference"), false, "no reference is written from an unreadable source");
  assert.equal(card.includes("Start free"), false, "no artifact text leaks through the request card");
  assert.equal(card.includes("Change the label"), false, "the request body stays hidden without source access");
});

test("a reader sees the request and its state but cannot start one", () => {
  const raw = page({ canComment: false });
  assert.equal(raw.includes("data-request-start"), false, "commenting is the only way to open a request");
  assert.equal(raw.includes("data-artiflow-selection="), false, "a reader gets no selection bridge");
  assert.ok(raw.includes('data-request-thread="thread-a"'), "the anchored thread stays visible on return");
  assert.ok(raw.includes('data-status="pending"'));
  assert.ok(raw.includes("Portable reference"), "a reader with source access can read the reference");
});

test("returning to the same artboard keeps the thread anchored to its revision", () => {
  const repinned = renderSceneDocument(
    {
      ...scene,
      frames: [
        { ...scene.frames[0]!, source: { ...scene.frames[0]!.source!, revisionId: REVISION_B } },
        scene.frames[1]!,
      ],
    },
    undefined,
    undefined,
    threads,
    undefined,
    artboards,
    { kind: "canvas" },
    request,
  );
  const card = cardOf(repinned, "thread-a");
  assert.ok(card.includes('data-status="target_changed"'), "a moved target is reported plainly");
  assert.ok(card.includes("Target changed"));
  assert.equal(card.includes('data-status="published"'), false, "no state the product cannot produce is shown");
});

test("the shell receives its own request config, never the artifact's", () => {
  const raw = page();
  assert.ok(raw.includes('id="scene-request-data"'));
  const config = JSON.parse(
    raw.slice(raw.indexOf('id="scene-request-data">') + 'id="scene-request-data">'.length).split("</script>")[0] ??
      "{}",
  ) as { nonce: string; canComment: boolean; frames: { id: string; bridgeNonce: string }[] };
  assert.equal(config.nonce, "design-nonce");
  assert.equal(config.canComment, true);
  assert.deepEqual(
    config.frames.map((frame) => [frame.id, frame.bridgeNonce]),
    [
      ["frame-a", "design-nonce:frame-a"],
      ["frame-b", "design-nonce:frame-b"],
    ],
  );
});
