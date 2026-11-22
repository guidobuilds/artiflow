import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMIN_EVENTS,
  adminEventLine,
  recordAdminEvent,
  type AdminEventInput,
  type AdminEventName,
} from "../apps/api/src/logging/admin-events.ts";

const at = new Date("2026-11-20T10:00:00.000Z");

const NAMED_OPERATIONS = [
  "role.granted",
  "role.revoked",
  "user.registered",
  "user.updated",
  "user.deactivated",
  "user.reactivated",
  "user.purged",
  "session.revoked",
  "sessions.revoked",
  "invitation.created",
  "invitation.revoked",
  "invitation.regenerated",
  "password.reset.issued",
  "access.methods.updated",
  "access.sso.updated",
  "password.policy.updated",
  "login.fallback.used",
];

const samples: Record<AdminEventName, AdminEventInput> = {
  "role.granted": {
    event: "role.granted",
    actorId: "actor-1",
    actorRole: "administrator",
    subjectId: "subject-1",
    outcome: "applied",
  },
  "role.revoked": {
    event: "role.revoked",
    actorId: "console",
    actorRole: "console",
    subjectId: "subject-1",
    outcome: "applied",
  },
  "user.registered": {
    event: "user.registered",
    actorId: "subject-1",
    actorRole: "member",
    subjectId: "subject-1",
    outcome: "applied",
  },
  "user.updated": {
    event: "user.updated",
    actorId: "actor-1",
    actorRole: "administrator",
    subjectId: "subject-1",
    emailChange: { before: "before@example.test", after: "after@example.test" },
    outcome: "applied",
  },
  "user.deactivated": {
    event: "user.deactivated",
    actorId: "actor-1",
    actorRole: "administrator",
    subjectId: "subject-1",
    outcome: "applied",
  },
  "user.reactivated": {
    event: "user.reactivated",
    actorId: "actor-1",
    actorRole: "administrator",
    subjectId: "subject-1",
    outcome: "applied",
  },
  "user.purged": {
    event: "user.purged",
    actorId: "console",
    actorRole: "console",
    subjectId: "subject-1",
    outcome: "applied",
  },
  "session.revoked": {
    event: "session.revoked",
    actorId: "actor-1",
    actorRole: "administrator",
    subjectId: "subject-1",
    sessionId: "session-1",
    outcome: "applied",
  },
  "sessions.revoked": {
    event: "sessions.revoked",
    actorId: "actor-1",
    actorRole: "administrator",
    subjectId: "subject-1",
    outcome: "applied",
  },
  "invitation.created": {
    event: "invitation.created",
    actorId: "actor-1",
    actorRole: "administrator",
    subjectId: "invitation-1",
    outcome: "applied",
  },
  "invitation.revoked": {
    event: "invitation.revoked",
    actorId: "actor-1",
    actorRole: "administrator",
    subjectId: "invitation-1",
    outcome: "applied",
  },
  "invitation.regenerated": {
    event: "invitation.regenerated",
    actorId: "actor-1",
    actorRole: "administrator",
    subjectId: "invitation-2",
    outcome: "applied",
  },
  "password.reset.issued": {
    event: "password.reset.issued",
    actorId: "console",
    actorRole: "console",
    subjectId: "subject-1",
    outcome: "applied",
  },
  "access.methods.updated": {
    event: "access.methods.updated",
    actorId: "actor-1",
    actorRole: "administrator",
    settingKey: "access.methods",
    outcome: "applied",
  },
  "access.sso.updated": {
    event: "access.sso.updated",
    actorId: "actor-1",
    actorRole: "administrator",
    settingKey: "access.sso",
    outcome: "applied",
  },
  "password.policy.updated": {
    event: "password.policy.updated",
    actorId: "actor-1",
    actorRole: "administrator",
    settingKey: "password.policy",
    outcome: "applied",
  },
  "login.fallback.used": {
    event: "login.fallback.used",
    actorId: "subject-1",
    actorRole: "member",
    subjectId: "subject-1",
    outcome: "refused",
  },
};

test("the closed union names exactly the audited operations", () => {
  assert.deepEqual([...ADMIN_EVENTS].sort(), [...NAMED_OPERATIONS].sort());
});

test("a role change records actor, subject and outcome in one JSON line", () => {
  const parsed = JSON.parse(
    adminEventLine(
      {
        event: "role.granted",
        actorId: "actor-1",
        actorRole: "administrator",
        subjectId: "subject-1",
        outcome: "applied",
        requestId: "request-1",
      },
      at,
    ),
  ) as Record<string, unknown>;
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

test("every closed event names its actor, its subject and its outcome on one line", () => {
  for (const name of ADMIN_EVENTS) {
    const parsed = JSON.parse(adminEventLine(samples[name], at)) as Record<string, unknown>;
    assert.equal(parsed.event, name, `${name} keeps its own name`);
    assert.equal(typeof parsed.actorId, "string", `${name} names the actor`);
    assert.equal(typeof parsed.actorRole, "string", `${name} names the actor role`);
    assert.equal(
      typeof (parsed.subjectId ?? parsed.settingKey),
      "string",
      `${name} names its subject, or the setting it changes`,
    );
    assert.equal(parsed.outcome, samples[name].outcome, `${name} names the outcome`);
    assert.equal(typeof parsed.ts, "string", `${name} carries a timestamp`);
    for (const forbidden of ["password", "token", "link", "body", "secret"]) {
      assert.equal(forbidden in parsed, false, `${name} carries no ${forbidden} field`);
    }
  }
});

test("fields outside the recorded shape never reach the line", () => {
  const tainted = {
    ...samples["role.granted"],
    clientSecret: "leak-value",
    password: "leak-value",
    token: "leak-value",
  };
  const line = adminEventLine(tainted as AdminEventInput, at);
  assert.equal(line.includes("leak-value"), false, "an unlisted field cannot leak through the event");
  assert.deepEqual(Object.keys(JSON.parse(line) as Record<string, unknown>).sort(), [
    "actorId",
    "actorRole",
    "event",
    "level",
    "outcome",
    "subjectId",
    "ts",
  ]);
});

test("a tainted request body cannot add an invitation link or a credential to any event", () => {
  const forbidden = ["leak-password", "leak-token", "leak-link", "leak-body"];
  for (const name of ADMIN_EVENTS) {
    const tainted = {
      ...samples[name],
      password: forbidden[0],
      token: forbidden[1],
      link: forbidden[2],
      body: { password: forbidden[0], refreshToken: forbidden[1], url: forbidden[2], raw: forbidden[3] },
    } as unknown as AdminEventInput;
    const line = adminEventLine(tainted, at);
    for (const value of forbidden) {
      assert.equal(line.includes(value), false, `${name} keeps ${value} out of the line`);
    }
  }
});

test("recording an event writes exactly one line and keeps the recorded shape", () => {
  const written: string[] = [];
  recordAdminEvent(samples["role.revoked"], (line) => written.push(line), at);
  assert.equal(written.length, 1);
  assert.equal(JSON.parse(written[0] ?? "{}").event, "role.revoked");
  assert.equal((written[0] ?? "").endsWith("\n"), false, "the writer receives the line without a terminator");
});

test("the fallback event records a refused and an admitted attempt in the same closed shape", () => {
  const refused = JSON.parse(adminEventLine(samples["login.fallback.used"], at)) as Record<string, unknown>;
  const admitted = JSON.parse(adminEventLine({ ...samples["login.fallback.used"], outcome: "applied" }, at)) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(refused).sort(), Object.keys(admitted).sort());
  assert.equal(refused.outcome, "refused");
  assert.equal(admitted.outcome, "applied");
  assert.equal(refused.event, "login.fallback.used");
});

test("an unattributed fallback attempt keeps the same keys and names no account", () => {
  const line = JSON.parse(
    adminEventLine(
      {
        event: "login.fallback.used",
        actorId: "unattributed",
        actorRole: "anonymous",
        subjectId: "unattributed",
        outcome: "refused",
      },
      at,
    ),
  ) as Record<string, unknown>;
  assert.equal(line.actorId, "unattributed");
  assert.equal(line.actorRole, "anonymous");
  assert.deepEqual(Object.keys(line).sort(), ["actorId", "actorRole", "event", "level", "outcome", "subjectId", "ts"]);
});
