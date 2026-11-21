import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const component = readFileSync(
  new URL("../apps/dashboard/src/components/comments/comment-thread-margin.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(new URL("../apps/dashboard/src/styles/globals.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("../apps/dashboard/src/comment-thread-layout.ts", import.meta.url), "utf8");

test("the margin is three hundred pixels wide and cards are absolutely positioned", () => {
  assert.match(styles, /\.comment-thread-margin \{[^}]*width: 300px;/);
  assert.match(styles, /\.comment-thread-card \{[^}]*position: absolute;/);
  assert.match(styles, /\.comment-thread-margin \{[^}]*position: relative;/);
});

test("opening a thread never moves the document", () => {
  for (const mover of ["scrollIntoView", "scrollTo", "scrollTop =", "window.scrollBy"]) {
    assert.equal(component.includes(mover) || layout.includes(mover), false, `the component never calls ${mover}`);
  }
});

test("card heights are measured and threads without a location form their own group", () => {
  assert.match(component, /typeof ResizeObserver === "undefined"/);
  assert.match(component, /new ResizeObserver/);
  assert.match(component, /heights\[thread\.id\] \?\? measured\[thread\.id\]/);
  assert.match(component, /partitionPlaced\(shown, anchors\)/);
  assert.match(component, /role="group"\s+aria-label="No location"/);
  assert.match(component, /<h3 className="comment-thread-unplaced-title">No location<\/h3>/);
  assert.match(styles, /\.comment-thread-unplaced \.comment-thread-card \{[^}]*position: relative;/);
});

test("the bar toggles visibility, counts open threads and hides resolved ones by default", () => {
  assert.match(component, /aria-pressed=\{visible\}/);
  assert.match(component, /aria-controls=\{label\}/);
  assert.match(component, /\{visible \? "Hide comments" : "Show comments"\}/);
  assert.match(component, /openThreadCount\(threads\)/);
  assert.match(component, /\[resolvedState, setResolvedState\] = useState\(false\)/);
  assert.match(component, /const showResolved = showResolvedProp \?\? resolvedState;/);
  assert.match(component, /Show resolved/);
  assert.equal(component.includes("readCommentsVisible(store)"), true);
  assert.equal(component.includes("writeCommentsVisible(store, next)"), true);
});

test("every card state has a surface", () => {
  for (const marker of [
    "comment-thread-card-active",
    "comment-thread-card-resolved",
    "comment-thread-card-stale",
    "comment-thread-clamp",
    "comment-thread-count",
  ])
    assert.equal(styles.includes(marker), true, `${marker} is styled`);
  assert.match(component, /thread\.replies\.length === 1 \? "reply" : "replies"/);
  assert.match(component, />\s*Resolve\s*<\/Button>/);
  assert.match(component, />\s*Reopen\s*<\/Button>/);
  assert.match(component, />\s*Close\s*<\/Button>/);
  assert.match(component, /thread\.staleLabel \?\? "Text changed"/);
  assert.match(component, /<p className="comment-thread-flag">Resolved<\/p>/);
  assert.match(component, /\$\{active \? "Close" : "Open"\} thread by/);
  assert.equal(/Texto cambiado|Resuelto|Abrir|Cerrar/.test(component), false, "no Spanish labels remain");
  assert.match(component, /active \? "comment-thread-body" : "comment-thread-body comment-thread-clamp"/);
  assert.equal(/\.comment-thread-card \{[^}]*overflow: hidden;/.test(styles), false, "cards never clip their content");
  assert.equal(/height: placement\.height/.test(component), false, "cards size to their content");
  assert.match(styles, /mark\.viewer-comment-mark-flash \{[^}]*animation: comment-flash/);
  assert.match(component, /comment-thread-draft/);
});

test("view states cover loading, empty, load errors, publish errors and hidden", () => {
  assert.match(component, /status === "loading" \? <Skeleton \/> : null/);
  assert.match(component, /status === "error" \?/);
  assert.match(component, /status === "empty"/);
  assert.match(component, /Could not load comments\./);
  assert.match(component, />\s*Retry\s*<\/Button>/);
  assert.match(component, /role="alert"[\s\S]{0,120}publishError/);
  assert.match(component, /draft\.error/);
  assert.match(component, /comment-thread-margin-hidden/);
  assert.match(styles, /\.comment-thread-skeleton/);
});

test("narrow screens drop the margin and open a bottom sheet with navigation", () => {
  assert.match(styles, /@media \(max-width: 800px\) \{[\s\S]*\.comment-thread-margin \{[\s\S]*display: none;/);
  assert.match(styles, /\.comment-thread-sheet-open \{[\s\S]*align-items: flex-end;/);
  assert.match(styles, /\.comment-thread-sheet-reply \{[\s\S]*position: sticky;/);
  assert.match(component, /role="dialog" aria-modal="true"/);
  assert.match(component, /Previous thread/);
  assert.match(component, /Next thread/);
  assert.match(component, /Close thread/);
  assert.match(component, /thread\.resolvedAt === null \? "Resolve" : "Reopen"/);
});

test("cards and anchors stay keyboard reachable with forty-four pixel targets", () => {
  assert.match(component, /tabIndex=\{0\}/);
  assert.match(component, /event\.key === "Enter"/);
  assert.match(component, /event\.key === "Escape"/);
  assert.match(component, /aria-expanded=\{active\}/);
  assert.match(component, /aria-labelledby=/);
  assert.match(component, /className="sr-only"[^>]*\n?\s*(?:htmlFor|children)/);
  assert.match(styles, /\.comment-thread-header \{[^}]*min-height: 44px;/);
  assert.match(styles, /\.comment-thread-input \{[^}]*min-height: 44px;/);
  assert.match(component, /className="min-h-11"/);
});

test("the component is not wired into a view yet", () => {
  for (const view of ["../EditorPage.tsx", "./EditorPage.tsx", "LibraryPage", "AuthScreen"]) {
    assert.equal(component.includes(view), false, `the margin stays independent of ${view}`);
  }
});

test("the draft shares the one layout pass that positions the cards", () => {
  assert.match(component, /marginLayout\(\{/);
  assert.match(component, /draft: draftOpen \? \{ anchorTop: draftAnchorTop, height: active \} : null/);
  assert.match(component, /placement=\{placementOf\(placements, DRAFT_ID\) \?\? null\}/);
  assert.doesNotMatch(component, /draftPlacement\(/);
});
