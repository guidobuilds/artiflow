import { Hono } from "hono";

import type {
  AccountSessionListResponse,
  RevokeAccountSessionResponse,
  RevokeOtherAccountSessionsResponse,
} from "@artiflow/contracts/account";

import type { Database } from "../adapters/postgres/db/client.ts";
import type { createAuth } from "../auth.ts";
import { listOwnedSessions, revokeOtherOwnedSessions, revokeOwnedSession } from "../account/sessions.ts";
import { authenticatedSession, cookieMutationGuard, jsonError } from "../http/index.ts";

export type AccountSessionsOptions = {
  database: Database;
  auth: ReturnType<typeof createAuth>;
  publicOrigin: string;
};

export function createAccountSessionsApp(options: AccountSessionsOptions): Hono {
  const app = new Hono();

  app.get("/api/account/sessions", async (c) => {
    const identity = await authenticatedSession(options.auth, c.req.raw.headers);
    if (identity === null) return jsonError(c, "sign_in_required", 401);
    const sessions = await listOwnedSessions({
      db: options.database.db,
      userId: identity.userId,
      currentSessionId: identity.sessionId,
    });
    return c.json({ sessions } satisfies AccountSessionListResponse);
  });

  app.post("/api/account/sessions/revoke-others", async (c) => {
    const mutationRefusal = cookieMutationGuard(c, options.publicOrigin);
    if (mutationRefusal !== null)
      return jsonError(c, mutationRefusal, mutationRefusal === "origin_not_allowed" ? 403 : 415);
    const identity = await authenticatedSession(options.auth, c.req.raw.headers);
    if (identity === null) return jsonError(c, "sign_in_required", 401);
    const revoked = await revokeOtherOwnedSessions({
      db: options.database.db,
      userId: identity.userId,
      keepSessionId: identity.sessionId,
    });
    return c.json({ revoked } satisfies RevokeOtherAccountSessionsResponse);
  });

  app.post("/api/account/sessions/:id/revoke", async (c) => {
    const mutationRefusal = cookieMutationGuard(c, options.publicOrigin);
    if (mutationRefusal !== null)
      return jsonError(c, mutationRefusal, mutationRefusal === "origin_not_allowed" ? 403 : 415);
    const identity = await authenticatedSession(options.auth, c.req.raw.headers);
    if (identity === null) return jsonError(c, "sign_in_required", 401);
    const sessionId = c.req.param("id");
    const revoked = await revokeOwnedSession({ db: options.database.db, userId: identity.userId, sessionId });
    if (!revoked) return jsonError(c, "session_not_found", 404);
    return c.json({ session: { id: sessionId } } satisfies RevokeAccountSessionResponse);
  });

  return app;
}
