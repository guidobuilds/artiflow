import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_THREAD_GAP,
  layoutCommentThreads,
  marginHeight,
  overlaps,
  placementOf,
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
