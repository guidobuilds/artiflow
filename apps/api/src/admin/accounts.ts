import { sql } from "drizzle-orm";

import { user } from "../adapters/postgres/db/schema.ts";
import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import type { AccountStatus } from "../identity/account-status.ts";

export type AccountLookup = { id: string; status: AccountStatus };

export async function findAccountByEmail(db: AppDb | AppTx, email: string): Promise<AccountLookup | null> {
  const rows = await db
    .select({ id: user.id, status: user.status })
    .from(user)
    .where(sql`lower(btrim(${user.email})) = ${email}`)
    .limit(1);
  return rows[0] ?? null;
}
