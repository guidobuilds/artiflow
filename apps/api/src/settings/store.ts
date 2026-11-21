import { and, eq, sql } from "drizzle-orm";
import type { ZodType } from "zod";

import {
  accessMethodsDocumentReadSchema,
  accessMethodsDocumentSchema,
  passwordPolicyDocumentReadSchema,
  passwordPolicyDocumentSchema,
  sessionPolicyDocumentReadSchema,
  sessionPolicyDocumentSchema,
  type AccessMethodsDocument,
  type PasswordPolicyDocument,
  type SessionPolicyDocument,
} from "@artiflow/contracts/settings";

import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import { instanceSetting } from "../adapters/postgres/db/settings-schema.ts";

type Query = AppDb | AppTx;

export const ACCESS_METHODS_KEY = "access.methods";
export const PASSWORD_POLICY_KEY = "password.policy";
export const SESSIONS_POLICY_KEY = "sessions.policy";

export type SettingDefinition<T> = {
  key: string;
  write: ZodType<T>;
  read: ZodType<T>;
};

export const accessMethodsSetting: SettingDefinition<AccessMethodsDocument> = {
  key: ACCESS_METHODS_KEY,
  write: accessMethodsDocumentSchema,
  read: accessMethodsDocumentReadSchema,
};

export const sessionPolicySetting: SettingDefinition<SessionPolicyDocument> = {
  key: SESSIONS_POLICY_KEY,
  write: sessionPolicyDocumentSchema,
  read: sessionPolicyDocumentReadSchema,
};

export const passwordPolicySetting: SettingDefinition<PasswordPolicyDocument> = {
  key: PASSWORD_POLICY_KEY,
  write: passwordPolicyDocumentSchema,
  read: passwordPolicyDocumentReadSchema,
};

export const settingDefinitions = {
  accessMethods: accessMethodsSetting,
  sessionPolicy: sessionPolicySetting,
  passwordPolicy: passwordPolicySetting,
} as const;

export type StoredSetting<T> = {
  value: T;
  revision: number;
  updatedAt: Date;
  updatedBy: string | null;
};

export type SettingIssue = { path: string; message: string };

export class SettingValidationError extends Error {
  override name = "SettingValidationError";
  readonly key: string;
  readonly issues: SettingIssue[];

  constructor(key: string, issues: SettingIssue[]) {
    super(`the ${key} setting document is invalid: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    this.key = key;
    this.issues = issues;
  }
}

export class SettingRevisionConflictError extends Error {
  override name = "SettingRevisionConflictError";
  readonly key: string;
  readonly expectedRevision: number | null;
  readonly actualRevision: number | null;

  constructor(key: string, expectedRevision: number | null, actualRevision: number | null) {
    super(
      expectedRevision === null
        ? `the ${key} setting already exists at revision ${actualRevision}; it cannot be created twice`
        : `the ${key} setting is at revision ${actualRevision}, not the expected revision ${expectedRevision}`,
    );
    this.key = key;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function issuesOf(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): SettingIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "document" : issue.path.map((part) => String(part)).join("."),
    message: issue.message,
  }));
}

async function currentRevision(db: Query, key: string): Promise<number | null> {
  const rows = await db.select({ revision: instanceSetting.revision }).from(instanceSetting).where(eq(instanceSetting.key, key));
  return rows[0]?.revision ?? null;
}

export async function readSettingsRevision(db: Query): Promise<number | null> {
  const rows = await db.select({ writes: sql<string | null>`sum(${instanceSetting.revision})` }).from(instanceSetting);
  const writes = rows[0]?.writes ?? null;
  return writes === null ? null : Number(writes);
}

export async function readSetting<T>(db: Query, definition: SettingDefinition<T>): Promise<StoredSetting<T> | null> {
  const rows = await db.select().from(instanceSetting).where(eq(instanceSetting.key, definition.key));
  const row = rows[0];
  if (row === undefined) return null;
  const parsed = definition.read.safeParse(row.value);
  if (!parsed.success) throw new SettingValidationError(definition.key, issuesOf(parsed.error));
  return { value: parsed.data, revision: row.revision, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
}

export type SettingWrite = {
  value: unknown;
  expectedRevision: number | null;
  updatedBy?: string | null;
};

export async function writeSetting<T>(
  db: Query,
  definition: SettingDefinition<T>,
  input: SettingWrite,
): Promise<StoredSetting<T>> {
  const parsed = definition.write.safeParse(input.value);
  if (!parsed.success) throw new SettingValidationError(definition.key, issuesOf(parsed.error));

  const updatedBy = input.updatedBy ?? null;
  if (input.expectedRevision === null) {
    const inserted = await db
      .insert(instanceSetting)
      .values({ key: definition.key, value: parsed.data, revision: 1, updatedAt: new Date(), updatedBy })
      .onConflictDoNothing({ target: instanceSetting.key })
      .returning();
    const row = inserted[0];
    if (row === undefined) throw new SettingRevisionConflictError(definition.key, null, await currentRevision(db, definition.key));
    return { value: parsed.data, revision: row.revision, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
  }

  const updated = await db
    .update(instanceSetting)
    .set({
      value: parsed.data,
      revision: sql`${instanceSetting.revision} + 1`,
      updatedAt: new Date(),
      updatedBy,
    })
    .where(and(eq(instanceSetting.key, definition.key), eq(instanceSetting.revision, input.expectedRevision)))
    .returning();
  const row = updated[0];
  if (row === undefined) {
    throw new SettingRevisionConflictError(definition.key, input.expectedRevision, await currentRevision(db, definition.key));
  }
  return { value: parsed.data, revision: row.revision, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
}
