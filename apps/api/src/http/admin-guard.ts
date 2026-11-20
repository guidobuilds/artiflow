import { eq } from "drizzle-orm";

import { user } from "../adapters/postgres/db/schema.ts";
import type { Database } from "../adapters/postgres/db/client.ts";
import type { createAuth } from "../auth.ts";
import { ADMINISTRATOR_ROLE, isAdministrator } from "../identity/roles.ts";
import { sessionUserId } from "./index.ts";

export type GuardedActor = { kind: "actor"; actorId: string; actorRole: typeof ADMINISTRATOR_ROLE };

export type GuardRefusal = {
  kind: "refusal";
  status: 401 | 403;
  error: "sign_in_required" | "administrator_required";
};

export async function requireAdministrator(
  deps: { auth: ReturnType<typeof createAuth>; database: Database },
  headers: Headers,
): Promise<GuardedActor | GuardRefusal> {
  const actorId = await sessionUserId(deps.auth, headers);
  if (actorId === null) return { kind: "refusal", status: 401, error: "sign_in_required" };
  const rows = await deps.database.db
    .select({ role: user.role, banned: user.banned })
    .from(user)
    .where(eq(user.id, actorId))
    .limit(1);
  const account = rows[0];
  if (account === undefined || !isAdministrator(account.role) || account.banned) {
    return { kind: "refusal", status: 403, error: "administrator_required" };
  }
  return { kind: "actor", actorId, actorRole: ADMINISTRATOR_ROLE };
}
