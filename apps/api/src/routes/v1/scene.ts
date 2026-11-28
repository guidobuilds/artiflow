import { Hono, type Context } from "hono";

import {
  MAX_SCENE_READ_NODES,
  sceneApplyInput,
  sceneApplyOf,
  sceneNodeCapRefusal,
  sceneOutlineOf,
  sceneReadInput,
  sceneReadOf,
  type SceneRefusalBody,
} from "@artiflow/mcp-server/scene-tools";
import type { SceneOperation } from "@artiflow/domain/scene-operations";

import { readPrincipal } from "../../http/principal.ts";
import { isUuid } from "../../http/index.ts";
import { createMcpBackend } from "../../mcp/backend.ts";
import type { Database } from "../../adapters/postgres/db/client.ts";
import type { Storage } from "../../adapters/storage/client.ts";

type Options = { database: Database; storage: Storage };

const failureStatus: Record<string, 400 | 404 | 409 | 413> = {
  not_found: 404,
  gone: 404,
  unknown_frame: 404,
  unknown_node: 404,
  wrong_kind: 409,
  concurrent_edit: 409,
  invalid_scene: 400,
  invalid_operation: 400,
  too_large: 413,
};

const refused = (c: Context, refusal: SceneRefusalBody): Response =>
  c.json(refusal, failureStatus[refusal.error] ?? 500);

const emptyToUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value;

const nodeIdsOf = (value: string | undefined): string[] | undefined => {
  if (value === undefined) return undefined;
  const ids = value.split(",").filter((id) => id.length > 0);
  return ids.length === 0 ? undefined : ids;
};

export function createSceneV1App({ database, storage }: Options): Hono {
  const backend = createMcpBackend(database, storage);
  const app = new Hono();

  app.get("/api/artifacts/:id/scene/outline", async (c: Context) => {
    const principal = readPrincipal(c.req.raw.headers);
    if (principal === null || !principal.scopes.includes("artifacts:read")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const artifactId = c.req.param("id") ?? "";
    if (!isUuid(artifactId)) return c.json({ error: "not_found" }, 404);
    const outcome = await sceneOutlineOf(backend, { artifactId, ownerId: principal.userId });
    if (!outcome.ok) return refused(c, outcome.refusal);
    return c.json(outcome.value, 200);
  });

  app.get("/api/artifacts/:id/scene/read", async (c: Context) => {
    const principal = readPrincipal(c.req.raw.headers);
    if (principal === null || !principal.scopes.includes("artifacts:read")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const artifactId = c.req.param("id") ?? "";
    if (!isUuid(artifactId)) return c.json({ error: "not_found" }, 404);
    const frameId = emptyToUndefined(c.req.query("frameId"));
    const nodeIds = nodeIdsOf(c.req.query("nodeIds"));
    if (nodeIds !== undefined && nodeIds.length > MAX_SCENE_READ_NODES) {
      return c.json(sceneNodeCapRefusal(artifactId, nodeIds.length), 413);
    }
    const parsed = sceneReadInput.omit({ artifactId: true }).safeParse({ frameId, nodeIds });
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const outcome = await sceneReadOf(backend, {
      artifactId,
      ownerId: principal.userId,
      frameId: parsed.data.frameId,
      nodeIds: parsed.data.nodeIds,
    });
    if (!outcome.ok) return refused(c, outcome.refusal);
    return c.json(outcome.value, 200);
  });

  app.post("/api/artifacts/:id/scene/apply", async (c: Context) => {
    const principal = readPrincipal(c.req.raw.headers);
    if (principal === null || !principal.scopes.includes("artifacts:write")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const artifactId = c.req.param("id") ?? "";
    if (!isUuid(artifactId)) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const parsed = sceneApplyInput.omit({ artifactId: true }).safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const outcome = await sceneApplyOf(
      backend,
      { ownerId: principal.userId, authorKind: "agent", authorId: principal.userId },
      {
        artifactId,
        baseSeq: parsed.data.baseSeq,
        idempotencyKey: parsed.data.idempotencyKey,
        ops: parsed.data.ops as SceneOperation[],
      },
    );
    if (!outcome.ok) return refused(c, outcome.refusal);
    return c.json(outcome.value, 200);
  });

  return app;
}
