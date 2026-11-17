import { createArtifactTools as createPackageTools } from "@artiflow/mcp-server/server";
import { mcpAppsViewerHtml } from "@artiflow/mcp-apps/viewer";

export { ARTIFACT_VIEWER_RESOURCE_URI } from "@artiflow/mcp-server/constants";

export function createArtifactTools(options: {
  backend: import("@artiflow/mcp-server/ports").McpBackend;
  requireScope?: string;
  readScope?: string;
}) {
  return createPackageTools({ ...options, viewerHtml: mcpAppsViewerHtml });
}
