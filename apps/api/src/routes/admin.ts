import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";

import { user } from "../adapters/postgres/db/schema.ts";
import type { Database } from "../adapters/postgres/db/client.ts";
import type { createAuth } from "../auth.ts";
import { requireAdministrator } from "../http/admin-guard.ts";
import { cookieMutationGuard, jsonError } from "../http/index.ts";
import { ADMINISTRATOR_ROLE, isUserRole } from "../identity/roles.ts";
import { recordAdminEvent } from "../logging/admin-events.ts";
import { setUserRoleRequestSchema, type AdministratorListResponse, type SetUserRoleResponse } from "@artiflow/contracts/admin";

export type AdminOptions = {
  database: Database;
  auth: ReturnType<typeof createAuth>;
  publicOrigin: string;
};

type AdminEnv = { Variables: { requestId?: string } };

export function createAdminApp(options: AdminOptions): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  const deps = { auth: options.auth, database: options.database };

  app.get("/api/admin/administrators", async (c) => {
    const guard = await requireAdministrator(deps, c.req.raw.headers);
    if (guard.kind === "refusal") return jsonError(c, guard.error, guard.status);
    const rows = await options.database.db
      .select({ id: user.id, name: user.name, email: user.email, role: user.role })
      .from(user)
      .where(eq(user.role, ADMINISTRATOR_ROLE))
      .orderBy(asc(user.email));
    return c.json({ administrators: rows } satisfies AdministratorListResponse);
  });

  app.post("/api/admin/users/:id/role", async (c) => {
    const mutationRefusal = cookieMutationGuard(c, options.publicOrigin);
    if (mutationRefusal !== null)
      return jsonError(c, mutationRefusal, mutationRefusal === "origin_not_allowed" ? 403 : 415);
    const guard = await requireAdministrator(deps, c.req.raw.headers);
    if (guard.kind === "refusal") return jsonError(c, guard.error, guard.status);

    const body = await c.req.json().catch(() => null);
    const parsed = setUserRoleRequestSchema.safeParse(body);
    if (!parsed.success) return jsonError(c, "invalid_body", 400);
    if (!isUserRole(parsed.data.role)) return jsonError(c, "invalid_role", 400);

    const subjectId = c.req.param("id");
    const requestedRole = parsed.data.role;
    const outcome = await options.database.db.transaction(async (tx) => {
      const rows = await tx.select({ role: user.role }).from(user).where(eq(user.id, subjectId)).limit(1);
      const current = rows[0];
      if (current === undefined) return { kind: "missing" as const };
      if (current.role === requestedRole) return { kind: "unchanged" as const, id: subjectId, role: current.role };
      const updated = await tx
        .update(user)
        .set({ role: requestedRole, updatedAt: new Date() })
        .where(eq(user.id, subjectId))
        .returning({ id: user.id, role: user.role });
      const subject = updated[0];
      if (subject === undefined) return { kind: "missing" as const };
      recordAdminEvent({
        event: subject.role === ADMINISTRATOR_ROLE ? "role.granted" : "role.revoked",
        actorId: guard.actorId,
        actorRole: guard.actorRole,
        subjectId: subject.id,
        outcome: "applied",
        requestId: c.get("requestId"),
      });
      return { kind: "changed" as const, id: subject.id, role: subject.role };
    });
    if (outcome.kind === "missing") return jsonError(c, "user_not_found", 404);
    return c.json({
      user: { id: outcome.id, role: outcome.role },
      changed: outcome.kind === "changed",
    } satisfies SetUserRoleResponse);
  });

  return app;
}
