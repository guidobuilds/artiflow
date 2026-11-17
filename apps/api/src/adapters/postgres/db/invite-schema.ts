import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const date = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const registrationInvite = pgTable(
  "registrationInvite",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    tokenHash: text("tokenHash").notNull().unique(),
    expiresAt: date("expiresAt").notNull(),
    consumedAt: date("consumedAt"),
    createdAt: date("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("registrationInvite_email_idx").on(table.email),
    check("registrationInvite_tokenHash_check", sql`${sql.identifier("tokenHash")} ~ '^[0-9a-f]{64}$'`),
    check("registrationInvite_email_check", sql`${sql.identifier("email")} = lower(btrim(${sql.identifier("email")}))`),
  ],
);

export const inviteSchema = { registrationInvite };
