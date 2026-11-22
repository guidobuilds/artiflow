import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Hono } from "hono";

import {
  SCENE_FORMAT_VERSION,
  canonicalScene,
  type RectNode,
  type Scene,
  type SceneFrame,
} from "@artiflow/domain/scene";

import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { newRevisionStorageKey } from "../apps/api/src/adapters/storage/s3.ts";
import { createLibraryApp, type LibraryOptions } from "../apps/api/src/routes/library.ts";
import { createShareViewerApp } from "../apps/api/src/routes/sharing.ts";
import { viewerCommentsAssets } from "../apps/api/src/viewer/assets.ts";
import { bridgeNonce, bridgePins, viewerCommentsConfig } from "../apps/api/src/viewer/comments-data.ts";
import { htmlBridgeScript } from "../apps/api/src/viewer/html-bridge-script.ts";
import { escapeAttribute, NOT_FOUND_PAGE, SANDBOX, VIEWER_CSP, wrapperPage } from "../apps/api/src/viewer/html.ts";
import { markdownViewerPage, renderMarkdownFragment } from "../apps/api/src/viewer/markdown.ts";
import { renderSceneDocument } from "../apps/api/src/viewer/scene.ts";

const ARTIFACT_ID = "artifact-one";
const VIEWER_ID = "user-one";
const TITLE = "A canvas";
const SHARE_TOKEN = "a".repeat(43);
const HTML_SOURCE = `<!doctype html><html><body><h1>Pinned</h1><script>document.title = "pwn"</script></body></html>`;
const MARKDOWN_SOURCE = "# Notas\n\nUn p\u00e1rrafo con **negrita**\n";

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type Query = Promise<unknown> & {
  from: () => Query;
  leftJoin: () => Query;
  innerJoin: () => Query;
  where: () => Query;
  orderBy: () => Query;
  limit: () => Query;
  $dynamic: () => Query;
};

const queryBuilder = (results: readonly unknown[], onRead: () => void) => {
  let next = 0;
  const read = (): unknown => {
    onRead();
    return results[next++];
  };
  const chain = (): Query => {
    const query: Query = Object.assign(Promise.resolve().then(read), {
      from: () => query,
      leftJoin: () => query,
      innerJoin: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      $dynamic: () => query,
    });
    return query;
  };
  return { select: chain };
};

const storageWith = (bytes: Uint8Array): Storage =>
  ({
    client: {
      send: async (command: { constructor: { name: string } }): Promise<unknown> => {
        if (command.constructor.name === "HeadObjectCommand") return { ContentLength: bytes.length };
        if (command.constructor.name === "GetObjectCommand")
          return {
            Body: (async function* (): AsyncIterable<Uint8Array> {
              yield bytes;
            })(),
          };
        throw new Error(`unexpected command ${command.constructor.name}`);
      },
    },
    bucket: "test-bucket",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
  }) as unknown as Storage;

const sessionAuth = {
  api: { getSession: async () => ({ user: { id: VIEWER_ID } }) },
} as unknown as LibraryOptions["auth"];

const rect = (id: string, y: number): RectNode => ({ id, type: "rect", x: 0, y, w: 40, h: 20, fill: "#eeeeee" });

const frame = (id: string, name: string, nodes: readonly RectNode[] = []): SceneFrame => ({
  id,
  name,
  x: 0,
  y: 0,
  w: 390,
  h: 844,
  nodes: [...nodes],
});

const scene: Scene = {
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [frame("home", "Home", [rect("home-card", 10)]), frame("checkout", "Checkout", [rect("pay-button", 30)])],
};
const SCENE_TEXT = canonicalScene(scene);
const SCENE_BYTES = new TextEncoder().encode(SCENE_TEXT);

const IMAGE_DIGEST = "c".repeat(64);
const SCENE_PAGE_POLICY =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; img-src http://localhost; base-uri 'none'; form-action 'none'; connect-src 'self'";

const imageScene = (assetId: string, id = "shot"): Scene => ({
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    {
      ...frame("home", "Home"),
      nodes: [{ id, type: "image", x: 10, y: 20, w: 200, h: 120, assetId }],
    },
  ],
});
const imageSceneBytes = (assetId = IMAGE_DIGEST, id = "shot"): Uint8Array =>
  new TextEncoder().encode(canonicalScene(imageScene(assetId, id)));

const servedScene = (frameId?: string): string =>
  renderSceneDocument(scene, frameId, { origin: "http://localhost", artifactId: ARTIFACT_ID, digests: new Set() });

const metaPolicyOf = (document: string): string =>
  /content-security-policy" content="([^"]*)"/.exec(document)?.[1] ?? "";

const imageTagsOf = (document: string): string[] => document.match(/<img\b[^>]*>/g) ?? [];

type Revision = { storageKey: string; sha256: string; revisionNumber: number; sizeBytes: number };

const boardThread = {
  id: "comment-pin",
  artifactId: ARTIFACT_ID,
  authorId: VIEWER_ID,
  authorName: "Ann",
  authorImage: null,
  anchor: { kind: "board-point", boardId: "home", nodeId: "home-card", x: 0.25, y: 0.25 },
  body: "Tighten this",
  parentId: null,
  resolvedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const revisionOf = (bytes: Uint8Array): Revision => ({
  storageKey: newRevisionStorageKey(),
  sha256: digestOf(bytes),
  revisionNumber: 1,
  sizeBytes: bytes.length,
});

type Probe = { status: number; body: string; csp: string | null; contentType: string | null; queries: number };

const ownerView = async (input: {
  bytes: Uint8Array;
  kind: string;
  query?: string;
  commentResults?: readonly unknown[];
  assetResults?: readonly unknown[];
}): Promise<Probe> => {
  const revision = revisionOf(input.bytes);
  let queries = 0;
  const rows = queryBuilder(
    [
      [{ id: ARTIFACT_ID, title: TITLE, kind: input.kind, ...revision }],
      ...(input.assetResults ?? []),
      ...(input.commentResults ?? []),
    ],
    () => {
      queries += 1;
    },
  );
  const app = new Hono();
  app.route(
    "/",
    createLibraryApp({
      database: { db: rows } as unknown as Database,
      auth: sessionAuth,
      storage: storageWith(input.bytes),
    }),
  );
  const response = await app.request(`/artifact/${ARTIFACT_ID}${input.query ?? ""}`, {
    headers: { cookie: "session=one" },
  });
  return {
    status: response.status,
    body: await response.text(),
    csp: response.headers.get("content-security-policy"),
    contentType: response.headers.get("content-type"),
    queries,
  };
};

const shareView = async (input: {
  bytes: Uint8Array;
  kind: string;
  query?: string;
  showComments?: boolean;
  assetResults?: readonly unknown[];
}): Promise<Probe> => {
  const revision = revisionOf(input.bytes);
  let queries = 0;
  const rows = queryBuilder(
    [
      [
        {
          artifactId: ARTIFACT_ID,
          showComments: input.showComments ?? false,
          kind: input.kind,
          ...revision,
        },
      ],
      ...(input.assetResults ?? []),
      [],
    ],
    () => {
      queries += 1;
    },
  );
  const app = new Hono();
  app.route(
    "/",
    createShareViewerApp({ database: { db: rows } as unknown as Database, storage: storageWith(input.bytes) }),
  );
  const response = await app.request(`/share/${SHARE_TOKEN}${input.query ?? ""}`);
  return {
    status: response.status,
    body: await response.text(),
    csp: response.headers.get("content-security-policy"),
    contentType: response.headers.get("content-type"),
    queries,
  };
};

const unescapeAttribute = (value: string): string =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

const srcdocOf = (page: string): string => {
  const attribute = /srcdoc="([^"]*)"/.exec(page);
  assert.ok(attribute !== null, "the served page carries a srcdoc frame");
  return unescapeAttribute(attribute[1] ?? "");
};

const frameTag = (html: string, id: string): string =>
  html.match(new RegExp(`<section[^>]*id="frame-${id}"[^>]*>`))?.[0] ?? "";

test("the owner viewer of a canvas serves the rendered scene inside the one sandboxed frame", async () => {
  const reply = await ownerView({ bytes: SCENE_BYTES, kind: "canvas" });
  assert.equal(reply.status, 200);
  assert.equal(reply.csp, SCENE_PAGE_POLICY, "the canvas page adds one image source and keeps the rest");
  assert.equal(reply.contentType, "text/html; charset=UTF-8");
  assert.equal((reply.body.match(/<iframe /g) ?? []).length, 1, "exactly one frame");
  assert.ok(reply.body.includes(`sandbox="${SANDBOX}"`), "the frame keeps its opaque origin");
  assert.equal(reply.body.includes("allow-same-origin"), false);
  assert.equal(srcdocOf(reply.body), servedScene(), "the frame carries the rendered document");
  assert.ok(srcdocOf(reply.body).includes('id="frame-home"'), "the wrapper is the same wrapper");
  assert.equal(reply.body.includes("/api/artifacts/" + ARTIFACT_ID + '"'), true, "and the same refresh poller");
});

test("the canvas document arrives as markup, never as the stored JSON", async () => {
  const reply = await ownerView({ bytes: SCENE_BYTES, kind: "canvas" });
  const document = srcdocOf(reply.body);
  assert.ok(document.includes('data-frame-id="home"'), document);
  assert.ok(document.includes('data-frame-id="checkout"'), document);
  assert.ok(document.includes('data-target="home"'), "the frame index ships the navigation");
  assert.ok(document.includes('data-target="checkout"'));
  assert.ok(document.includes('data-node-id="pay-button"'), "the nodes are rendered, not echoed");
  for (const dumped of [SCENE_TEXT, '"formatVersion"', '"frames":[', '{"id":"home"'])
    assert.equal(document.includes(dumped), false, `the stored JSON is not dumped as text: ${dumped}`);
});

test("?frame selects the initially visible frame server-side", async () => {
  const reply = await ownerView({ bytes: SCENE_BYTES, kind: "canvas", query: "?frame=checkout" });
  assert.equal(reply.status, 200);
  const document = srcdocOf(reply.body);
  assert.equal(document, servedScene("checkout"));
  assert.ok(frameTag(document, "home").includes("hidden"), "the first frame is hidden");
  assert.equal(frameTag(document, "checkout").includes("hidden"), false);
  assert.ok(document.includes('data-target="checkout" aria-current="true"'), "the index follows the deep link");
});

test("a canvas with an unknown ?frame still renders, opening the first frame", async () => {
  const reply = await ownerView({ bytes: SCENE_BYTES, kind: "canvas", query: "?frame=missing" });
  assert.equal(reply.status, 200);
  const document = srcdocOf(reply.body);
  assert.equal(document, servedScene(), "the unknown id falls back to the first frame");
  assert.equal(frameTag(document, "home").includes("hidden"), false);
  assert.ok(frameTag(document, "checkout").includes("hidden"));
  assert.equal((document.match(/data-target="/g) ?? []).length, 2, "both frames stay reachable");
});

test("the public link serves the same canvas document with the same navigation", async () => {
  const owner = await ownerView({ bytes: SCENE_BYTES, kind: "canvas", query: "?frame=checkout" });
  const shared = await shareView({ bytes: SCENE_BYTES, kind: "canvas", query: "?frame=checkout", showComments: true });
  assert.equal(shared.status, 200);
  assert.equal(shared.csp, SCENE_PAGE_POLICY);
  assert.equal(srcdocOf(shared.body), srcdocOf(owner.body), "one renderer, one document");
  const document = srcdocOf(shared.body);
  assert.ok(document.includes('data-frame-id="checkout"'), "the public frame is rendered markup");
  assert.ok(document.includes('data-target="checkout" aria-current="true"'), "the public index follows the same link");
  assert.equal(document.includes('"formatVersion"'), false, "and never the stored JSON as text");
  assert.ok(shared.body.includes("/share/" + SHARE_TOKEN + "?meta=1"), "the public poller is the share one");
  assert.equal(shared.body.includes('<a class="vbar-cell vbar-back"'), false, "no owner chrome on the public page");
});

test("a canvas reads its threads for the pins and still mounts no comments panel or bridge", async () => {
  const owner = await ownerView({ bytes: SCENE_BYTES, kind: "canvas" });
  assert.equal(owner.queries, 2, "the artifact row and one comment access read, nothing else");
  assert.equal(owner.body.includes('id="viewer-comments"'), false, "no margin");
  assert.equal(owner.body.includes("viewer-comments-data"), false, "no comment data island");
  assert.equal(owner.body.includes("data-artiflow-bridge"), false, "no bridge inside the frame");
  assert.equal(srcdocOf(owner.body).includes('class="scene-pin"'), false, "no threads means no pins");

  const shared = await shareView({ bytes: SCENE_BYTES, kind: "canvas", showComments: true });
  assert.equal(shared.queries, 1, "the public canvas never lists comments, even with the option on");
  assert.equal(shared.body.includes('id="viewer-comments"'), false);
  assert.equal(shared.body.includes("viewer-comments-data"), false);
  assert.equal(shared.body.includes("data-artiflow-bridge"), false);
});

test("a deck renders as slides with the counter and no strip, on both viewers", async () => {
  const deck = renderSceneDocument(
    scene,
    undefined,
    { origin: "http://localhost", artifactId: ARTIFACT_ID, digests: new Set() },
    [],
    "deck",
  );
  const owner = await ownerView({ bytes: SCENE_BYTES, kind: "deck" });
  assert.equal(owner.status, 200);
  assert.equal(owner.csp, SCENE_PAGE_POLICY, "the deck keeps the canvas policy unchanged");
  assert.ok(owner.body.includes(`sandbox="${SANDBOX}"`), "the deck keeps the same sandbox");
  assert.equal(srcdocOf(owner.body), deck, "the viewer hands the kind to the renderer");
  assert.ok(srcdocOf(owner.body).includes('class="scene-counter"'), "the counter is visible");
  assert.ok(/<nav class="scene-index"[^>]*hidden/.test(srcdocOf(owner.body)), "no index strip by default");
  const shared = await shareView({ bytes: SCENE_BYTES, kind: "deck" });
  assert.equal(shared.status, 200);
  assert.equal(srcdocOf(shared.body), deck, "the public link presents the same deck");
});

test("a deck's ?frame deep link picks the slide and its counter", async () => {
  const reply = await ownerView({ bytes: SCENE_BYTES, kind: "deck", query: "?frame=checkout" });
  assert.equal(reply.status, 200);
  const document = srcdocOf(reply.body);
  assert.equal(
    document,
    renderSceneDocument(
      scene,
      "checkout",
      { origin: "http://localhost", artifactId: ARTIFACT_ID, digests: new Set() },
      [],
      "deck",
    ),
  );
  assert.ok(document.includes('aria-live="polite">2 / 2</p>'), document);
  assert.ok(frameTag(document, "home").includes("hidden"));
  assert.equal(frameTag(document, "checkout").includes("hidden"), false);
});

test("the canvas path still passes its kind and keeps the index strip and no counter", async () => {
  const reply = await ownerView({ bytes: SCENE_BYTES, kind: "canvas" });
  const document = srcdocOf(reply.body);
  assert.equal(document, servedScene(), "the canvas document is the same document it served before the deck");
  assert.equal(document.includes('class="scene-counter"'), false);
  assert.equal(/<nav class="scene-index"[^>]*hidden/.test(document), false, "the canvas index strip stays visible");
});

test("a canvas whose stored bytes are not a scene is refused instead of rendered blank", async () => {
  const owner = await ownerView({ bytes: new TextEncoder().encode("not a scene"), kind: "canvas" });
  assert.deepEqual([owner.status, owner.body], [500, JSON.stringify({ error: "artifact_unavailable" })]);
  const shared = await shareView({ bytes: new TextEncoder().encode("not a scene"), kind: "canvas" });
  assert.deepEqual([shared.status, shared.body], [404, NOT_FOUND_PAGE]);
});

test("PRESERVE: an html artifact keeps its exact page bytes", async () => {
  const bytes = new TextEncoder().encode(HTML_SOURCE);
  const revision = revisionOf(bytes);
  const reply = await ownerView({ bytes, kind: "html", commentResults: [[{ access: "owner" }], []] });
  assert.equal(reply.status, 200);
  assert.equal(reply.csp, VIEWER_CSP);
  assert.equal(reply.body.includes('id="scene-stage"'), false, "no canvas chrome on an html page");
  assert.equal(srcdocOf(reply.body).startsWith(HTML_SOURCE), true, "the stored bytes still reach the frame");
  const config = viewerCommentsConfig({
    artifactId: ARTIFACT_ID,
    mode: "element",
    bridgeNonce: bridgeNonce(ARTIFACT_ID, revision.sha256),
    source: "",
    rows: [],
    viewerId: VIEWER_ID,
    canComment: true,
    canDeleteOwn: true,
    endpoints: {
      comments: `/api/artifacts/${ARTIFACT_ID}/comments`,
      resolve: `/api/artifacts/${ARTIFACT_ID}/comments`,
      deleteComment: `/api/artifacts/${ARTIFACT_ID}/comments`,
      list: `/artifact/${ARTIFACT_ID}/comments`,
    },
  });
  const nonce = bridgeNonce(ARTIFACT_ID, revision.sha256);
  assert.equal(
    reply.body,
    wrapperPage(
      escapeAttribute(HTML_SOURCE),
      "/",
      { title: TITLE, version: revision.revisionNumber },
      false,
      {
        metaUrl: `/api/artifacts/${ARTIFACT_ID}`,
        srcdocUrl: `/artifact/${ARTIFACT_ID}`,
        revisionNumber: revision.revisionNumber,
        sha256: revision.sha256,
      },
      {
        nonce,
        bridge: htmlBridgeScript({ nonce, pins: bridgePins(config.threads) }),
        config,
        assets: viewerCommentsAssets(),
      },
    ),
    "the html path is byte-identical to the page it served before the scene branch existed",
  );
});

test("PRESERVE: a markdown artifact keeps its exact page bytes", async () => {
  const bytes = new TextEncoder().encode(MARKDOWN_SOURCE);
  const revision = revisionOf(bytes);
  const reply = await ownerView({ bytes, kind: "markdown", commentResults: [[{ access: "owner" }], []] });
  assert.equal(reply.status, 200);
  assert.equal(/<iframe/.test(reply.body), false, "the markdown viewer keeps rendering inline");
  const config = viewerCommentsConfig({
    artifactId: ARTIFACT_ID,
    source: MARKDOWN_SOURCE,
    rows: [],
    viewerId: VIEWER_ID,
    canComment: true,
    canDeleteOwn: true,
    endpoints: {
      comments: `/api/artifacts/${ARTIFACT_ID}/comments`,
      resolve: `/api/artifacts/${ARTIFACT_ID}/comments`,
      deleteComment: `/api/artifacts/${ARTIFACT_ID}/comments`,
      list: `/artifact/${ARTIFACT_ID}/comments`,
    },
  });
  assert.equal(
    reply.body,
    markdownViewerPage(
      renderMarkdownFragment(MARKDOWN_SOURCE),
      "/",
      { title: TITLE, version: revision.revisionNumber },
      false,
      {
        metaUrl: `/api/artifacts/${ARTIFACT_ID}`,
        revisionNumber: revision.revisionNumber,
        sha256: revision.sha256,
      },
      { config, assets: viewerCommentsAssets() },
    ),
    "the markdown path is byte-identical to the page it served before the scene branch existed",
  );
});

test("the owner canvas page draws one pin per scene-anchored thread at the node-relative point", async () => {
  const reply = await ownerView({
    bytes: SCENE_BYTES,
    kind: "canvas",
    commentResults: [[{ access: "owner" }], [boardThread]],
  });
  assert.equal(reply.status, 200);
  const document = srcdocOf(reply.body);
  assert.equal((document.match(/class="scene-pin"/g) ?? []).length, 1, "exactly one pin");
  assert.ok(
    document.includes(
      '<span class="scene-pin" tabindex="0" data-thread-id="comment-pin" data-node-id="home-card" aria-label="Comment thread 1" style="left:10px;top:15px">1</span>',
    ),
    "40*0.25 at x 0 and 20*0.25 at y 10",
  );
  assert.equal(reply.body.includes("viewer-comments-data"), false, "the pin ships inside the document");
  assert.equal(reply.body.includes("data-artiflow-bridge"), false, "and never a bridge");
});

test("an orphaned canvas thread draws no pin and is named in the document", async () => {
  const reply = await ownerView({
    bytes: SCENE_BYTES,
    kind: "canvas",
    commentResults: [
      [{ access: "owner" }],
      [{ ...boardThread, anchor: { ...boardThread.anchor, nodeId: "home-gone" } }],
    ],
  });
  assert.equal(reply.status, 200);
  const document = srcdocOf(reply.body);
  assert.equal((document.match(/class="scene-pin"/g) ?? []).length, 0, "no pin at a stale position");
  assert.ok(document.includes("Thread 1 points at something that no longer exists in this canvas."), document);
});

test("a canvas still renders when the comment store cannot be read", async () => {
  const reply = await ownerView({ bytes: SCENE_BYTES, kind: "canvas" });
  assert.equal(reply.status, 200);
  const document = srcdocOf(reply.body);
  assert.equal(document.includes('class="scene-pin"'), false, "no pins without threads");
  assert.equal(document.includes('class="scene-orphans"'), false, "and no list either");
  assert.ok(document.includes('id="frame-home"'), "the scene itself still renders");
});

test("the canvas page allows images from exactly this instance's origin", async () => {
  const reply = await ownerView({
    bytes: imageSceneBytes(),
    kind: "canvas",
    assetResults: [[{ sha256: IMAGE_DIGEST }]],
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.csp, SCENE_PAGE_POLICY, "one image source, every other directive unchanged");
  assert.equal((reply.csp?.match(/img-src/g) ?? []).length, 1);
  for (const widened of ["img-src *", "data:", "blob:", "https:"]) assert.equal(reply.csp?.includes(widened), false);
  assert.equal(
    metaPolicyOf(srcdocOf(reply.body)),
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src http://localhost; base-uri 'none'; form-action 'none'",
    "the rendered document carries the same single image source",
  );
  assert.equal(reply.queries, 3, "the reference table is read once, beside the artifact and the comment access row");
});

test("PRESERVE: html and markdown keep their exact policy strings", async () => {
  assert.equal(
    VIEWER_CSP,
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; connect-src 'self'",
    "the viewer policy is byte for byte the one it was before the canvas gained images",
  );
  const html = await ownerView({
    bytes: new TextEncoder().encode(HTML_SOURCE),
    kind: "html",
    commentResults: [[{ access: "owner" }], []],
  });
  assert.equal(html.csp, VIEWER_CSP, "the html page keeps the viewer policy");
  const markdown = await ownerView({
    bytes: new TextEncoder().encode(MARKDOWN_SOURCE),
    kind: "markdown",
    commentResults: [[{ access: "owner" }], []],
  });
  assert.equal(markdown.csp, VIEWER_CSP, "the markdown page keeps the viewer policy");
});

test("the owner viewer emits the delivery url for a referenced asset and no share token", async () => {
  const reply = await ownerView({
    bytes: imageSceneBytes(),
    kind: "canvas",
    assetResults: [[{ sha256: IMAGE_DIGEST }]],
  });
  const document = srcdocOf(reply.body);
  const tags = imageTagsOf(document);
  assert.equal(tags.length, 1, document);
  const tag = tags[0] ?? "";
  assert.equal(
    tag,
    `<img class="node node-image node-image-asset" data-node-id="shot" alt="shot" src="http://localhost/artifact/${ARTIFACT_ID}/asset/${IMAGE_DIGEST}" style="left:10px;top:20px;width:200px;height:120px;object-fit:contain">`,
    "one image, at the delivery route, in the node's box",
  );
  assert.equal(document.includes("token="), false, "the owner page never embeds a link's token");
  assert.equal(/<[a-z][^>]*\son[a-z]+\s*=/i.test(document), false, "the image carries no event handler");
});

test("the public link renders images the same token can fetch", async () => {
  const shared = await shareView({
    bytes: imageSceneBytes(),
    kind: "canvas",
    assetResults: [[{ sha256: IMAGE_DIGEST }]],
  });
  assert.equal(shared.status, 200);
  assert.equal(shared.csp, SCENE_PAGE_POLICY);
  const document = srcdocOf(shared.body);
  const tags = imageTagsOf(document);
  assert.equal(tags.length, 1, document);
  assert.ok(
    (tags[0] ?? "").includes(
      `src="http://localhost/artifact/${ARTIFACT_ID}/asset/${IMAGE_DIGEST}?token=${SHARE_TOKEN}"`,
    ),
    tags[0] ?? "",
  );
});

test("an image the artifact does not reference stays a labelled placeholder on both viewers", async () => {
  const owner = await ownerView({ bytes: imageSceneBytes(), kind: "canvas", assetResults: [[]] });
  const shared = await shareView({ bytes: imageSceneBytes(), kind: "canvas", assetResults: [[]] });
  for (const document of [srcdocOf(owner.body), srcdocOf(shared.body)]) {
    assert.deepEqual(imageTagsOf(document), [], "no bytes are fetched for an unreferenced digest");
    assert.ok(document.includes(`<code class="node-image-id">${IMAGE_DIGEST}</code>`), "the placeholder named it");
    assert.ok(document.includes('class="node node-image"'));
  }
});

test("an asset id that is not a digest degrades to the placeholder, never to a url", async () => {
  const hostile = `"><script>alert(1)</script>`;
  const reply = await ownerView({
    bytes: imageSceneBytes(hostile),
    kind: "canvas",
    assetResults: [[{ sha256: hostile }]],
  });
  const document = srcdocOf(reply.body);
  assert.deepEqual(imageTagsOf(document), []);
  assert.ok(document.includes('class="node node-image"'), document);
  assert.equal(document.includes("<script>alert(1)</script>"), false);
});

test("alt text taken from the scene is escaped on the served page", async () => {
  const hostile = `"><script>alert(1)</script>`;
  const reply = await ownerView({
    bytes: imageSceneBytes(IMAGE_DIGEST, hostile),
    kind: "canvas",
    assetResults: [[{ sha256: IMAGE_DIGEST }]],
  });
  const document = srcdocOf(reply.body);
  const tag = imageTagsOf(document)[0] ?? "";
  assert.ok(tag.includes('alt="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'), tag);
  assert.equal(document.includes(hostile), false);
});
