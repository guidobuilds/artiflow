import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as auth from "../apps/api/src/auth.ts";

const config = (overrides: Partial<auth.AuthConfig> = {}): auth.AuthConfig => ({
  nodeEnv: "development",
  demoAuth: true,
  authSecret: "x".repeat(32),
  publicOrigin: "http://127.0.0.1:5173",
  authProviders: {},
  ...overrides,
});

const GITHUB = { clientId: "github-id", clientSecret: "github-secret" };
const GOOGLE = { clientId: "google-id", clientSecret: "google-secret" };

test("public email/password sign-up is closed in every profile while login keeps its guard", () => {
  const profiles = [
    config({ nodeEnv: "production", demoAuth: false }),
    config({ nodeEnv: "production", demoAuth: false, publicOrigin: "https://artifacts.example.com" }),
    config(),
    config({ demoAuth: false }),
    config({ nodeEnv: "test" }),
    config({ publicOrigin: "https://artifacts.example.com" }),
  ];
  for (const profile of profiles) {
    const options = auth.emailPasswordOptions(profile);
    assert.equal(options.disableSignUp, true, `${profile.nodeEnv} must not accept a public sign-up`);
    assert.equal(options.enabled, auth.emailPasswordEnabled(profile));
  }
  assert.deepEqual(auth.emailPasswordOptions(config({ nodeEnv: "production", demoAuth: false })), {
    enabled: true,
    disableSignUp: true,
  });
  assert.deepEqual(auth.emailPasswordOptions(config({ nodeEnv: "test" })), { enabled: false, disableSignUp: true });
  assert.equal(auth.PUBLIC_REGISTRATION_OPEN, false);
});

test("configured social providers refuse new accounts without the bypassable implicit toggle", () => {
  const providers = auth.socialProviderOptions({ github: GITHUB, google: GOOGLE });
  assert.deepEqual(Object.keys(providers), ["github", "google"]);
  for (const name of ["github", "google"]) {
    const options = providers[name] as Record<string, unknown>;
    assert.equal(options.disableSignUp, true);
    assert.equal(options.clientId, `${name}-id`);
    assert.equal(options.clientSecret, `${name}-secret`);
    assert.equal("disableImplicitSignUp" in options, false);
  }
  assert.deepEqual(auth.socialProviderOptions({}), {});
});

test("capabilities publish registration separately from login and ignore bypass input", async () => {
  const stub = {
    handler: () => {
      throw new Error("capabilities must never reach the auth handler");
    },
  };
  const app = (profile: auth.AuthConfig) =>
    auth.createAuthApp(stub as unknown as Parameters<typeof auth.createAuthApp>[0], profile);
  const expected = { emailPassword: true, registration: false, socialProviders: ["github"] };

  const response = await app(config({ authProviders: { github: GITHUB } })).request("/api/auth/capabilities");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), expected);

  const bypass = await app(config({ authProviders: { github: GITHUB } })).request(
    "/api/auth/capabilities?invitation=token",
    { headers: { "x-artiflow-invitation": "token" } },
  );
  assert.deepEqual(await bypass.json(), expected);

  const production = await app(config({ nodeEnv: "production", demoAuth: false })).request("/api/auth/capabilities");
  assert.deepEqual(await production.json(), { emailPassword: true, registration: false, socialProviders: [] });
});

test("the registration guard has no environment-variable escape hatch", () => {
  const source = readFileSync(new URL("../apps/api/src/auth.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.env/);
});
