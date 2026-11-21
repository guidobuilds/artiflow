import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";

import { user } from "../adapters/postgres/db/schema.ts";
import type { Database } from "../adapters/postgres/db/client.ts";
import type { createAuth } from "../auth.ts";
import type { AppConfig } from "../config.ts";
import { requireAdministrator } from "../http/admin-guard.ts";
import { cookieMutationGuard, jsonError } from "../http/index.ts";
import { ADMINISTRATOR_ROLE, isUserRole } from "../identity/roles.ts";
import { recordAdminEvent } from "../logging/admin-events.ts";
import { AdminUserEditError, adminUserListQuerySchema, listAdminUsers, updateAdminUser } from "../admin/users.ts";
import { deactivateAccount, reactivateAccount } from "../admin/lifecycle.ts";
import {
  AccessConfigurationError,
  readAccessConfiguration,
  updateAccessConfiguration,
} from "../settings/access-administration.ts";
import { SettingRevisionConflictError, ACCESS_METHODS_KEY, PASSWORD_POLICY_KEY } from "../settings/store.ts";
import {
  readPasswordPolicyConfiguration,
  updatePasswordPolicyConfiguration,
} from "../password-policy/administration.ts";
import {
  setUserRoleRequestSchema,
  setUserStatusRequestSchema,
  updateAccessConfigurationRequestSchema,
  updateAdminUserRequestSchema,
  updatePasswordPolicyRequestSchema,
  type AccessConfiguration,
  type AdminUser,
  type AdministratorListResponse,
  type AdminUserListResponse,
  type PasswordPolicyConfiguration,
  type SetUserRoleResponse,
  type SetUserStatusResponse,
  type UpdateAdminUserResponse,
} from "@artiflow/contracts/admin";

export type AdminOptions = {
  database: Database;
  auth: ReturnType<typeof createAuth>;
  publicOrigin: string;
  config: Pick<AppConfig, "authProviders" | "secretEncryptionKey">;
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

  app.post("/api/admin/users/:id/status", async (c) => {
    const mutationRefusal = cookieMutationGuard(c, options.publicOrigin);
    if (mutationRefusal !== null)
      return jsonError(c, mutationRefusal, mutationRefusal === "origin_not_allowed" ? 403 : 415);
    const guard = await requireAdministrator(deps, c.req.raw.headers);
    if (guard.kind === "refusal") return jsonError(c, guard.error, guard.status);

    const body = await c.req.json().catch(() => null);
    const parsed = setUserStatusRequestSchema.safeParse(body);
    if (!parsed.success) return jsonError(c, "invalid_body", 400);

    const change = {
      db: options.database.db,
      userId: c.req.param("id"),
      actorId: guard.actorId,
      actorRole: guard.actorRole,
      ...(c.get("requestId") === undefined ? {} : { requestId: c.get("requestId") }),
    };
    const outcome =
      parsed.data.status === "deactivated" ? await deactivateAccount(change) : await reactivateAccount(change);
    if (outcome.kind === "missing") return jsonError(c, "user_not_found", 404);
    if (outcome.kind === "unchanged") return jsonError(c, "status_unchanged", 409);
    return c.json({ user: outcome.user } satisfies SetUserStatusResponse);
  });

  app.get("/api/admin/users", async (c) => {
    const guard = await requireAdministrator(deps, c.req.raw.headers);
    if (guard.kind === "refusal") return jsonError(c, guard.error, guard.status);
    const parsed = adminUserListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return jsonError(c, "invalid_query", 400);
    const page = await listAdminUsers({ db: options.database.db, query: parsed.data });
    return c.json(page satisfies AdminUserListResponse);
  });

  app.patch("/api/admin/users/:id", async (c) => {
    const mutationRefusal = cookieMutationGuard(c, options.publicOrigin);
    if (mutationRefusal !== null)
      return jsonError(c, mutationRefusal, mutationRefusal === "origin_not_allowed" ? 403 : 415);
    const guard = await requireAdministrator(deps, c.req.raw.headers);
    if (guard.kind === "refusal") return jsonError(c, guard.error, guard.status);

    const body = await c.req.json().catch(() => null);
    const parsed = updateAdminUserRequestSchema.safeParse(body);
    if (!parsed.success) return jsonError(c, "invalid_body", 400);

    let updated: AdminUser | null;
    try {
      updated = await updateAdminUser({
        db: options.database.db,
        userId: c.req.param("id"),
        name: parsed.data.name,
        email: parsed.data.email,
        actorId: guard.actorId,
        actorRole: guard.actorRole,
        requestId: c.get("requestId"),
      });
    } catch (error) {
      if (error instanceof AdminUserEditError)
        return jsonError(c, error.code, error.code === "email_in_use" ? 409 : 400);
      throw error;
    }
    if (updated === null) return jsonError(c, "user_not_found", 404);
    return c.json({ user: updated } satisfies UpdateAdminUserResponse);
  });

  app.get("/api/admin/access", async (c) => {
    const guard = await requireAdministrator(deps, c.req.raw.headers);
    if (guard.kind === "refusal") return jsonError(c, guard.error, guard.status);
    const configuration = await readAccessConfiguration({
      db: options.database.db,
      providers: options.config.authProviders,
    });
    return c.json(configuration satisfies AccessConfiguration);
  });

  app.put("/api/admin/access", async (c) => {
    const mutationRefusal = cookieMutationGuard(c, options.publicOrigin);
    if (mutationRefusal !== null)
      return jsonError(c, mutationRefusal, mutationRefusal === "origin_not_allowed" ? 403 : 415);
    const guard = await requireAdministrator(deps, c.req.raw.headers);
    if (guard.kind === "refusal") return jsonError(c, guard.error, guard.status);

    const body = await c.req.json().catch(() => null);
    const parsed = updateAccessConfigurationRequestSchema.safeParse(body);
    if (!parsed.success) return jsonError(c, "invalid_body", 400);

    let configuration: AccessConfiguration;
    try {
      configuration = await updateAccessConfiguration({
        db: options.database.db,
        key: options.config.secretEncryptionKey ?? null,
        change: parsed.data,
        actorId: guard.actorId,
      });
    } catch (error) {
      if (error instanceof SettingRevisionConflictError) return jsonError(c, "revision_conflict", 409);
      if (error instanceof AccessConfigurationError) return jsonError(c, error.code, 400);
      throw error;
    }

    recordAdminEvent({
      event: "access.methods.updated",
      actorId: guard.actorId,
      actorRole: guard.actorRole,
      settingKey: ACCESS_METHODS_KEY,
      outcome: "applied",
      requestId: c.get("requestId"),
    });
    return c.json(configuration satisfies AccessConfiguration);
  });

  app.get("/api/admin/password-policy", async (c) => {
    const guard = await requireAdministrator(deps, c.req.raw.headers);
    if (guard.kind === "refusal") return jsonError(c, guard.error, guard.status);
    const configuration = await readPasswordPolicyConfiguration({ db: options.database.db });
    return c.json(configuration satisfies PasswordPolicyConfiguration);
  });

  app.put("/api/admin/password-policy", async (c) => {
    const mutationRefusal = cookieMutationGuard(c, options.publicOrigin);
    if (mutationRefusal !== null)
      return jsonError(c, mutationRefusal, mutationRefusal === "origin_not_allowed" ? 403 : 415);
    const guard = await requireAdministrator(deps, c.req.raw.headers);
    if (guard.kind === "refusal") return jsonError(c, guard.error, guard.status);

    const body = await c.req.json().catch(() => null);
    const parsed = updatePasswordPolicyRequestSchema.safeParse(body);
    if (!parsed.success) return jsonError(c, "invalid_body", 400);

    let configuration: PasswordPolicyConfiguration;
    try {
      configuration = await updatePasswordPolicyConfiguration({
        db: options.database.db,
        change: parsed.data,
        actorId: guard.actorId,
      });
    } catch (error) {
      if (error instanceof SettingRevisionConflictError) return jsonError(c, "revision_conflict", 409);
      throw error;
    }

    recordAdminEvent({
      event: "password.policy.updated",
      actorId: guard.actorId,
      actorRole: guard.actorRole,
      settingKey: PASSWORD_POLICY_KEY,
      outcome: "applied",
      requestId: c.get("requestId"),
    });
    return c.json(configuration satisfies PasswordPolicyConfiguration);
  });

  return app;
}
