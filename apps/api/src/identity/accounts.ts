import { eq } from "drizzle-orm";

import { user } from "../adapters/postgres/db/schema.ts";
import type { AppDb } from "../adapters/postgres/db/client.ts";
import { isActiveAccount } from "./account-status.ts";

export async function accountIsActive(db: AppDb, userId: string): Promise<boolean> {
  const rows = await db.select({ status: user.status }).from(user).where(eq(user.id, userId)).limit(1);
  return isActiveAccount(rows[0]?.status);
}
