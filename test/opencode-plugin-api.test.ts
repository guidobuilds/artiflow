import assert from "node:assert/strict";
import test from "node:test";
import { Unauthorized } from "@artiflow/sdk/auth";
import { ArtifactRefusal, createArtifactApi, type Refusal } from "@artiflow/plugin-core/core";

const base = "https://artifacts.example";
const token = "access";
const revision = (id: string, revisionNumber: number) => ({
  artifactId: "a",
  revisionId: id,
  revisionNumber,
  sizeBytes: 8,
  observedSizeBytes: 8,
  sha256: "0".repeat(64),
});

type Sent = { method: string; url: string; body: unknown; authorization: string | null };

function transport(replies: ((sent: Sent) => Response | Promise<Response>)[]) {
  const sent: Sent[] = [];
  const request: typeof fetch = async (url, init) => {
    const entry = {
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      authorization: new Headers(init?.headers).get("authorization"),
    };
    sent.push(entry);
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)];
    assert.ok(reply, "a reply must exist for every request");
    return reply(entry);
  };
  return { sent, request };
}

const refusalOf = async (promise: Promise<unknown>): Promise<Refusal> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ArtifactRefusal, `expected a typed refusal, got ${String(error)}`);
    return error.body;
  }
  assert.fail("expected a refusal");
};

test("every request carries the v1 prefix and the bearer credential", async () => {
  const { sent, request } = transport([() => Response.json({ artifacts: [] })]);
  await createArtifactApi({ base, token, request }).probe();
  assert.deepEqual(
    sent.map(({ method, url, authorization }) => ({ method, url, authorization })),
    [{ method: "GET", url: `${base}/api/v1/artifacts`, authorization: `Bearer ${token}` }],
  );
});

test("a rejected credential surfaces as the SDK Unauthorized so the caller can refresh", async () => {
  const { request } = transport([() => new Response(null, { status: 401 })]);
  await assert.rejects(createArtifactApi({ base, token, request }).probe(), Unauthorized);
});

test("get reads the v1 bytes route and preserves the pinned selector", async () => {
  const { sent, request } = transport([
    () =>
      Response.json({
        artifactId: "a",
        revisionId: "r1",
        revisionNumber: 1,
        kind: "html",
        sha256: "0".repeat(64),
        sizeBytes: 3,
        contentBase64: "PC9wPg==",
      }),
  ]);
  const reply = await createArtifactApi({ base, token, request }).get({ artifactId: "a", revisionId: "r1" });
  assert.equal(sent[0]?.url, `${base}/api/v1/artifacts/a/bytes?revisionId=r1`);
  assert.deepEqual(reply, {
    artifactId: "a",
    revisionId: "r1",
    revisionNumber: 1,
    kind: "html",
    sha256: "0".repeat(64),
    sizeBytes: 3,
    contentBase64: "PC9wPg==",
  });
});

test("get_markdown reads the v1 document and clamps the window", async () => {
  const document = {
    artifactId: "a",
    title: null,
    kind: "markdown",
    revisionId: "r1",
    revisionNumber: 1,
    text: "# A\n\nbody",
  };
  const { sent, request } = transport([() => Response.json(document), () => Response.json(document)]);
  const api = createArtifactApi({ base, token, request });
  assert.deepEqual(await api.getMarkdown({ artifactId: "a" }), {
    artifactId: "a",
    revisionId: "r1",
    lineCount: 3,
    from: 1,
    to: 3,
    lines: ["# A", "", "body"],
  });
  assert.deepEqual(await api.getMarkdown({ artifactId: "a", from: 2, to: 99 }), {
    artifactId: "a",
    revisionId: "r1",
    lineCount: 3,
    from: 2,
    to: 3,
    lines: ["", "body"],
  });
  assert.deepEqual(
    sent.map(({ url }) => url),
    [`${base}/api/v1/artifacts/a/document`, `${base}/api/v1/artifacts/a/document`],
  );
});

test("edit_lines saves the whole document with its compare-and-set pointer", async () => {
  const document = { artifactId: "a", title: null, kind: "markdown", revisionId: "r1", revisionNumber: 1, text: "# A" };
  const { sent, request } = transport([
    () => Response.json(document),
    () => Response.json({ artifactId: "a", revisionId: "r2", revisionNumber: 2, sizeBytes: 7, sha256: "1".repeat(64) }),
  ]);
  const reply = await createArtifactApi({ base, token, request }).editLines({
    artifactId: "a",
    expectedRevisionId: "r1",
    ops: [{ op: "replace", from: 1, to: 1, text: ["# B"] }],
  });
  assert.deepEqual(reply, {
    artifactId: "a",
    revisionId: "r2",
    revisionNumber: 2,
    lineCount: 1,
    appliedOps: 1,
    sha256: "1".repeat(64),
  });
  assert.deepEqual(
    sent.map(({ method, url, body }) => ({ method, url, body })),
    [
      { method: "GET", url: `${base}/api/v1/artifacts/a/document`, body: undefined },
      {
        method: "PUT",
        url: `${base}/api/v1/artifacts/a/document`,
        body: { text: "# B", expectedRevisionId: "r1" },
      },
    ],
  );
});

test("a stale pointer is a concurrent_edit refusal naming the live revision, with no write", async () => {
  const { sent, request } = transport([
    () =>
      Response.json({
        artifactId: "a",
        title: null,
        kind: "markdown",
        revisionId: "r2",
        revisionNumber: 2,
        text: "# A",
      }),
  ]);
  const refusal = await refusalOf(
    createArtifactApi({ base, token, request }).editLines({
      artifactId: "a",
      expectedRevisionId: "r1",
      ops: [{ op: "delete", from: 1, to: 1 }],
    }),
  );
  assert.deepEqual(refusal, {
    error: "concurrent_edit",
    message: "document_changed_since_read",
    artifactId: "a",
    currentRevisionId: "r2",
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.method, "GET");
});

test("a lost race reports the live revision from a follow-up read instead of a blind retry", async () => {
  const document = { artifactId: "a", title: null, kind: "markdown", revisionId: "r1", revisionNumber: 1, text: "# A" };
  const { sent, request } = transport([
    () => Response.json(document),
    () => Response.json({ error: "concurrent_edit", currentRevisionId: "r9" }, { status: 409 }),
    () => Response.json({ ...document, revisionId: "r9", revisionNumber: 9 }),
  ]);
  const refusal = await refusalOf(
    createArtifactApi({ base, token, request }).editLines({
      artifactId: "a",
      expectedRevisionId: "r1",
      ops: [{ op: "replace", from: 1, to: 1, text: ["# B"] }],
    }),
  );
  assert.deepEqual(refusal, {
    error: "concurrent_edit",
    message: "document_changed_since_read",
    artifactId: "a",
    currentRevisionId: "r9",
  });
  assert.deepEqual(
    sent.map(({ method }) => method),
    ["GET", "PUT", "GET"],
  );
});

test("a line-op mismatch refuses with the live window and writes nothing", async () => {
  const { sent, request } = transport([
    () =>
      Response.json({
        artifactId: "a",
        title: null,
        kind: "markdown",
        revisionId: "r1",
        revisionNumber: 1,
        text: "# A",
      }),
  ]);
  const refusal = await refusalOf(
    createArtifactApi({ base, token, request }).editLines({
      artifactId: "a",
      expectedRevisionId: "r1",
      ops: [{ op: "replace", from: 1, to: 1, expect: ["# Wrong"], text: ["# B"] }],
    }),
  );
  assert.equal(refusal.error, "expectation_mismatch");
  assert.deepEqual(refusal.window, { from: 1, to: 1, lines: ["# A"] });
  assert.equal(sent.length, 1);
});

const comment = (id: string) => ({
  id,
  authorId: "u1",
  author: { email: "owner@example.com" },
  anchor: { kind: "text-range", startLine: 1, startCol: 1, endLine: 1, endCol: 2, quotedText: "# A" },
  body: "body",
  resolvedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  canDelete: true,
});

test("list_comments reads the v1 comment surface and keeps the thread envelope", async () => {
  const { sent, request } = transport([
    () => Response.json({ canComment: true, comments: [{ ...comment("c1"), replies: [comment("c2")] }] }),
  ]);
  assert.deepEqual(await createArtifactApi({ base, token, request }).listComments({ artifactId: "a" }), {
    comments: [{ ...comment("c1"), replies: [comment("c2")] }],
  });
  assert.equal(sent[0]?.url, `${base}/api/v1/artifacts/a/comments`);
});

test("write creates through POST /api/v1/artifacts and returns the create reply unchanged", async () => {
  const { sent, request } = transport([() => Response.json(revision("r1", 1), { status: 201 })]);
  assert.deepEqual(await createArtifactApi({ base, token, request }).write({ text: "<p>x</p>", kind: "html" }), {
    ...revision("r1", 1),
  });
  assert.deepEqual(
    sent.map(({ method, url, body }) => ({ method, url, body })),
    [{ method: "POST", url: `${base}/api/v1/artifacts`, body: { text: "<p>x</p>", kind: "html" } }],
  );
});

test("write updates HTML through PUT /api/v1/artifacts/:id and reports a concurrent commit", async () => {
  const { sent, request } = transport([
    () => Response.json(revision("r2", 2)),
    () => Response.json({ error: "concurrent_commit", currentRevisionId: "r9" }, { status: 409 }),
  ]);
  const api = createArtifactApi({ base, token, request });
  assert.deepEqual(
    await api.write({ text: "<p>x</p>", kind: "html", artifactId: "a", expectedRevisionId: "r1" }),
    revision("r2", 2),
  );
  assert.deepEqual(sent[0]?.body, { text: "<p>x</p>", kind: "html", expectedRevisionId: "r1" });
  assert.equal(sent[0]?.method, "PUT");
  assert.equal(sent[0]?.url, `${base}/api/v1/artifacts/a`);
  assert.deepEqual(await refusalOf(api.write({ text: "<p>y</p>", artifactId: "a", expectedRevisionId: "r1" })), {
    error: "concurrent_commit",
    message: "artifact_changed_since_read",
    currentRevisionId: "r9",
  });
});

test("write routes a markdown update to the document save and an unknown kind to a read first", async () => {
  const detail = {
    id: "a",
    title: null,
    kind: "markdown",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    observedSizeBytes: 3,
    revision: { id: "r1", revisionNumber: 1, sha256: "1".repeat(64), sizeBytes: 3 },
  };
  const { sent, request } = transport([
    () => Response.json({ artifactId: "a", revisionId: "r2", revisionNumber: 2, sizeBytes: 3, sha256: "2".repeat(64) }),
    () => Response.json(detail),
    () => Response.json({ artifactId: "a", revisionId: "r3", revisionNumber: 3, sizeBytes: 3, sha256: "3".repeat(64) }),
  ]);
  const api = createArtifactApi({ base, token, request });
  assert.deepEqual(await api.write({ text: "# B", kind: "markdown", artifactId: "a", expectedRevisionId: "r1" }), {
    artifactId: "a",
    revisionId: "r2",
    revisionNumber: 2,
    sizeBytes: 3,
    sha256: "2".repeat(64),
  });
  assert.deepEqual(await api.write({ text: "# C", artifactId: "a", expectedRevisionId: "r2" }), {
    artifactId: "a",
    revisionId: "r3",
    revisionNumber: 3,
    sizeBytes: 3,
    sha256: "3".repeat(64),
  });
  assert.deepEqual(
    sent.map(({ method, url }) => ({ method, url })),
    [
      { method: "PUT", url: `${base}/api/v1/artifacts/a/document` },
      { method: "GET", url: `${base}/api/v1/artifacts/a` },
      { method: "PUT", url: `${base}/api/v1/artifacts/a/document` },
    ],
  );
});

test("an artifactId without a base pointer is refused before any request", async () => {
  const { sent, request } = transport([() => Response.json({})]);
  const refusal = await refusalOf(createArtifactApi({ base, token, request }).write({ text: "x", artifactId: "a" }));
  assert.deepEqual(refusal, {
    error: "expected_revision_id_required",
    message: "expectedRevisionId is required to update an existing artifact",
    artifactId: "a",
  });
  assert.equal(sent.length, 0);
});

test("metadata reads the v1 artifact detail as the canonical projection", async () => {
  const { sent, request } = transport([
    () =>
      Response.json({
        id: "a",
        title: "Demo",
        kind: "markdown",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        observedSizeBytes: 4,
        revision: { id: "r3", revisionNumber: 3, sha256: "3".repeat(64), sizeBytes: 4 },
      }),
  ]);
  assert.deepEqual(await createArtifactApi({ base, token, request }).metadata({ artifactId: "a" }), {
    artifactId: "a",
    revisionId: "r3",
    revisionNumber: 3,
    kind: "markdown",
    sha256: "3".repeat(64),
    sizeBytes: 4,
  });
  assert.equal(sent[0]?.url, `${base}/api/v1/artifacts/a`);
});

const detailBody = (overrides: Record<string, unknown> = {}) => ({
  id: "a",
  title: "Demo",
  kind: "markdown",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  observedSizeBytes: 4,
  revision: { id: "r3", revisionNumber: 3, sha256: "3".repeat(64), sizeBytes: 4 },
  ...overrides,
});

test("metadata refuses an unknown artifact kind instead of guessing one", async () => {
  const { request } = transport([() => Response.json(detailBody({ kind: "unknown" }))]);
  assert.deepEqual(await refusalOf(createArtifactApi({ base, token, request }).metadata({ artifactId: "a" })), {
    error: "wrong_kind",
    message: "artifact_kind_mismatch",
    artifactId: "a",
  });
});

test("metadata refuses an artifact with no current revision instead of fabricating one", async () => {
  const { request } = transport([() => Response.json(detailBody({ revision: null }))]);
  assert.deepEqual(await refusalOf(createArtifactApi({ base, token, request }).metadata({ artifactId: "a" })), {
    error: "no_current_revision",
    message: "artifact_has_no_current_revision",
    artifactId: "a",
  });
});
