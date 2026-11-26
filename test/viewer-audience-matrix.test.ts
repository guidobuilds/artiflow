import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Hono } from "hono";

import { ARTIFACT_KINDS, rendersScene, type ArtifactKind } from "@artiflow/domain/kinds";
import { SCENE_FORMAT_VERSION, canonicalScene, type Scene } from "@artiflow/domain/scene";

import {
  artifactAssets,
  artifactComments,
  artifactPublicLinks,
  artifactRevisions,
  artifactShares,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import type { AppDb, Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { newRevisionStorageKey } from "../apps/api/src/adapters/storage/s3.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { createLibraryApp, type LibraryOptions } from "../apps/api/src/routes/library.ts";
import { createShareViewerApp } from "../apps/api/src/routes/sharing.ts";
import { sceneCsp, VIEWER_CSP } from "../apps/api/src/viewer/html.ts";
import type { ViewerActions, ViewerAudience, ViewerChrome, ViewerModel } from "../apps/api/src/viewer/model.ts";
import { prepareViewer, type ViewerRequest } from "../apps/api/src/viewer/prepare.ts";

const ARTIFACT_ID = "artifact-one";
const OWNER_ID = "user-owner";
const VIEWER_ID = "user-viewer";
const TOKEN = "a".repeat(43);
const REVISION_ID = "55555555-5555-4555-8555-555555555555";
const REVISION_NUMBER = 3;
const TITLE = "Pricing artifact";
const MARKDOWN_SOURCE = "# Pricing\n\nThe second paragraph target text.\n";
const HTML_SOURCE = `<!doctype html><html><body><h1>Pinned</h1><p>body</p></body></html>`;
const ORIGIN = "http://localhost";
const SCENE: Scene = {
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    {
      id: "home",
      name: "Home",
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      nodes: [{ id: "n1", type: "rect", x: 10, y: 10, w: 40, h: 20, fill: "#ffffff" }],
    },
  ],
};

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const bytesOf = (kind: ArtifactKind): Uint8Array =>
  new TextEncoder().encode(
    kind === "html" ? HTML_SOURCE : kind === "markdown" ? MARKDOWN_SOURCE : canonicalScene(SCENE),
  );

const anchorOf = (kind: ArtifactKind): unknown =>
  kind === "html"
    ? { kind: "element", selector: "#hero", textHint: "Hero", point: { x: 0.5, y: 0.5 }, viewportWidth: 1200 }
    : kind === "markdown"
      ? { kind: "text-range", startLine: 3, startCol: 22, endLine: 3, endCol: 33, quotedText: "target text" }
      : kind === "canvas"
        ? { kind: "board-point", boardId: "home", nodeId: "n1", x: 0.5, y: 0.5 }
        : { kind: "slide-point", slideId: "home", nodeId: "n1", x: 0.5, y: 0.5 };

const commentOf = (kind: ArtifactKind) => ({
  id: "comment-one",
  artifactId: ARTIFACT_ID,
  authorId: OWNER_ID,
  authorName: "Owner",
  authorImage: null,
  parentId: null,
  anchor: anchorOf(kind),
  body: "please check the wording",
  resolvedAt: null,
  resolvedBy: null,
  revisionId: REVISION_ID,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

type Seat = "owner" | "reader" | "commenter" | "editor" | "bearer" | "public-on" | "public-off" | "embed";
const SEATS: readonly Seat[] = ["owner", "reader", "commenter", "editor", "bearer", "public-on", "public-off", "embed"];

const accessOf = (seat: Seat): string | null => {
  if (seat === "public-on" || seat === "public-off") return null;
  if (seat === "owner" || seat === "embed") return "owner";
  if (seat === "bearer") return "commenter";
  return seat;
};
const ownsArtifact = (seat: Seat): boolean => seat === "owner" || seat === "embed";
const isPublic = (seat: Seat): boolean => seat === "public-on" || seat === "public-off";
const showsComments = (seat: Seat): boolean => seat === "public-on";

type Rights = { canComment: boolean; canResolve: boolean; threadCanDelete: boolean; threadCanResolve: boolean };
const RIGHTS: Record<Seat, Rights> = {
  owner: { canComment: true, canResolve: true, threadCanDelete: true, threadCanResolve: true },
  reader: { canComment: false, canResolve: false, threadCanDelete: false, threadCanResolve: false },
  commenter: { canComment: true, canResolve: true, threadCanDelete: false, threadCanResolve: true },
  editor: { canComment: true, canResolve: true, threadCanDelete: false, threadCanResolve: true },
  bearer: { canComment: true, canResolve: true, threadCanDelete: false, threadCanResolve: true },
  "public-on": { canComment: false, canResolve: false, threadCanDelete: false, threadCanResolve: false },
  "public-off": { canComment: false, canResolve: false, threadCanDelete: false, threadCanResolve: false },
  embed: { canComment: true, canResolve: true, threadCanDelete: true, threadCanResolve: true },
};
const CHROME: Record<Seat, ViewerChrome> = {
  owner: "full",
  reader: "full",
  commenter: "full",
  editor: "full",
  bearer: "full",
  "public-on": "anonymous",
  "public-off": "anonymous",
  embed: "none",
};

const actionsOf = (seat: Seat): ViewerActions =>
  isPublic(seat)
    ? { comment: false, resolve: false, deleteOwn: false, deleteAny: false }
    : {
        comment: RIGHTS[seat].canComment,
        resolve: RIGHTS[seat].canResolve,
        deleteOwn: true,
        deleteAny: ownsArtifact(seat),
      };

const audienceOf = (seat: Seat): ViewerAudience =>
  isPublic(seat)
    ? { kind: "public", showComments: showsComments(seat) }
    : seat === "bearer"
      ? { kind: "bearer", viewerId: VIEWER_ID }
      : { kind: "session", viewerId: VIEWER_ID, access: accessOf(seat) ?? "owner" };

const planKindOf = (seat: Seat, kind: ArtifactKind): "page" | "document" | "none" =>
  rendersScene(kind)
    ? isPublic(seat)
      ? "none"
      : "document"
    : isPublic(seat) && !showsComments(seat)
      ? "none"
      : "page";

const metaUrlOf = (seat: Seat): string => (isPublic(seat) ? `/share/${TOKEN}?meta=1` : `/api/artifacts/${ARTIFACT_ID}`);

const commentsFlagOf = (seat: Seat, kind: ArtifactKind): boolean =>
  isPublic(seat) && showsComments(seat) && !rendersScene(kind);

type Row = {
  id: string;
  artifactId: string;
  ownerId: string;
  title: string;
  kind: string;
  revisionId: string;
  revisionNumber: number;
  sha256: string;
  sizeBytes: number;
  storageKey: string;
  showComments: boolean;
};

const rowOf = (seat: Seat, kind: ArtifactKind): Row => {
  const bytes = bytesOf(kind);
  return {
    id: ARTIFACT_ID,
    artifactId: ARTIFACT_ID,
    ownerId: ownsArtifact(seat) ? VIEWER_ID : OWNER_ID,
    title: TITLE,
    kind,
    revisionId: REVISION_ID,
    revisionNumber: REVISION_NUMBER,
    sha256: digestOf(bytes),
    sizeBytes: bytes.length,
    storageKey: newRevisionStorageKey(),
    showComments: showsComments(seat),
  };
};

type Query = Promise<unknown[]> & {
  from: (table: unknown) => Query;
  leftJoin: (table: unknown) => Query;
  innerJoin: (table: unknown) => Query;
  where: () => Query;
  orderBy: () => Query;
  limit: () => Query;
  for: () => Query;
  $dynamic: () => Query;
};

const fakeDb = (row: Row, access: string | null, comments: readonly unknown[], onQuery: () => void): AppDb => {
  const rowsFor = (tables: ReadonlySet<unknown>): unknown[] => {
    if (tables.has(artifactPublicLinks)) return [{ ...row }];
    if (tables.has(artifactShares))
      return access === null ? [] : [{ id: row.id, ownerId: row.ownerId, kind: row.kind, deletedAt: null, access }];
    if (tables.has(artifactComments)) return [...comments];
    if (tables.has(artifactAssets)) return [];
    if (tables.has(artifactRevisions)) return [{ ...row }];
    return [];
  };
  const select = (): Query => {
    const tables = new Set<unknown>();
    const chain = (): Query => query;
    const query: Query = Object.assign(
      Promise.resolve().then(() => {
        onQuery();
        return rowsFor(tables);
      }),
      {
        from: (table: unknown) => {
          tables.add(table);
          return chain();
        },
        leftJoin: (table: unknown) => {
          tables.add(table);
          return chain();
        },
        innerJoin: (table: unknown) => {
          tables.add(table);
          return chain();
        },
        where: chain,
        orderBy: chain,
        limit: chain,
        for: chain,
        $dynamic: chain,
      },
    ) as unknown as Query;
    return query;
  };
  return { select } as unknown as AppDb;
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

const SESSION_AUTH = {
  api: { getSession: async () => ({ user: { id: VIEWER_ID } }) },
} as unknown as LibraryOptions["auth"];

const BEARER: NonNullable<LibraryOptions["bearerVerifier"]> = async (request, handler) =>
  handler(request, { userId: VIEWER_ID, scopes: ["artifacts:read"] });

type Cell = { status: number; page: string; headers: Headers; model: ViewerModel; queries: number };

const requestOf = (seat: Seat): ViewerRequest =>
  isPublic(seat)
    ? { kind: "public", token: TOKEN, showComments: showsComments(seat) }
    : seat === "bearer"
      ? { kind: "bearer", viewerId: VIEWER_ID }
      : { kind: "session", viewerId: VIEWER_ID };

const cellOf = async (seat: Seat, kind: ArtifactKind, grant: string | null = accessOf(seat)): Promise<Cell> => {
  const row = rowOf(seat, kind);
  const comments = [commentOf(kind)];
  const bytes = bytesOf(kind);
  let queries = 0;
  const database = { db: fakeDb(row, grant, comments, () => (queries += 1)) } as unknown as Database;
  const app = new Hono();
  if (isPublic(seat)) app.route("/", createShareViewerApp({ database, storage: storageWith(bytes) }));
  else
    app.route(
      "/",
      createLibraryApp({
        database,
        storage: storageWith(bytes),
        auth: SESSION_AUTH,
        ...(seat === "bearer" ? { bearerVerifier: BEARER } : {}),
      }),
    );
  const response = isPublic(seat)
    ? await app.request(`/share/${TOKEN}`)
    : await app.request(`/artifact/${ARTIFACT_ID}${seat === "embed" ? "?embed=1" : ""}`, {
        headers: seat === "bearer" ? { authorization: "Bearer one" } : { cookie: "session=one" },
      });
  const page = await response.text();
  const model = await prepareViewer({
    db: fakeDb(row, grant, comments, () => undefined),
    artifact: row,
    request: requestOf(seat),
    embed: seat === "embed",
    source: kind === "markdown" ? MARKDOWN_SOURCE : null,
    ...(rendersScene(kind) ? { publishedScene: async () => SCENE } : {}),
  });
  return { status: response.status, page, headers: response.headers, model, queries };
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
  return attribute === null ? "" : unescapeAttribute(attribute[1] ?? "");
};

const islandOf = (page: string): Record<string, unknown> | null => {
  const raw = /<script type="application\/json" id="viewer-comments-data">([\s\S]*?)<\/script>/.exec(page)?.[1];
  return raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
};

const barOf = (page: string): string | null => /<header class="vbar">([\s\S]*?)<\/header>/.exec(page)?.[1] ?? null;

const refreshFieldsOf = (page: string): Record<string, string> => {
  const raw = /const refresh = \{([^}]*)\};/.exec(page)?.[1] ?? "";
  const fields: Record<string, string> = {};
  for (const match of raw.matchAll(/(\w+):("[^"]*"|[^,]+)/g)) {
    const value = match[2] ?? "";
    fields[match[1] ?? ""] = value.startsWith('"') ? value.slice(1, -1) : value;
  }
  return fields;
};

const threadAt = (island: Record<string, unknown>): Record<string, unknown> => {
  const thread = ((island.threads ?? []) as Record<string, unknown>[])[0];
  assert.ok(thread !== undefined, "the island carries the stored thread");
  return thread;
};

const keysOf = (value: object): string[] => Object.keys(value).sort();

test("no response carries the owner id outside the thread it authored", async () => {
  for (const seat of SEATS) {
    for (const kind of ARTIFACT_KINDS) {
      const label = `${seat} x ${kind}`;
      const { page, headers, model } = await cellOf(seat, kind);
      for (const value of headers.values()) assert.equal(value.includes(OWNER_ID), false, `${label} header`);
      const island = JSON.stringify(islandOf(page) ?? {});
      assert.equal(
        page.split(OWNER_ID).length - 1,
        island.split(OWNER_ID).length - 1,
        `${label} the id reaches the page only through the island`,
      );
      assert.equal(
        island.split(OWNER_ID).length - 1,
        planKindOf(seat, kind) === "page" ? 1 : 0,
        `${label} the island carries the author it read, and nothing else`,
      );
      assert.equal(
        model.comments.kind === "none" || model.comments.config.threads[0]?.author.id === OWNER_ID,
        true,
        `${label} the plan keeps the author the store reported`,
      );
    }
  }
});

test("the page path reads the artifact, the access and the threads once; a public page reads no access", async () => {
  for (const seat of SEATS) {
    for (const kind of ARTIFACT_KINDS) {
      const expected = isPublic(seat) ? (showsComments(seat) && !rendersScene(kind) ? 2 : 1) : 3;
      assert.equal((await cellOf(seat, kind)).queries, expected, `${seat} x ${kind} query count`);
    }
  }
});

test("the owner seat resolves its access from the projected owner, not from the share table", async () => {
  for (const kind of ARTIFACT_KINDS) {
    const { model } = await cellOf("owner", kind, null);
    assert.deepEqual(
      model.audience,
      { kind: "session", viewerId: VIEWER_ID, access: "owner" },
      `${kind} owner without a share row`,
    );
    assert.deepEqual(model.actions, { comment: false, resolve: false, deleteOwn: true, deleteAny: false });
  }
  for (const seat of ["reader", "commenter", "editor"] as const) {
    const { model } = await cellOf(seat, "html", null);
    assert.deepEqual(
      model.audience,
      { kind: "session", viewerId: VIEWER_ID, access: null },
      `${seat} without a share row has no role to report`,
    );
  }
});

test("the audience matrix: each seat receives only what its grant prepares", async () => {
  for (const seat of SEATS) {
    for (const kind of ARTIFACT_KINDS) {
      const label = `${seat} x ${kind}`;
      const { model, page, status, headers } = await cellOf(seat, kind);
      assert.equal(status, 200, `${label} serves a page`);

      const digest = digestOf(bytesOf(kind));
      assert.equal(model.id, ARTIFACT_ID, `${label} names its artifact`);
      assert.equal(model.kind, kind, `${label} names its kind`);
      assert.deepEqual(
        model.revision,
        { id: isPublic(seat) ? null : REVISION_ID, number: REVISION_NUMBER, sha256: digest },
        `${label} names the revision of record, and no public page learns its id`,
      );
      assert.deepEqual(model.audience, audienceOf(seat), `${label} records who is reading`);
      assert.equal(model.chrome, CHROME[seat], `${label} decides the chrome`);
      assert.equal(model.embed, CHROME[seat] === "none", `${label} embed is the chrome that is none`);
      assert.deepEqual(
        model.actions,
        actionsOf(seat),
        `${label} records exactly the actions the grant allows and no management entitlement`,
      );
      assert.deepEqual(keysOf(model.actions), ["comment", "deleteAny", "deleteOwn", "resolve"]);
      assert.equal(model.title, model.chrome === "full" ? TITLE : null, `${label} carries a title only where it shows`);
      assert.equal(
        model.backHref,
        model.chrome === "full" ? "/" : undefined,
        `${label} back cell only on a session page`,
      );
      assert.deepEqual(
        model.meta,
        model.chrome === "full" ? { title: TITLE, version: REVISION_NUMBER } : undefined,
        `${label} bar metadata follows the chrome`,
      );

      assert.deepEqual(
        refreshFieldsOf(page),
        {
          metaUrl: metaUrlOf(seat),
          revisionNumber: String(REVISION_NUMBER),
          sha256: digest,
          ...(isPublic(seat) ? { comments: String(commentsFlagOf(seat, kind)) } : {}),
        },
        `${label} refresh plan`,
      );
      assert.deepEqual(model.refresh.plan, { kind: "reload", metaUrl: metaUrlOf(seat) }, `${label} model refresh plan`);
      assert.equal(model.refresh.revisionNumber, REVISION_NUMBER, `${label} refresh revision`);
      assert.equal(model.refresh.sha256, digest, `${label} refresh digest`);
      assert.equal(
        model.refresh.comments,
        isPublic(seat) ? commentsFlagOf(seat, kind) : undefined,
        `${label} refresh comment flag`,
      );

      assert.equal(
        headers.get("content-security-policy"),
        rendersScene(kind) ? sceneCsp(ORIGIN) : VIEWER_CSP,
        `${label} keeps the served policy byte for byte`,
      );
      assert.equal(headers.get("x-content-type-options"), "nosniff", `${label} nosniff`);
      assert.equal(headers.get("cache-control"), "no-store", `${label} no-store`);
      assert.equal(headers.get("x-robots-tag"), isPublic(seat) ? "noindex" : null, `${label} indexability`);

      const bar = barOf(page);
      if (model.chrome === "none") {
        assert.equal(bar, null, `${label} embed renders no bar`);
        assert.equal(page.includes('class="vbar-focus"'), false, `${label} embed renders no bar control`);
      } else {
        assert.notEqual(bar, null, `${label} renders the bar`);
        assert.equal(
          (bar?.match(/<button/g) ?? []).length,
          kind === "markdown" ? 0 : 1,
          `${label} the bar holds only the control its builder ships`,
        );
        assert.equal(bar?.includes("vbar-focus") ?? false, kind !== "markdown", `${label} focus control`);
        assert.equal(
          bar?.includes('class="vbar-cell vbar-back"') ?? false,
          model.chrome === "full",
          `${label} back cell`,
        );
        assert.equal(bar?.includes(`<b>${TITLE}</b>`) ?? false, model.chrome === "full", `${label} title cell`);
      }
      assert.equal(page.match(/<a /g)?.length ?? 0, model.chrome === "full" ? 1 : 0, `${label} links in the page`);
      assert.equal(
        page.includes(TITLE),
        model.chrome === "full",
        `${label} the title reaches the page only with the bar`,
      );

      const plan = model.comments;
      assert.equal(plan.kind, planKindOf(seat, kind), `${label} comment plan`);
      assert.equal(islandOf(page) !== null, plan.kind === "page", `${label} island only where the plan mounts it`);
      assert.equal(page.includes('id="viewer-comments"'), plan.kind === "page", `${label} margin host`);
      assert.equal(/<script type="module"/.test(page), plan.kind === "page", `${label} bundle`);
      if (kind === "html")
        assert.equal(page.includes("comments-available"), plan.kind === "page", `${label} shell class`);

      if (plan.kind === "page") {
        const island = islandOf(page) ?? {};
        assert.equal(island.canComment, RIGHTS[seat].canComment, `${label} island canComment`);
        assert.equal(island.canResolve, RIGHTS[seat].canResolve, `${label} island canResolve`);
        assert.equal(threadAt(island).canDelete, RIGHTS[seat].threadCanDelete, `${label} island thread canDelete`);
        assert.equal(threadAt(island).canResolve, RIGHTS[seat].threadCanResolve, `${label} island thread canResolve`);
        assert.equal(island.canComment, plan.config.canComment, `${label} island and model agree on canComment`);
        assert.equal(island.canResolve, plan.config.canResolve, `${label} island and model agree on canResolve`);
        assert.deepEqual(island.endpoints, plan.config.endpoints, `${label} island and model agree on endpoints`);
        assert.equal(
          keysOf(island).includes("revisionId"),
          !isPublic(seat),
          `${label} only a session viewer learns the revision id`,
        );
        assert.deepEqual(
          plan.config.endpoints,
          isPublic(seat)
            ? { comments: `/share/${TOKEN}/comments`, resolve: "", deleteComment: "" }
            : {
                comments: `/api/artifacts/${ARTIFACT_ID}/comments`,
                resolve: `/api/artifacts/${ARTIFACT_ID}/comments`,
                deleteComment: `/api/artifacts/${ARTIFACT_ID}/comments`,
                list: `/artifact/${ARTIFACT_ID}/comments`,
              },
          `${label} endpoints come from the audience`,
        );
      }
      if (plan.kind !== "none")
        assert.equal(plan.config.threads.length, 1, `${label} the stored thread reaches the plan`);

      if (kind === "markdown") assert.equal(/<iframe/.test(page), false, `${label} markdown mounts no frame`);
      else assert.equal((page.match(/<iframe /g) ?? []).length, 1, `${label} one frame`);
      if (kind !== "markdown") {
        assert.ok(page.includes('sandbox="allow-scripts"'), `${label} script sandbox`);
        assert.equal(/allow-same-origin|allow-forms|allow-popups|allow-top-navigation/.test(page), false);
      }
      if (kind === "html")
        assert.equal(
          srcdocOf(page).includes("data-artiflow-bridge"),
          plan.kind === "page",
          `${label} the bridge rides the payload only where the margin mounts`,
        );
      if (rendersScene(kind))
        assert.equal(
          (srcdocOf(page).match(/data-thread-id="comment-one"/g) ?? []).length,
          plan.kind === "document" ? 1 : 0,
          `${label} scene pins follow the document plan`,
        );
    }
  }
});

test("no seat ever receives a management entitlement or a management surface", async () => {
  for (const seat of SEATS) {
    for (const kind of ARTIFACT_KINDS) {
      const label = `${seat} x ${kind}`;
      const { model, page } = await cellOf(seat, kind);
      assert.equal("manage" in model.actions, false, `${label} carries no management decision`);
      assert.deepEqual(
        keysOf(model.actions),
        ["comment", "deleteAny", "deleteOwn", "resolve"],
        `${label} the whole action vocabulary`,
      );
      for (const term of [
        `/api/artifacts/${ARTIFACT_ID}/shares`,
        `/api/artifacts/${ARTIFACT_ID}/links`,
        "data-actions",
        "data-manage",
      ])
        assert.equal(page.includes(term), false, `${label} never ships ${term}`);
      assert.equal(/manage/i.test(page), false, `${label} never ships a management affordance`);
    }
  }
});

test("the audience vocabulary is the audience the routes pass through", async () => {
  assert.deepEqual(keysOf((await cellOf("bearer", "html")).model.audience), ["kind", "viewerId"]);
  assert.deepEqual(keysOf((await cellOf("reader", "html")).model.audience), ["access", "kind", "viewerId"]);
  assert.deepEqual(keysOf((await cellOf("public-on", "html")).model.audience), ["kind", "showComments"]);
});

const sourceOf = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const librarySource = sourceOf("../apps/api/src/routes/library.ts");
const sharingSource = sourceOf("../apps/api/src/routes/sharing.ts");
const prepareSource = sourceOf("../apps/api/src/viewer/prepare.ts");
const modelSource = sourceOf("../apps/api/src/viewer/model.ts");
const htmlSource = sourceOf("../apps/api/src/viewer/html.ts");

test("one authorized preparation: both routes call prepareViewer and decide none of it themselves", () => {
  for (const [name, source] of [
    ["library", librarySource],
    ["sharing", sharingSource],
  ] as const) {
    assert.match(source, /await prepareViewer\(\{/, `${name} prepares the page through the one entry point`);
    for (const derived of [
      /loadViewerComments[<(]/,
      /commentDocument\(/,
      /viewerCommentsConfig\(/,
      /bridgeNonce\(/,
      /bridgePins\(/,
      /htmlBridgeScript\(/,
      /refreshPlan\(/,
      /viewerCommentsAssets\(/,
      /bridgeComments\(/,
      /marginalComments\(/,
    ])
      assert.equal(derived.test(source), false, `${name} derives nothing itself: ${String(derived)}`);
    assert.match(source, /markdownView\(model, /, `${name} still calls the markdown builder with model values`);
    assert.match(source, /htmlView\(model, /, `${name} still calls the html builder with model values`);
    assert.match(source, /sceneView\(model, /, `${name} still calls the scene builder with model values`);
  }
  for (const owned of [
    /loadViewerComments[<(]/,
    /commentDocument\(/,
    /listComments\(/,
    /viewerCommentsConfig\(/,
    /bridgeNonce\(/,
    /refreshPlan\(/,
    /viewerCommentsAssets\(/,
  ])
    assert.match(prepareSource, owned, `prepare owns ${String(owned)}`);
  assert.equal(
    [...prepareSource.matchAll(/refreshPlan\(/g)].length,
    2,
    "both audiences' refresh plans are built here, and nowhere else",
  );
  assert.match(prepareSource, /refreshPlan\(`\/api\/artifacts\/\$\{artifact\.id\}`\)/, "the session poll target");
  assert.match(prepareSource, /refreshPlan\(`\/share\/\$\{request\.token\}\?meta=1`\)/, "the public poll target");
});

test("ownership is projected, not inferred from the reader", () => {
  assert.match(librarySource, /ownerId: artifacts\.ownerId,/, "the artifact projection carries its owner");
  assert.match(sharingSource, /ownerId: artifacts\.ownerId,/, "so does the public one");
  const signature = /const viewerPage = async \(([^)]*)\)/.exec(librarySource)?.[1] ?? "";
  assert.match(signature, /viewerId: string/, "the page parameter that receives the reader is named for the reader");
  assert.equal(/ownerId/.test(signature), false, "no page parameter calls the reader an owner");
  assert.match(librarySource, /kind: "bearer", viewerId/, "the bearer audience is built from the reader");
  assert.match(librarySource, /kind: "session", viewerId/, "the session audience is built from the reader");
  assert.match(sharingSource, /kind: "public", token, showComments/, "the public audience is built from the link");
  assert.match(modelSource, /export type ViewerChrome = "full" \| "anonymous" \| "none"/, "the chrome vocabulary");
  assert.match(
    modelSource,
    /export type RefreshPlan = \{ kind: "reload"; metaUrl: string \} \| \{ kind: "none" \}/,
    "the refresh plan lives in the viewer model",
  );
  assert.match(htmlSource, /export type \{ RefreshPlan \} from "\.\/model\.ts"/, "and is re-exported where it was");
  assert.equal(/^export type RefreshPlan =/m.test(htmlSource), false, "html no longer declares it");
});
