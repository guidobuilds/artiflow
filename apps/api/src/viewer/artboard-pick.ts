import type { AppliedOverride } from "@artiflow/domain/scene-overrides";

import { withDocumentPolicy } from "./artifact.ts";
import { overridesBridgeScript } from "./overrides-bridge-script.ts";
import { selectionBridgeScript } from "./selection-bridge-script.ts";
import type { SceneArtboardContent } from "./views/scene.ts";

export function artboardPickPage(
  content: Extract<SceneArtboardContent, { kind: "ready" }>,
  overrides: readonly AppliedOverride[],
  nonce: string,
): string {
  const overrideScript = overrides.length === 0 ? "" : overridesBridgeScript({ overrides });
  return `${withDocumentPolicy(content.html)}${overrideScript}${selectionBridgeScript({ nonce, pins: [], allowSelect: true })}`;
}
