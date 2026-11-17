import { Hono, type Context } from "hono";
import { and, eq, sql } from "drizzle-orm";

import type { AppDb, Database } from "../../adapters/postgres/db/client.ts";

import { getRevisionBytes } from "../../adapters/storage/s3.ts";
import { artifacts, artifactRevisions, MAX_ARTIFACT_BYTES } from "../../adapters/postgres/db/artifact-schema.ts";
import { readableArtifactPredicate } from "../sharing.ts";
import { isUuid } from "../../http/index.ts";
import { readPrincipal } from "../../http/principal.ts";
import type { ArtifactKind } from "@artiflow/contracts/artifacts";
import { v1ArtifactBytesResponseSchema, type V1ArtifactBytesResponse } from "@artiflow/contracts/artifacts";
import type { Storage } from "../../adapters/storage/client.ts";

type Options = { database: Database; storage: Storage };

const wireKind = (kind: string): ArtifactKind => (kind === "html" || kind === "markdown" ? kind : "unknown");

async function readableRevision(
  db: AppDb,
  input: { artifactId: string; userId: string; revisionId?: string | undefined },
) {
  const { artifactId, userId, revisionId } = input;
  return (
    await db
      .select({
        id: artifacts.id,
        kind: artifacts.kind,
        revisionId: artifactRevisions.id,
        revisionNumber: artifactRevisions.revision,
        sha256: artifactRevisions.sha256,
        sizeBytes: artifactRevisions.sizeBytes,
        storageKey: artifactRevisions.storageKey,
      })
      .from(artifacts)
      .leftJoin(
        artifactRevisions,
        and(
          eq(artifactRevisions.artifactId, artifacts.id),
          eq(artifactRevisions.id, sql`coalesce(${revisionId ?? null}::text, ${artifacts.currentRevisionId})`),
        ),
      )
      .where(and(eq(artifacts.id, artifactId), readableArtifactPredicate(userId)))
  )[0];
}

export function createArtifactBytesV1App({ database, storage }: Options): Hono {
  const db = database.db;
  const app = new Hono();

  app.get("/api/artifacts/:id/bytes", async (c: Context) => {
    const principal = readPrincipal(c.req.raw.headers);
    if (principal === null || !principal.scopes.includes("artifacts:read")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const artifactId = c.req.param("id") ?? "";
    if (!isUuid(artifactId)) return c.json({ error: "not_found" }, 404);
    const requested = c.req.query("revisionId");
    if (requested !== undefined && !isUuid(requested)) return c.json({ error: "not_found" }, 404);
    const row = await readableRevision(db, { artifactId, userId: principal.userId, revisionId: requested });
    if (
      !row ||
      row.revisionId === null ||
      row.revisionNumber === null ||
      row.sha256 === null ||
      row.sizeBytes === null ||
      row.storageKey === null
    )
      return c.json({ error: "not_found" }, 404);
    const read = await getRevisionBytes({
      storage,
      storageKey: row.storageKey,
      sha256: row.sha256,
      maxBytes: MAX_ARTIFACT_BYTES,
    });
    if (!read.ok) return c.json({ error: "artifact_unavailable", reason: read.kind }, 500);
    const value = v1ArtifactBytesResponseSchema.parse({
      artifactId: row.id,
      revisionId: row.revisionId,
      revisionNumber: row.revisionNumber,
      kind: wireKind(row.kind),
      sha256: row.sha256,
      sizeBytes: read.value.sizeBytes,
      contentBase64: Buffer.from(read.value.bytes).toString("base64"),
    } satisfies V1ArtifactBytesResponse);
    return c.json(value);
  });

  return app;
}
