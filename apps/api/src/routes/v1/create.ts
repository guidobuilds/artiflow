import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";

import { writeArtifact } from "../../domain/commit-flow.ts";
import { readPrincipal } from "../../http/principal.ts";
import { MAX_ARTIFACT_BYTES } from "../../adapters/postgres/db/artifact-schema.ts";
import { createArtifactRequestSchema, type CreateArtifactResponse } from "@artiflow/contracts/artifacts";
import type { Database } from "../../adapters/postgres/db/client.ts";
import type { Storage } from "../../adapters/storage/client.ts";

type Options = { database: Database; storage: Storage };

const failureStatus: Record<string, 400 | 409 | 413 | 500> = {
  validation: 400,
  conflict: 409,
  concurrent_commit: 409,
  too_large: 413,
  error: 500,
  storage: 500,
  expired: 500,
  forbidden: 500,
  gone: 500,
  not_found: 500,
};

export function createArtifactsV1App({ database, storage }: Options): Hono {
  const app = new Hono();
  app.post("/api/artifacts", async (c: Context) => {
    const principal = readPrincipal(c.req.raw.headers);
    if (principal === null || !principal.scopes.includes("artifacts:write")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const declared = c.req.header("content-length");
    if (declared !== undefined && Number.isFinite(Number(declared)) && Number(declared) > MAX_ARTIFACT_BYTES) {
      return c.json({ error: "too_large", maxBytes: MAX_ARTIFACT_BYTES }, 413);
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const parsed = createArtifactRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const bytes = new TextEncoder().encode(parsed.data.text);
    if (bytes.length === 0) return c.json({ error: "text_required" }, 400);
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
    });
    if (!written.ok) {
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
    } satisfies CreateArtifactResponse;
    return c.json(value, 201);
  });
  return app;
}
