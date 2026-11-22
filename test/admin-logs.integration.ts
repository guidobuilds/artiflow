import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { loadConfig } from "../apps/api/src/config.ts";
import { session, user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { decodeSecretKey } from "../apps/api/src/settings/secrets.ts";
import { recordConsoleAdminEvent } from "../apps/api/src/logging/admin-events.ts";
import { DEFAULT_PASSWORD_POLICY } from "@artiflow/contracts/settings";
import {
  adminGet,
  adminPatch,
  adminPost,
  adminRequest,
  startAdminHarness,
  type AdminHarness,
} from "./helpers/admin-harness.ts";
import {
  seedTrustedAccount,
  trustedSession,
  type TrustedFixture,
  type TrustedSession,
} from "./helpers/trusted-accounts.ts";
import { completeSocialSignIn, seedSocialIdentity } from "./helpers/social-sign-in.ts";
import {
  assertAttributed,
  assertNoSensitiveContent,
  captureAudit,
  singleEventNamed,
  type AuditLine,
} from "./helpers/audit.ts";

const TEST_TIMEOUT_MS = 30_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

const REGISTRATION_COMPLETE_PATH = "/api/auth/registration/complete";
const SIGN_IN_PATH = "/api/auth/sign-in/email";
const REGISTRATION_TOKEN_MARKER = "#token=";
const KEY = decodeSecretKey(randomBytes(32).toString("base64"));
const SSO_ISSUER = `https://idp-${randomUUID().slice(0, 8)}.example.test/tenant-a`;
const SSO_CLIENT_ID = `artiflow-client-${randomUUID()}`;
const SSO_CLIENT_SECRET = `oidc-client-secret-${randomUUID()}`;
const DISCOVERY_SUFFIX = "/.well-known/openid-configuration";

type Settings = {
  administrator: TrustedSession;
  member: TrustedSession;
  editedEmail: string;
  promotedEmail: string;
  deactivatedEmail: string;
  invitedEmail: string;
  newcomerEmail: string;
  newcomerPassword: string;
};

let harness: AdminHarness | null = null;
let fixture: TrustedFixture | null = null;
let settings: Settings | null = null;
const observed: AuditLine[] = [];

function target(): AdminHarness {
  assert.ok(harness, "the harness started");
  return harness;
}

function fixtureOf(): TrustedFixture {
  assert.ok(fixture, "the fixture started");
  return fixture;
}

function seeded(): Settings {
  assert.ok(settings, "the fixture seeded");
  return settings;
}

async function capture<T>(run: () => Promise<T>): Promise<{ result: T; lines: AuditLine[] }> {
  const captured = await captureAudit(run);
  observed.push(...captured.lines);
  return captured;
}

function singleLine(captured: { lines: AuditLine[] }, event: string): AuditLine {
  assert.equal(captured.lines.length, 1, `one operation writes exactly one line, found ${captured.lines.length}`);
  const line = captured.lines[0] ?? {};
  assert.equal(line.event, event);
  return line;
}

function tokenOfLink(link: string): string {
  const marker = link.indexOf(REGISTRATION_TOKEN_MARKER);
  assert.equal(marker > 0, true, `the answer carries a link with a token: ${link}`);
  return link.slice(marker + REGISTRATION_TOKEN_MARKER.length);
}

async function seedAccount(email: string, name: string): Promise<void> {
  await seedTrustedAccount(target().database, { email, name });
}

async function withDiscovery<T>(run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith(DISCOVERY_SUFFIX)) return await real(input as Parameters<typeof real>[0], init);
    return new Response(JSON.stringify({ issuer: SSO_ISSUER, authorization_endpoint: `${SSO_ISSUER}/authorize` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

function passwordSignIn(email: string, password: string): Promise<Response> {
  return adminRequest(target(), SIGN_IN_PATH, {
    method: "POST",
    headers: { origin: target().config.publicOrigin, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

before(async () => {
  const base = loadConfig(process.env);
  harness = await startAdminHarness({ ...base, secretEncryptionKey: KEY });
  fixture = { database: harness.database, baseUrl: harness.baseUrl, origin: harness.config.publicOrigin };
  const administrator = await trustedSession(fixtureOf(), { role: "administrator", name: "Logging Administrator" });
  const member = await trustedSession(fixtureOf(), { name: "Logging Member" });
  const suffix = randomUUID();
  await seedAccount(`edited-${suffix}@example.test`, "Logged Before Editing");
  await seedAccount(`promoted-${suffix}@example.test`, "Logged To Be Promoted");
  await seedAccount(`deactivated-${suffix}@example.test`, "Logged To Be Deactivated");
  settings = {
    administrator,
    member,
    editedEmail: `edited-${suffix}@example.test`,
    promotedEmail: `promoted-${suffix}@example.test`,
    deactivatedEmail: `deactivated-${suffix}@example.test`,
    invitedEmail: `invited-${suffix}@example.test`,
    newcomerEmail: `newcomer-${suffix}@example.test`,
    newcomerPassword: `Newcomer-Pass-${randomUUID()}`,
  };
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("every administration operation the specification names writes exactly one attributed line", async () => {
  const state = seeded();
  const actor = state.administrator;
  const directory = (await (await adminGet(target(), "/api/admin/users?pageSize=100", actor.cookie)).json()) as {
    users: { id: string; email: string }[];
  };
  const idOf = (email: string): string => {
    const row = directory.users.find((entry) => entry.email === email);
    assert.ok(row, `the directory lists ${email}`);
    return row.id;
  };

  const edited = await capture(() =>
    adminPatch(
      target(),
      `/api/admin/users/${idOf(state.editedEmail)}`,
      { name: "Logged After Editing", email: `renamed-${randomUUID()}@example.test` },
      actor.cookie,
    ),
  );
  assert.equal(edited.result.status, 200, "the edit is applied");
  assertAttributed(singleLine(edited, "user.updated"), {
    actorId: actor.userId,
    subjectId: idOf(state.editedEmail),
    outcome: "applied",
  });

  const promoted = await capture(() =>
    adminPost(target(), `/api/admin/users/${idOf(state.promotedEmail)}/role`, { role: "administrator" }, actor.cookie),
  );
  assert.equal(promoted.result.status, 200, "the role change is applied");
  assertAttributed(singleLine(promoted, "role.granted"), {
    actorId: actor.userId,
    subjectId: idOf(state.promotedEmail),
    outcome: "applied",
  });

  const deactivated = await capture(() =>
    adminPost(
      target(),
      `/api/admin/users/${idOf(state.deactivatedEmail)}/status`,
      { status: "deactivated" },
      actor.cookie,
    ),
  );
  assert.equal(deactivated.result.status, 200, "the deactivation is applied");
  assertAttributed(singleLine(deactivated, "user.deactivated"), {
    actorId: actor.userId,
    subjectId: idOf(state.deactivatedEmail),
    outcome: "applied",
  });

  const marked = await trustedSession(fixtureOf(), {
    email: `marked-${randomUUID()}@example.test`,
    name: "Logged For A Session",
  });
  const listed = (await (
    await adminGet(target(), `/api/admin/users/${marked.userId}/sessions`, actor.cookie)
  ).json()) as { sessions: { id: string }[] };
  const listedSession = listed.sessions[0];
  assert.ok(listedSession, "the account lists a session to close");
  const closed = await capture(() =>
    adminPost(target(), `/api/admin/users/${marked.userId}/sessions/${listedSession.id}/revoke`, {}, actor.cookie),
  );
  assert.equal(closed.result.status, 200, "the session is closed");
  const closedLine = singleLine(closed, "session.revoked");
  assertAttributed(closedLine, { actorId: actor.userId, subjectId: marked.userId, outcome: "applied" });
  assert.equal(closedLine.sessionId, listedSession.id, "the line names the closed session");

  const invited = await capture(() =>
    adminPost(target(), "/api/admin/invitations", { email: state.invitedEmail }, actor.cookie),
  );
  assert.equal(invited.result.status, 200, "the invitation is issued");
  const invitedAnswer = (await invited.result.json()) as { invitation: { id: string }; link: string };
  const createdLine = singleLine(invited, "invitation.created");
  assertAttributed(createdLine, { actorId: actor.userId, subjectId: invitedAnswer.invitation.id, outcome: "applied" });
  assert.equal(
    observed.some((line) => JSON.stringify(line).includes(tokenOfLink(invitedAnswer.link))),
    false,
    "the issuance line carries no link",
  );

  const revoked = await capture(() =>
    adminPost(target(), `/api/admin/invitations/${invitedAnswer.invitation.id}/revoke`, {}, actor.cookie),
  );
  assert.equal(revoked.result.status, 200, "the invitation is revoked");
  assertAttributed(singleLine(revoked, "invitation.revoked"), {
    actorId: actor.userId,
    subjectId: invitedAnswer.invitation.id,
    outcome: "applied",
  });

  const reset = await capture(() =>
    adminPost(target(), "/api/admin/reset-links", { email: state.member.email }, actor.cookie),
  );
  assert.equal(reset.result.status, 200, "the reset link is issued");
  const resetAnswer = (await reset.result.json()) as { link: string };
  assertAttributed(singleLine(reset, "password.reset.issued"), {
    actorId: actor.userId,
    subjectId: state.member.userId,
    outcome: "applied",
  });
  assert.equal(
    observed.some((line) => JSON.stringify(line).includes(tokenOfLink(resetAnswer.link))),
    false,
    "the reset line carries no link",
  );

  const methods = await capture(() =>
    adminRequest(target(), "/api/admin/access", {
      method: "PUT",
      headers: { cookie: actor.cookie, origin: target().config.publicOrigin, "content-type": "application/json" },
      body: JSON.stringify({
        revision: null,
        passwordEnabled: true,
        providers: {
          google: { enabled: false, clientId: "" },
          github: { enabled: false, clientId: "" },
        },
      }),
    }),
  );
  assert.equal(methods.result.status, 200, "the access configuration is saved");
  assertAttributed(singleLine(methods, "access.methods.updated"), { actorId: actor.userId, outcome: "applied" });
  assert.equal(singleLine(methods, "access.methods.updated").settingKey, "access.methods");

  const policy = await capture(() =>
    adminRequest(target(), "/api/admin/password-policy", {
      method: "PUT",
      headers: { cookie: actor.cookie, origin: target().config.publicOrigin, "content-type": "application/json" },
      body: JSON.stringify({ revision: null, policy: { ...DEFAULT_PASSWORD_POLICY } }),
    }),
  );
  assert.equal(policy.result.status, 200, "the password policy is saved");
  assertAttributed(singleLine(policy, "password.policy.updated"), { actorId: actor.userId, outcome: "applied" });
  assert.equal(singleLine(policy, "password.policy.updated").settingKey, "password.policy");

  const connection = await capture(() =>
    withDiscovery(() =>
      adminRequest(target(), "/api/admin/sso", {
        method: "PUT",
        headers: { cookie: actor.cookie, origin: target().config.publicOrigin, "content-type": "application/json" },
        body: JSON.stringify({
          revision: null,
          enabled: true,
          displayName: "Acme Workforce",
          issuer: SSO_ISSUER,
          clientId: SSO_CLIENT_ID,
          clientSecret: SSO_CLIENT_SECRET,
          scopes: ["openid", "profile", "email"],
          jitProvisioning: true,
          allowedDomains: ["example.test"],
          acceptAnyAccount: false,
        }),
      }),
    ),
  );
  assert.equal(connection.result.status, 200, "the connection is saved with just-in-time provisioning on");
  assertAttributed(singleLine(connection, "access.sso.updated"), { actorId: actor.userId, outcome: "applied" });
  assert.equal(singleLine(connection, "access.sso.updated").settingKey, "access.sso");
  assert.equal(
    JSON.stringify(observed).includes(SSO_CLIENT_SECRET),
    false,
    "the connection line carries no credential",
  );
});

integration("signing up through an invitation writes exactly one line naming the new account", async () => {
  const state = seeded();
  const issued = await capture(() =>
    adminPost(target(), "/api/admin/invitations", { email: state.newcomerEmail }, state.administrator.cookie),
  );
  const issuedAnswer = (await issued.result.json()) as { link: string };
  const token = tokenOfLink(issuedAnswer.link);

  const completed = await capture(() =>
    adminRequest(target(), REGISTRATION_COMPLETE_PATH, {
      method: "POST",
      headers: { origin: target().config.publicOrigin, "content-type": "application/json" },
      body: JSON.stringify({ token, name: "Newcomer Person", password: state.newcomerPassword }),
    }),
  );
  assert.equal(completed.result.status, 200, `the registration completes: ${await completed.result.clone().text()}`);

  const rows = await target().database.db.select({ id: user.id }).from(user).where(eq(user.email, state.newcomerEmail));
  const created = rows[0];
  assert.ok(created, "the completing person holds an account");

  const line = singleEventNamed(completed.lines, "user.registered");
  assertAttributed(line, { actorId: created.id, subjectId: created.id, outcome: "applied" });
  assert.equal(line.actorRole, "member", "a sign-up never grants a role");
  assert.equal(JSON.stringify(observed).includes(token), false, "the completion line carries no link");
  assert.equal(JSON.stringify(observed).includes(state.newcomerPassword), false, "no line carries the password");
});

integration("the emergency fallback writes exactly one line per attempt while the connection is enabled", async () => {
  const state = seeded();

  const enabled = (await (await adminGet(target(), "/api/admin/sso", state.administrator.cookie)).json()) as {
    connection: { enabled: boolean };
  };
  assert.equal(enabled.connection.enabled, true, "the connection is enabled before the fallback is exercised");

  const admitted = await capture(() => passwordSignIn(state.administrator.email, state.administrator.password));
  assert.equal(admitted.result.status, 200, "an administrator is admitted by the fallback");
  assertAttributed(singleLine(admitted, "login.fallback.used"), {
    actorId: state.administrator.userId,
    subjectId: state.administrator.userId,
    outcome: "applied",
  });

  const refused = await capture(() => passwordSignIn(state.member.email, state.member.password));
  assert.equal(refused.result.status, 401, "a member is refused by the fallback");
  const refusedLine = singleLine(refused, "login.fallback.used");
  assertAttributed(refusedLine, { actorId: state.member.userId, subjectId: state.member.userId, outcome: "refused" });
  assert.equal(refusedLine.actorRole, "member", "the refused line names the attempted role");

  const unknown = `unknown-${randomUUID()}@example.test`;
  const unattributed = await capture(() => passwordSignIn(unknown, `Pass-${randomUUID()}`));
  assert.equal(unattributed.result.status, 401, "an unknown address is refused");
  const anonymous = singleLine(unattributed, "login.fallback.used");
  assert.equal(anonymous.actorId, "unattributed");
  assert.equal(anonymous.actorRole, "anonymous");
  assert.equal(anonymous.outcome, "refused");
  assert.deepEqual(Object.keys(anonymous).sort(), Object.keys(refusedLine).sort(), "the shape stays closed");
  assert.equal(JSON.stringify(anonymous).includes(unknown), false, "the refused line carries no address");
});

integration("a social sign-in through the fallback writes one line per attempt at the lock", async () => {
  const state = seeded();
  const current = (await (await adminGet(target(), "/api/admin/access", state.administrator.cookie)).json()) as {
    revision: number;
  };
  const enabled = await capture(() =>
    adminRequest(target(), "/api/admin/access", {
      method: "PUT",
      headers: {
        cookie: state.administrator.cookie,
        origin: target().config.publicOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        revision: current.revision,
        passwordEnabled: true,
        providers: {
          google: { enabled: false, clientId: "" },
          github: {
            enabled: true,
            clientId: `github-client-${randomUUID()}`,
            clientSecret: `github-secret-${randomUUID()}`,
          },
        },
      }),
    }),
  );
  assert.equal(enabled.result.status, 200, "the social provider is administrable again");
  assert.equal(singleLine(enabled, "access.methods.updated").settingKey, "access.methods");

  const administrator = await seedSocialIdentity(target().database, {
    role: "administrator",
    name: "Social Administrator",
  });
  const member = await seedSocialIdentity(target().database, { role: "member", name: "Social Member" });

  const admitted = await capture(() => completeSocialSignIn(fixtureOf(), administrator));
  assert.equal(admitted.result.sessionPairs.length > 0, true, "the administrator keeps the social session");
  assertAttributed(singleLine(admitted, "login.fallback.used"), {
    actorId: administrator.userId,
    subjectId: administrator.userId,
    outcome: "applied",
  });

  const refused = await capture(() => completeSocialSignIn(fixtureOf(), member));
  assert.equal(refused.result.cookie, "", "the lock strips the cookie of the refused social session");
  assertAttributed(singleLine(refused, "login.fallback.used"), {
    actorId: member.userId,
    subjectId: member.userId,
    outcome: "refused",
  });
  const stored = await target()
    .database.db.select({ id: session.id })
    .from(session)
    .where(eq(session.userId, member.userId));
  assert.deepEqual(stored, [], "the refused social session leaves no row");
});

integration("the console recorder writes its line to stderr and leaves stdout for the answer", async () => {
  const stderr: string[] = [];
  const stdout: string[] = [];
  const originalError = process.stderr.write.bind(process.stderr);
  const originalOutput = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    recordConsoleAdminEvent(
      {
        event: "invitation.created",
        actorId: "console",
        actorRole: "console",
        subjectId: "invitation-issued-from-the-console",
        outcome: "applied",
      },
      new Date(0),
    );
  } finally {
    process.stderr.write = originalError;
    process.stdout.write = originalOutput;
  }

  assert.equal(stdout.join(""), "", "the console answer keeps stdout to itself");
  assert.equal(stderr.join("").endsWith("\n"), true, "the line is newline terminated");
  const lines = stderr
    .join("")
    .split("\n")
    .filter((line) => line !== "");
  assert.equal(lines.length, 1, "one operation writes exactly one line");
  const line = JSON.parse(lines[0] ?? "") as AuditLine;
  assert.deepEqual(Object.keys(line), ["ts", "level", "event", "actorId", "actorRole", "subjectId", "outcome"]);
  assert.equal(line.ts, new Date(0).toISOString());
  assert.equal(line.event, "invitation.created");
  assert.equal(line.actorId, "console");
  assert.equal(line.actorRole, "console");
  assert.equal(line.outcome, "applied");
});

integration("no recorded line carries a credential, a token, a link or a request body", async () => {
  const state = seeded();
  const sessionTokens = (await target().database.db.select({ token: session.token }).from(session)).map(
    (row) => row.token,
  );
  assert.equal(sessionTokens.length > 0, true, "the fixture holds sessions");
  assert.equal(observed.length > 0, true, "the walk recorded lines");
  assertNoSensitiveContent(observed, [
    state.administrator.password,
    state.member.password,
    state.newcomerPassword,
    SSO_CLIENT_SECRET,
    ...sessionTokens,
  ]);
  for (const line of observed) {
    assert.equal(typeof line.event, "string", "every line names an event");
    assert.equal(typeof line.outcome, "string", "every line names an outcome");
  }
});
