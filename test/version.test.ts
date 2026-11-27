import assert from "node:assert/strict";
import test from "node:test";

import { buildInfoFromEnv, createVersionApp } from "../apps/api/src/routes/version.ts";

test("serves the build identity without caching", async () => {
  const app = createVersionApp({ version: "0.4.1", revision: "abc123" });

  const response = await app.request("/api/version");
  const body = (await response.json()) as { version: string; revision: string };

  assert.equal(response.status, 200);
  assert.deepEqual(body, { version: "0.4.1", revision: "abc123" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("defaults to development placeholders when the environment carries no build identity", () => {
  assert.deepEqual(buildInfoFromEnv({}), { version: "dev", revision: "unknown" });
});

test("trims the configured build identity", () => {
  assert.deepEqual(buildInfoFromEnv({ ARTIFLOW_BUILD_VERSION: " 0.4.1 ", ARTIFLOW_BUILD_REVISION: " abc123 " }), {
    version: "0.4.1",
    revision: "abc123",
  });
});

test("treats blank values as absent", () => {
  assert.deepEqual(buildInfoFromEnv({ ARTIFLOW_BUILD_VERSION: "   ", ARTIFLOW_BUILD_REVISION: "" }), {
    version: "dev",
    revision: "unknown",
  });
});
