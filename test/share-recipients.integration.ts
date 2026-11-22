import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { artifacts } from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import {
  signInTrustedAccount,
  trustedSession,
  type TrustedFixture,
  type TrustedSession,
} from "./helpers/trusted-accounts.ts";
import { adminGet, adminPost, assertStatus, startAdminHarness, type AdminHarness } from "./helpers/admin-harness.ts";

const TEST_TIMEOUT_MS = 20_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

type ShareRow = { id: string; sharedWithUserId?: string; sharedWith: { email: string } };
type ShareList = { shares: ShareRow[] };
type SharedArtifact = { id: string; sharedBy: { email: string } };

let harness: AdminHarness | null = null;
let fixture: TrustedFixture | null = null;
let administrator: TrustedSession | null = null;
let owner: TrustedSession | null = null;
let offered: TrustedSession | null = null;
let departed: TrustedSession | null = null;
let survivor: TrustedSession | null = null;

function target(): AdminHarness {
  assert.ok(harness, "the harness started");
  return harness;
}

function actor(session: TrustedSession | null, label: string): TrustedSession {
  assert.ok(session, `the ${label} account exists`);
  return session;
}

function sharesPath(artifactId: string): string {
  return `/api/artifacts/${artifactId}/shares`;
}

function shareArtifact(artifactId: string, email: string, cookie: string): Promise<Response> {
  return adminPost(target(), sharesPath(artifactId), { email }, cookie);
}

async function sharesOf(artifactId: string, cookie: string): Promise<ShareList> {
  const response = await adminGet(target(), sharesPath(artifactId), cookie);
  assertStatus(response, 200, "the owner lists the shares of the artifact");
  return (await response.json()) as ShareList;
}

function artifactDetail(artifactId: string, cookie: string): Promise<Response> {
  return adminGet(target(), `/api/artifacts/${artifactId}`, cookie);
}

function setStatus(userId: string, status: "active" | "deactivated"): Promise<Response> {
  return adminPost(
    target(),
    `/api/admin/users/${userId}/status`,
    { status },
    actor(administrator, "administrator").cookie,
  );
}

async function seedArtifact(ownerId: string, title: string): Promise<string> {
  const artifactId = `artifact-${randomUUID()}`;
  const now = new Date();
  await target()
    .database.db.insert(artifacts)
    .values({
      id: artifactId,
      ownerId,
      title,
      kind: "markdown",
      observedSizeBytes: 12,
      createdAt: now,
      updatedAt: now,
    });
  return artifactId;
}

before(async () => {
  harness = await startAdminHarness(loadConfig(process.env));
  fixture = { database: harness.database, baseUrl: harness.baseUrl, origin: harness.config.publicOrigin };
  administrator = await trustedSession(fixture, { role: "administrator", name: "Recipients Administrator" });
  owner = await trustedSession(fixture, { name: "Sharing Owner" });
  offered = await trustedSession(fixture, { name: "Offerable Person" });
  departed = await trustedSession(fixture, { name: "Departed Person" });
  survivor = await trustedSession(fixture, { name: "Existing Reader" });
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("an active account is offered as a recipient", async () => {
  const artifactId = await seedArtifact(actor(owner, "owner").userId, "Offered recipient");
  const response = await shareArtifact(artifactId, actor(offered, "offered").email, actor(owner, "owner").cookie);
  assertStatus(response, 201, "an active account is offered as a recipient");
  const body = (await response.json()) as { id: string; sharedWith: { email: string }; createdAt: string };
  assert.equal(body.sharedWith.email, actor(offered, "offered").email, "the grant names the recipient address");
  assert.equal(typeof body.createdAt, "string", "the grant carries its creation instant");

  const listed = await sharesOf(artifactId, actor(owner, "owner").cookie);
  assert.deepEqual(
    listed.shares.map((share) => share.sharedWith.email),
    [actor(offered, "offered").email],
    "the active recipient appears in the share list",
  );
  assert.equal(listed.shares[0]?.sharedWithUserId, actor(offered, "offered").userId);
});

integration("a deactivated account is not offered as a new recipient", async () => {
  const artifactId = await seedArtifact(actor(owner, "owner").userId, "Deactivated recipient");
  assertStatus(
    await setStatus(actor(departed, "departed").userId, "deactivated"),
    200,
    "the administrator deactivates the account",
  );

  const response = await shareArtifact(artifactId, actor(departed, "departed").email, actor(owner, "owner").cookie);
  assertStatus(response, 404, "a deactivated account is not an available recipient");
  assert.deepEqual(await response.json(), { error: "recipient_not_found" });
  assert.deepEqual(
    await sharesOf(artifactId, actor(owner, "owner").cookie),
    { shares: [] },
    "the refusal grants nothing",
  );

  assertStatus(await setStatus(actor(departed, "departed").userId, "active"), 200, "reactivation restores the account");
  const later = await shareArtifact(artifactId, actor(departed, "departed").email, actor(owner, "owner").cookie);
  assertStatus(later, 201, "a reactivated account is offered again");
});

integration("an existing grant of a deactivated account keeps reading the artifact", async () => {
  const artifactId = await seedArtifact(actor(owner, "owner").userId, "Existing grant");
  const reader = actor(survivor, "survivor");

  assertStatus(
    await shareArtifact(artifactId, reader.email, actor(owner, "owner").cookie),
    201,
    "the owner shares while the account is active",
  );
  assertStatus(await artifactDetail(artifactId, reader.cookie), 200, "the recipient reads the artifact while active");

  assertStatus(await setStatus(reader.userId, "deactivated"), 200, "the administrator deactivates the reader");
  assert.deepEqual(
    (await sharesOf(artifactId, actor(owner, "owner").cookie)).shares.map((share) => share.sharedWith.email),
    [reader.email],
    "deactivation keeps the grant it did not issue",
  );
  const regrant = await shareArtifact(artifactId, reader.email, actor(owner, "owner").cookie);
  assertStatus(regrant, 404, "the deactivated account is not offered again");
  assert.deepEqual(await regrant.json(), { error: "recipient_not_found" });

  assertStatus(await setStatus(reader.userId, "active"), 200, "the account is reactivated");
  const cookie = await signInTrustedAccount(target().baseUrl, target().config.publicOrigin, {
    email: reader.email,
    password: reader.password,
  });
  assertStatus(
    await artifactDetail(artifactId, cookie),
    200,
    "the grant made before deactivation still reads the artifact",
  );
  const shared = await adminGet(target(), "/api/artifacts/shared", cookie);
  assertStatus(shared, 200, "the shared library answers");
  const listed = (await shared.json()) as { artifacts: SharedArtifact[] };
  assert.deepEqual(
    listed.artifacts.filter((artifact) => artifact.id === artifactId).map((artifact) => artifact.sharedBy.email),
    [actor(owner, "owner").email],
    "the surviving grant is the one that reads",
  );
});
