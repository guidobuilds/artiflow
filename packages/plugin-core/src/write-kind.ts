import { extname } from "node:path";

import { DEFAULT_ARTIFACT_KIND, kindForExtension, type ArtifactKind } from "@artiflow/domain/kinds";

export const fileKind = (path: string): ArtifactKind => kindForExtension(extname(path)) ?? DEFAULT_ARTIFACT_KIND;
