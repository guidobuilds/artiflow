import assert from "node:assert/strict";
import { test } from "node:test";

import { artifactSchema } from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import {
  authSchema as adapterSchema,
  registrationAuthSchema,
} from "../apps/api/src/adapters/postgres/db/auth-schema.ts";
import { appSchema } from "../apps/api/src/adapters/postgres/db/app-schema.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";

const AUTH_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "oauthClient",
  "oauthResource",
  "oauthClientResource",
  "oauthRefreshToken",
  "oauthAccessToken",
  "oauthConsent",
  "oauthClientAssertion",
  "jwks",
];
const PRODUCT_TABLES = [
  "artifacts",
  "artifactRevisions",
  "artifactUploads",
  "artifactChunks",
  "artifactShares",
  "artifactPublicLinks",
  "artifactComments",
];

test("the runtime aggregate exposes every auth, oauth and product table", () => {
  assert.deepEqual(Object.keys(appSchema).sort(), [...AUTH_TABLES, ...PRODUCT_TABLES].sort());
  for (const name of PRODUCT_TABLES) {
    assert.equal(
      (appSchema as Record<string, unknown>)[name],
      (artifactSchema as Record<string, unknown>)[name],
      `${name} identity`,
    );
  }
  for (const name of AUTH_TABLES) {
    assert.equal(
      (appSchema as Record<string, unknown>)[name],
      (adapterSchema as Record<string, unknown>)[name],
      `${name} identity`,
    );
  }
});

test("the invitation adapter bundle adds its table without touching the runtime aggregates", () => {
  assert.deepEqual(
    Object.keys(registrationAuthSchema).sort(),
    [...AUTH_TABLES, "registrationInvite", "passwordResetToken"].sort(),
  );
  for (const name of AUTH_TABLES) {
    assert.equal(
      (registrationAuthSchema as Record<string, unknown>)[name],
      (adapterSchema as Record<string, unknown>)[name],
      `${name} identity`,
    );
  }
  assert.equal("registrationInvite" in appSchema, false, "invitation storage stays out of the runtime aggregate");
  assert.equal("registrationInvite" in adapterSchema, false, "invitation storage stays out of the auth aggregate");
});

test("the typed database schema accepts the runtime aggregate", () => {
  type ArtifactQuery = Database["db"]["query"]["artifacts"];
  const _probe: ArtifactQuery | undefined = undefined;
  assert.ok(_probe === undefined);
});
