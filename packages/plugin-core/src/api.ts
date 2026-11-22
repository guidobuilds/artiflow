import { Unauthorized } from "@artiflow/sdk/auth";
import {
  artifactDetailSchema,
  v1ArtifactBytesResponseSchema,
  v1ArtifactUpdateResponseSchema,
  type ArtifactDetail,
  type ArtifactMetadata,
  type CreateArtifactResponse,
  type V1ArtifactBytesResponse,
} from "@artiflow/contracts/artifacts";
import {
  documentResponseSchema,
  savedRevisionSchema,
  type DocumentResponse,
  type SavedRevision,
} from "@artiflow/contracts/document";
import { commentListResponseSchema, type CommentListResponse } from "@artiflow/contracts/comments";
import { acceptsTextOperations, capabilitiesFor } from "@artiflow/domain/kinds";
import { applyLineOps, joinLines, toLines, type LineOp } from "@artiflow/domain/markdown";

export type Refusal = { error: string; message: string; [key: string]: unknown };

export class ArtifactRefusal extends Error {
  readonly body: Refusal;
  constructor(body: Refusal) {
    super(body.message);
    this.name = "ArtifactRefusal";
    this.body = body;
  }
}

type Schema<T> = { safeParse: (value: unknown) => { success: true; data: T } | { success: false } };

export type ArtifactApiOptions = {
  base: string;
  token: string;
  request?: typeof fetch;
  signal?: AbortSignal;
};

export type WriteInput = {
  text: string;
  kind?: string;
  title?: string;
  artifactId?: string;
  expectedRevisionId?: string;
};

export type MarkdownInput = { artifactId: string; from?: number; to?: number };

export type EditLinesInput = { artifactId: string; expectedRevisionId: string; ops: LineOp[] };

export type ArtifactApi = ReturnType<typeof createArtifactApi>;

const messages: Record<string, string> = {
  concurrent_edit: "document_changed_since_read",
  concurrent_commit: "artifact_changed_since_read",
  not_found: "artifact_not_visible_to_owner",
  gone: "artifact_deleted",
  wrong_kind: "artifact_kind_mismatch",
  expected_revision_id_required: "expectedRevisionId is required to update an existing artifact",
  artifact_id_required_for_expected_revision: "artifactId is required with expectedRevisionId",
  no_current_revision: "artifact_has_no_current_revision",
  text_required: "text_required",
  too_large: "the document exceeds the artifact size cap",
  unauthorized: "the credential may not use this route",
  forbidden: "the credential may not write this artifact",
  artifact_unavailable: "artifact bytes are unavailable",
  invalid_request: "invalid_request",
  empty_line_window: "empty_line_window",
  validation: "invalid_line_operation",
  unreadable_response: "the instance answered a body this plugin cannot read",
  http: "the instance answered with an unexpected status",
};

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

export function createArtifactApi(options: ArtifactApiOptions) {
  const request = options.request ?? fetch;
  const base = options.base.replace(/\/$/, "");

  const refusal = (error: string, extra: Record<string, unknown> = {}): never => {
    throw new ArtifactRefusal({ error, message: messages[error] ?? error, ...extra });
  };

  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${options.token}`);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await request(`${base}/api/v1${path}`, {
      ...init,
      method: init.method ?? "GET",
      headers,
      cache: "no-store",
      signal: options.signal,
    });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text.trim() === "" ? null : JSON.parse(text);
    } catch {
      payload = null;
    }
    if (response.status === 401) throw new Unauthorized("Artiflow API rejected the access token");
    return { status: response.status, ok: response.ok, payload };
  };

  const failure = (payload: unknown, status: number): never => {
    const body = object(payload);
    const error = typeof body.error === "string" ? body.error : "http";
    const extra = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "error"));
    return refusal(error, { ...extra, ...(error === "http" ? { status } : {}) });
  };

  const parse = <T>(schema: Schema<T>, payload: unknown, extra: Record<string, unknown>): T => {
    const parsed = schema.safeParse(payload);
    return parsed.success ? parsed.data : refusal("unreadable_response", extra);
  };

  const read = async <T>(schema: Schema<T>, path: string, extra: Record<string, unknown>): Promise<T> => {
    const response = await send(path);
    if (!response.ok) return failure(response.payload, response.status);
    return parse(schema, response.payload, extra);
  };

  const document = (artifactId: string) =>
    read<DocumentResponse>(documentResponseSchema, `/artifacts/${encodeURIComponent(artifactId)}/document`, {
      artifactId,
    });

  const currentRevision = async (artifactId: string): Promise<Record<string, string>> => {
    const live = await send(`/artifacts/${encodeURIComponent(artifactId)}/document`);
    const revisionId = object(live.payload).revisionId;
    return live.ok && typeof revisionId === "string" ? { currentRevisionId: revisionId } : {};
  };

  const kindOf = async (artifactId: string): Promise<string> => {
    const detail = await read<ArtifactDetail>(artifactDetailSchema, `/artifacts/${encodeURIComponent(artifactId)}`, {
      artifactId,
    });
    if (detail.kind === "unknown") return refusal("wrong_kind", { artifactId });
    return detail.kind;
  };

  return {
    async probe(): Promise<void> {
      const response = await send("/artifacts");
      if (!response.ok) failure(response.payload, response.status);
    },

    async metadata(input: { artifactId: string }): Promise<ArtifactMetadata> {
      const detail = await read<ArtifactDetail>(
        artifactDetailSchema,
        `/artifacts/${encodeURIComponent(input.artifactId)}`,
        {
          artifactId: input.artifactId,
        },
      );
      const { revision } = detail;
      if (revision === null) return refusal("no_current_revision", { artifactId: input.artifactId });
      if (detail.kind === "unknown") return refusal("wrong_kind", { artifactId: input.artifactId });
      return {
        artifactId: detail.id,
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        kind: detail.kind,
        sha256: revision.sha256,
        sizeBytes: revision.sizeBytes,
      };
    },

    async get(input: { artifactId: string; revisionId?: string }): Promise<V1ArtifactBytesResponse> {
      const query = input.revisionId === undefined ? "" : `?revisionId=${encodeURIComponent(input.revisionId)}`;
      return read<V1ArtifactBytesResponse>(
        v1ArtifactBytesResponseSchema,
        `/artifacts/${encodeURIComponent(input.artifactId)}/bytes${query}`,
        { artifactId: input.artifactId },
      );
    },

    async getMarkdown(input: MarkdownInput) {
      const doc = await document(input.artifactId);
      const lines = toLines(doc.text);
      const from = Math.max(1, input.from ?? 1);
      const to = Math.min(lines.length, input.to ?? lines.length);
      if (from > to) return refusal("empty_line_window", { lineCount: lines.length, from, to });
      return {
        artifactId: input.artifactId,
        revisionId: doc.revisionId,
        lineCount: lines.length,
        from,
        to,
        lines: lines.slice(from - 1, to),
      };
    },

    async editLines(input: EditLinesInput) {
      const doc = await document(input.artifactId);
      if (doc.revisionId !== input.expectedRevisionId)
        return refusal("concurrent_edit", { artifactId: input.artifactId, currentRevisionId: doc.revisionId });
      const applied = applyLineOps(toLines(doc.text), input.ops);
      if (!applied.ok) {
        if (applied.kind === "expectation_mismatch")
          return refusal("expectation_mismatch", {
            reason: applied.reason,
            opIndex: applied.opIndex,
            window: applied.window,
          });
        return refusal("validation", {
          reason: applied.kind === "empty_ops" ? "ops_required" : applied.reason,
          opIndex: "opIndex" in applied ? applied.opIndex : undefined,
        });
      }
      const text = joinLines(applied.value);
      if (text.length === 0) return refusal("validation", { reason: "bytes_required" });
      const response = await send(`/artifacts/${encodeURIComponent(input.artifactId)}/document`, {
        method: "PUT",
        body: JSON.stringify({ text, expectedRevisionId: input.expectedRevisionId }),
      });
      if (!response.ok) {
        if (object(response.payload).error === "concurrent_edit")
          return refusal("concurrent_edit", {
            artifactId: input.artifactId,
            ...(await currentRevision(input.artifactId)),
          });
        return failure(response.payload, response.status);
      }
      const saved = parse<SavedRevision>(savedRevisionSchema, response.payload, { artifactId: input.artifactId });
      return {
        artifactId: input.artifactId,
        revisionId: saved.revisionId,
        revisionNumber: saved.revisionNumber,
        lineCount: applied.value.length,
        appliedOps: input.ops.length,
        sha256: saved.sha256,
      };
    },

    async listComments(input: { artifactId: string }): Promise<{ comments: CommentListResponse["comments"] }> {
      const listed = await read<CommentListResponse>(
        commentListResponseSchema,
        `/artifacts/${encodeURIComponent(input.artifactId)}/comments`,
        { artifactId: input.artifactId },
      );
      return { comments: listed.comments };
    },

    async write(input: WriteInput): Promise<CreateArtifactResponse | Record<string, unknown>> {
      const { text, kind, title, artifactId, expectedRevisionId } = input;
      const titleField = title === undefined ? {} : { title };
      if (expectedRevisionId === undefined) {
        if (artifactId !== undefined) return refusal("expected_revision_id_required", { artifactId });
        const response = await send("/artifacts", {
          method: "POST",
          body: JSON.stringify({ text, ...(kind === undefined ? {} : { kind }), ...titleField }),
        });
        if (!response.ok) return failure(response.payload, response.status);
        return parse<CreateArtifactResponse>(v1ArtifactUpdateResponseSchema, response.payload, {});
      }
      if (artifactId === undefined) return refusal("artifact_id_required_for_expected_revision", {});
      const target = kind ?? (await kindOf(artifactId));
      const capabilities = capabilitiesFor(target);
      if (capabilities === null) return refusal("wrong_kind", { artifactId });
      if (acceptsTextOperations(target)) {
        const response = await send(`/artifacts/${encodeURIComponent(artifactId)}/document`, {
          method: "PUT",
          body: JSON.stringify({ text, expectedRevisionId }),
        });
        if (!response.ok) {
          if (object(response.payload).error === "concurrent_edit")
            return refusal("concurrent_edit", { artifactId, ...(await currentRevision(artifactId)) });
          return failure(response.payload, response.status);
        }
        const saved = parse<SavedRevision>(savedRevisionSchema, response.payload, { artifactId });
        return {
          artifactId,
          revisionId: saved.revisionId,
          revisionNumber: saved.revisionNumber,
          sizeBytes: saved.sizeBytes,
          sha256: saved.sha256,
        };
      }
      const response = await send(`/artifacts/${encodeURIComponent(artifactId)}`, {
        method: "PUT",
        body: JSON.stringify({ text, kind: target, expectedRevisionId, ...titleField }),
      });
      if (!response.ok) return failure(response.payload, response.status);
      return parse<CreateArtifactResponse>(v1ArtifactUpdateResponseSchema, response.payload, { artifactId });
    },
  };
}
