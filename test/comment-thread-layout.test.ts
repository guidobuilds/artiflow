import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_THREAD_GAP,
  DRAFT_ID,
  anchorOffsets,
  layoutCommentThreads,
  marginLayout,
  marginHeight,
  overlaps,
  partitionPlaced,
  placementOf,
  threadOrder,
} from "../apps/dashboard/src/comment-thread-layout.ts";
import {
  COMMENTS_VISIBLE_KEY,
  openThreadCount,
  readCommentsVisible,
  visibleThreads,
  writeCommentsVisible,
} from "../apps/dashboard/src/comment-visibility.ts";

const at = (id: string, anchorTop: number, height = 100) => ({ id, anchorTop, height });

test("threads without an active card stack downward without overlapping", () => {
  const placed = layoutCommentThreads({ threads: [at("a", 0), at("b", 10), at("c", 400)] });
  assert.deepEqual(
    placed.map((placement) => [placement.id, placement.top]),
    [
      ["a", 0],
      ["b", 100 + DEFAULT_THREAD_GAP],
      ["c", 400],
    ],
  );
  for (let index = 1; index < placed.length; index++) assert.equal(overlaps(placed[index - 1]!, placed[index]!), false);
});

test("the active card stays pinned to its own anchor", () => {
  const placed = layoutCommentThreads({ threads: [at("a", 0), at("b", 300), at("c", 320)], activeId: "b" });
  assert.equal(placementOf(placed, "b")!.top, 300);
  assert.equal(placementOf(placed, "a")!.top, 0);
  assert.equal(placementOf(placed, "c")!.top, 300 + 100 + DEFAULT_THREAD_GAP);
});

test("a collision below the active card pushes the later card down and never the active one", () => {
  const placed = layoutCommentThreads({ threads: [at("a", 100, 120), at("b", 130)], activeId: "a" });
  assert.equal(placementOf(placed, "a")!.top, 100);
  assert.equal(placementOf(placed, "b")!.top, 100 + 120 + DEFAULT_THREAD_GAP);
});

test("a collision above the active card moves the earlier card up while the active stays pinned", () => {
  const placed = layoutCommentThreads({ threads: [at("a", 150), at("b", 200)], activeId: "b" });
  assert.equal(placementOf(placed, "b")!.top, 200, "the active card never leaves its anchor");
  assert.equal(placementOf(placed, "a")!.top, 200 - 100 - DEFAULT_THREAD_GAP, "the earlier card gives way upward");
});

test("when the card above cannot clear the top the block moves down instead of overlapping", () => {
  const placed = layoutCommentThreads({ threads: [at("a", 0), at("b", 40, 240)], activeId: "b" });
  assert.equal(placementOf(placed, "a")!.top, 0, "no card is pushed above the margin");
  assert.equal(placementOf(placed, "b")!.top, 100 + DEFAULT_THREAD_GAP);
  assert.equal(overlaps(placed[0]!, placed[1]!), false);
});

test("the upward pass clamps at the top and shifts the whole block down", () => {
  const placed = layoutCommentThreads({
    threads: [at("a", 0), at("b", 10), at("c", 20, 500)],
    activeId: "c",
  });
  assert.equal(placementOf(placed, "a")!.top, 0);
  assert.ok(placementOf(placed, "b")!.top >= placementOf(placed, "a")!.top + 100 + DEFAULT_THREAD_GAP - 0.001);
  assert.ok(placementOf(placed, "c")!.top >= placementOf(placed, "b")!.top + 100 + DEFAULT_THREAD_GAP - 0.001);
  for (let index = 1; index < placed.length; index++) assert.equal(overlaps(placed[index - 1]!, placed[index]!), false);
});

test("a block shifted down by the top clamp never overlaps the threads below the active one", () => {
  const threads = Array.from({ length: 8 }, (_, index) => ({
    id: `t${index + 1}`,
    anchorTop: 200 + index * 10,
    height: index === 3 ? 220 : 96,
  }));
  const placed = layoutCommentThreads({ threads, activeId: "t4" });
  for (let first = 0; first < placed.length; first++)
    for (let second = first + 1; second < placed.length; second++)
      assert.equal(overlaps(placed[first]!, placed[second]!), false, `${placed[first]!.id} vs ${placed[second]!.id}`);
  assert.ok(placementOf(placed, "t5")!.top >= placementOf(placed, "t4")!.top + 220 + DEFAULT_THREAD_GAP);
});

test("partitionPlaced separates threads without an anchor and stale threads", () => {
  const threads = [
    { id: "a", createdAt: "2026-01-01" },
    { id: "b", createdAt: "2026-01-02" },
    { id: "c", createdAt: "2026-01-03", stale: true },
    { id: "d", createdAt: "2026-01-04", stale: false },
  ];
  const { placed, unplaced } = partitionPlaced(threads, { a: 10, c: 20, d: 0 });
  assert.deepEqual(
    placed.map((thread) => thread.id),
    ["a", "d"],
  );
  assert.deepEqual(
    unplaced.map((thread) => thread.id),
    ["b", "c"],
  );
});

test("threadOrder lists placed threads by anchor then id and unplaced ones by creation", () => {
  const threads = [
    { id: "z", createdAt: "2026-01-05" },
    { id: "y", createdAt: "2026-01-01" },
    { id: "b", createdAt: "2026-01-02" },
    { id: "a", createdAt: "2026-01-03" },
    { id: "m", createdAt: "2026-01-04", stale: true },
  ];
  assert.deepEqual(threadOrder(threads, { a: 50, b: 50, m: 5 }), ["a", "b", "y", "m", "z"]);
  assert.deepEqual(threadOrder([], {}), []);
});

test("anchorOffsets keeps the rounded minimum offset per id relative to the origin", () => {
  assert.deepEqual(
    anchorOffsets(
      [
        { id: "a", top: 340.6 },
        { id: "a", top: 300.2 },
        { id: "b", top: 90 },
      ],
      100,
    ),
    { a: 200, b: -10 },
  );
  assert.deepEqual(anchorOffsets([], 10), {});
});

test("layout ignores input order and keeps anchors monotonic", () => {
  const forward = layoutCommentThreads({ threads: [at("a", 0), at("b", 200), at("c", 400)] });
  const shuffled = layoutCommentThreads({ threads: [at("c", 400), at("a", 0), at("b", 200)] });
  assert.deepEqual(
    shuffled.map((placement) => placement.id),
    forward.map((placement) => placement.id),
  );
  assert.deepEqual(
    shuffled.map((placement) => placement.top),
    forward.map((placement) => placement.top),
  );
});

test("two anchors at the same offset separate by height and gap", () => {
  const placed = layoutCommentThreads({ threads: [at("a", 100), at("b", 100)], activeId: "a", gap: 8 });
  assert.equal(placementOf(placed, "a")!.top, 100);
  assert.equal(placementOf(placed, "b")!.top, 100 + 100 + 8);
});

test("layout handles no threads, a custom gap and the margin height", () => {
  assert.deepEqual(layoutCommentThreads({ threads: [] }), []);
  const placed = layoutCommentThreads({ threads: [at("a", 0, 50), at("b", 60, 50)], gap: 20 });
  assert.equal(placementOf(placed, "b")!.top, 70);
  assert.equal(marginHeight(placed, 20), 70 + 50 + 20);
});

test("the visibility preference defaults to visible and remembers hiding", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  assert.equal(readCommentsVisible(storage), true, "no stored value shows the comments");
  assert.equal(writeCommentsVisible(storage, false), true);
  assert.equal(store.get(COMMENTS_VISIBLE_KEY), "hidden");
  assert.equal(readCommentsVisible(storage), false);
  assert.equal(writeCommentsVisible(storage, true), true);
  assert.equal(readCommentsVisible(storage), true);
});

test("a failing storage never hides the comments", () => {
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readCommentsVisible(throwing), true);
  assert.equal(writeCommentsVisible(throwing, false), false);
  assert.equal(readCommentsVisible(null), true);
  assert.equal(readCommentsVisible(undefined), true);
});

test("the bar counter and the resolved filter follow the thread state", () => {
  const threads = [{ resolvedAt: null }, { resolvedAt: "2026-01-01T00:00:00.000Z" }, { resolvedAt: null }];
  assert.equal(openThreadCount(threads), 2);
  assert.equal(visibleThreads(threads, false).length, 2);
  assert.equal(visibleThreads(threads, true).length, 3);
});

test("an open draft takes its own slot and never overlaps the cards around it", () => {
  const threads = [
    { id: "above", anchorTop: 10, height: 96 },
    { id: "below", anchorTop: 100, height: 96 },
  ];
  const closed = marginLayout({ threads, draft: null, activeId: null, minTop: 0 });
  assert.equal(placementOf(closed, DRAFT_ID) ?? null, null);
  const open = marginLayout({
    threads,
    draft: { anchorTop: 110, height: 220 },
    activeId: null,
    minTop: 0,
  });
  const draft = placementOf(open, DRAFT_ID);
  assert.notEqual(draft ?? null, null);
  assert.ok(draft!.top >= 110, `the draft never rises above its anchor, got ${draft!.top}`);
  for (const other of open) {
    if (other.id === DRAFT_ID) continue;
    assert.equal(overlaps(draft!, other), false, `the draft must not overlap ${other.id} at ${other.top}`);
  }
});
