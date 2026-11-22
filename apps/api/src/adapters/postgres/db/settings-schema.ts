import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const date = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const instanceSetting = pgTable("instanceSetting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: date("updatedAt").notNull().defaultNow(),
  updatedBy: text("updatedBy"),
});

export const instanceSecret = pgTable("instanceSecret", {
  name: text("name").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  updatedAt: date("updatedAt").notNull().defaultNow(),
  updatedBy: text("updatedBy"),
});

export const settingsSchema = { instanceSetting, instanceSecret };
