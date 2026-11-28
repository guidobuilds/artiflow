import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ARTIFACT_KINDS, acceptsTextOperations } from "@artiflow/domain/kinds";
import { applyLineOps, decodeMarkdownText, joinLines, toLines, type LineOp } from "@artiflow/domain/markdown";
import {
  BLOCK_KINDS,
  diffBlocks,
  documentBlocks,
  type DocumentBlock,
  type DocumentOperation,
} from "@artiflow/domain/document-operations";
import type { Scene } from "@artiflow/domain/scene";
import type { SceneOperation } from "@artiflow/domain/scene-operations";
import { artifactMetadataSchema, type ArtifactMetadata } from "@artiflow/contracts/artifacts";
import {
  McpRollback,
  type McpBackend,
  type McpCommentDocument,
  type McpCommentRow,
  type McpExecutor,
  type McpRevisionInput,
} from "@artiflow/mcp-server/ports";
import {
  loadScene,
  sceneApplyInput,
  sceneApplyOf,
  sceneCurrentOf,
  sceneOutlineInput,
  sceneOutlineOf,
  sceneReadInput,
  sceneReadOf,
  type SceneRefusalBody,
} from "@artiflow/mcp-server/scene-tools";

import {
  acceptsSceneAnchors,
  anchorKindsForDocument,
  anchorKindAllowed,
  anchorText,
  isSceneAnchor,
  sceneAnchorIsOrphaned,
  sceneAnchorRefusal,
  type AnyCommentAnchor,
} from "@artiflow/domain/comment-anchors";
import { commentAnchorSchema } from "@artiflow/contracts/comments";
import { MCP_SERVER_INFO, type McpClaims } from "./claims.ts";

export { ARTIFACT_VIEWER_RESOURCE_URI } from "@artiflow/mcp-server/constants";
import {
  ARTIFACT_VIEWER_RESOURCE_URI,
  BASE64,
  HEX_SHA256,
  MAX_DOCUMENT_APPLY_OPS,
  MAX_DOCUMENT_DIFF_ENTRIES,
  MAX_DOCUMENT_QUERY_RESULTS,
  MAX_DOCUMENT_READ_BLOCKS,
  MAX_DOCUMENT_READ_BYTES,
  MAX_DOCUMENT_READ_LINES,
  MAX_MCP_ASSET_BASE64_CHARS,
  MAX_MCP_ASSET_BYTES,
  MAX_SCENE_READ_BYTES,
  MAX_SCENE_READ_NODES,
  digestOf,
  refusal as pkgRefusal,
  refusalOf as pkgRefusalOf,
  reply as pkgReply,
  UUID_RE,
  VIEWER_RESOURCE_MIME,
  VIEWER_TOOL_META,
  WRITE_SCOPE,
} from "@artiflow/mcp-server/constants";
type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
type Access = { ok: true; userId: string } | { ok: false; reply: ToolReply };
type DocumentRefusal = {
  ok: false;
  kind: string;
  reason: string;
  currentSeq?: number;
  opIndex?: number;
  artifactKind?: string;
};

class RollbackReply extends McpRollback<ToolReply> {}

const refusal = pkgRefusal;
const reply = pkgReply;
const refusalOf = pkgRefusalOf;

function decodeBase64(value: string): Uint8Array | undefined {
  if (!BASE64.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 ? bytes : undefined;
}

export type SceneDocumentInput = { artifactId: string; kind: string; scene: Scene };

export type SceneDocumentRender = (input: SceneDocumentInput) => Promise<string>;

export type ArtifactToolOptions = {
  backend: McpBackend;
  viewerHtml: () => string;
  sceneDocument?: SceneDocumentRender;
  viewerUrl?: (artifactId: string) => string;
  requireScope?: string;
  readScope?: string;
};

export function createArtifactTools(options: ArtifactToolOptions): (claims: McpClaims) => McpServer {
  const { backend } = options;
  const caps = backend.caps;
  const scope = options.requireScope ?? WRITE_SCOPE;
  const readScope = options.readScope ?? scope;
  const {
    maxArtifactBytes: MAX_ARTIFACT_BYTES,
    maxChunkBytes: MAX_CHUNK_BYTES,
    maxCommentBody: MAX_COMMENT_BODY,
    maxCommentQuote: MAX_COMMENT_QUOTE,
  } = caps;
  const BASE64_CHUNK_MAX = Math.ceil((MAX_CHUNK_BYTES + 1) / 3) * 4;
  const MAX_CHUNK_INDEX = Math.floor(MAX_ARTIFACT_BYTES / MAX_CHUNK_BYTES) - 1;
  const {
    createUpload,
    putChunk,
    getUpload,
    listChunks,
    commitUpload,
    writeArtifact,
    getRevisionBytes,
    putRevisionBytes,
    getStagingChunk,
    putStagingChunk,
    getCurrentState,
    selectReadRevision,
    setRevisionCas,
    commentDocument,
    findComment: backendFindComment,
    currentRevision,
    insertComment,
    listComments,
    setCommentResolved,
    commentTransaction,
    uploadAsset,
  } = backend;
  const stagingStorageKey = (sha256: string) => `staging/${sha256}`;
  const viewerLink = (artifactId: string): { url?: string } => {
    const url = options.viewerUrl?.(artifactId);
    return url === undefined ? {} : { url };
  };
  return (claims) => {
    const server = new McpServer(MCP_SERVER_INFO);
    server.registerResource(
      "artifact-viewer",
      ARTIFACT_VIEWER_RESOURCE_URI,
      {
        title: "Artiflow viewer",
        description: "Inline preview of one Artiflow artifact, rendered by MCP Apps hosts after artifact_commit.",
        mimeType: VIEWER_RESOURCE_MIME,
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: VIEWER_RESOURCE_MIME,
            text: options.viewerHtml(),
            _meta: { ui: { csp: { connectDomains: [], frameDomains: ["blob:"] }, prefersBorder: false } },
          },
        ],
      }),
    );
    const allow = (needed: string): Access => {
      if (!claims.userId)
        return { ok: false, reply: refusal("invalid_token", "the access token carries no subject claim") };
      if (!claims.scopes.includes(needed))
        return {
          ok: false,
          reply: refusal(
            "insufficient_scope",
            `WWW-Authenticate: Bearer error="insufficient_scope", scope="${needed}"`,
            { scope: needed },
          ),
        };
      return { ok: true, userId: claims.userId };
    };

    server.registerTool(
      "artifact_start_upload",
      {
        title: "Start an artifact upload",
        description: `Open a bounded staging upload for the authenticated owner. Declares the final decoded size and its sha256; the whole-artifact digest is verified at commit. Re-sending the same uploadId with the same declaration is idempotent. The artifact kind is chosen at artifact_commit: pass kind "markdown" there to create a markdown document (default "html").`,
        inputSchema: {
          declaredSizeBytes: z.number().int().min(1).max(MAX_ARTIFACT_BYTES),
          declaredSha256: z.string().regex(HEX_SHA256),
          title: z.string().min(1).max(200).optional(),
          uploadId: z.string().min(1).max(100).optional(),
        },
      },
      async (input) => {
        const access = allow(scope);
        if (!access.ok) return access.reply;
        const uploadId = input.uploadId ?? `upload-${randomUUID()}`;
        const created = await createUpload({
          ownerId: access.userId,
          uploadId,
          declaredSizeBytes: input.declaredSizeBytes,
          declaredSha256: input.declaredSha256,
        });
        if (!created.ok) return refusalOf(created);
        return reply({
          uploadId: created.value.id,
          status: created.value.status,
          declaredSizeBytes: created.value.declaredSizeBytes,
          declaredSha256: created.value.declaredSha256,
          expiresAt: created.value.expiresAt.toISOString(),
        });
      },
    );

    server.registerTool(
      "artifact_put_chunk",
      {
        title: "Stage one artifact chunk",
        description: `Stage one base64-encoded chunk (at most ${MAX_CHUNK_BYTES} decoded bytes, indices 0..${MAX_CHUNK_INDEX}). The server decodes the bytes and computes their sha256 itself; a byte-identical retry is idempotent and different bytes for an already staged index are a conflict.`,
        inputSchema: {
          uploadId: z.string().min(1).max(100),
          chunkIndex: z.number().int().min(0).max(MAX_CHUNK_INDEX),
          contentBase64: z.string().min(1).max(BASE64_CHUNK_MAX),
        },
      },
      async (input) => {
        const access = allow(scope);
        if (!access.ok) return access.reply;
        const bytes = decodeBase64(input.contentBase64);
        if (!bytes) return refusal("validation", "contentBase64 is not a non-empty base64 payload");
        const sha256 = digestOf(bytes);
        const staged = await putChunk({
          ownerId: access.userId,
          uploadId: input.uploadId,
          chunkIndex: input.chunkIndex,
          sizeBytes: bytes.length,
          sha256,
        });
        if (!staged.ok) return refusalOf(staged);
        if (!(await putStagingChunk(sha256, bytes))) return refusal("storage", "staging write failed");
        return reply({
          uploadId: input.uploadId,
          chunkIndex: staged.value.chunkIndex,
          sizeBytes: staged.value.sizeBytes,
          sha256: staged.value.sha256,
          storageKey: stagingStorageKey(staged.value.sha256),
        });
      },
    );

    server.registerTool(
      "artifact_commit",
      {
        title: "Commit a staged upload",
        description: `Verify every staged chunk, recompute the whole-artifact sha256 and commit the upload as a new artifact or, with expectedRevisionId, as a compare-and-set revision. artifactId is optional and must be a canonical lowercase uuid when supplied. A digest mismatch stores no artifact row; staging keys may remain until a later cleanup unit. kind selects the artifact type and commits the choice: "html" (default) is a Page, a self-contained HTML page such as a report, dashboard, demo or tool the person uses directly in its viewer; "canvas" is a Design, a JSON scene of frames and nodes the person compares and refines in its own canvas space, so give it a title and a scene scene_apply can address; "markdown" is a document readable and line-edited over MCP, and its bytes must be valid UTF-8 text. The reply carries url, the link that opens the committed artifact's viewer, so a client without an inline preview can still open what it just created. artifact_commit ONLY finalizes a staged chunk stream; when the content already exists in your context as text, prefer the one-call artifact_write.`,
        inputSchema: {
          uploadId: z.string().min(1).max(100),
          artifactId: z.string().min(1).max(100).optional(),
          title: z.string().min(1).max(200).optional(),
          expectedRevisionId: z.string().min(1).max(100).optional(),
          kind: z.enum(ARTIFACT_KINDS).optional(),
        },
        _meta: VIEWER_TOOL_META,
        outputSchema: {
          artifactId: z.string(),
          revisionId: z.string(),
          revisionNumber: z.number().int(),
          sizeBytes: z.number().int(),
          observedSizeBytes: z.number().int(),
          sha256: z.string().regex(HEX_SHA256),
          url: z.string().optional(),
        },
      },
      async (input) => {
        const access = allow(scope);
        if (!access.ok) return access.reply;
        if (input.artifactId !== undefined && !UUID_RE.test(input.artifactId)) {
          return refusal(
            "invalid_artifact_id",
            "artifactId must be a canonical lowercase uuid (8-4-4-4-12 hex): generate one instead of a readable name",
            { artifactId: input.artifactId },
          );
        }
        const upload = await getUpload(input.uploadId, access.userId);
        if (!upload.ok) return refusalOf(upload);
        const listing = await listChunks(input.uploadId, access.userId);
        if (!listing.ok) return refusalOf(listing);
        const parts: Uint8Array[] = [];
        let total = 0;
        for (const chunk of listing.value.chunks) {
          const bytes = await getStagingChunk(chunk.sha256);
          if (!bytes)
            return refusal("chunk_unavailable", "a staged chunk is missing or does not match its recorded digest", {
              chunkIndex: chunk.chunkIndex,
            });
          if (bytes.length !== chunk.sizeBytes)
            return refusal("conflict", "staged chunk size disagrees with its recorded claim", {
              chunkIndex: chunk.chunkIndex,
            });
          total += bytes.length;
          if (total > MAX_ARTIFACT_BYTES)
            return refusal("too_large", "assembled artifact exceeds the artifact cap", {
              maxBytes: MAX_ARTIFACT_BYTES,
            });
          parts.push(bytes);
        }
        if (total !== upload.value.declaredSizeBytes)
          return refusal("conflict", "staged_size_mismatch", {
            declaredSizeBytes: upload.value.declaredSizeBytes,
            observedSizeBytes: total,
          });
        const observed = digestOf(Buffer.concat(parts, total));
        if (observed !== upload.value.declaredSha256)
          return refusal("digest_mismatch", "assembled bytes do not match the declared artifact digest", {
            declaredSha256: upload.value.declaredSha256,
            observedSha256: observed,
          });
        const committed = await commitUpload({
          ownerId: access.userId,
          uploadId: input.uploadId,
          bytes: Buffer.concat(parts, total),
          artifactId: input.artifactId,
          title: input.title,
          expectedRevisionId: input.expectedRevisionId,
          kind: input.kind,
        });
        if (!committed.ok)
          return refusal(
            committed.kind,
            committed.reason,
            "currentRevisionId" in committed ? { currentRevisionId: committed.currentRevisionId } : {},
          );
        const value = {
          artifactId: committed.value.artifactId,
          revisionId: committed.value.revisionId,
          revisionNumber: committed.value.revisionNumber,
          sizeBytes: committed.value.sizeBytes,
          observedSizeBytes: committed.value.observedSizeBytes,
          sha256: observed,
          ...viewerLink(committed.value.artifactId),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
          _meta: { ui: { resourceUri: ARTIFACT_VIEWER_RESOURCE_URI } },
        };
      },
    );

    server.registerTool(
      "artifact_write",
      {
        title: "Write a whole text artifact in one call",
        description: `Create a new artifact (or, with artifactId plus expectedRevisionId, a compare-and-set revision) from content you already hold as text: pass the full UTF-8 document. kind commits the output the person asked for: "html" (default) is a Page, a self-contained HTML page such as a report, dashboard, demo or tool the person uses directly in its viewer; "canvas" is a Design, a JSON scene of frames and nodes the person compares and refines in its own canvas space, so give it a title and a scene scene_apply can address; "markdown" is a document readable with artifact_get_markdown and editable with artifact_edit_lines. Say plainly which one you are opening, and if the request does not decide it, choose the one that fits and name the other. The reply carries url, the link that opens the created artifact's viewer, so a client without an inline preview can still open what it just created. One call, no staging: the server computes the sha256 itself. Content over ${Math.floor(MAX_CHUNK_BYTES / 1024)} KiB decoded, or any binary artifact, goes through artifact_start_upload / artifact_put_chunk / artifact_commit instead (requires disk access).`,
        inputSchema: {
          text: z.string().min(1),
          kind: z.enum(ARTIFACT_KINDS).optional(),
          artifactId: z.string().min(1).max(100).optional(),
          title: z.string().min(1).max(200).optional(),
          expectedRevisionId: z.string().min(1).max(100).optional(),
        },
        _meta: VIEWER_TOOL_META,
        outputSchema: {
          artifactId: z.string(),
          revisionId: z.string(),
          revisionNumber: z.number().int(),
          sizeBytes: z.number().int(),
          observedSizeBytes: z.number().int(),
          sha256: z.string().regex(HEX_SHA256),
          url: z.string().optional(),
        },
      },
      async (input) => {
        const access = allow(scope);
        if (!access.ok) return access.reply;
        if (input.artifactId !== undefined && !UUID_RE.test(input.artifactId)) {
          return refusal(
            "invalid_artifact_id",
            "artifactId must be a canonical lowercase uuid (8-4-4-4-12 hex): generate one instead of a readable name",
            { artifactId: input.artifactId },
          );
        }
        const bytes = new TextEncoder().encode(input.text);
        if (bytes.length > MAX_CHUNK_BYTES) {
          return refusal(
            "too_large",
            `text exceeds the artifact_write cap of ${MAX_CHUNK_BYTES} decoded bytes: stream larger or binary payloads with artifact_start_upload and artifact_put_chunk`,
            { maxBytes: MAX_CHUNK_BYTES, observedBytes: bytes.length },
          );
        }
        const written = await writeArtifact({
          ownerId: access.userId,
          bytes,
          artifactId: input.artifactId,
          title: input.title,
          expectedRevisionId: input.expectedRevisionId,
          kind: input.kind,
        });
        if (!written.ok)
          return refusal(
            written.kind,
            written.reason,
            "currentRevisionId" in written ? { currentRevisionId: written.currentRevisionId } : {},
          );
        const value = {
          artifactId: written.value.artifactId,
          revisionId: written.value.revisionId,
          revisionNumber: written.value.revisionNumber,
          sizeBytes: written.value.sizeBytes,
          observedSizeBytes: written.value.observedSizeBytes,
          sha256: digestOf(bytes),
          ...viewerLink(written.value.artifactId),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
          _meta: { ui: { resourceUri: ARTIFACT_VIEWER_RESOURCE_URI } },
        };
      },
    );

    server.registerTool(
      "artifact_get",
      {
        title: "Read one artifact revision",
        annotations: { readOnlyHint: true },
        description: `Return one owned artifact revision as base64: the current revision when revisionId is omitted, or exactly that pinned revision. Requires ${readScope}; bytes are re-read from storage, capped and re-hashed against the revision digest, so tampered or missing bytes are typed errors rather than content. kind reports the artifact type ("html" or "markdown") so a viewer can route the bytes without guessing. metadataOnly returns the revision row's metadata instead: no bytes, no storage read and no integrity claim about them.`,
        inputSchema: {
          artifactId: z.string().min(1).max(100),
          revisionId: z.string().min(1).max(100).optional(),
          metadataOnly: z.boolean().optional(),
        },
      },
      async (input) => {
        const access = allow(readScope);
        if (!access.ok) return access.reply;
        const row = await selectReadRevision(undefined, access.userId, input.artifactId, input.revisionId);
        if (!row) return refusal("not_found", "artifact_not_visible_to_owner", { artifactId: input.artifactId });
        if (row.deletedAt) return refusal("gone", "artifact_deleted", { artifactId: input.artifactId });
        if (!row.id || !row.sha256 || !row.storageKey || row.revisionNumber === null || row.sizeBytes === null)
          return refusal("not_found", "revision_not_found", { artifactId: input.artifactId });
        if (input.metadataOnly) {
          const metadata: ArtifactMetadata = artifactMetadataSchema.parse({
            artifactId: input.artifactId,
            revisionId: row.id,
            revisionNumber: row.revisionNumber,
            kind: row.kind,
            sha256: row.sha256,
            sizeBytes: row.sizeBytes,
            title: row.title,
          });
          return { content: [{ type: "text", text: JSON.stringify(metadata) }], structuredContent: metadata };
        }
        const read = await getRevisionBytes({ storageKey: row.storageKey as string, maxBytes: MAX_ARTIFACT_BYTES });
        if (!read.ok) return refusalOf(read);
        return reply({
          artifactId: input.artifactId,
          revisionId: row.id,
          kind: row.kind,
          sha256: row.sha256,
          sizeBytes: read.value.sizeBytes,
          contentBase64: Buffer.from(read.value.bytes).toString("base64"),
        });
      },
    );

    server.registerTool(
      "artifact_update_metadata",
      {
        title: "Rename an artifact",
        description: `Change one owned artifact's title in a single operation: no upload, no chunks, no new revision — the current revision, its bytes and its sha256 stay exactly as they are. Requires ${scope}. Pass expectedRevisionId to refuse when a concurrent commit moved the pointer; omit it to rename regardless. The reply carries the persisted title plus the untouched revision pointer and count, so a caller can verify that no revision was created.`,
        inputSchema: {
          artifactId: z.string().min(1).max(100),
          title: z.string().min(1).max(200),
          expectedRevisionId: z.string().min(1).max(100).optional(),
        },
      },
      async (input) => {
        const access = allow(scope);
        if (!access.ok) return access.reply;
        if (!UUID_RE.test(input.artifactId))
          return refusal("invalid_artifact_id", "artifactId must be a canonical lowercase uuid (8-4-4-4-12 hex)");
        if (input.title.trim().length === 0)
          return refusal("invalid_title", "title must contain at least one non-whitespace character");
        const result = await backend.renameArtifact({
          artifactId: input.artifactId,
          ownerId: access.userId,
          title: input.title,
          expectedRevisionId: input.expectedRevisionId ?? null,
        });
        if (!result.ok)
          return refusal(
            result.kind,
            result.reason,
            result.currentRevisionId ? { currentRevisionId: result.currentRevisionId } : {},
          );
        return reply(result.value);
      },
    );

    const readMarkdownText = async (
      userId: string,
      artifactId: string,
    ): Promise<{ ok: true; revisionId: string; text: string } | { ok: false; reply: ToolReply }> => {
      const row = await selectReadRevision(undefined, userId, artifactId);
      if (!row) return { ok: false, reply: refusal("not_found", "artifact_not_visible_to_owner", { artifactId }) };
      if (row.deletedAt) return { ok: false, reply: refusal("gone", "artifact_deleted", { artifactId }) };
      if (!row.id || !row.sha256 || !row.storageKey)
        return { ok: false, reply: refusal("not_found", "revision_not_found", { artifactId }) };
      if (!acceptsTextOperations(row.kind))
        return {
          ok: false,
          reply: refusal("wrong_kind", "artifact_is_not_a_markdown_document", { artifactId, kind: row.kind }),
        };
      const read = await getRevisionBytes({ storageKey: row.storageKey as string, maxBytes: MAX_ARTIFACT_BYTES });
      if (!read.ok) return { ok: false, reply: refusalOf(read) };
      const decoded = decodeMarkdownText(read.value.bytes);
      if (!decoded.ok)
        return {
          ok: false,
          reply: refusal("not_valid_utf8_markdown", "stored markdown bytes are not valid UTF-8", { artifactId }),
        };
      return { ok: true, revisionId: row.id, text: decoded.text };
    };

    server.registerTool(
      "artifact_get_markdown",
      {
        title: "Read a markdown document as numbered lines",
        annotations: { readOnlyHint: true },
        description: `Return one owned markdown artifact as 1-indexed lines: the full document, or the window [from,to] with the edges clamped to the document. Requires ${readScope}; non-markdown artifacts and non-UTF-8 bytes are typed refusals, never decoded content.`,
        inputSchema: {
          artifactId: z.string().min(1).max(100),
          from: z.number().int().min(1).optional(),
          to: z.number().int().min(1).optional(),
        },
      },
      async (input) => {
        const access = allow(readScope);
        if (!access.ok) return access.reply;
        const loaded = await readMarkdownText(access.userId, input.artifactId);
        if (!loaded.ok) return loaded.reply;
        const lines = toLines(loaded.text);
        const from = Math.max(1, input.from ?? 1);
        const to = Math.min(lines.length, input.to ?? lines.length);
        if (from > to) return refusal("validation", "empty_line_window", { lineCount: lines.length, from, to });
        return reply({
          artifactId: input.artifactId,
          revisionId: loaded.revisionId,
          lineCount: lines.length,
          from,
          to,
          lines: lines.slice(from - 1, to),
        });
      },
    );

    const LINE_OP_TEXT = z.array(z.string().max(MAX_ARTIFACT_BYTES)).min(1).max(1000);
    const lineOp = z.discriminatedUnion("op", [
      z.object({
        op: z.literal("replace"),
        from: z.number().int().min(1),
        to: z.number().int().min(1),
        expect: z.array(z.string()).optional(),
        text: LINE_OP_TEXT,
      }),
      z.object({ op: z.literal("insert"), after: z.number().int().min(0), text: LINE_OP_TEXT }),
      z.object({
        op: z.literal("delete"),
        from: z.number().int().min(1),
        to: z.number().int().min(1),
        expect: z.array(z.string()).optional(),
      }),
    ]);
    server.registerTool(
      "artifact_edit_lines",
      {
        title: "Edit a markdown document with line patch operations",
        description: `Apply bounded line operations (replace/insert/delete, 1-indexed, ranges inclusive) to one owned markdown artifact and commit the result as a new revision. Each op may carry expect: the exact current lines that must match, or the whole call refuses with the live window. expectedRevisionId is required; a stale pointer is a concurrent_edit refusal carrying the current revision id.`,
        inputSchema: {
          artifactId: z.string().min(1).max(100),
          expectedRevisionId: z.string().min(1).max(100),
          ops: z.array(lineOp).min(1).max(50),
        },
      },
      async (input) => {
        const access = allow(scope);
        if (!access.ok) return access.reply;
        const loaded = await readMarkdownText(access.userId, input.artifactId);
        if (!loaded.ok) return loaded.reply;
        if (loaded.revisionId !== input.expectedRevisionId) {
          return refusal("concurrent_edit", "document_changed_since_read", {
            artifactId: input.artifactId,
            currentRevisionId: loaded.revisionId,
          });
        }
        const applied = applyLineOps(toLines(loaded.text), input.ops as LineOp[]);
        if (!applied.ok) {
          return applied.kind === "expectation_mismatch"
            ? refusal("expectation_mismatch", applied.reason, { opIndex: applied.opIndex, window: applied.window })
            : refusal(
                "validation",
                applied.kind === "empty_ops"
                  ? "ops_required"
                  : ((applied as { reason?: string }).reason ?? "invalid_line_operation"),
                { opIndex: (applied as { opIndex?: number }).opIndex },
              );
        }
        const bytes = new TextEncoder().encode(joinLines(applied.value));
        if (bytes.length === 0) return refusal("validation", "bytes_required");
        if (bytes.length > MAX_ARTIFACT_BYTES)
          return refusal("too_large", "edited_document_exceeds_the_artifact_cap", { maxBytes: MAX_ARTIFACT_BYTES });
        const sha256 = digestOf(bytes);
        const stored = await putRevisionBytes({ sha256, bytes });
        if (!stored.ok) return refusalOf(stored);
        const state = await getCurrentState(input.artifactId, access.userId);
        if (!state.ok) return refusal(state.kind, state.reason);
        const next: McpRevisionInput = {
          revision: state.value.revisionCount + 1,
          sizeBytes: bytes.length,
          sha256,
          storageKey: stored.value.storageKey,
          observedSizeBytes: bytes.length,
        };
        const advanced = await setRevisionCas({
          artifactId: input.artifactId,
          ownerId: access.userId,
          expectedRevisionId: input.expectedRevisionId,
          next,
        });
        if (!advanced.ok)
          return refusal(
            advanced.kind,
            advanced.reason,
            advanced.currentRevisionId ? { currentRevisionId: advanced.currentRevisionId } : {},
          );
        return reply({
          artifactId: input.artifactId,
          revisionId: advanced.value.revisionId,
          revisionNumber: advanced.value.revisionNumber,
          lineCount: applied.value.length,
          appliedOps: input.ops.length,
          sha256,
        });
      },
    );

    const documentIdSchema = z.string().min(1).max(100);
    const documentFailure = (failure: DocumentRefusal, artifactId?: string): ToolReply => {
      const detail: Record<string, unknown> = artifactId === undefined ? {} : { artifactId };
      if (failure.artifactKind !== undefined) detail.kind = failure.artifactKind;
      if (failure.currentSeq !== undefined) detail.currentSeq = failure.currentSeq;
      if (failure.opIndex !== undefined) detail.opIndex = failure.opIndex;
      const error = failure.kind === "operation_rejected" ? "invalid_operation" : failure.kind;
      return refusal(error, failure.reason, detail);
    };
    const openDocument = async (
      userId: string,
      artifactId: string,
    ): Promise<{ kind: string; seq: number; text: string } | ToolReply> => {
      const opened = await backend.documentOpen(userId, artifactId);
      return opened.ok ? opened.value : documentFailure(opened, artifactId);
    };
    const outlineEntry = (block: DocumentBlock): Record<string, unknown> => ({
      id: block.id,
      kind: block.kind,
      line: block.line,
      endLine: block.endLine,
      ...(block.level === undefined ? {} : { level: block.level }),
    });
    const documentOp = z.discriminatedUnion("op", [
      z.object({
        op: z.literal("replace_text"),
        find: z.string().min(1),
        replace: z.string(),
        all: z.boolean().optional(),
        expectedOccurrences: z.number().int().min(1).optional(),
      }),
      z.object({
        op: z.literal("insert_text"),
        text: z.string().min(1),
        at: z.object({ line: z.number().int().min(1), column: z.number().int().min(1) }).optional(),
      }),
      z.object({
        op: z.literal("delete_range"),
        start: z.object({ line: z.number().int().min(1), column: z.number().int().min(1) }),
        end: z.object({ line: z.number().int().min(1), column: z.number().int().min(1) }),
      }),
      z.object({
        op: z.literal("append_blocks"),
        text: z.string().min(1),
        blockId: z.string().min(1).optional(),
      }),
      z.object({ op: z.literal("replace_document"), text: z.string().min(1) }),
    ]);
    server.registerTool(
      "document_create",
      {
        title: "Create a markdown document",
        description: `Create a markdown document inside the product in one call: no upload, no chunking, no file on disk. kind defaults to "markdown" and must name a kind whose agent write mode is text operations, so a kind edited as a whole document refuses with wrong_kind and belongs on artifact_write. When text is omitted the document starts as "# <title>" so the published title keeps matching the request. Returns the artifact identity shape artifact_write returns plus seq, the sequence document_apply accepts as baseSeq.`,
        inputSchema: {
          title: z.string().min(1).max(200),
          kind: z.enum(ARTIFACT_KINDS).optional(),
          text: z.string().optional(),
        },
        outputSchema: {
          artifactId: z.string(),
          revisionId: z.string(),
          revisionNumber: z.number().int(),
          sizeBytes: z.number().int(),
          observedSizeBytes: z.number().int(),
          sha256: z.string().regex(HEX_SHA256),
          seq: z.number().int(),
        },
      },
      async (input) => {
        const access = allow(scope);
        if (!access.ok) return access.reply;
        const kind = input.kind ?? "markdown";
        if (!acceptsTextOperations(kind))
          return refusal("wrong_kind", "kind_does_not_accept_text_operations", {
            kind,
            acceptedKinds: ARTIFACT_KINDS.filter((candidate) => acceptsTextOperations(candidate)),
          });
        if (input.text !== undefined) {
          const bytes = new TextEncoder().encode(input.text);
          if (bytes.length > MAX_CHUNK_BYTES)
            return refusal(
              "too_large",
              `initial text exceeds the document_create cap of ${MAX_CHUNK_BYTES} bytes: create the document and append blocks with document_apply`,
              { maxBytes: MAX_CHUNK_BYTES, observedBytes: bytes.length },
            );
        }
        const created = await backend.documentCreate({
          ownerId: access.userId,
          title: input.title,
          kind,
          text: input.text,
        });
        if (!created.ok) return documentFailure(created);
        return {
          content: [{ type: "text", text: JSON.stringify(created.value) }],
          structuredContent: created.value,
        };
      },
    );
    server.registerTool(
      "document_outline",
      {
        title: "Outline a markdown document",
        annotations: { readOnlyHint: true },
        description: `Return the block index of one owned markdown document's current draft: one entry per heading, paragraph, list item, code fence or table with its id, kind, line and endLine, plus level for headings. Never the text, so a large document costs one line per block. Requires ${readScope}. The ids are what document_read, document_query and document_diff accept; seq is the draft sequence document_apply accepts as baseSeq.`,
        inputSchema: { artifactId: documentIdSchema },
      },
      async ({ artifactId }) => {
        const access = allow(readScope);
        if (!access.ok) return access.reply;
        const opened = await openDocument(access.userId, artifactId);
        if ("content" in opened) return opened;
        const blocks = documentBlocks(opened.text);
        return reply({
          artifactId,
          kind: opened.kind,
          seq: opened.seq,
          lineCount: toLines(opened.text).length,
          blockCount: blocks.length,
          blocks: blocks.map(outlineEntry),
        });
      },
    );
    server.registerTool(
      "document_read",
      {
        title: "Read a window of a markdown document",
        annotations: { readOnlyHint: true },
        description: `Read a bounded window of one owned markdown document. With no arguments it answers the outline projection (one entry per block, never the text). blockIds reads at most ${MAX_DOCUMENT_READ_BLOCKS} complete blocks by id; from/to reads at most ${MAX_DOCUMENT_READ_LINES} numbered lines, clamped to the document. Both are capped at ${MAX_DOCUMENT_READ_BYTES} bytes, and neither may be combined with the other. Requires ${readScope}; ids come from document_outline or document_query.`,
        inputSchema: {
          artifactId: documentIdSchema,
          blockIds: z.array(z.string().min(1)).min(1).max(MAX_DOCUMENT_READ_BLOCKS).optional(),
          from: z.number().int().min(1).optional(),
          to: z.number().int().min(1).optional(),
        },
      },
      async ({ artifactId, blockIds, from, to }) => {
        const access = allow(readScope);
        if (!access.ok) return access.reply;
        const opened = await openDocument(access.userId, artifactId);
        if ("content" in opened) return opened;
        const blocks = documentBlocks(opened.text);
        if (blockIds !== undefined && (from !== undefined || to !== undefined))
          return refusal("validation", "read_is_either_block_ids_or_a_line_range", { artifactId });
        if (blockIds === undefined && from === undefined && to === undefined)
          return reply({
            artifactId,
            kind: opened.kind,
            seq: opened.seq,
            lineCount: toLines(opened.text).length,
            blockCount: blocks.length,
            blocks: blocks.map(outlineEntry),
          });
        if (blockIds !== undefined) {
          const window: Record<string, unknown>[] = [];
          for (const id of blockIds) {
            const block = blocks.find((candidate) => candidate.id === id);
            if (!block) return refusal("unknown_block", "block_not_in_outline", { artifactId, blockId: id });
            window.push({ ...outlineEntry(block), text: block.content });
          }
          const observedBytes = window.reduce((sum, entry) => sum + String(entry.text).length, 0);
          if (observedBytes > MAX_DOCUMENT_READ_BYTES)
            return refusal("too_large", "read_window_exceeds_the_byte_cap", {
              artifactId,
              maxBytes: MAX_DOCUMENT_READ_BYTES,
              observedBytes,
            });
          return reply({ artifactId, kind: opened.kind, seq: opened.seq, blocks: window, sizeBytes: observedBytes });
        }
        const lines = toLines(opened.text);
        const start = Math.max(1, from ?? 1);
        const end = Math.min(lines.length, to ?? lines.length);
        if (start > end)
          return refusal("validation", "empty_line_window", { lineCount: lines.length, from: start, to: end });
        if (end - start + 1 > MAX_DOCUMENT_READ_LINES)
          return refusal("too_large", "read_window_exceeds_the_line_cap", {
            maxLines: MAX_DOCUMENT_READ_LINES,
            requestedLines: end - start + 1,
          });
        const window = lines.slice(start - 1, end);
        const observedBytes = new TextEncoder().encode(window.join("\n")).length;
        if (observedBytes > MAX_DOCUMENT_READ_BYTES)
          return refusal("too_large", "read_window_exceeds_the_byte_cap", {
            maxBytes: MAX_DOCUMENT_READ_BYTES,
            observedBytes,
          });
        return reply({
          artifactId,
          kind: opened.kind,
          seq: opened.seq,
          lineCount: lines.length,
          from: start,
          to: end,
          lines: window,
        });
      },
    );
    server.registerTool(
      "document_query",
      {
        title: "Find blocks in a markdown document",
        annotations: { readOnlyHint: true },
        description: `Find blocks in one owned markdown document by case-insensitive text substring, by kind, or both, answering ids and line numbers only. Requires ${readScope}. At most ${MAX_DOCUMENT_QUERY_RESULTS} matches are returned and truncated reports the rest; every id is accepted by document_read.`,
        inputSchema: {
          artifactId: documentIdSchema,
          text: z.string().min(1).optional(),
          kind: z.enum(BLOCK_KINDS).optional(),
          limit: z.number().int().min(1).max(MAX_DOCUMENT_QUERY_RESULTS).optional(),
        },
      },
      async ({ artifactId, text, kind, limit }) => {
        const access = allow(readScope);
        if (!access.ok) return access.reply;
        const opened = await openDocument(access.userId, artifactId);
        if ("content" in opened) return opened;
        if (text === undefined && kind === undefined)
          return refusal("validation", "query_needs_text_or_kind", { artifactId });
        const needle = text?.toLowerCase();
        const matches = documentBlocks(opened.text)
          .filter((block) => kind === undefined || block.kind === kind)
          .filter((block) => needle === undefined || block.content.toLowerCase().includes(needle))
          .map((block) => ({ id: block.id, kind: block.kind, line: block.line }));
        const bounded = matches.slice(0, limit ?? MAX_DOCUMENT_QUERY_RESULTS);
        return reply({
          artifactId,
          seq: opened.seq,
          matchCount: matches.length,
          truncated: matches.length > bounded.length,
          matches: bounded,
        });
      },
    );
    server.registerTool(
      "document_diff",
      {
        title: "Diff two sequences of a markdown document",
        annotations: { readOnlyHint: true },
        description: `Compare one owned markdown document at two sequences and report, per block, whether it was added, removed, changed or moved — ids, lines and the previous id of a changed block only, never the text. Requires ${readScope}. fromSeq is the sequence you last read; toSeq defaults to the current draft sequence, so an edit made by another author shows up without reading the document. A sequence that is ahead of the draft refuses with the current sequence.`,
        inputSchema: {
          artifactId: documentIdSchema,
          fromSeq: z.number().int().min(0),
          toSeq: z.number().int().min(0).optional(),
        },
      },
      async ({ artifactId, fromSeq, toSeq }) => {
        const access = allow(readScope);
        if (!access.ok) return access.reply;
        const opened = await openDocument(access.userId, artifactId);
        if ("content" in opened) return opened;
        const target = toSeq ?? opened.seq;
        if (fromSeq > target)
          return refusal("validation", "diff_range_is_reversed", { artifactId, fromSeq, toSeq: target });
        const blocksAt = async (seq: number): Promise<{ blocks: DocumentBlock[] } | ToolReply> => {
          if (seq === opened.seq) return { blocks: documentBlocks(opened.text) };
          const resolved = await backend.documentTextAt(access.userId, artifactId, seq);
          return resolved.ok ? { blocks: documentBlocks(resolved.value.text) } : documentFailure(resolved, artifactId);
        };
        const before = await blocksAt(fromSeq);
        if ("content" in before) return before;
        const after = await blocksAt(target);
        if ("content" in after) return after;
        const changes = diffBlocks(before.blocks, after.blocks);
        const bounded = changes.slice(0, MAX_DOCUMENT_DIFF_ENTRIES);
        return reply({
          artifactId,
          fromSeq,
          toSeq: target,
          changeCount: changes.length,
          truncated: changes.length > bounded.length,
          changes: bounded,
        });
      },
    );
    server.registerTool(
      "document_apply",
      {
        title: "Apply operations to a markdown document",
        description: `Apply a batch of typed operations to one owned markdown document in one atomic call, instead of resending the document. Requires ${scope}. baseSeq is the sequence you read; a stale one refuses with concurrent_edit and the current sequence, and nothing is written. idempotencyKey makes a retry safely replayable: the same key applies once. Operations: replace_text (find/replace, optional all and expectedOccurrences), insert_text (at an optional 1-indexed line/column), delete_range (start/end, end exclusive), append_blocks (with an optional blockId to insert after that block) and replace_document. A batch is all-or-nothing: a failing operation refuses with invalid_operation, its opIndex, the named reason and the unchanged document. The reply carries the new sequence and how many operations this call applied. The accepted batch also snapshots the document when 100 operations or ten minutes are due: published reports whether this call froze one, and revisionId names it, so a viewer sees the edit without a second call. Below the threshold nothing is written to storage.`,
        inputSchema: {
          artifactId: documentIdSchema,
          baseSeq: z.number().int().min(0),
          idempotencyKey: z.string().min(1).max(100),
          ops: z.array(documentOp).min(1).max(MAX_DOCUMENT_APPLY_OPS),
        },
        outputSchema: {
          artifactId: z.string(),
          baseSeq: z.number().int(),
          seq: z.number().int(),
          applied: z.number().int(),
          replayed: z.boolean(),
          published: z.boolean(),
          revisionId: z.string().nullable(),
        },
      },
      async (input) => {
        const access = allow(scope);
        if (!access.ok) return access.reply;
        const applied = await backend.documentApply({
          artifactId: input.artifactId,
          ownerId: access.userId,
          authorKind: "agent",
          authorId: access.userId,
          baseSeq: input.baseSeq,
          idempotencyKey: input.idempotencyKey,
          ops: input.ops as DocumentOperation[],
        });
        if (!applied.ok) return documentFailure(applied, input.artifactId);
        const value = {
          artifactId: input.artifactId,
          baseSeq: input.baseSeq,
          seq: applied.value.seq,
          applied: applied.value.applied,
          replayed: applied.value.replayed,
          published: applied.value.published,
          revisionId: applied.value.revisionId,
        };
        return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
      },
    );
    server.registerTool(
      "document_publish",
      {
        title: "Publish a markdown document",
        description: `Snapshot one owned markdown document's current draft and move the published pointer to it in one transaction, so the viewer and the public link serve the edits made with document_apply right away. Requires ${scope}. Publishing always freezes, whatever the operation count and however little time passed since the last snapshot. A draft with no pending operations refuses with nothing_to_publish and the reason no_pending_operations, because publishing nothing is not a publish. The reply carries the published revision id and the sequence it covers, seqFrom through seqTo.`,
        inputSchema: { artifactId: documentIdSchema },
        outputSchema: {
          artifactId: z.string(),
          revisionId: z.string(),
          revisionNumber: z.number().int(),
          seqFrom: z.number().int(),
          seqTo: z.number().int(),
        },
      },
      async ({ artifactId }) => {
        const access = allow(scope);
        if (!access.ok) return access.reply;
        const published = await backend.documentPublish(access.userId, artifactId);
        if (!published.ok) return documentFailure(published, artifactId);
        const value = published.value;
        return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
      },
    );

    const sceneRefusalOf = (body: SceneRefusalBody): ToolReply => {
      const { error, message, ...extra } = body;
      return refusal(error, message, extra);
    };
    const currentSceneOf = (userId: string, artifactId: string): Promise<Scene | null> =>
      sceneCurrentOf(backend, userId, artifactId);
    server.registerTool(
      "scene_outline",
      {
        title: "Outline a canvas scene",
        annotations: { readOnlyHint: true },
        description: `Return the frame index of one owned canvas's current draft: one entry per frame with its id, name, node count and bbox, plus the scene format version, the number of loose canvas-level nodes and the draft sequence — never the node bodies, so a canvas with hundreds of nodes costs one line per frame. Requires ${readScope}. The frame ids are what scene_read accepts; looseNodeCount is the size of the canvas level scene_read answers without a frameId; any artifact kind that is not a canvas refuses with wrong_kind.`,
        inputSchema: sceneOutlineInput.shape,
      },
      async ({ artifactId }) => {
        const access = allow(readScope);
        if (!access.ok) return access.reply;
        const outcome = await sceneOutlineOf(backend, { artifactId, ownerId: access.userId });
        if (!outcome.ok) return sceneRefusalOf(outcome.refusal);
        return reply(outcome.value);
      },
    );
    server.registerTool(
      "artifact_get_scene",
      {
        title: "Render a canvas or deck for the host viewer",
        annotations: { readOnlyHint: true },
        description: `Render one owned canvas or deck's current draft as a complete HTML document, the same document the instance's own viewer serves: a canvas arrives as one surface with its frames, a frame index and a fit control, a deck as one slide at a time with back, forward and the slide list, so a host draws the design instead of the scene JSON. Requires ${readScope}. The document names a single image origin, the instance's own, and an image the artifact does not own draws as a placeholder, so nothing else is ever fetched. Read it with artifact_get when the bytes matter; any artifact kind that is not a canvas or a deck refuses with wrong_kind.`,
        inputSchema: { artifactId: documentIdSchema },
      },
      async ({ artifactId }) => {
        const access = allow(readScope);
        if (!access.ok) return access.reply;
        const render = options.sceneDocument;
        if (render === undefined) return refusal("unavailable", "scene_document_renderer_unavailable", { artifactId });
        const loaded = await loadScene(backend, access.userId, artifactId);
        if (!loaded.ok) return sceneRefusalOf(loaded.refusal);
        return reply({
          artifactId,
          revisionId: loaded.value.revisionId,
          kind: loaded.value.kind,
          documentHtml: await render({
            artifactId,
            kind: loaded.value.kind,
            scene: loaded.value.scene,
          }),
        });
      },
    );
    server.registerTool(
      "scene_read",
      {
        title: "Read one canvas frame or the canvas level",
        annotations: { readOnlyHint: true },
        description: `Read one frame of one owned canvas's current draft — its id, name, geometry, bbox and nodes — or, with no frameId, the canvas level: the loose nodes that belong to no frame, answered as canvas { nodeCount, nodes }. Both narrow to nodeIds when given. Requires ${readScope}. One read returns at most ${MAX_SCENE_READ_NODES} nodes and at most ${MAX_SCENE_READ_BYTES} bytes of frame or canvas JSON; a wider request refuses with too_large and its named reason instead of truncating, so narrow it with nodeIds or read another frame. An id the scene does not hold refuses with unknown_frame or unknown_node, and any artifact kind that is not a canvas refuses with wrong_kind.`,
        inputSchema: sceneReadInput.shape,
      },
      async ({ artifactId, frameId, nodeIds }) => {
        const access = allow(readScope);
        if (!access.ok) return access.reply;
        const outcome = await sceneReadOf(backend, { artifactId, ownerId: access.userId, frameId, nodeIds });
        if (!outcome.ok) return sceneRefusalOf(outcome.refusal);
        return reply(outcome.value);
      },
    );
    server.registerTool(
      "scene_apply",
      {
        title: "Apply operations to a canvas scene",
        description: `Apply a batch of id-addressed operations to one owned canvas in one atomic call, instead of resending the scene. Requires ${scope}. baseSeq is the draft sequence you read; a stale one refuses with concurrent_edit and the current sequence, and nothing is written. idempotencyKey makes a retry safely replayable: the same key applies once. Operations: add_frame, update_frame, remove_frame, add_node, update_node, move_node, reorder_node, remove_node, add_canvas_node, update_canvas_node, move_canvas_node, reorder_canvas_node, remove_canvas_node and replace_scene (the escape hatch that replaces the whole scene). The eight frame operations address a node inside one frame; the five canvas operations address a loose node that belongs to no frame, and they are the only way to create, move, restack or delete that canvas level. A batch is all-or-nothing: a failing operation refuses with invalid_operation, its opIndex, the named reason and the unchanged scene. The reply carries the new sequence, how many operations applied, the computed box of every touched frame node so the result can be judged without pixels, the violations the scene engine reports, and whether this call froze a snapshot: published reports whether it froze one and revisionId names it. A loose canvas node is reported in no box, because a box is absolute scene geometry inside a named frame; read the canvas level with scene_read and no frameId to see one.`,
        inputSchema: sceneApplyInput.shape,
        outputSchema: {
          artifactId: z.string(),
          baseSeq: z.number().int(),
          seq: z.number().int(),
          applied: z.number().int(),
          replayed: z.boolean(),
          published: z.boolean(),
          revisionId: z.string().nullable(),
          boxes: z.array(
            z.object({
              id: z.string(),
              frameId: z.string(),
              x: z.number(),
              y: z.number(),
              w: z.number(),
              h: z.number(),
            }),
          ),
          violations: z.array(z.looseObject({ reason: z.string(), path: z.string() })),
        },
      },
      async (input) => {
        const access = allow(scope);
        if (!access.ok) return access.reply;
        const outcome = await sceneApplyOf(
          backend,
          { ownerId: access.userId, authorKind: "agent", authorId: access.userId },
          {
            artifactId: input.artifactId,
            baseSeq: input.baseSeq,
            idempotencyKey: input.idempotencyKey,
            ops: input.ops as SceneOperation[],
          },
        );
        if (!outcome.ok) return sceneRefusalOf(outcome.refusal);
        const value = outcome.value;
        return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
      },
    );

    server.registerTool(
      "asset_upload",
      {
        title: "Attach one raster asset to an artifact",
        description: `Store one raster image once, by its content address, and reference it from one owned artifact: the reply's sha256 is the digest a canvas scene's image node names. Requires ${scope}. contentType must be image/png, image/jpeg, image/webp or image/gif; svg is refused on purpose. contentBase64 decodes to at most ${MAX_MCP_ASSET_BYTES} bytes (${Math.floor(MAX_MCP_ASSET_BYTES / 1024)} KiB), the largest asset the MCP request body can carry in one call: a bigger payload refuses with too_large and its maxBytes, so downscale the image instead of sending it. The server decodes and hashes the bytes itself, so re-sending identical bytes answers the same digest and stores no second object.`,
        inputSchema: {
          artifactId: z.string().min(1).max(100),
          contentType: z.string().min(1).max(200),
          contentBase64: z.string().min(1),
        },
        outputSchema: {
          sha256: z.string().regex(HEX_SHA256),
          sizeBytes: z.number().int(),
          contentType: z.string(),
        },
      },
      async (input) => {
        const access = allow(scope);
        if (!access.ok) return access.reply;
        if (!UUID_RE.test(input.artifactId))
          return refusal("invalid_artifact_id", "artifactId must be a canonical lowercase uuid (8-4-4-4-12 hex)", {
            artifactId: input.artifactId,
          });
        if (input.contentBase64.length > MAX_MCP_ASSET_BASE64_CHARS)
          return refusal(
            "too_large",
            `the encoded payload exceeds the ${MAX_MCP_ASSET_BYTES} raw bytes the MCP request body carries in one call: downscale the image`,
            {
              maxBytes: MAX_MCP_ASSET_BYTES,
              maxEncodedChars: MAX_MCP_ASSET_BASE64_CHARS,
              encodedChars: input.contentBase64.length,
            },
          );
        const bytes = decodeBase64(input.contentBase64);
        if (!bytes) return refusal("validation", "contentBase64 is not a non-empty base64 payload");
        const stored = await uploadAsset({
          ownerId: access.userId,
          artifactId: input.artifactId,
          contentType: input.contentType,
          bytes,
        });
        if (!stored.ok)
          return refusal(
            stored.kind,
            stored.reason,
            stored.maxBytes === undefined ? {} : { maxBytes: stored.maxBytes },
          );
        const value = {
          sha256: stored.value.sha256,
          sizeBytes: stored.value.sizeBytes,
          contentType: stored.value.contentType,
        };
        return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
      },
    );

    const commentGate = async (
      query: McpExecutor,
      userId: string,
      artifactId: string,
      lock = false,
    ): Promise<McpCommentDocument | ToolReply> => {
      if (!UUID_RE.test(artifactId))
        return refusal("invalid_artifact_id", "artifactId must be a canonical lowercase uuid (8-4-4-4-12 hex)");
      const row = await commentDocument(query as unknown as McpExecutor, userId, artifactId, "owner", lock);
      if (!row) return refusal("not_found", "artifact_not_visible_to_owner");
      if (row.deletedAt) return refusal("gone", "artifact_deleted");
      return row;
    };
    const mutateComment = async (
      userId: string,
      artifactId: string,
      action: (client: McpExecutor, doc: McpCommentDocument) => Promise<ToolReply>,
    ): Promise<ToolReply> => {
      return commentTransaction(async (tx) => {
        const gate = await commentGate(tx, userId, artifactId, true);
        const result = "content" in gate ? gate : await action(tx, gate);
        if (result.isError) throw new RollbackReply(result);
        return result;
      });
    };
    const bodyError = (body: string): ToolReply | undefined => {
      if (!body.trim()) return refusal("validation", "body_required");
      if (Array.from(body).length > MAX_COMMENT_BODY)
        return refusal("too_large", "comment_body_exceeds_cap", { maxCharacters: MAX_COMMENT_BODY });
    };
    const findStored = async (
      client: McpExecutor,
      artifactId: string,
      commentId: string,
    ): Promise<McpCommentRow | ToolReply> => {
      if (!UUID_RE.test(commentId)) return refusal("validation", "commentId must be a canonical lowercase uuid");
      const row = await backendFindComment(client, artifactId, commentId);
      return row ?? refusal("comment_not_found", "comment_not_found");
    };
    const insertStored = async (
      client: McpExecutor,
      artifactId: string,
      userId: string,
      parentId: string | null,
      anchor: AnyCommentAnchor | null,
      revisionId: string | null,
      body: string,
    ): Promise<ToolReply> => {
      const inserted = await insertComment(client, {
        artifactId,
        authorId: userId,
        parentId,
        anchor,
        revisionId,
        body,
      });
      return reply({ id: inserted.id });
    };
    const artifactIdSchema = z.string().min(1).max(100);
    const commentIdSchema = z.string().min(1).max(100);
    server.registerTool(
      "artifact_list_comments",
      {
        title: "List comment threads",
        annotations: { readOnlyHint: true },
        description: `List an owned document's roots with ordered nested replies, including anchors, bodies and resolution timestamps. Requires ${readScope}; comments create no document revisions. Authors are returned as { id, name, image } and never expose email addresses. A canvas thread also carries orphaned, true when the node its anchor names is no longer in the current scene.`,
        inputSchema: { artifactId: artifactIdSchema },
      },
      async ({ artifactId }) => {
        const access = allow(readScope);
        if (!access.ok) return access.reply;
        const gate = await commentGate(undefined, access.userId, artifactId);
        if ("content" in gate) return gate;
        const rows = await listComments(undefined, artifactId, false);
        const scene = acceptsSceneAnchors(gate.kind) ? await currentSceneOf(access.userId, artifactId) : null;
        return reply({
          comments: rows
            .filter((row) => row.parentId === null)
            .map((row) => ({
              ...serializeComment(row),
              ...(scene === null ? {} : { orphaned: sceneAnchorIsOrphaned(scene, row.anchor) }),
              replies: rows
                .filter((child) => child.parentId === row.id)
                .map((child) => ({ ...serializeComment(child, row.anchor), replies: [] })),
            })),
        });
      },
    );
    server.registerTool(
      "artifact_add_comment",
      {
        title: "Comment on a document anchor",
        description: `Add a root comment to an owned document at a discriminated anchor. Requires ${scope}. Markdown accepts { kind: 'text-range', startLine, startCol, endLine, endCol, quotedText } with 1-indexed UTF-16 columns, end-exclusive, and quotedText matching the CURRENT source exactly; html accepts { kind: 'element', selector, point: { x, y } in 0..1, textHint (max 120 chars), viewportWidth } and { kind: 'page-point', x in 0..1, y in pixels, viewportWidth }; a canvas accepts { kind: 'board-point', boardId, nodeId, x, y } with x and y normalized 0..1 inside that node, so the pin survives the node moving or resizing. Nonblank body: at most ${MAX_COMMENT_BODY} Unicode characters; quote: at most ${MAX_COMMENT_QUOTE}. Refuses malformed anchors with validation, an anchor the document kind does not accept with unsupported_anchor_kind, a node the current scene does not hold with unknown_node, and changed quotes with anchor_mismatch.`,
        inputSchema: {
          artifactId: artifactIdSchema,
          anchor: commentAnchorSchema,
          body: z.string(),
        },
      },
      async ({ artifactId, anchor, body }) => {
        const access = allow(scope);
        if (!access.ok) return access.reply;
        return mutateComment(access.userId, artifactId, async (client, doc) => {
          const rejected = bodyError(body);
          if (rejected) return rejected;
          if (!anchorKindAllowed(doc.kind, anchor.kind))
            return refusal("unsupported_anchor_kind", "unsupported_anchor_kind", {
              acceptedKinds: anchorKindsForDocument(doc.kind),
            });
          const revision = await currentRevision(client, artifactId, true);
          if (!revision) return refusal("not_found", "revision_not_found");
          if (anchor.kind === "text-range") {
            if (Array.from(anchor.quotedText).length > MAX_COMMENT_QUOTE)
              return refusal("too_large", "comment_quote_exceeds_cap", { maxCharacters: MAX_COMMENT_QUOTE });
            const read = await getRevisionBytes({ storageKey: revision.storageKey, maxBytes: MAX_ARTIFACT_BYTES });
            if (!read.ok) return refusalOf(read);
            const decoded = decodeMarkdownText(read.value.bytes);
            if (!decoded.ok) return refusal("not_valid_utf8_markdown", "stored markdown bytes are not valid UTF-8");
            const selected = anchorText(decoded.text, anchor);
            if (selected === null) return refusal("validation", "invalid_anchor");
            if (selected !== anchor.quotedText) return refusal("anchor_mismatch", "anchor_mismatch");
          }
          if (isSceneAnchor(anchor)) {
            const loaded = await loadScene(backend, access.userId, artifactId);
            if (!loaded.ok) return sceneRefusalOf(loaded.refusal);
            if (sceneAnchorRefusal(loaded.value.scene, anchor) !== null)
              return refusal("unknown_node", "anchor_node_is_not_in_the_scene", {
                artifactId,
                nodeId: anchor.nodeId,
              });
          }
          return insertStored(client, artifactId, access.userId, null, anchor, revision.id, body);
        });
      },
    );
    server.registerTool(
      "artifact_reply_comment",
      {
        title: "Reply to a comment thread",
        description: `Reply to an owned document's root comment with body only (nonblank, at most ${MAX_COMMENT_BODY} Unicode characters). Requires ${scope}. Replies carry no anchor and inherit their root's context, even if outdated; replying to a reply refuses with nested_reply.`,
        inputSchema: { artifactId: artifactIdSchema, commentId: commentIdSchema, body: z.string() },
      },
      async ({ artifactId, commentId, body }) => {
        const access = allow(scope);
        if (!access.ok) return access.reply;
        return mutateComment(access.userId, artifactId, async (client) => {
          const rejected = bodyError(body);
          if (rejected) return rejected;
          const parent = await findStored(client, artifactId, commentId);
          if (!("id" in parent)) return parent;
          if (parent.parentId !== null) return refusal("nested_reply", "nested_reply", { status: 400 });
          return insertStored(client, artifactId, access.userId, parent.id, null, null, body);
        });
      },
    );
    for (const operation of ["resolve", "unresolve"] as const) {
      server.registerTool(
        `artifact_${operation}_comment`,
        {
          title: `${operation === "resolve" ? "Resolve" : "Unresolve"} a markdown comment thread`,
          description: `Set or clear resolvedAt on an owned markdown document's root comment. Requires ${scope}. Replies refuse with reply_is_not_root (status 400).`,
          inputSchema: { artifactId: artifactIdSchema, commentId: commentIdSchema },
        },
        async ({ artifactId, commentId }) => {
          const access = allow(scope);
          if (!access.ok) return access.reply;
          return mutateComment(access.userId, artifactId, async (client) => {
            const row = await findStored(client, artifactId, commentId);
            if (!("id" in row)) return row;
            if (row.parentId !== null) return refusal("reply_is_not_root", "reply_is_not_root", { status: 400 });
            await setCommentResolved(client, commentId, operation === "resolve", access.userId);
            return reply({ id: commentId });
          });
        },
      );
    }

    return server;
  };
}

const serializeComment = (row: McpCommentRow, inheritedAnchor?: unknown) => {
  const anchor = (row.anchor ?? inheritedAnchor ?? null) as AnyCommentAnchor | null;
  return {
    id: row.id,
    parentId: row.parentId,
    authorId: row.authorId,
    author: { id: row.authorId, name: row.authorName ?? "", image: row.authorImage ?? null },
    anchor,
    body: row.body,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
};
