import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { Hono } from "hono";

import { artifactComments, artifactPublicLinks } from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { newRevisionStorageKey } from "../apps/api/src/adapters/storage/s3.ts";
import { createLibraryApp } from "../apps/api/src/routes/library.ts";
import { createShareViewerApp } from "../apps/api/src/routes/sharing.ts";
import { SCENE_FORMAT_VERSION, canonicalScene, type Scene } from "@artiflow/domain/scene";

const TOKEN = "a".repeat(43);
const ARTIFACT = "artifact-one";
const VIEWER = "user-one";
const REVISION = "55555555-5555-4555-8555-555555555555";
const SOURCE = "# Title\n\nthe anchored sentence here\n";
const HTML = "<!doctype html><p>body</p>";
const KIND_SOURCE = new TextEncoder().encode(SOURCE);
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
      nodes: [{ id: "n1", type: "rect", x: 1, y: 2, w: 3, h: 4, fill: "#fff" }],
    },
  ],
};
const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type Chain = Promise<unknown[]> & {
  leftJoin: () => Chain;
  innerJoin: () => Chain;
  where: () => Chain;
  orderBy: () => Chain;
  limit: () => Chain;
  for: () => Chain;
  $dynamic: () => Chain;
};

const chainOf = (read: () => unknown[]): Chain => {
  const node = Object.assign(Promise.resolve().then(read), {
    leftJoin: () => node,
    innerJoin: () => node,
    where: () => node,
    orderBy: () => node,
    limit: () => node,
    for: () => node,
    $dynamic: () => node,
  }) as unknown as Chain;
  return node;
};

const sceneAnchor = { kind: "board-point", boardId: "home", nodeId: "n1", x: 0.5, y: 0.5 };
const textRange = {
  kind: "text-range",
  startLine: 3,
  startCol: 1,
  endLine: 3,
  endCol: 24,
  quotedText: "the anchored sentence",
};
const commentRow = (anchor: unknown) => ({
  id: "comment-one",
  artifactId: ARTIFACT,
  authorId: VIEWER,
  authorName: "Ann",
  authorImage: null,
  parentId: null,
  anchor,
  body: "hi",
  resolvedAt: null,
  resolvedBy: null,
  revisionId: REVISION,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const storageOf = (bytes: Uint8Array): Storage =>
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

const bytesFor = (kind: string): Uint8Array =>
  kind === "markdown"
    ? KIND_SOURCE
    : kind === "html"
      ? new TextEncoder().encode(HTML)
      : new TextEncoder().encode(canonicalScene(SCENE));

type Page = { status: number; body: string; json: Record<string, unknown> | null; robots: string | null };

const sharePage = async (kind: string, showComments: boolean, query = ""): Promise<Page> => {
  const bytes = bytesFor(kind);
  const link = {
    artifactId: ARTIFACT,
    showComments,
    storageKey: newRevisionStorageKey(),
    sha256: digestOf(bytes),
    revisionNumber: 1,
    sizeBytes: bytes.length,
    kind,
  };
  const database = {
    db: {
      select: () => ({
        from: (table: unknown) =>
          chainOf(() => {
            if (table === artifactPublicLinks) return [link];
            if (table === artifactComments) return [commentRow(kind === "markdown" ? textRange : sceneAnchor)];
            return [];
          }),
      }),
    },
  } as unknown as Database;
  const app = new Hono();
  app.route("/", createShareViewerApp({ database, storage: storageOf(bytes) }));
  const response = await app.request(`/share/${TOKEN}${query}`);
  const body = await response.text();
  return {
    status: response.status,
    body,
    json: (response.headers.get("content-type") ?? "").startsWith("application/json")
      ? (JSON.parse(body) as Record<string, unknown>)
      : null,
    robots: response.headers.get("x-robots-tag"),
  };
};

const moduleScripts = (page: string): string[] =>
  [...page.matchAll(/<script type="module" src="([^"]*)"><\/script>/g)].map((match) => match[1] ?? "");

const islandScripts = (page: string): string[] =>
  moduleScripts(page).filter((src) => src !== "" && src !== "/@vite/client");

const commentsChunk = (page: string): boolean => islandScripts(page).some((src) => /viewer-comments/.test(src));

const ships = (page: string) => ({
  host: page.includes('id="viewer-comments"'),
  config: page.includes("viewer-comments-data"),
  bundle: commentsChunk(page),
  bridge: page.includes("data-artiflow-bridge"),
  available: page.includes("comments-available"),
});

const mountsMargin = (kind: string): boolean => kind === "html" || kind === "markdown";

test("every kind crossed with the link option: the meta flag is exactly what the page ships", async () => {
  for (const kind of ["html", "markdown", "canvas", "deck"]) {
    for (const showComments of [false, true]) {
      const meta = await sharePage(kind, showComments, "?meta=1");
      const page = await sharePage(kind, showComments);
      const what = ships(page.body);
      const flag = meta.json?.comments;
      const label = `${kind} option=${showComments}`;
      assert.equal(meta.status, 200, label);
      assert.equal(page.status, 200, label);
      assert.equal(meta.robots, "noindex", label);
      assert.equal(page.robots, "noindex", label);
      assert.equal(flag, showComments && mountsMargin(kind), `${label} flag`);
      assert.equal(what.host, flag, `${label} host agrees with the flag`);
      assert.equal(what.config, flag, `${label} config agrees with the flag`);
      assert.equal(flag, what.bundle, `${label} the comments chunk mounts exactly where comments do`);
      assert.deepEqual(
        islandScripts(page.body).filter((src) => !/viewer-comments/.test(src)),
        [],
        `${label} the page ships no other module script`,
      );
      if (kind === "html") assert.equal(what.available, flag, `${label} shell class agrees with the flag`);
      assert.equal(what.bridge, kind === "html" && flag, `${label} bridge only with the flag`);
      assert.ok(page.body.includes(`,comments:${String(flag)}}`), `${label} poller reads the same flag`);
    }
  }
});

const refreshScriptOf = (page: string): string => {
  const start = page.indexOf("const refresh =");
  const tail = "if (!document.hidden) startPolling();";
  const end = page.indexOf(tail);
  assert.ok(start > 0 && end > start, "poller present");
  return page.slice(start, end + tail.length);
};

const runPoller = (script: string, meta: Record<string, unknown>): Promise<number> => {
  let reloads = 0;
  const handlers: Array<() => void> = [];
  const shell: { dataset: Record<string, string | undefined> } = { dataset: {} };
  const context = {
    document: {
      hidden: false,
      getElementById: (id: string) => (id === "docshell" ? shell : null),
      querySelector: () => null,
      addEventListener: (): void => undefined,
    },
    window: { addEventListener: (): void => undefined },
    location: {
      reload: (): void => {
        reloads += 1;
      },
    },
    history: { scrollRestoration: "manual" },
    fetch: async () => ({ ok: true, status: 200, json: async () => meta }),
    setInterval: (handler: () => void): number => {
      handlers.push(handler);
      return 1;
    },
    clearInterval: (): void => undefined,
    MutationObserver: class {
      observe(): void {}
    },
  };
  runInNewContext(script, context);
  for (const handler of handlers) handler();
  return new Promise<number>((resolve) => setTimeout(() => resolve(reloads), 30));
};

test("the served page's own poller agrees with the route's own meta across the option flip", async () => {
  for (const kind of ["html", "markdown"]) {
    for (const served of [false, true]) {
      for (const live of [false, true]) {
        const page = await sharePage(kind, served);
        const meta = await sharePage(kind, live, "?meta=1");
        const reloads = await runPoller(refreshScriptOf(page.body), meta.json as Record<string, unknown>);
        assert.equal(reloads, served && !live ? 1 : 0, `${kind} served=${served} linkNow=${live}`);
      }
    }
  }
});

const ownerPageFor = async (kind: string): Promise<{ status: number; page: string; robots: string | null }> => {
  const bytes = bytesFor(kind);
  const artifact = {
    id: ARTIFACT,
    title: "T",
    kind,
    revisionId: REVISION,
    revisionNumber: 1,
    sizeBytes: bytes.length,
    sha256: digestOf(bytes),
    storageKey: newRevisionStorageKey(),
    createdAt: new Date(),
    updatedAt: new Date(),
    currentRevisionId: REVISION,
    observedSizeBytes: bytes.length,
  };
  let step = 0;
  const database = {
    db: {
      select: () => ({
        from: () =>
          chainOf(() => {
            step += 1;
            if (step === 1) return [artifact];
            if (step === 2) return [{ id: ARTIFACT, ownerId: VIEWER, kind, deletedAt: null, access: "owner" }];
            return [];
          }),
      }),
    },
  } as unknown as Database;
  const app = new Hono();
  app.route(
    "/",
    createLibraryApp({
      database,
      auth: { api: { getSession: async () => ({ user: { id: VIEWER } }) } } as never,
      storage: storageOf(bytes),
    }),
  );
  const response = await app.request(`/artifact/${ARTIFACT}`, { headers: { cookie: "s=1" } });
  return { status: response.status, page: await response.text(), robots: response.headers.get("x-robots-tag") };
};

test("the owner page keeps its island and its revision id, and its poller has no comments flag", async () => {
  for (const kind of ["html", "markdown", "canvas"]) {
    const { status, page, robots } = await ownerPageFor(kind);
    assert.equal(status, 200, `${kind} owner page`);
    const what = ships(page);
    const island = /<script type="application\/json" id="viewer-comments-data">([\s\S]*?)<\/script>/.exec(page)?.[1];
    const config = island === undefined ? null : (JSON.parse(island) as Record<string, unknown>);
    if (kind !== "canvas") {
      assert.equal(config?.revisionId, REVISION, `${kind} owner island names the served revision`);
      assert.equal(config?.canComment, true, `${kind} owner island knows it may write`);
      assert.equal(what.host, true, `${kind} owner page mounts its margin`);
    }
    assert.deepEqual(
      islandScripts(page).filter((src) => !/viewer-comments|viewer-actions/.test(src)),
      [],
      `${kind} owner page mounts no other module script`,
    );
    assert.equal(/,comments:(true|false)/.test(page), false, `${kind} owner poller carries no comments flag`);
    assert.equal(robots, null, `${kind} owner page is not forced noindex`);
  }
});

test("the owner meta route is unchanged and carries no comments flag", async () => {
  const bytes = KIND_SOURCE;
  const artifact = {
    id: ARTIFACT,
    title: "T",
    kind: "markdown",
    revisionId: REVISION,
    revisionNumber: 1,
    sizeBytes: bytes.length,
    sha256: digestOf(bytes),
    storageKey: newRevisionStorageKey(),
    createdAt: new Date(),
    updatedAt: new Date(),
    currentRevisionId: REVISION,
    observedSizeBytes: bytes.length,
  };
  const database = { db: { select: () => ({ from: () => chainOf(() => [artifact]) }) } } as unknown as Database;
  const app = new Hono();
  app.route(
    "/",
    createLibraryApp({
      database,
      auth: { api: { getSession: async () => ({ user: { id: VIEWER } }) } } as never,
      storage: storageOf(bytes),
    }),
  );
  const response = await app.request(`/api/artifacts/${ARTIFACT}`);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), [
    "createdAt",
    "id",
    "kind",
    "observedSizeBytes",
    "revision",
    "title",
    "updatedAt",
  ]);
});

test("a scene page ships no comments surface on the public route or the owner one", async () => {
  for (const kind of ["canvas", "deck"]) {
    for (const showComments of [false, true]) {
      const label = `${kind} option=${String(showComments)}`;
      const page = await sharePage(kind, showComments);
      assert.equal(page.status, 200, label);
      const what = ships(page.body);
      assert.equal(what.host, false, `${label} public host`);
      assert.equal(what.config, false, `${label} public config`);
      assert.equal(what.bundle, false, `${label} public bundle`);
      assert.equal(what.available, false, `${label} public shell class`);
      assert.equal(what.bridge, false, `${label} public bridge`);
      assert.equal(page.body.includes("Show comments"), false, `${label} public toggle`);
      assert.equal(page.body.includes("Hide comments"), false, `${label} public toggle`);
    }
    const owner = await ownerPageFor(kind);
    assert.equal(owner.status, 200, `${kind} owner page`);
    const what = ships(owner.page);
    assert.equal(what.host, false, `${kind} owner host`);
    assert.equal(what.config, false, `${kind} owner config`);
    assert.equal(what.bundle, false, `${kind} owner page mounts no comments chunk`);
    assert.equal(
      islandScripts(owner.page).every((src) => /viewer-actions/.test(src)),
      true,
      `${kind} owner page mounts the management island and no other module script`,
    );
    assert.equal(what.available, false, `${kind} owner shell class`);
    assert.equal(what.bridge, false, `${kind} owner bridge`);
    assert.equal(owner.page.includes("Show comments"), false, `${kind} owner toggle`);
    assert.equal(owner.page.includes("Hide comments"), false, `${kind} owner toggle`);
  }
});

test("a public scene page ships no pin, and a public markdown island names no revision", async () => {
  for (const kind of ["canvas", "deck"]) {
    const page = await sharePage(kind, true);
    assert.equal([...page.body.matchAll(/data-thread-id=/g)].length, 0, `${kind} pin`);
    assert.equal(page.body.includes('aria-label="Comment threads without a node"'), false, `${kind} orphan list`);
    assert.equal(ships(page.body).host, false, `${kind} host`);
  }
  const markdown = await sharePage("markdown", true);
  const island = /<script type="application\/json" id="viewer-comments-data">([\s\S]*?)<\/script>/.exec(
    markdown.body,
  )?.[1];
  const config = JSON.parse(island ?? "{}") as Record<string, unknown>;
  assert.equal("revisionId" in config, false, "the public island names no revision");
  assert.equal(config.canComment, false);
});
