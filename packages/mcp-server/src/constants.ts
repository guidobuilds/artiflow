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
