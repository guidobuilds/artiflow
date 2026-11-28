import { createArtifactTools as createPackageTools } from "@artiflow/mcp-server/server";
import { mcpAppsViewerHtml } from "@artiflow/mcp-apps/viewer";
import type { Scene } from "@artiflow/domain/scene";
import type { Database } from "../adapters/postgres/db/client.ts";
import { sceneAssetDigests } from "../routes/sharing.ts";
import { artboardDepsOf } from "../routes/artboard-sources.ts";
import { ARTBOARD_MAX_INLINE_BYTES, resolveSceneArtboards } from "../viewer/artboards.ts";
import { renderSceneDocument, type SceneImages } from "../viewer/views/scene.ts";
import type { Storage } from "../adapters/storage/client.ts";

export { ARTIFACT_VIEWER_RESOURCE_URI } from "@artiflow/mcp-server/constants";

export function createArtifactTools(options: {
  backend: import("@artiflow/mcp-server/ports").McpBackend;
  database?: Database;
  storage?: Storage;
  publicOrigin?: string;
  requireScope?: string;
  readScope?: string;
}) {
  const { backend, database, storage, publicOrigin, requireScope, readScope } = options;
  const imagesOf = async (artifactId: string, scene: Scene): Promise<SceneImages | undefined> => {
    const images: SceneImages | undefined =
      database === undefined || publicOrigin === undefined
        ? undefined
        : { origin: publicOrigin, artifactId, digests: await sceneAssetDigests(database.db, artifactId, scene) };
    return images;
  };
  const artboardsOf = async (userId: string, scene: Scene) => {
    if (database === undefined || storage === undefined) return {};
    return resolveSceneArtboards(
      scene,
      userId,
      artboardDepsOf({
        db: database.db,
        storage,
        viewerId: userId,
        origin: publicOrigin ?? null,
        maxBytes: ARTBOARD_MAX_INLINE_BYTES,
      }),
    );
  };
  const viewerUrl =
    publicOrigin === undefined
      ? undefined
      : (artifactId: string) => `${publicOrigin}/artifact/${encodeURIComponent(artifactId)}`;
  return createPackageTools({
    backend,
    requireScope,
    readScope,
    viewerUrl,
    viewerHtml: () => mcpAppsViewerHtml(undefined, { imageOrigin: publicOrigin }),
    sceneDocument: async ({ artifactId, kind, scene, userId }) =>
      renderSceneDocument(
        scene,
        undefined,
        await imagesOf(artifactId, scene),
        [],
        kind,
        await artboardsOf(userId, scene),
      ),
  });
}
