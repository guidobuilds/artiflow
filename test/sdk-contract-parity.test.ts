import assert from "node:assert/strict";
import { test } from "node:test";
import { createSdkClient } from "@artiflow/sdk/client";
import { artifactDetailSchema } from "@artiflow/contracts/artifacts";
import { parseArtifactList } from "../apps/dashboard/src/auth-client.ts";
import { metadataFromDetail, type DetailWire } from "../apps/dashboard/src/lib/editor-freshness.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("the sdk parses a wire-shaped artifact list exactly like the dashboard parser", async () => {
  const wire = {
    artifacts: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Notes",
        kind: "markdown",
        createdAt: "2026-11-10T00:00:00.000Z",
        updatedAt: "2026-11-10T01:00:00.000Z",
        observedSizeBytes: 32,
        revisionCount: 2,
        currentRevisionId: "r2",
        sha256: "a".repeat(64),
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        title: null,
        kind: "html",
        createdAt: "2026-11-10T00:00:00.000Z",
        updatedAt: "2026-11-10T02:00:00.000Z",
        observedSizeBytes: null,
        revisionCount: 0,
        currentRevisionId: null,
        sha256: null,
      },
    ],
  };
  const calls: Request[] = [];
  const client = createSdkClient({
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(new Request(input, init));
      return json(wire);
    }) as typeof fetch,
  });
  const result = await client.listArtifacts();
  assert.ok(result.ok);
  assert.equal(result.value.artifacts.length, 2);
  const expected: ReturnType<typeof parseArtifactList> = parseArtifactList(wire);
  assert.ok(expected);
  assert.deepEqual(result.value.artifacts.length, expected.length);
  for (const [index, row] of result.value.artifacts.entries()) {
    const view = expected[index]! as (typeof expected)[number];
    assert.equal(row.id, view.id);
    assert.equal(view.title, row.title === null ? "Untitled artifact" : row.title);
    assert.equal(view.kind, row.kind === "markdown" ? "markdown" : "html");
    assert.equal(
      row.revisionCount,
      view.versionsLabel === "no version yet" ? 0 : Number.parseInt(view.versionsLabel, 10),
    );
    assert.deepEqual(
      [view.sizeLabel, view.versionsLabel, view.verLabel, view.viewerHref],
      [
        row.observedSizeBytes === null ? "size unknown" : `${row.observedSizeBytes} B`,
        row.revisionCount === 0 ? "no version yet" : `${row.revisionCount} versions`,
        view.verLabel,
        `/artifact/${row.id}`,
      ],
    );
  }
  assert.equal(calls[0]?.url, "http://127.0.0.1:5173/api/artifacts");
  assert.equal(calls[0]?.headers.get("accept"), "application/json");
});

test("apiPrefix points the same methods at the v1 surface for bearer sessions", async () => {
  const calls: Request[] = [];
  const client = createSdkClient({
    apiPrefix: "/api/v1",
    bearerToken: "token123",
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(new Request(input, init));
      return Response.json({ artifacts: [] });
    }) as typeof fetch,
  });
  const result = await client.listArtifacts();
  assert.ok(result.ok);
  assert.equal(calls[0]?.url, "http://127.0.0.1:5173/api/v1/api/artifacts");
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer token123");
});

test("a legacy error body fails the sdk with the server's code, not a fabricated success", async () => {
  const client = createSdkClient({
    fetch: (async () => json({ error: "unauthorized" }, 401)) as typeof fetch,
  });
  const result = await client.listArtifacts();
  assert.deepEqual(result, { ok: false, code: "unauthorized", status: 401 });
});

test("an unreadable payload is a typed failure, never a guessable success", async () => {
  const client = createSdkClient({
    fetch: (async () => json({ artifacts: "not-a-list" })) as typeof fetch,
  });
  const result = await client.listArtifacts();
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.code, "list_unreadable");
});

test("the extended detail wire carries the additive kind the dashboard projection drops", async () => {
  const wire = {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Notes",
    kind: "markdown",
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T01:00:00.000Z",
    observedSizeBytes: 32,
    revision: {
      id: "22222222-2222-4222-8222-222222222222",
      revisionNumber: 3,
      sha256: "a".repeat(64),
      sizeBytes: 32,
    },
  };
  const client = createSdkClient({
    fetch: (async () => json(wire)) as typeof fetch,
  });
  const result = await client.getArtifact(wire.id);
  assert.ok(result.ok, "the sdk parses the detail body through the contract");
  assert.equal(result.value.kind, "markdown");
  const detail: DetailWire = result.value;
  assert.deepEqual(metadataFromDetail(detail, "markdown"), {
    artifactId: wire.id,
    revisionId: wire.revision.id,
    revisionNumber: wire.revision.revisionNumber,
    kind: "markdown",
    sha256: wire.revision.sha256,
    sizeBytes: wire.revision.sizeBytes,
  });
  assert.deepEqual(metadataFromDetail(detail, "html")?.kind, "html", "the projection keeps its caller's kind");
  for (const kind of ["html", "markdown", "unknown"])
    assert.equal(artifactDetailSchema.parse({ ...wire, kind }).kind, kind);
  assert.equal(artifactDetailSchema.safeParse({ ...wire, kind: "text" }).success, false, "closed kind");
  assert.equal(artifactDetailSchema.safeParse({ ...wire, kind: undefined }).success, false, "kind is required");
  const { kind: _omitted, ...withoutKind } = wire;
  assert.equal(artifactDetailSchema.safeParse(withoutKind).success, false, "the pre-existing wire is not valid");
});
