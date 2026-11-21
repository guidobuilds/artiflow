import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatThreadHash,
  isChromeTarget,
  isEditableTarget,
  parseThreadHash,
  resolveDeepLink,
  revealCommentsForHash,
  shortcutFor,
  stepThread,
  threadHashUrl,
} from "../apps/dashboard/src/comment-thread-navigation.ts";

test("J, K, R and Escape map to actions and any modifier cancels them", () => {
  assert.equal(shortcutFor({ key: "j", editable: false }), "next");
  assert.equal(shortcutFor({ key: "K", editable: false }), "previous");
  assert.equal(shortcutFor({ key: "r", editable: false }), "reply");
  assert.equal(shortcutFor({ key: "Escape", editable: false }), "close");
  assert.equal(shortcutFor({ key: "x", editable: false }), null);
  for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const)
    assert.equal(shortcutFor({ key: "j", editable: false, [modifier]: true }), null);
  assert.equal(shortcutFor({ key: "j", editable: false, defaultPrevented: true }), null);
});

test("typing surfaces ignore letters and Escape unless the focus is inside the comments", () => {
  assert.equal(shortcutFor({ key: "j", editable: true }), null);
  assert.equal(shortcutFor({ key: "r", editable: true, insideComments: true }), null);
  assert.equal(shortcutFor({ key: "Escape", editable: true }), null);
  assert.equal(shortcutFor({ key: "Escape", editable: true, insideComments: true }), "close");
});

test("editable targets cover form fields, contenteditable and their descendants", () => {
  assert.equal(isEditableTarget({ tagName: "INPUT" }), true);
  assert.equal(isEditableTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: "P", closest: () => ({}) }), true);
  assert.equal(isEditableTarget({ tagName: "BUTTON", closest: () => null }), false);
  assert.equal(isEditableTarget(null), false);
});

test("stepping clamps at both ends and starts from the edges when nothing is open", () => {
  const order = ["a", "b", "c"];
  assert.equal(stepThread(order, "a", 1), "b");
  assert.equal(stepThread(order, "c", 1), "c");
  assert.equal(stepThread(order, "a", -1), "a");
  assert.equal(stepThread(order, "c", -1), "b");
  assert.equal(stepThread(order, null, 1), "a");
  assert.equal(stepThread(order, null, -1), "c");
  assert.equal(stepThread(order, "gone", 1), "a");
  assert.equal(stepThread([], "a", 1), null);
});

test("thread hashes round-trip and reject anything else", () => {
  assert.equal(parseThreadHash("#c-123e4567-e89b"), "123e4567-e89b");
  assert.equal(parseThreadHash(formatThreadHash("a b")), "a b");
  for (const hash of ["", "#", "#c-", "#section", "#c-<script>", "#c-%E0%A4%A", `#c-${"a".repeat(129)}`])
    assert.equal(parseThreadHash(hash), null);
});

test("deep links resolve only known threads", () => {
  assert.equal(resolveDeepLink("#c-t2", ["t1", "t2"]), "t2");
  assert.equal(resolveDeepLink("#c-t9", ["t1", "t2"]), null);
  assert.equal(resolveDeepLink("#top", ["t1"]), null);
});

test("the hash url keeps the path and query, replaces a thread hash and spares other fragments", () => {
  assert.equal(threadHashUrl("https://x.test/p?a=1", "t1"), "https://x.test/p?a=1#c-t1");
  assert.equal(threadHashUrl("https://x.test/p#c-t1", "t2"), "https://x.test/p#c-t2");
  assert.equal(threadHashUrl("https://x.test/p#c-t1", null), "https://x.test/p");
  assert.equal(threadHashUrl("https://x.test/p#intro", null), "https://x.test/p#intro");
  assert.equal(threadHashUrl("https://x.test/p", null), "https://x.test/p");
});

test("an IME composition never triggers a thread shortcut", () => {
  assert.equal(shortcutFor({ key: "j", editable: false, composing: true }), null);
  assert.equal(shortcutFor({ key: "Escape", editable: true, insideComments: true, composing: true }), null);
  assert.equal(shortcutFor({ key: "r", editable: false, composing: false }), "reply");
});

test("a thread link reveals the comments column even when the reader hid it", () => {
  assert.equal(revealCommentsForHash(true, ""), true);
  assert.equal(revealCommentsForHash(false, ""), false);
  assert.equal(revealCommentsForHash(false, "#c-abc123"), true);
  assert.equal(revealCommentsForHash(false, "#elsewhere"), false);
});

test("a thread id round-trips through the hash whatever characters it carries", () => {
  for (const id of ["plain", "with space", "a!b", "x(y)", "z*w", "ñoño", "0f8f-1c2d", "a".repeat(100)]) {
    const hash = formatThreadHash(id);
    assert.equal(parseThreadHash(hash), id, `${JSON.stringify(id)} must come back from ${hash}`);
  }
});

test("chrome controls and other surfaces keep their own keys", () => {
  const inChrome = { key: "j", editable: false, inChrome: true };
  assert.equal(shortcutFor(inChrome), null);
  assert.equal(shortcutFor({ ...inChrome, key: "k" }), null);
  assert.equal(shortcutFor({ ...inChrome, key: "r" }), null);
  assert.equal(shortcutFor({ key: "Escape", editable: false, inChrome: true }), null);
  assert.equal(shortcutFor({ key: "Escape", editable: false }), "close");
  assert.equal(shortcutFor({ key: "Escape", editable: true, insideComments: true, inChrome: true }), "close");
  assert.equal(
    isChromeTarget({ tagName: "BUTTON", closest: (selector: string) => (selector.includes("button") ? {} : null) }),
    true,
  );
  assert.equal(isChromeTarget({ tagName: "P", closest: () => null }), false);
});
