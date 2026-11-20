import assert from "node:assert/strict";
import { test } from "node:test";

import { adminEventLine, recordAdminEvent, type AdminEventInput } from "../apps/api/src/logging/admin-events.ts";

const at = new Date("2026-11-20T10:00:00.000Z");

const granted: AdminEventInput = {
  event: "role.granted",
  actorId: "actor-1",
  actorRole: "administrator",
  subjectId: "subject-1",
  outcome: "applied",
  requestId: "request-1",
};

test("a role change records actor, subject and outcome in one JSON line", () => {
  const parsed = JSON.parse(adminEventLine(granted, at)) as Record<string, unknown>;
  assert.deepEqual(parsed, {
    ts: "2026-11-20T10:00:00.000Z",
    level: "info",
    event: "role.granted",
    actorId: "actor-1",
    actorRole: "administrator",
    subjectId: "subject-1",
    outcome: "applied",
    requestId: "request-1",
  });
});

test("fields outside the recorded shape never reach the line", () => {
  const tainted = { ...granted, clientSecret: "leak-value", password: "leak-value", token: "leak-value" };
  const line = adminEventLine(tainted as AdminEventInput, at);
  assert.equal(line.includes("leak-value"), false, "an unlisted field cannot leak through the event");
  assert.deepEqual(Object.keys(JSON.parse(line) as Record<string, unknown>).sort(), [
    "actorId",
    "actorRole",
    "event",
    "level",
    "outcome",
    "requestId",
    "subjectId",
    "ts",
  ]);
});

test("recording an event writes exactly one line and keeps the recorded shape", () => {
  const written: string[] = [];
  recordAdminEvent({ ...granted, event: "role.revoked" }, (line) => written.push(line), at);
  assert.equal(written.length, 1);
  assert.equal(JSON.parse(written[0] ?? "{}").event, "role.revoked");
  assert.equal((written[0] ?? "").endsWith("\n"), false, "the writer receives the line without a terminator");
});
