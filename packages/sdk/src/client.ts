import {
  artifactDetailSchema,
  createArtifactResponseSchema,
  artifactListResponseSchema,
  okResponseSchema,
  sharedArtifactListResponseSchema,
  type ArtifactDetail,
  type ArtifactListResponse,
  type CreateArtifactRequest,
  type CreateArtifactResponse,
  type OkResponse,
  type SharedArtifactListResponse,
} from "@artiflow/contracts/artifacts";
import {
  documentResponseSchema,
  revisionListResponseSchema,
  savedRevisionSchema,
  type DocumentResponse,
  type RevisionListResponse,
  type RestoreRevisionRequest,
  type SaveDocumentRequest,
  type SavedRevision,
} from "@artiflow/contracts/document";
import {
  commentListResponseSchema,
  commentMutationResponseSchema,
  type CommentListResponse,
  type CommentMutationResponse,
  type CreateCommentRequest,
} from "@artiflow/contracts/comments";
import {
  linkListResponseSchema,
  linkRevealSchema,
  shareListResponseSchema,
  type LinkListResponse,
  type LinkReveal,
  type ShareListResponse,
} from "@artiflow/contracts/shares";
import type { z } from "zod";

export type SdkResult<T> = { ok: true; value: T } | { ok: false; code: string; status: number };

export type SdkClientOptions = {
  baseUrl?: string;
  apiPrefix?: string;
  fetch?: typeof fetch;
  bearerToken?: string | (() => string | undefined | Promise<string | undefined>);
  credentials?: "omit" | "same-origin" | "include";
};

const fail = (status: number, payload: unknown, fallback: string): SdkResult<never> => {
  const code =
    payload !== null && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : status >= 200 && status < 300
        ? fallback
        : `http_${status}`;
  return { ok: false, code: code || fallback, status };
};

const accept = <T>(schema: z.ZodType<T>, status: number, payload: unknown, fallback: string): SdkResult<T> => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail(status, payload, fallback);
  return { ok: true, value: parsed.data };
};

export function createSdkClient(options: SdkClientOptions = {}) {
  const transport = options.fetch ?? fetch;
  const anchor = options.baseUrl ?? "http://127.0.0.1:5173";
  const apiPrefix = options.apiPrefix ?? "";
  const base = (path: string): string => `${anchor.replace(/\/$/, "")}${apiPrefix}${path}`;

  const call = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const token = typeof options.bearerToken === "function" ? await options.bearerToken() : options.bearerToken;
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await transport(base(path), { ...init, headers });
    return { response, payload: await parsePayload(response) };
  };
  const parsePayload = async (response: Response): Promise<unknown> => {
    try {
      const text = await response.text();
      return text.trim() === "" ? null : JSON.parse(text);
    } catch {
      return null;
    }
  };

  const mutation = (path: string, body: unknown, method: "POST" | "PUT" | "DELETE") => {
    const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
    headers.set("origin", new URL(anchor).origin);
    return call(path, { method, headers, body: body === undefined ? "{}" : JSON.stringify(body) });
  };

  return {
    createArtifact: async (body: CreateArtifactRequest): Promise<SdkResult<CreateArtifactResponse>> => {
      const { response, payload } = await mutation(`/api/artifacts`, body, "POST");
      if (!response.ok) return fail(response.status, payload, "create_failed");
      return accept(createArtifactResponseSchema, response.status, payload, "create_unreadable");
    },
    listArtifacts: async (): Promise<SdkResult<ArtifactListResponse>> => {
      const { response, payload } = await call("/api/artifacts", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return fail(response.status, payload, "list_failed");
      return accept(artifactListResponseSchema, response.status, payload, "list_unreadable");
    },
    listSharedArtifacts: async (): Promise<SdkResult<SharedArtifactListResponse>> => {
      const { response, payload } = await call("/api/artifacts/shared", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return fail(response.status, payload, "list_failed");
      return accept(sharedArtifactListResponseSchema, response.status, payload, "list_unreadable");
    },
    getArtifact: async (id: string): Promise<SdkResult<ArtifactDetail>> => {
      const { response, payload } = await call(`/api/artifacts/${encodeURIComponent(id)}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return fail(response.status, payload, "get_failed");
      return accept(artifactDetailSchema, response.status, payload, "get_unreadable");
    },
    deleteArtifact: async (id: string): Promise<SdkResult<OkResponse>> => {
      const { response, payload } = await mutation(`/api/artifacts/${encodeURIComponent(id)}`, undefined, "DELETE");
      if (!response.ok) return fail(response.status, payload, "delete_failed");
      return accept(okResponseSchema, response.status, payload, "delete_unreadable");
    },
    getDocument: async (id: string): Promise<SdkResult<DocumentResponse>> => {
      const { response, payload } = await call(`/api/artifacts/${encodeURIComponent(id)}/document`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return fail(response.status, payload, "get_failed");
      return accept(documentResponseSchema, response.status, payload, "get_unreadable");
    },
    saveDocument: async (id: string, body: SaveDocumentRequest): Promise<SdkResult<SavedRevision>> => {
      const { response, payload } = await mutation(`/api/artifacts/${encodeURIComponent(id)}/document`, body, "PUT");
      if (!response.ok) return fail(response.status, payload, "save_failed");
      return accept(savedRevisionSchema, response.status, payload, "save_unreadable");
    },
    restoreRevision: async (
      id: string,
      revisionId: string,
      body: RestoreRevisionRequest,
    ): Promise<SdkResult<SavedRevision>> => {
      const { response, payload } = await mutation(
        `/api/artifacts/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/restore`,
        body,
        "POST",
      );
      if (!response.ok) return fail(response.status, payload, "restore_failed");
      return accept(savedRevisionSchema, response.status, payload, "restore_unreadable");
    },
    listRevisions: async (id: string): Promise<SdkResult<RevisionListResponse>> => {
      const { response, payload } = await call(`/api/artifacts/${encodeURIComponent(id)}/revisions`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return fail(response.status, payload, "list_failed");
      return accept(revisionListResponseSchema, response.status, payload, "list_unreadable");
    },
    listComments: async (id: string): Promise<SdkResult<CommentListResponse>> => {
      const { response, payload } = await call(`/api/artifacts/${encodeURIComponent(id)}/comments`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return fail(response.status, payload, "list_failed");
      return accept(commentListResponseSchema, response.status, payload, "list_unreadable");
    },
    createComment: async (id: string, body: CreateCommentRequest): Promise<SdkResult<CommentMutationResponse>> => {
      const { response, payload } = await mutation(`/api/artifacts/${encodeURIComponent(id)}/comments`, body, "POST");
      if (!response.ok) return fail(response.status, payload, "create_failed");
      return accept(commentMutationResponseSchema, response.status, payload, "create_unreadable");
    },
    listShares: async (id: string): Promise<SdkResult<ShareListResponse>> => {
      const { response, payload } = await call(`/api/artifacts/${encodeURIComponent(id)}/shares`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return fail(response.status, payload, "list_failed");
      return accept(shareListResponseSchema, response.status, payload, "list_unreadable");
    },
    createShare: async (id: string, body: { email: string }): Promise<SdkResult<ShareListResponse>> => {
      const { response, payload } = await mutation(`/api/artifacts/${encodeURIComponent(id)}/shares`, body, "POST");
      if (!response.ok) return fail(response.status, payload, "create_failed");
      return accept(shareListResponseSchema, response.status, payload, "create_unreadable");
    },
    listLinks: async (id: string): Promise<SdkResult<LinkListResponse>> => {
      const { response, payload } = await call(`/api/artifacts/${encodeURIComponent(id)}/links`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return fail(response.status, payload, "list_failed");
      return accept(linkListResponseSchema, response.status, payload, "list_unreadable");
    },
    createLink: async (id: string): Promise<SdkResult<LinkReveal>> => {
      const { response, payload } = await mutation(`/api/artifacts/${encodeURIComponent(id)}/links`, undefined, "POST");
      if (!response.ok) return fail(response.status, payload, "create_failed");
      return accept(linkRevealSchema, response.status, payload, "create_unreadable");
    },
  };
}

export type SdkClient = ReturnType<typeof createSdkClient>;
