import { Hono } from "hono";
import { randomUUID } from "node:crypto";

import type { createAuth } from "../auth.ts";
import { writeArtifact } from "../domain/commit-flow.ts";
import { cookieMutationGuard, jsonError, sessionUserId } from "../http/index.ts";
import { exampleBytes, examplePlan, isExampleId, type ExampleId, type ExampleSource } from "@artiflow/domain/examples";
import type { ArtifactKind } from "@artiflow/domain/kinds";

const EXAMPLE_BODY_LIMIT = 64 * 1024;

type ExamplesAuth = ReturnType<typeof createAuth>;

export type ExampleWriteInput = {
  ownerId: string;
  artifactId: string;
  title: string;
  kind: ArtifactKind;
  bytes: Uint8Array;
};
export type ExampleWriteResult =
  { ok: true; artifactId: string; revisionId: string } | { ok: false; kind: string; reason: string };
export type ExampleWriter = (input: ExampleWriteInput) => Promise<ExampleWriteResult>;

export type ExampleWiring = { write: ExampleWriter; newId?: () => string };

export type ExampleCreated = {
  example: ExampleId;
  artifacts: { id: string; title: string; kind: ArtifactKind }[];
  open: { id: string; kind: ArtifactKind; href: string };
};

export type ExampleOutcome =
  | { ok: true; value: ExampleCreated }
  | { ok: false; reason: "unknown_example" }
  | {
      ok: false;
      reason: "example_not_committed";
      detail: string;
      artifacts: ExampleCreated["artifacts"];
    };

export async function createFromExample(input: {
  example: string;
  ownerId: string;
  write: ExampleWriter;
  newId: () => string;
}): Promise<ExampleOutcome> {
  if (!isExampleId(input.example)) return { ok: false, reason: "unknown_example" };
  const plan = examplePlan(input.example, input.newId);
  if (plan === null) return { ok: false, reason: "unknown_example" };
  const written: { id: string; title: string; kind: ArtifactKind }[] = [];
  const sources: ExampleSource[] = [];
  for (const artifact of plan.artifacts) {
    const result = await input.write({
      ownerId: input.ownerId,
      artifactId: artifact.artifactId,
      title: artifact.title,
      kind: artifact.kind,
      bytes: exampleBytes(artifact),
    });
    if (!result.ok)
      return {
        ok: false,
        reason: "example_not_committed",
        detail: `${artifact.title}: ${result.kind}/${result.reason}`,
        artifacts: written,
      };
    written.push({ id: artifact.artifactId, title: artifact.title, kind: artifact.kind });
    sources.push({ artifactId: artifact.artifactId, revisionId: result.revisionId });
  }
  if (plan.design !== null) {
    const design = plan.design;
    const result = await input.write({
      ownerId: input.ownerId,
      artifactId: design.artifactId,
      title: design.title,
      kind: design.kind,
      bytes: new TextEncoder().encode(design.scene(sources)),
    });
    if (!result.ok)
      return {
        ok: false,
        reason: "example_not_committed",
        detail: `${design.title}: ${result.kind}/${result.reason}`,
        artifacts: written,
      };
    written.push({ id: design.artifactId, title: design.title, kind: design.kind });
  }
  const opened = written[written.length - 1];
  if (opened === undefined) return { ok: false, reason: "unknown_example" };
  return {
    ok: true,
    value: {
      example: plan.id,
      artifacts: written,
      open: { id: opened.id, kind: opened.kind, href: `/artifact/${encodeURIComponent(opened.id)}` },
    },
  };
}

export type ExamplesOptions = {
  auth: ExamplesAuth;
  publicOrigin: string;
  examples: ExampleWiring;
};

export function createExamplesApp(options: ExamplesOptions): Hono {
  const app = new Hono();
  if (options.publicOrigin === "") return app;
  const examples = options.examples;
  app.post("/api/artifacts/examples", async (c) => {
    const rejected = cookieMutationGuard(c, options.publicOrigin);
    if (rejected === "origin_not_allowed") return jsonError(c, rejected, 403);
    if (rejected === "json_content_type_required") return jsonError(c, rejected, 415);
    const ownerId = await sessionUserId(options.auth, c.req.raw.headers);
    if (!ownerId) return jsonError(c, "unauthorized", 401);
    const declared = c.req.header("content-length");
    if (declared !== undefined && Number.isFinite(Number(declared)) && Number(declared) > EXAMPLE_BODY_LIMIT)
      return jsonError(c, "too_large", 413);
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > EXAMPLE_BODY_LIMIT) return jsonError(c, "too_large", 413);
    const body = ((): { example?: unknown } | null => {
      try {
        return JSON.parse(raw) as { example?: unknown } | null;
      } catch {
        return null;
      }
    })();
    const outcome = await createFromExample({
      example: typeof body?.example === "string" ? body.example : "",
      ownerId,
      write: examples.write,
      newId: examples.newId ?? (() => randomUUID()),
    });
    if (!outcome.ok) {
      if (outcome.reason === "unknown_example") return jsonError(c, "unknown_example", 400);
      return c.json({ error: "example_not_committed", detail: outcome.detail, artifacts: outcome.artifacts }, 500);
    }
    return c.json(outcome.value, 201);
  });
  return app;
}

export const exampleWriteOf =
  (
    database: Parameters<typeof writeArtifact>[0]["database"],
    storage: Parameters<typeof writeArtifact>[0]["storage"],
  ): ExampleWriter =>
  async (input) => {
    const written = await writeArtifact({
      database,
      storage,
      ownerId: input.ownerId,
      artifactId: input.artifactId,
      title: input.title,
      kind: input.kind,
      bytes: input.bytes,
    });
    return written.ok
      ? { ok: true as const, artifactId: written.value.artifactId, revisionId: written.value.revisionId }
      : { ok: false as const, kind: written.kind, reason: written.reason };
  };
