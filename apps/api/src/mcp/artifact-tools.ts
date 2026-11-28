import { createArtifactTools as createPackageTools } from "@artiflow/mcp-server/server";
import { mcpAppsViewerHtml } from "@artiflow/mcp-apps/viewer";
import type { Scene } from "@artiflow/domain/scene";
import type { Database } from "../adapters/postgres/db/client.ts";
import { sceneAssetDigests } from "../routes/sharing.ts";
import { renderSceneDocument, type SceneImages } from "../viewer/views/scene.ts";

export { ARTIFACT_VIEWER_RESOURCE_URI } from "@artiflow/mcp-server/constants";

export function createArtifactTools(options: {
  backend: import("@artiflow/mcp-server/ports").McpBackend;
  database?: Database;
  publicOrigin?: string;
  requireScope?: string;
  readScope?: string;
}) {
  const { backend, database, publicOrigin, requireScope, readScope } = options;
  const imagesOf = async (artifactId: string, scene: Scene): Promise<SceneImages | undefined> => {
    const images: SceneImages | undefined =
      database === undefined || publicOrigin === undefined
        ? undefined
        : { origin: publicOrigin, artifactId, digests: await sceneAssetDigests(database.db, artifactId, scene) };
    return images;
  };
  return createPackageTools({
    backend,
    requireScope,
    readScope,
    viewerHtml: () => mcpAppsViewerHtml(undefined, { imageOrigin: publicOrigin }),
    sceneDocument: async ({ artifactId, kind, scene }) =>
      renderSceneDocument(scene, undefined, await imagesOf(artifactId, scene), [], kind),
  });
}
