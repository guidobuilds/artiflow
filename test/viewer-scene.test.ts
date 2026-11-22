import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Hono } from "hono";

import { SCENE_FORMAT_VERSION, type RectNode, type Scene, type SceneFrame } from "@artiflow/domain/scene";
import { canonicalScene } from "@artiflow/domain/scene";

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

const queryBuilder = (results: readonly unknown[], onRead: () => void) => {
  let next = 0;
  const query = {
    select: () => query,
    from: () => query,
    leftJoin: () => query,
    innerJoin: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    $dynamic: () => query,
    then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown): Promise<unknown> => {
      onRead();
      return Promise.resolve(results[next++]).then(onFulfilled, onRejected);
    },
  };
  return query;
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

type Revision = { storageKey: string; sha256: string; revisionNumber: number; sizeBytes: number };

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
}): Promise<Probe> => {
  const revision = revisionOf(input.bytes);
  let queries = 0;
  const rows = queryBuilder(
    [[{ id: ARTIFACT_ID, title: TITLE, kind: input.kind, ...revision }], ...(input.commentResults ?? [])],
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
  assert.equal(reply.csp, VIEWER_CSP, "the canvas inherits the viewer policy unchanged");
  assert.equal(reply.contentType, "text/html; charset=UTF-8");
  assert.equal((reply.body.match(/<iframe /g) ?? []).length, 1, "exactly one frame");
  assert.ok(reply.body.includes(`sandbox="${SANDBOX}"`), "the frame keeps its opaque origin");
  assert.equal(reply.body.includes("allow-same-origin"), false);
  assert.equal(srcdocOf(reply.body), renderSceneDocument(scene), "the frame carries the rendered document");
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
  assert.equal(document, renderSceneDocument(scene, "checkout"));
  assert.ok(frameTag(document, "home").includes("hidden"), "the first frame is hidden");
  assert.equal(frameTag(document, "checkout").includes("hidden"), false);
  assert.ok(document.includes('data-target="checkout" aria-current="true"'), "the index follows the deep link");
});

test("a canvas with an unknown ?frame still renders, opening the first frame", async () => {
  const reply = await ownerView({ bytes: SCENE_BYTES, kind: "canvas", query: "?frame=missing" });
  assert.equal(reply.status, 200);
  const document = srcdocOf(reply.body);
  assert.equal(document, renderSceneDocument(scene), "the unknown id falls back to the first frame");
  assert.equal(frameTag(document, "home").includes("hidden"), false);
  assert.ok(frameTag(document, "checkout").includes("hidden"));
  assert.equal((document.match(/data-target="/g) ?? []).length, 2, "both frames stay reachable");
});

test("the public link serves the same canvas document with the same navigation", async () => {
  const owner = await ownerView({ bytes: SCENE_BYTES, kind: "canvas", query: "?frame=checkout" });
  const shared = await shareView({ bytes: SCENE_BYTES, kind: "canvas", query: "?frame=checkout", showComments: true });
  assert.equal(shared.status, 200);
  assert.equal(shared.csp, VIEWER_CSP);
  assert.equal(srcdocOf(shared.body), srcdocOf(owner.body), "one renderer, one document");
  const document = srcdocOf(shared.body);
  assert.ok(document.includes('data-frame-id="checkout"'), "the public frame is rendered markup");
  assert.ok(document.includes('data-target="checkout" aria-current="true"'), "the public index follows the same link");
  assert.equal(document.includes('"formatVersion"'), false, "and never the stored JSON as text");
  assert.ok(shared.body.includes("/share/" + SHARE_TOKEN + "?meta=1"), "the public poller is the share one");
  assert.equal(shared.body.includes('<a class="vbar-cell vbar-back"'), false, "no owner chrome on the public page");
});

test("a canvas mounts no comments panel on either viewer, whatever the link option says", async () => {
  const owner = await ownerView({ bytes: SCENE_BYTES, kind: "canvas" });
  assert.equal(owner.queries, 1, "the canvas viewer never reads the comment store");
  assert.equal(owner.body.includes('id="viewer-comments"'), false, "no margin");
  assert.equal(owner.body.includes("viewer-comments-data"), false, "no comment data island");
  assert.equal(owner.body.includes("data-artiflow-bridge"), false, "no bridge inside the frame");

  const shared = await shareView({ bytes: SCENE_BYTES, kind: "canvas", showComments: true });
  assert.equal(shared.queries, 1, "the public canvas never lists comments, even with the option on");
  assert.equal(shared.body.includes('id="viewer-comments"'), false);
  assert.equal(shared.body.includes("viewer-comments-data"), false);
  assert.equal(shared.body.includes("data-artiflow-bridge"), false);
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
