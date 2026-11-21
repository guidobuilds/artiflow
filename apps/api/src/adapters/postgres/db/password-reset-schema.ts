import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./schema.ts";

const date = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const passwordResetToken = pgTable(
  "passwordResetToken",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: text("tokenHash").notNull().unique(),
    expiresAt: date("expiresAt").notNull(),
    consumedAt: date("consumedAt"),
    createdBy: text("createdBy").references(() => user.id, { onDelete: "set null" }),
    createdAt: date("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("passwordResetToken_userId_idx").on(table.userId),
    check("passwordResetToken_tokenHash_check", sql`${sql.identifier("tokenHash")} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const passwordResetSchema = { passwordResetToken };
