import assert from "node:assert/strict";
import test from "node:test";

import { MigrationTargetError, assertMigrationTarget } from "../apps/api/src/adapters/postgres/db/migration-target.ts";

const LOOPBACK_URL = "postgres://artiflow:secret@127.0.0.1:5432/artiflow";
const LOCALHOST_URL = "postgres://artiflow:secret@localhost:5432/artiflow";
const REMOTE_URL = "postgresql://user:secret@db.example.com:5432/artiflow";

test("accepts any loopback PostgreSQL target", () => {
  assert.doesNotThrow(() => assertMigrationTarget(LOOPBACK_URL, false));
  assert.doesNotThrow(() => assertMigrationTarget(LOCALHOST_URL, false));
  assert.doesNotThrow(() => assertMigrationTarget("postgres://u:secret@127.0.0.1:5433/other", false));
});

test("refuses a non-loopback database target by default", () => {
  assert.throws(
    () => assertMigrationTarget(REMOTE_URL, false),
    (error: unknown) =>
      error instanceof MigrationTargetError &&
      error.message.includes("non-loopback") &&
      !error.message.includes("secret"),
  );
});

test("allows a remote database target only with the explicit opt-in", () => {
  assert.doesNotThrow(() => assertMigrationTarget(REMOTE_URL, true));
});

test("refuses malformed connection strings", () => {
  assert.throws(
    () => assertMigrationTarget("not-a-url", true),
    (error: unknown) => error instanceof MigrationTargetError && error.message.includes("postgres://"),
  );
  assert.throws(
    () => assertMigrationTarget("mysql://user:secret@db.example.com/artiflow", true),
    (error: unknown) => error instanceof MigrationTargetError && error.message.includes("postgres://"),
  );
});
