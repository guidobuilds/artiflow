import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { applyLineOps, decodeMarkdownText, joinLines, toLines, type LineOp } from "@artiflow/domain/markdown";
import { artifactMetadataSchema, type ArtifactMetadata } from "@artiflow/contracts/artifacts";
import {
  McpRollback,
  type McpBackend,
  type McpCommentRow,
  type McpExecutor,
  type McpRevisionInput,
} from "@artiflow/mcp-server/ports";

import { anchorText, type AnyCommentAnchor, type TextRangeAnchor } from "@artiflow/domain/comment-anchors";
import { MCP_SERVER_INFO, type McpClaims } from "./claims.ts";

export { ARTIFACT_VIEWER_RESOURCE_URI } from "@artiflow/mcp-server/constants";
import {
  ARTIFACT_VIEWER_RESOURCE_URI,
  BASE64,
  HEX_SHA256,
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
class RollbackReply extends McpRollback<ToolReply> {}

const refusal = pkgRefusal;
const reply = pkgReply;
const refusalOf = pkgRefusalOf;

function decodeBase64(value: string): Uint8Array | undefined {
  if (!BASE64.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 ? bytes : undefined;
}

export type ArtifactToolOptions = {
  backend: McpBackend;
  viewerHtml: () => string;
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
  } = backend;
  const stagingStorageKey = (sha256: string) => `staging/${sha256}`;
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
        description: `Verify every staged chunk, recompute the whole-artifact sha256 and commit the upload as a new artifact or, with expectedRevisionId, as a compare-and-set revision. artifactId is optional and must be a canonical lowercase uuid when supplied. A digest mismatch stores no artifact row; staging keys may remain until a later cleanup unit. kind selects the artifact type: "html" (default) for a self-contained HTML artifact, "markdown" for a markdown document — markdown bytes must be valid UTF-8 text and the document can then be read and line-edited with artifact_get_markdown and artifact_edit_lines. artifact_commit ONLY finalizes a staged chunk stream; when the content already exists in your context as text, prefer the one-call artifact_write.`,
        inputSchema: {
          uploadId: z.string().min(1).max(100),
          artifactId: z.string().min(1).max(100).optional(),
          title: z.string().min(1).max(200).optional(),
          expectedRevisionId: z.string().min(1).max(100).optional(),
          kind: z.enum(["html", "markdown"]).optional(),
        },
        _meta: VIEWER_TOOL_META,
        outputSchema: {
          artifactId: z.string(),
          revisionId: z.string(),
          revisionNumber: z.number().int(),
          sizeBytes: z.number().int(),
          observedSizeBytes: z.number().int(),
          sha256: z.string().regex(HEX_SHA256),
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
        description: `Create a new artifact (or, with artifactId plus expectedRevisionId, a compare-and-set revision) from content you already hold as text: pass the full UTF-8 document — "html" (default) for a self-contained HTML page, "markdown" for a markdown document readable with artifact_get_markdown and editable with artifact_edit_lines. One call, no staging: the server computes the sha256 itself. Content over ${Math.floor(MAX_CHUNK_BYTES / 1024)} KiB decoded, or any binary artifact, goes through artifact_start_upload / artifact_put_chunk / artifact_commit instead (requires disk access).`,
        inputSchema: {
          text: z.string().min(1),
          kind: z.enum(["html", "markdown"]).optional(),
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
      if (row.kind !== "markdown")
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

    const commentGate = async (
      query: McpExecutor,
      userId: string,
      artifactId: string,
      lock = false,
    ): Promise<ToolReply | undefined> => {
      if (!UUID_RE.test(artifactId))
        return refusal("invalid_artifact_id", "artifactId must be a canonical lowercase uuid (8-4-4-4-12 hex)");
      const row = await commentDocument(query as unknown as McpExecutor, userId, artifactId, "owner", lock);
      if (!row) return refusal("not_found", "artifact_not_visible_to_owner");
      if (row.deletedAt) return refusal("gone", "artifact_deleted");
      if (row.kind !== "markdown") return refusal("wrong_kind", "artifact_is_not_a_markdown_document");
    };
    const mutateComment = async (
      userId: string,
      artifactId: string,
      action: (client: McpExecutor) => Promise<ToolReply>,
    ): Promise<ToolReply> => {
      return commentTransaction(async (tx) => {
        const result = (await commentGate(tx, userId, artifactId, true)) ?? (await action(tx));
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
        title: "List markdown comment threads",
        annotations: { readOnlyHint: true },
        description: `List an owned markdown document's roots with ordered nested replies, including source anchors, quotes and resolution timestamps. Requires ${readScope}; comments create no document revisions.`,
        inputSchema: { artifactId: artifactIdSchema },
      },
      async ({ artifactId }) => {
        const access = allow(readScope);
        if (!access.ok) return access.reply;
        const rejected = await commentGate(undefined, access.userId, artifactId);
        if (rejected) return rejected;
        const rows = await listComments(undefined, artifactId, false);
        return reply({
          comments: rows
            .filter((row) => row.parentId === null)
            .map((row) => ({
              ...serializeComment(row),
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
        title: "Comment on a markdown source selection",
        description: `Add a root comment to an owned markdown document. Requires ${scope}. Anchor lines and UTF-16 columns are 1-indexed, end-exclusive, and quotedText must match the CURRENT source exactly. Nonblank body: at most ${MAX_COMMENT_BODY} Unicode characters; quote: at most ${MAX_COMMENT_QUOTE}. Refuses invalid anchors with validation and changed quotes with anchor_mismatch.`,
        inputSchema: {
          artifactId: artifactIdSchema,
          anchor: z.object({ startLine: z.number(), startCol: z.number(), endLine: z.number(), endCol: z.number() }),
          quotedText: z.string(),
          body: z.string(),
        },
      },
      async ({ artifactId, anchor, quotedText, body }) => {
        const access = allow(scope);
        if (!access.ok) return access.reply;
        return mutateComment(access.userId, artifactId, async (client) => {
          const rejected = bodyError(body);
          if (rejected) return rejected;
          if (!quotedText) return refusal("validation", "quote_required");
          if (Array.from(quotedText).length > MAX_COMMENT_QUOTE)
            return refusal("too_large", "comment_quote_exceeds_cap", { maxCharacters: MAX_COMMENT_QUOTE });
          const revision = await currentRevision(client, artifactId, true);
          if (!revision) return refusal("not_found", "revision_not_found");
          const read = await getRevisionBytes({ storageKey: revision.storageKey, maxBytes: MAX_ARTIFACT_BYTES });
          if (!read.ok) return refusalOf(read);
          const decoded = decodeMarkdownText(read.value.bytes);
          if (!decoded.ok) return refusal("not_valid_utf8_markdown", "stored markdown bytes are not valid UTF-8");
          const selected = anchorText(decoded.text, anchor);
          if (selected === null) return refusal("validation", "invalid_anchor");
          if (selected !== quotedText) return refusal("anchor_mismatch", "anchor_mismatch");
          return insertStored(
            client,
            artifactId,
            access.userId,
            null,
            { ...anchor, kind: "text-range", quotedText },
            revision.id,
            body,
          );
        });
      },
    );
    server.registerTool(
      "artifact_reply_comment",
      {
        title: "Reply to a markdown comment thread",
        description: `Reply to an owned markdown document's root comment with body only (nonblank, at most ${MAX_COMMENT_BODY} Unicode characters). Requires ${scope}. Replies inherit their root's source context, even if outdated; replying to a reply refuses with nested_reply.`,
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
  const anchor = (row.anchor ?? inheritedAnchor ?? null) as TextRangeAnchor | null;
  return {
    id: row.id,
    parentId: row.parentId,
    authorId: row.authorId,
    anchor: anchor
      ? {
          startLine: anchor.startLine,
          startCol: anchor.startCol,
          endLine: anchor.endLine,
          endCol: anchor.endCol,
        }
      : null,
    quotedText: anchor?.quotedText ?? "",
    body: row.body,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
};
