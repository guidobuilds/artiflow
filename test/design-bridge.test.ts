import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DESIGN_BRIDGE_CHANNEL,
  DESIGN_BRIDGE_VERSION,
  parseDesignResult,
  parseDesignSubmit,
} from "../packages/domain/src/design-bridge.ts";

const nonce = "design-nonce";
const sceneFrame = { id: "scene-iframe" };
const envelope = { channel: DESIGN_BRIDGE_CHANNEL, version: DESIGN_BRIDGE_VERSION, nonce };

const submit = {
  type: "submit",
  frameId: "frame-a",
  revisionId: "rev-12",
  selection: { selector: "#cta", textHint: "Start free", point: { x: 0.4, y: 0.5 }, viewportWidth: 1280 },
  body: "Change the label",
};

const submitResult = (raw: unknown, source: unknown = sceneFrame) =>
  parseDesignSubmit(raw, { nonce, source, frame: sceneFrame });

test("a submit from the scene document passes and keeps only allowlisted data", () => {
  const result = submitResult({ ...envelope, ...submit });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.message.selection : null, submit.selection);
});

test("a submit from another window or with a foreign nonce is refused", () => {
  assert.deepEqual(submitResult({ ...envelope, ...submit }, { id: "other" }), { ok: false, reason: "wrong-source" });
  assert.deepEqual(
    parseDesignSubmit({ ...envelope, ...submit }, { nonce: "other", source: sceneFrame, frame: sceneFrame }),
    {
      ok: false,
      reason: "wrong-nonce",
    },
  );
  assert.equal(submitResult({ ...envelope, version: DESIGN_BRIDGE_VERSION + 1, ...submit }).ok, false);
  assert.equal(submitResult({ ...envelope, channel: "other", ...submit }).ok, false);
});

test("a submit cannot override the revision, permissions or endpoints", () => {
  for (const extra of [
    { expectedRevisionId: "other-revision" },
    { token: "secret" },
    { permission: "editor" },
    { endpoint: "/api/admin" },
  ])
    assert.deepEqual(submitResult({ ...envelope, ...submit, ...extra }), { ok: false, reason: "schema" });
});

test("a submit with an invalid selection or an empty body is refused", () => {
  assert.equal(
    submitResult({ ...envelope, ...submit, selection: { ...submit.selection, point: { x: 2, y: 0 } } }).ok,
    false,
  );
  assert.equal(submitResult({ ...envelope, ...submit, selection: { ...submit.selection, extra: true } }).ok, false);
  assert.equal(submitResult({ ...envelope, ...submit, body: "   " }).ok, false);
  assert.equal(submitResult({ ...envelope, ...submit, body: "x".repeat(4001) }).ok, false);
});

test("a result carries exactly one of a request id or an error", () => {
  const base = { ...envelope, type: "result" };
  assert.equal(
    parseDesignResult({ ...base, requestId: "request-1", error: null }, { nonce, source: sceneFrame }).ok,
    true,
  );
  assert.equal(
    parseDesignResult({ ...base, requestId: null, error: "Request was not saved" }, { nonce, source: sceneFrame }).ok,
    true,
  );
  assert.equal(
    parseDesignResult({ ...base, requestId: "request-1", error: "both" }, { nonce, source: sceneFrame }).ok,
    false,
  );
  assert.equal(parseDesignResult({ ...base, requestId: null, error: null }, { nonce, source: sceneFrame }).ok, false);
});

test("a result with extra fields is refused", () => {
  const base = { ...envelope, type: "result", requestId: "request-1", error: null };
  assert.equal(parseDesignResult({ ...base, status: "published" }, { nonce, source: sceneFrame }).ok, false);
});
