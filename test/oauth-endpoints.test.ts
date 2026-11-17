import assert from "node:assert/strict";
import { test } from "node:test";

import { publicIssuer, publicResource } from "../apps/api/src/oauth.ts";

test("issuer and resource derive from the configured public origin", () => {
  const config = { publicOrigin: "https://artifact.example.com" };
  assert.equal(publicIssuer(config), "https://artifact.example.com/api/auth");
  assert.equal(publicResource(config), "https://artifact.example.com/mcp");
});

test("a loopback origin keeps the historical endpoints byte-identical", () => {
  const config = { publicOrigin: "http://127.0.0.1:5173" };
  assert.equal(publicIssuer(config), "http://127.0.0.1:5173/api/auth");
  assert.equal(publicResource(config), "http://127.0.0.1:5173/mcp");
});
