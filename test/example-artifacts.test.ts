import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Hono } from "hono";

import { exampleCatalog, examplePlan } from "../packages/domain/src/examples.ts";
import { readScene } from "../packages/domain/src/scene.ts";
import {
  createExamplesApp,
  createFromExample,
  type ExampleWriteInput,
  type ExamplesOptions,
} from "../apps/api/src/routes/examples.ts";

const ORIGIN = "http://localhost";
const JSON_TYPE = { "content-type": "application/json", origin: ORIGIN };

const auth = (userId: string | null): ExamplesOptions["auth"] =>
  ({
    api: {
      getSession: async () => (userId === null ? null : { user: { id: userId }, session: { id: "session-one" } }),
    },
  }) as unknown as ExamplesOptions["auth"];

type Write = { input: ExampleWriteInput; revisionId: string };
const recorder = (refuseAt = -1) => {
  const writes: Write[] = [];
  const write = async (input: ExampleWriteInput) => {
    writes.push({ input, revisionId: randomUUID() });
    if (refuseAt !== -1 && writes.length === refuseAt)
      return { ok: false as const, kind: "validation", reason: "nope" };
    return { ok: true as const, artifactId: input.artifactId, revisionId: writes[writes.length - 1]!.revisionId };
  };
  return { writes, write };
};

test("the picker offers a report Page and a Design with two variants, each naming the type it produces", () => {
  const catalog = exampleCatalog();
  assert.deepEqual(
    catalog.map((entry) => [entry.id, entry.kind, entry.label]),
    [
      ["report", "html", "Report page"],
      ["variants", "canvas", "Design with two variants"],
    ],
  );
  for (const entry of catalog) assert.ok(entry.description.length > 0, entry.id);
});

test("the report example is one self-contained Page with its own title", () => {
  const plan = examplePlan("report", () => randomUUID());
  assert.notEqual(plan, null);
  if (plan === null) return;
  assert.equal(plan.kind, "html");
  assert.equal(plan.artifacts.length, 1);
  assert.equal(plan.design, null);
  const [page] = plan.artifacts;
  assert.equal(page?.kind, "html");
  assert.match(page?.text ?? "", /<title>Sharing a Design: option comparison<\/title>/);
  assert.match(page?.text ?? "", /<script>/);
  assert.doesNotMatch(page?.text ?? "", /src="http|<link /);
});

test("the variants example writes two live screens and a Design whose artboards point at those revisions", async () => {
  const { writes, write } = recorder();
  const outcome = await createFromExample({ example: "variants", ownerId: "user-owner", write, newId: randomUUID });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(
    writes.map(({ input }) => input.kind),
    ["html", "html", "canvas"],
  );
  assert.deepEqual(
    writes.map(({ input }) => input.ownerId),
    ["user-owner", "user-owner", "user-owner"],
  );
  const scene = readScene(new TextDecoder().decode(writes[2]!.input.bytes));
  assert.equal(scene.ok, true, "the Design example is a scene this build can read");
  if (!scene.ok) return;
  assert.equal(scene.value.frames.length, 2);
  assert.equal(scene.value.frames[0]?.name, "A · stacked");
  assert.equal(scene.value.frames[1]?.name, "B · inline");
  for (const [index, frame] of scene.value.frames.entries()) {
    assert.equal(frame.source?.artifactId, writes[index]!.input.artifactId);
    assert.equal(frame.source?.revisionId, writes[index]!.revisionId);
    assert.equal(frame.nodes.length, 0);
  }
  assert.equal(outcome.value.artifacts.length, 3);
  assert.equal(outcome.value.open.id, writes[2]!.input.artifactId);
  assert.equal(outcome.value.open.kind, "canvas");
  assert.equal(outcome.value.open.href, `/artifact/${writes[2]!.input.artifactId}`);
  const ids = new Set(writes.map(({ input }) => input.artifactId));
  assert.equal(ids.size, 3, "each artifact of the example is its own row");
});

test("a second create writes fresh artifacts instead of reusing a shared template", async () => {
  const first = recorder();
  const second = recorder();
  await createFromExample({ example: "variants", ownerId: "user-owner", write: first.write, newId: randomUUID });
  await createFromExample({ example: "variants", ownerId: "user-owner", write: second.write, newId: randomUUID });
  const overlap = first.writes
    .map(({ input }) => input.artifactId)
    .filter((id) => second.writes.some(({ input }) => input.artifactId === id));
  assert.deepEqual(overlap, []);
  const bytesOf = (recorderWrites: Write[]) => recorderWrites.map(({ input }) => input.bytes.join(",")).join("|");
  assert.notEqual(bytesOf(first.writes), bytesOf(second.writes), "the Design names its own screens, not another run's");
});

test("a refused write stops the example instead of publishing the rest quietly", async () => {
  const refused = recorder(2);
  const outcome = await createFromExample({
    example: "variants",
    ownerId: "user-owner",
    write: refused.write,
    newId: randomUUID,
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "example_not_committed");
  assert.equal(refused.writes.length, 2, "the Design is not written after a refused screen");
  const unknown = recorder();
  const missing = await createFromExample({
    example: "poster",
    ownerId: "user-owner",
    write: unknown.write,
    newId: randomUUID,
  });
  assert.deepEqual(missing, { ok: false, reason: "unknown_example" });
  assert.equal(unknown.writes.length, 0);
});

const harness = (wiring: {
  userId?: string | null;
  write: (input: ExampleWriteInput) => Promise<never | unknown>;
  newId?: () => string;
}) => {
  const userId = wiring.userId === undefined ? "user-owner" : wiring.userId;
  const app = new Hono();
  app.route(
    "/",
    createExamplesApp({
      auth: auth(userId),
      publicOrigin: ORIGIN,
      examples: { write: wiring.write as never, ...(wiring.newId === undefined ? {} : { newId: wiring.newId }) },
    }),
  );
  return async (path: string, init: RequestInit = {}) => {
    const response = await app.request(path, init);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
};

const post = (body: unknown, headers: Record<string, string> = JSON_TYPE) => ({
  method: "POST",
  headers,
  body: JSON.stringify(body),
});

test("the real app mounts the examples route before the library's method fallback", () => {
  const app = readFileSync(new URL("../apps/api/src/app.ts", import.meta.url), "utf8");
  const examples = app.indexOf("createExamplesApp({");
  const library = app.indexOf("createLibraryApp({");
  assert.notEqual(examples, -1);
  assert.notEqual(library, -1);
  assert.ok(
    examples < library,
    "the library answers /api/artifacts/* for every other method, so it must come after the examples route",
  );
});

test("creating from an example is a cookie-guarded, signed-in JSON request", async () => {
  const signedOut = recorder();
  const anonymous = harness({ userId: null, write: signedOut.write });
  assert.equal((await anonymous("/api/artifacts/examples", post({ example: "report" }))).status, 401);

  const signedIn = recorder();
  const call = harness({ write: signedIn.write });
  const foreign = await call(
    "/api/artifacts/examples",
    post({ example: "report" }, { ...JSON_TYPE, origin: "http://127.0.0.1:1" }),
  );
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error, "origin_not_allowed");
  const plain = await call(
    "/api/artifacts/examples",
    post({ example: "report" }, { origin: ORIGIN, "content-type": "text/plain" }),
  );
  assert.equal(plain.status, 415);
  assert.equal((await call("/api/artifacts/examples", post({ example: "poster" }))).status, 400);
  assert.equal(signedIn.writes.length, 0, "nothing is written unless the request names a real example");
});

test("a successful create answers with the caller's own artifact and where it opens", async () => {
  const report = recorder();
  const reportCall = harness({ write: report.write, newId: randomUUID });
  const created = await reportCall("/api/artifacts/examples", post({ example: "report" }));
  assert.equal(created.status, 201);
  assert.equal(report.writes.length, 1);
  const open = created.body.open as Record<string, unknown>;
  assert.equal(open.kind, "html");
  assert.equal(open.id, report.writes[0]!.input.artifactId);
  assert.equal(open.href, `/artifact/${report.writes[0]!.input.artifactId}`);

  const variants = recorder();
  const variantsCall = harness({ write: variants.write, newId: randomUUID });
  const designed = await variantsCall("/api/artifacts/examples", post({ example: "variants" }));
  assert.equal(designed.status, 201);
  assert.equal(variants.writes.length, 3);
  assert.equal((designed.body.open as Record<string, unknown>).kind, "canvas");
  assert.equal((designed.body.artifacts as unknown[]).length, 3);
});

test("a refused example answers 500 and never presents a half-written artifact as created", async () => {
  const refused = recorder(1);
  const call = harness({ write: refused.write, newId: randomUUID });
  const reply = await call("/api/artifacts/examples", post({ example: "variants" }));
  assert.equal(reply.status, 500);
  assert.equal(reply.body.error, "example_not_committed");
  assert.equal(reply.body.open, undefined);
});
