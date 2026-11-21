import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { ACCOUNT_STATUSES } from "../../../identity/account-status.ts";
import { USER_ROLES } from "../../../identity/roles.ts";

const date = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  role: text("role", { enum: USER_ROLES }).notNull().default("member"),
  status: text("status", { enum: ACCOUNT_STATUSES }).notNull().default("active"),
  deactivatedAt: date("deactivatedAt"),
  deactivatedBy: text("deactivatedBy"),
  banned: boolean("banned").notNull().default(false),
  banReason: text("banReason"),
  banExpires: date("banExpires"),
  createdAt: date("createdAt").notNull().defaultNow(),
  updatedAt: date("updatedAt").notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: date("expiresAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    impersonatedBy: text("impersonatedBy"),
    createdAt: date("createdAt").notNull().defaultNow(),
    updatedAt: date("updatedAt").notNull().defaultNow(),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerId: text("providerId").notNull(),
    accountId: text("accountId").notNull(),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: date("accessTokenExpiresAt"),
    refreshTokenExpiresAt: date("refreshTokenExpiresAt"),
    scope: text("scope"),
    password: text("password"),
    createdAt: date("createdAt").notNull().defaultNow(),
    updatedAt: date("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    index("account_userId_idx").on(table.userId),
    uniqueIndex("account_providerId_accountId_unique").on(table.providerId, table.accountId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: date("expiresAt").notNull(),
    createdAt: date("createdAt").notNull().defaultNow(),
    updatedAt: date("updatedAt").notNull().defaultNow(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const ssoProvider = pgTable(
  "ssoProvider",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    domain: text("domain").notNull(),
    oidcConfig: text("oidcConfig"),
    samlConfig: text("samlConfig"),
    userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
    providerId: text("providerId").notNull().unique(),
    organizationId: text("organizationId"),
    createdAt: date("createdAt").notNull().defaultNow(),
    updatedAt: date("updatedAt").notNull().defaultNow(),
  },
  (table) => [index("ssoProvider_userId_idx").on(table.userId)],
);

export const authSchema = { user, session, account, verification };

export { instanceSecret, instanceSetting } from "./settings-schema.ts";
