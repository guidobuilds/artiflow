import type { McpClaims } from "./claims.ts";

export const WRITE_SCOPE = "artifacts:write";

export const ARTIFACT_VIEWER_RESOURCE_URI = "ui://artiflow/artifact-viewer";

export const VIEWER_TOOL_META = {
  ui: { resourceUri: ARTIFACT_VIEWER_RESOURCE_URI },
  "ui/resourceUri": ARTIFACT_VIEWER_RESOURCE_URI,
} as const;

export const VIEWER_RESOURCE_MIME = "text/html;profile=mcp-app";

export const VIEWER_VERSION = "0.1.0";

export const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
export const HEX_SHA256 = /^[0-9a-f]{64}$/;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const MAX_DOCUMENT_READ_BLOCKS = 20;
export const MAX_DOCUMENT_READ_LINES = 200;
export const MAX_DOCUMENT_READ_BYTES = 65_536;
export const MAX_DOCUMENT_QUERY_RESULTS = 50;
export const MAX_DOCUMENT_APPLY_OPS = 50;
export const MAX_DOCUMENT_DIFF_ENTRIES = 200;

export { MAX_SCENE_APPLY_OPS, MAX_SCENE_READ_BYTES, MAX_SCENE_READ_NODES } from "./scene-tools.ts";

export const MCP_REQUEST_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
export const MCP_REQUEST_ENVELOPE_HEADROOM_BYTES = 4_096;
export const MAX_MCP_ASSET_BYTES = Math.floor(
  ((MCP_REQUEST_BODY_LIMIT_BYTES - MCP_REQUEST_ENVELOPE_HEADROOM_BYTES) / 4) * 3,
);
export const MAX_MCP_ASSET_BASE64_CHARS = Math.ceil(MAX_MCP_ASSET_BYTES / 3) * 4;

export type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
export type Access = { ok: true; userId: string } | { ok: false; reply: ToolReply };

export const reply = (value: unknown): ToolReply => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
export const refusal = (error: string, message: string, extra: Record<string, unknown> = {}): ToolReply => ({
  content: [{ type: "text", text: JSON.stringify({ error, message, ...extra }) }],
  isError: true,
});
export const refusalOf = (failure: { kind: string; reason: string }): ToolReply =>
  refusal(failure.kind, failure.reason);

export const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

import { createHash } from "node:crypto";

export type ToolIdentity = { claims: McpClaims };
