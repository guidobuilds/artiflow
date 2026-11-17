import assert from "node:assert/strict";
import { test } from "node:test";

import {
  advanceReference,
  applyReference,
  beginFetch,
  compareMetadata,
  decideAfterDirtyResolution,
  initialFreshnessState,
  resolveFetch,
  stopFreshness,
  type MetadataIdentity,
} from "@artiflow/domain/freshness";
import { joinLines, toLines } from "@artiflow/domain/markdown";

const rev = (revisionNumber: number, sha256: string, revisionId = `rev-${revisionNumber}`): MetadataIdentity => ({
  revisionId,
  revisionNumber,
  sha256,
});

const base = () => initialFreshnessState(rev(1, "bytes-A"));

const withPending = () => advanceReference(base(), rev(5, "bytes-B")).state;

test("revisionNumber orders revisions and revisionId never does", () => {
  assert.equal(compareMetadata(rev(2, "b"), rev(1, "a")), "newer");
  assert.equal(compareMetadata(rev(1, "a"), rev(2, "b")), "older");
  assert.equal(compareMetadata(rev(1, "same"), rev(1, "same")), "same");
  assert.equal(compareMetadata(rev(3, "c", "aaa"), rev(2, "b", "zzz")), "newer");
  assert.equal(compareMetadata(rev(2, "b", "aaa"), rev(3, "c", "zzz")), "older");
});

test("equal revisionNumber is same for equal bytes and divergent for a different digest", () => {
  assert.equal(compareMetadata(rev(4, "bytes-A"), rev(4, "bytes-A", "other-id")), "same");
  assert.equal(compareMetadata(rev(4, "bytes-B"), rev(4, "bytes-A")), "divergent");
  assert.equal(compareMetadata(rev(4, "bytes-A"), rev(4, "bytes-B")), "divergent");
});

test("a same-byte newer revision advances the reference without a reload and keeps a newer queue", () => {
  const state = advanceReference(withPending(), rev(7, "bytes-B")).state;
  const result = advanceReference(state, rev(5, "bytes-A", "cas-5"));

  assert.equal(result.outcome, "same-bytes");
  assert.notEqual(result.outcome, "reload");
  assert.deepEqual(result.state.reference, { revisionId: "cas-5", revisionNumber: 5, sha256: "bytes-A" });
  assert.deepEqual(result.state.pending, { revisionId: "rev-7", revisionNumber: 7, sha256: "bytes-B" });
  assert.equal(state.reference?.revisionNumber, 1);
});

test("a same-byte restore past the queued revision drops what it superseded", () => {
  const state = withPending();
  const result = advanceReference(state, rev(7, "bytes-A"));

  assert.equal(result.outcome, "same-bytes");
  assert.equal(result.state.reference?.revisionNumber, 7);
  assert.equal(result.state.pending, null);
});

test("a newer revision with different bytes queues pending content instead of moving the reference", () => {
  const state = base();
  const first = advanceReference(state, rev(5, "bytes-B"));

  assert.equal(first.outcome, "reload");
  assert.equal(first.state.reference?.revisionNumber, 1);
  assert.deepEqual(first.state.pending, { revisionId: "rev-5", revisionNumber: 5, sha256: "bytes-B" });

  const again = advanceReference(first.state, rev(5, "bytes-B"));
  assert.equal(again.outcome, "queued");
  assert.deepEqual(again.state, first.state);

  const newer = advanceReference(first.state, rev(7, "bytes-C"));
  assert.equal(newer.outcome, "reload");
  assert.equal(newer.state.pending?.revisionNumber, 7);

  const behind = advanceReference(newer.state, rev(5, "bytes-D"));
  assert.equal(behind.outcome, "queued");
  assert.equal(behind.state.pending?.revisionNumber, 7);
  assert.deepEqual(behind.state, newer.state);
});

test("an older revision is ignored and a divergent one is never adopted", () => {
  const state = initialFreshnessState(rev(5, "bytes-B"));
  const older = advanceReference(state, rev(1, "bytes-A"));
  assert.equal(older.outcome, "older");
  assert.deepEqual(older.state, state);

  const divergent = advanceReference(state, { revisionId: "rev-5-other", revisionNumber: 5, sha256: "bytes-Z" });
  assert.equal(divergent.outcome, "divergent");
  assert.deepEqual(divergent.state, state);
});

test("the same revisionNumber with the same bytes refreshes an opaque revisionId without a reload", () => {
  const state = base();
  const result = advanceReference(state, rev(1, "bytes-A", "recreated-id"));

  assert.equal(result.outcome, "noop");
  assert.equal(result.state.reference?.revisionId, "recreated-id");
  assert.equal(result.state.reference?.revisionNumber, 1);
});

test("the first observation becomes the reference with nothing to reload", () => {
  const state = initialFreshnessState();
  const result = advanceReference(state, rev(2, "bytes-A"));
  assert.equal(result.outcome, "noop");
  assert.deepEqual(result.state.reference, { revisionId: "rev-2", revisionNumber: 2, sha256: "bytes-A" });
});

test("applying the pending bytes moves the reference and never rewinds or loses a newer pending", () => {
  const state = withPending();
  const applied = applyReference(state, rev(5, "bytes-B"));
  assert.equal(applied.outcome, "applied");
  assert.equal(applied.state.reference?.revisionNumber, 5);
  assert.equal(applied.state.pending, null);

  const rewound = applyReference(applied.state, rev(3, "bytes-C"));
  assert.equal(rewound.outcome, "older");
  assert.deepEqual(rewound.state, applied.state);

  const raced = applyReference(advanceReference(state, rev(7, "bytes-C")).state, rev(5, "bytes-B"));
  assert.equal(raced.outcome, "applied");
  assert.equal(raced.state.reference?.revisionNumber, 5);
  assert.equal(raced.state.pending?.revisionNumber, 7);
});

test("beginFetch holds exactly one in-flight slot and refuses a second fetch", () => {
  const state = withPending();
  const started = beginFetch(state, state.pending!);
  assert.equal(started.ok, true);
  if (!started.ok) return;

  assert.equal(started.state.inFlight, started.token);
  assert.equal(started.state.pending?.revisionNumber, 5);

  const second = beginFetch(started.state, started.state.pending!);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "in-flight");
  assert.deepEqual(second.state, started.state);
});

test("a fetch failure retries at the same pointer without touching the reference or the intent", () => {
  const state = withPending();
  const started = beginFetch(state, state.pending!);
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const resolved = resolveFetch(started.state, started.token, { ok: false, reason: "network" });
  assert.equal(resolved.outcome, "retry");
  assert.equal(resolved.state.inFlight, null);
  assert.deepEqual(resolved.state.reference, state.reference);
  assert.deepEqual(resolved.state.pending, state.pending);

  const retried = beginFetch(resolved.state, resolved.state.pending!);
  assert.equal(retried.ok, true);
  if (!retried.ok) return;
  assert.deepEqual(retried.token.target, { revisionId: "rev-5", revisionNumber: 5, sha256: "bytes-B" });
  assert.equal(retried.token.generation, started.token.generation + 1);
});

test("a fetch whose bytes match the applied reference advances it instead of reloading", () => {
  const state = withPending();
  const started = beginFetch(state, state.pending!);
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const resolved = resolveFetch(started.state, started.token, { ok: true, sha256: "bytes-A" });
  assert.equal(resolved.outcome, "same-bytes");
  assert.deepEqual(resolved.state.reference, { revisionId: "rev-5", revisionNumber: 5, sha256: "bytes-A" });
  assert.equal(resolved.state.pending, null);
  assert.equal(resolved.state.inFlight, null);
});

test("a fetch whose bytes changed asks for a reload and leaves the pending pointer queued", () => {
  const state = withPending();
  const started = beginFetch(state, state.pending!);
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const resolved = resolveFetch(started.state, started.token, { ok: true, sha256: "bytes-B" });
  assert.equal(resolved.outcome, "reload");
  assert.equal(resolved.state.reference?.revisionNumber, 1);
  assert.deepEqual(resolved.state.pending, { revisionId: "rev-5", revisionNumber: 5, sha256: "bytes-B" });
  assert.equal(resolved.state.inFlight, null);
});

test("late resolutions are discarded across a newer generation and after stop", () => {
  const state = withPending();
  const first = beginFetch(state, state.pending!);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const retried = resolveFetch(first.state, first.token, { ok: false });
  const second = beginFetch(retried.state, retried.state.pending!);
  assert.equal(second.ok, true);
  if (!second.ok) return;

  const late = resolveFetch(second.state, first.token, { ok: true, sha256: "bytes-B" });
  assert.equal(late.outcome, "discarded");
  assert.deepEqual(late.state, second.state);

  const stopped = stopFreshness(second.state);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.inFlight, null);
  const afterStop = resolveFetch(stopped, second.token, { ok: true, sha256: "bytes-B" });
  assert.equal(afterStop.outcome, "discarded");
  assert.deepEqual(afterStop.state, stopped);
  assert.equal(beginFetch(stopped, stopped.pending!).ok, false);
});

test("resolving the same result twice is idempotent", () => {
  const state = withPending();
  const started = beginFetch(state, state.pending!);
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const first = resolveFetch(started.state, started.token, { ok: true, sha256: "bytes-B" });
  const second = resolveFetch(first.state, started.token, { ok: true, sha256: "bytes-B" });
  assert.equal(second.outcome, "discarded");
  assert.deepEqual(second.state, first.state);
});

test("keep-local never drops pending remote content and accept-remote applies it", () => {
  const state = withPending();
  const kept = decideAfterDirtyResolution(state, "keep-local");
  assert.equal(kept.intent, "keep");
  assert.deepEqual(kept.state.pending, state.pending);

  const repolled = advanceReference(kept.state, rev(5, "bytes-B"));
  assert.deepEqual(repolled.state.pending, state.pending);

  const accepted = decideAfterDirtyResolution(repolled.state, "accept-remote");
  assert.equal(accepted.intent, "apply");
  assert.deepEqual(accepted.state.pending, state.pending);
  assert.equal(applyReference(accepted.state, accepted.state.pending!).outcome, "applied");

  const idle = decideAfterDirtyResolution(base(), "accept-remote");
  assert.equal(idle.intent, "idle");
  assert.equal(idle.state.pending, null);
});

test("the existing domain subpath exports keep resolving", () => {
  assert.equal(joinLines(toLines("a\nb\n")), "a\nb\n");
});
