import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("the hidden comments container stays mounted and a display rule cannot revive it", () => {
  const margin = read("../apps/dashboard/src/components/comments/comment-thread-margin.tsx");
  assert.match(margin, /className="comment-thread-margin"\s*\n\s*hidden=\{!visible\}/);
  const css = read("../apps/dashboard/src/styles/globals.css");
  const rule = /\.comment-thread-margin \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.notEqual(rule, "", ".comment-thread-margin has its own rule");
  assert.equal(/(^|[;\s])display\s*:/.test(rule), false, "a display rule on the container would defeat hidden");
  assert.match(css, /@import "tailwindcss";/, "preflight supplies [hidden] { display: none !important }");
});

test("the floating toggle lives in #docshell, never inside the #viewer-comments host it hides", () => {
  const viewer = read("../apps/dashboard/src/viewer-comments.tsx");
  assert.match(viewer, /const shell = document\.getElementById\("docshell"\)/);
  assert.match(viewer, /shell\.append\(node\)/);
  assert.equal(/host\.append\(node\)/.test(viewer), false);
});
