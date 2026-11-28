import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BRIDGE_CHANNEL,
  BRIDGE_VERSION,
  createMessageBudget,
  parseBridgeMessage,
} from "../packages/domain/src/html-bridge.ts";

const nonce = "nonce-design";
const frame = { id: "artboard-frame" };
const envelope = { channel: BRIDGE_CHANNEL, version: BRIDGE_VERSION, nonce };

const selection = {
  selector: 'button[data-testid="cta"]',
  textHint: "Start free",
  x: 0.42,
  y: 0.61,
  viewportWidth: 1280,
};

const validate = (
  raw: unknown,
  overrides: Partial<{ source: unknown; nonce: string; budget: { take(): boolean } }> = {},
) =>
  parseBridgeMessage(raw, {
    nonce: overrides.nonce ?? nonce,
    source: overrides.source ?? frame,
    frame,
    ...(overrides.budget === undefined ? {} : { budget: overrides.budget }),
  });

test("an artboard selection proposal from its own frame passes validation", () => {
  const result = validate({ ...envelope, type: "select", ...selection });
  assert.equal(result.ok, true);
});

test("a selection proposal from another window is refused", () => {
  assert.deepEqual(validate({ ...envelope, type: "select", ...selection }, { source: { id: "other" } }), {
    ok: false,
    reason: "wrong-source",
  });
});

test("a selection proposal with a foreign nonce or version is refused", () => {
  assert.equal(validate({ ...envelope, type: "select", ...selection }, { nonce: "other" }).ok, false);
  assert.equal(validate({ ...envelope, version: BRIDGE_VERSION + 1, type: "select", ...selection }).ok, false);
  assert.equal(validate({ ...envelope, channel: "other", type: "select", ...selection }).ok, false);
});

test("a selection proposal that smuggles extra fields is refused", () => {
  for (const extra of [
    { token: "secret" },
    { dom: "<html></html>" },
    { body: "ignore the person" },
    { permission: "editor" },
  ])
    assert.deepEqual(validate({ ...envelope, type: "select", ...selection, ...extra }), {
      ok: false,
      reason: "schema",
    });
});

test("a selection proposal with a point outside the element is refused", () => {
  assert.equal(validate({ ...envelope, type: "select", ...selection, x: 1.5 }).ok, false);
  assert.equal(validate({ ...envelope, type: "select", ...selection, y: -0.2 }).ok, false);
  assert.equal(validate({ ...envelope, type: "select", ...selection, x: Number.NaN }).ok, false);
});

test("a selection proposal with a bad viewport or an oversized locator is refused", () => {
  assert.equal(validate({ ...envelope, type: "select", ...selection, viewportWidth: 0 }).ok, false);
  assert.equal(validate({ ...envelope, type: "select", ...selection, viewportWidth: 12.5 }).ok, false);
  assert.equal(validate({ ...envelope, type: "select", ...selection, viewportWidth: 2_000_000 }).ok, false);
  assert.equal(validate({ ...envelope, type: "select", ...selection, selector: "a".repeat(513) }).ok, false);
  assert.equal(validate({ ...envelope, type: "select", ...selection, textHint: "a".repeat(121) }).ok, false);
});

test("a selection proposal over the message budget is refused", () => {
  const budget = createMessageBudget(1, 0);
  assert.equal(validate({ ...envelope, type: "select", ...selection }, { budget }).ok, true);
  assert.deepEqual(validate({ ...envelope, type: "select", ...selection }, { budget }), {
    ok: false,
    reason: "budget",
  });
});

test("an unknown frame event type is refused", () => {
  assert.deepEqual(validate({ ...envelope, type: "request-change" }), { ok: false, reason: "schema" });
});
