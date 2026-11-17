import { MCP_SERVER_INFO } from "@artiflow/mcp-server/claims";
import { ARTIFACT_VIEWER_RESOURCE_URI, VIEWER_RESOURCE_MIME } from "@artiflow/mcp-server/constants";

export const VIEWER_VERSION = MCP_SERVER_INFO.version;

export const viewerResourceUri = ARTIFACT_VIEWER_RESOURCE_URI;

export const viewerResourceMime = VIEWER_RESOURCE_MIME;

export type FallbackMode = "text";

export function deliveryMode(input: { supportsAppsMeta?: boolean }): FallbackMode | "apps" {
  return input.supportsAppsMeta === true ? "apps" : "text";
}

export function canRenderAppsFrame(input: { kind?: string }): boolean {
  return input.kind === "html";
}
