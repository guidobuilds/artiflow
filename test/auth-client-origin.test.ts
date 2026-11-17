import assert from "node:assert/strict";
import { test } from "node:test";

test("mutation origin follows the page origin in a browser-like environment", async () => {
  (globalThis as Record<string, unknown>).location = { origin: "https://artifact.example.com" };
  try {
    const mod = await import("../apps/dashboard/src/auth-client.ts");
    assert.equal(mod.MUTATION_ORIGIN, "https://artifact.example.com");
  } finally {
    delete (globalThis as Record<string, unknown>).location;
  }
});
