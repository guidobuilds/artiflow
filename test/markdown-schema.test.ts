import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import {
  ARTIFACT_KINDS,
  DEFAULT_ARTIFACT_KIND,
  DEFAULT_SHARE_ROLE,
  SHARE_ROLES,
  artifactSchema,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";

const tables = artifactSchema as unknown as Record<string, PgTable>;
const columnsOf = (name: string) =>
  new Map(getTableConfig(tables[name] as PgTable).columns.map((column) => [column.name, column]));
const checkNames = (name: string) =>
  getTableConfig(tables[name] as PgTable).checks.map((constraint) => constraint.name);

const drizzleDir = new URL("../drizzle/", import.meta.url);
const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", drizzleDir), "utf8")) as {
  entries: { idx: number; tag: string }[];
};
const kindMigrationTag = journal.entries
  .map((entry) => entry.tag)
  .find((tag) => readFileSync(new URL(`${tag}.sql`, drizzleDir), "utf8").includes("artifacts_kind_check"));
const latestSql = readFileSync(new URL(`${kindMigrationTag}.sql`, drizzleDir), "utf8");

test("artifact kind is a defaulted, database-checked enum", () => {
  assert.deepEqual([...ARTIFACT_KINDS], ["html", "markdown"]);
  assert.equal(DEFAULT_ARTIFACT_KIND, "html");
  const kind = columnsOf("artifacts").get("kind");
  assert.ok(kind, "artifacts.kind exists");
  assert.equal(kind.notNull, true, "kind is NOT NULL");
  assert.equal(kind.hasDefault, true, "kind has a default");
  assert.equal(kind.default, "html", "existing artifacts stay html");
  assert.deepEqual(
    checkNames("artifacts").filter((name) => name === "artifacts_kind_check"),
    ["artifacts_kind_check"],
  );
});

test("share role is a defaulted, database-checked enum", () => {
  assert.deepEqual([...SHARE_ROLES], ["reader", "editor", "commenter"]);
  assert.equal(DEFAULT_SHARE_ROLE, "reader");
  const role = columnsOf("artifactShares").get("role");
  assert.ok(role, "artifactShares.role exists");
  assert.equal(role.notNull, true, "role is NOT NULL");
  assert.equal(role.hasDefault, true, "role has a default");
  assert.equal(role.default, "reader", "existing grants stay read-only");
  assert.deepEqual(
    checkNames("artifactShares").filter((name) => name === "artifactShares_role_check"),
    ["artifactShares_role_check"],
  );
});

test("the kind and role migration carries the DDL with its defaults and checks", () => {
  assert.ok(kindMigrationTag, "a migration with artifacts_kind_check exists");
  const clauses = [
    `ALTER TABLE "artifacts" ADD COLUMN "kind" text DEFAULT 'html' NOT NULL`,
    `ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_kind_check" CHECK ("kind" in ('html', 'markdown'))`,
    `ALTER TABLE "artifactShares" ADD COLUMN "role" text DEFAULT 'reader' NOT NULL`,
    `ALTER TABLE "artifactShares" ADD CONSTRAINT "artifactShares_role_check" CHECK ("role" in ('reader', 'editor', 'commenter'))`,
  ];
  for (const clause of clauses) assert.ok(latestSql.includes(clause), clause);
});
