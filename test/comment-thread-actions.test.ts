import assert from "node:assert/strict";
import test from "node:test";

import { AMBIGUOUS_SELECTION, draftBlockedReason } from "../apps/dashboard/src/comment-draft.ts";
import { nextResolvedState } from "../apps/dashboard/src/comment-visibility.ts";

test("resolving an open thread targets resolved and reopening targets unresolved", () => {
  assert.equal(nextResolvedState({ resolvedAt: null }), true);
  assert.equal(nextResolvedState({ resolvedAt: "2026-01-02T03:04:05.000Z" }), false);
});

test("a draft with an anchor is never blocked", () => {
  assert.equal(draftBlockedReason(null), null);
  assert.equal(draftBlockedReason({ anchor: { kind: "text-range" }, candidates: [] }), null);
});

test("a selection that matched several places blocks submission with a reason", () => {
  const candidates = [{ snippet: "a" }, { snippet: "b" }];
  assert.equal(draftBlockedReason({ anchor: null, candidates }), AMBIGUOUS_SELECTION);
});

test("a selection that could not be anchored at all still blocks submission", () => {
  assert.equal(draftBlockedReason({ anchor: null, candidates: [] }), AMBIGUOUS_SELECTION);
  assert.match(AMBIGUOUS_SELECTION, /\S/);
});
