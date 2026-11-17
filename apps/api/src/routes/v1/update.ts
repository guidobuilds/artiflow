import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";

import { writeArtifact } from "../../domain/commit-flow.ts";
import { getCurrentState } from "../../domain/commits.ts";
import { readPrincipal } from "../../http/principal.ts";
import { isUuid } from "../../http/index.ts";
import { MAX_ARTIFACT_BYTES } from "../../adapters/postgres/db/artifact-schema.ts";
import { v1ArtifactUpdateRequestSchema, type V1ArtifactUpdateResponse } from "@artiflow/contracts/artifacts";
import type { Database } from "../../adapters/postgres/db/client.ts";
import type { Storage } from "../../adapters/storage/client.ts";

type Options = { database: Database; storage: Storage };

const failureStatus: Record<string, 400 | 404 | 409 | 413 | 500> = {
  validation: 400,
  conflict: 409,
  concurrent_commit: 409,
  too_large: 413,
  not_found: 404,
  gone: 404,
  error: 500,
  storage: 500,
  expired: 500,
  forbidden: 500,
};

export function createArtifactUpdateV1App({ database, storage }: Options): Hono {
  const app = new Hono();
  app.put("/api/artifacts/:id", async (c: Context) => {
    const principal = readPrincipal(c.req.raw.headers);
    if (principal === null || !principal.scopes.includes("artifacts:write")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const declared = c.req.header("content-length");
    if (declared !== undefined && Number.isFinite(Number(declared)) && Number(declared) > MAX_ARTIFACT_BYTES) {
      return c.json({ error: "too_large", maxBytes: MAX_ARTIFACT_BYTES }, 413);
    }
    const artifactId = c.req.param("id") ?? "";
    if (!isUuid(artifactId)) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof body?.expectedRevisionId !== "string" || body.expectedRevisionId.length === 0) {
      return c.json({ error: "expected_revision_id_required" }, 400);
    }
    const parsed = v1ArtifactUpdateRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const expectedRevisionId = parsed.data.expectedRevisionId;
    const state = await getCurrentState(database.db, artifactId, principal.userId);
    if (!state.ok) {
      const status = failureStatus[state.kind] ?? 500;
      return c.json({ error: state.kind === "validation" ? state.reason : state.kind }, status);
    }
    if (state.value.deletedAt !== null) return c.json({ error: "gone" }, 404);
    if (state.value.kind !== parsed.data.kind) return c.json({ error: "wrong_kind" }, 409);
    if (state.value.currentRevisionId !== expectedRevisionId) {
      return c.json({ error: "concurrent_commit", currentRevisionId: state.value.currentRevisionId }, 409);
    }
    const bytes = new TextEncoder().encode(parsed.data.text);
    if (bytes.length > MAX_ARTIFACT_BYTES) {
      return c.json({ error: "too_large", maxBytes: MAX_ARTIFACT_BYTES }, 413);
    }
    const written = await writeArtifact({
      database,
      storage,
      ownerId: principal.userId,
      bytes,
      title: parsed.data.title,
      kind: parsed.data.kind,
      artifactId,
      expectedRevisionId,
    });
    if (!written.ok) {
      if (written.kind === "conflict" && written.reason === "kind_mismatch") {
        return c.json({ error: "wrong_kind" }, 409);
      }
      if (written.kind === "concurrent_commit") {
        return c.json({ error: "concurrent_commit", currentRevisionId: written.currentRevisionId }, 409);
      }
      const status = failureStatus[written.kind] ?? 500;
      return c.json({ error: written.kind === "validation" ? written.reason : written.kind }, status);
    }
    const value = {
      artifactId: written.value.artifactId,
      revisionId: written.value.revisionId,
      revisionNumber: written.value.revisionNumber,
      sizeBytes: written.value.sizeBytes,
      observedSizeBytes: written.value.observedSizeBytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    } satisfies V1ArtifactUpdateResponse;
    return c.json(value, 200);
  });
  return app;
}
