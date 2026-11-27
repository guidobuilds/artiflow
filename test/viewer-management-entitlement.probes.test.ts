import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  artifactAssets,
  artifactComments,
  artifactPublicLinks,
  artifactRevisions,
  artifactShares,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import type { AppDb } from "../apps/api/src/adapters/postgres/db/client.ts";
import { resetViewerCommentsAssetCache } from "../apps/api/src/viewer/assets.ts";
import { prepareViewer, type ViewerRequest } from "../apps/api/src/viewer/prepare.ts";
import { htmlView } from "../apps/api/src/viewer/views/html.ts";

const ARTIFACT_ID = "artifact-one";
const OWNER_ID = "user-owner";
const VIEWER_ID = "user-viewer";
const TOKEN = "a".repeat(43);
const REVISION_ID = "55555555-5555-4555-8555-555555555555";
const REVISION_NUMBER = 2;
const TITLE = "Pricing artifact";
const HTML_SOURCE = `<!doctype html><html><body><h1>Pinned</h1></body></html>`;

const MANAGEMENT = [
  'data-island="actions"',
  'data-control="menu"',
  "viewer-management-data",
  "viewer-actions",
] as const;

type Row = {
  id: string;
  artifactId: string;
  ownerId: string;
  title: string | null;
  kind: string;
  revisionId: string;
  revisionNumber: number;
  sha256: string;
  sizeBytes: number;
  storageKey: string;
  showComments: boolean;
};

const rowOf = (title: string | null): Row => {
  const bytes = new TextEncoder().encode(HTML_SOURCE);
  return {
    id: ARTIFACT_ID,
    artifactId: ARTIFACT_ID,
    ownerId: OWNER_ID,
    title,
    kind: "html",
    revisionId: REVISION_ID,
    revisionNumber: REVISION_NUMBER,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    storageKey: "storage-key",
    showComments: false,
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

const fakeDb = (row: Row, access: string | null): AppDb => {
  const rowsFor = (tables: ReadonlySet<unknown>): unknown[] => {
    if (tables.has(artifactPublicLinks)) return [{ ...row }];
    if (tables.has(artifactShares))
      return access === null ? [] : [{ id: row.id, ownerId: row.ownerId, kind: row.kind, deletedAt: null, access }];
    if (tables.has(artifactComments)) return [];
    if (tables.has(artifactAssets)) return [];
    if (tables.has(artifactRevisions)) return [{ ...row }];
    return [];
  };
  const select = (): Query => {
    const tables = new Set<unknown>();
    const chain = (): Query => query;
    const query: Query = Object.assign(
      Promise.resolve().then(() => rowsFor(tables)),
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

type Cell = { request: ViewerRequest; embed: boolean; access: string | null; title?: string | null };

const pageOf = async (cell: Cell): Promise<string> => {
  const row = rowOf(cell.title === undefined ? TITLE : cell.title);
  const model = await prepareViewer({
    db: fakeDb(row, cell.access),
    artifact: row,
    request: cell.request,
    embed: cell.embed,
    source: null,
  });
  return htmlView(model, HTML_SOURCE).html;
};

const ownerCell: Cell = { request: { kind: "session", viewerId: OWNER_ID }, embed: false, access: null };

test("management is emitted for the owner alone", async () => {
  const owner = await pageOf(ownerCell);
  for (const term of MANAGEMENT) assert.equal(owner.includes(term), true, `the owner page ships ${term}`);

  const seats: ReadonlyArray<readonly [string, Cell]> = [
    [
      "a bearer holding the owner's own viewer id",
      { request: { kind: "bearer", viewerId: OWNER_ID }, embed: false, access: null },
    ],
    ["an owner embed", { request: { kind: "session", viewerId: OWNER_ID }, embed: true, access: null }],
    ["an invited editor", { request: { kind: "session", viewerId: VIEWER_ID }, embed: false, access: "editor" }],
    ["an invited commenter", { request: { kind: "session", viewerId: VIEWER_ID }, embed: false, access: "commenter" }],
    ["a public page", { request: { kind: "public", token: TOKEN, showComments: false }, embed: false, access: null }],
  ];
  for (const [label, cell] of seats) {
    const page = await pageOf(cell);
    for (const term of MANAGEMENT) assert.equal(page.includes(term), false, `${label} ships no ${term}`);
    assert.equal(/manage/i.test(page), false, `${label} carries no management affordance`);
  }
});

const HOSTILE_TITLE = `</script><script>alert(1)</script>"'\\<!--\n&amp;-->`;

test("a hostile title cannot break out of the management payload and round-trips unchanged", async () => {
  const page = await pageOf({ ...ownerCell, title: HOSTILE_TITLE });
  const payload = /<script type="application\/json" id="viewer-management-data">([\s\S]*?)<\/script>/.exec(page)?.[1];
  assert.notEqual(payload, undefined, "the payload is found, and closes on its own tag");
  assert.equal(/<\/script|<!--/.test(payload ?? ""), false, "the title's own markup is escaped, never emitted");
  assert.equal(
    (JSON.parse(payload ?? "null") as { title: unknown }).title,
    HOSTILE_TITLE,
    "and it round-trips unchanged",
  );
  assert.equal(
    (page.match(/<script\b/g) ?? []).length,
    (page.match(/<\/script>/g) ?? []).length,
    "every script element that opens also closes",
  );
  assert.equal(page.includes("<script>alert(1)"), false, "the title never becomes markup");
});

test("without an actions bundle the owner page ships no menu while comments still mount", async () => {
  resetViewerCommentsAssetCache();
  const dir = mkdtempSync(join(tmpdir(), "viewer-management-probe-"));
  const saved = { dist: process.env.ARTIFLOW_DASHBOARD_DIST, nodeEnv: process.env.NODE_ENV };
  const logged: string[] = [];
  const report = console.error;
  try {
    mkdirSync(join(dir, ".vite"), { recursive: true });
    writeFileSync(
      join(dir, ".vite", "manifest.json"),
      JSON.stringify({ "src/viewer-comments.tsx": { file: "assets/comments-abc.js" } }),
    );
    process.env.ARTIFLOW_DASHBOARD_DIST = dir;
    process.env.NODE_ENV = "production";
    resetViewerCommentsAssetCache();
    console.error = (...args: unknown[]): void => void logged.push(args.map(String).join(" "));
    const page = await pageOf(ownerCell);
    for (const term of MANAGEMENT) assert.equal(page.includes(term), false, `no ${term} without a bundle`);
    assert.equal(page.includes('id="viewer-comments-data"'), true, "comments still mount");
    assert.equal(page.includes('src="/assets/comments-abc.js"'), true, "through the chunk the manifest names");
    assert.equal(
      logged.some((message) => /no actions bundle/.test(message)),
      true,
      "and the missing entry is reported",
    );
  } finally {
    console.error = report;
    if (saved.dist === undefined) delete process.env.ARTIFLOW_DASHBOARD_DIST;
    else process.env.ARTIFLOW_DASHBOARD_DIST = saved.dist;
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
    resetViewerCommentsAssetCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
