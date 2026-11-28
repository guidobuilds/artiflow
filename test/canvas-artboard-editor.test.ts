import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArtboardRefresh } from "../apps/dashboard/src/artboard-source.ts";

const PAGE = "0d5b0f6a-3f2b-4b4a-9a44-6a2f4a1f7c11";
const LATEST = "c1b2a3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

test("the refresh reply is parsed only when it names what it pinned", () => {
  assert.deepEqual(
    parseArtboardRefresh({
      artifactId: "d-1",
      frameId: "a",
      updated: true,
      sourceArtifactId: PAGE,
      sourceRevisionId: LATEST,
      sourceRevisionNumber: 5,
      designRevisionId: "3f3f3f3f-3f3f-4f3f-8f3f-3f3f3f3f3f3f",
    }),
    { updated: true, sourceRevisionId: LATEST, sourceRevisionNumber: 5 },
  );
  assert.deepEqual(
    parseArtboardRefresh({ updated: false, sourceRevisionId: LATEST, sourceRevisionNumber: 5 }),
    { updated: false, sourceRevisionId: LATEST, sourceRevisionNumber: 5 },
  );
  for (const invalid of [
    null,
    {},
    { updated: true },
    { updated: "yes", sourceRevisionId: LATEST, sourceRevisionNumber: 5 },
    { updated: true, sourceRevisionId: "latest", sourceRevisionNumber: 5 },
    { updated: true, sourceRevisionId: LATEST, sourceRevisionNumber: 0 },
    { updated: true, sourceRevisionId: LATEST },
  ])
    assert.equal(parseArtboardRefresh(invalid), null, JSON.stringify(invalid));
});
