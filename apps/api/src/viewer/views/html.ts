import { artifactView, type ArtifactPage } from "../artifact.ts";
import { escapeAttribute } from "../chrome/theme.ts";
import type { ViewerModel } from "../model.ts";

export const htmlView = (model: ViewerModel, document: string): ArtifactPage =>
  artifactView(model, { srcdoc: escapeAttribute(document) });
