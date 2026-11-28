import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canRenderAppsFrame,
  deliveryMode,
  viewerResourceMime,
  viewerResourceUri,
  VIEWER_VERSION,
} from "@artiflow/mcp-apps/hosts";

test("hosts without the nested apps meta fall back to text delivery", () => {
  assert.equal(deliveryMode({ supportsAppsMeta: true }), "apps");
  assert.equal(deliveryMode({ supportsAppsMeta: false }), "text");
  assert.equal(deliveryMode({}), "text", "absence of the meta is the claude.ai gap, not apps support");
});

test("the apps frame renders html pages, canvas and deck scenes; AUD-05 keeps markdown out", () => {
  assert.equal(canRenderAppsFrame({ kind: "html" }), true);
  assert.equal(canRenderAppsFrame({ kind: "canvas" }), true, "a canvas draws the scene document in the frame");
  assert.equal(canRenderAppsFrame({ kind: "deck" }), true, "a deck draws the same scene document as a presentation");
  assert.equal(
    canRenderAppsFrame({ kind: "markdown" }),
    false,
    "markdown renders via the text fallback until artifact_get emits kind",
  );
  assert.equal(canRenderAppsFrame({}), false, "unknown kind is the least-privileged branch");
});

test("viewer identity rides the server version and the declared resource contract", () => {
  assert.equal(VIEWER_VERSION, "0.1.0");
  assert.equal(viewerResourceUri, "ui://artiflow/artifact-viewer");
  assert.equal(viewerResourceMime, "text/html;profile=mcp-app");
});
