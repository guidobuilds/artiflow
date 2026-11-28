import { manageRequest } from "./auth-client.ts";

export type ArtboardRefreshResult = {
  readonly updated: boolean;
  readonly sourceRevisionId: string;
  readonly sourceRevisionNumber: number;
};

const REVISION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseArtboardRefresh = (body: unknown): ArtboardRefreshResult | null => {
  if (!record(body)) return null;
  if (typeof body.updated !== "boolean") return null;
  if (typeof body.sourceRevisionId !== "string" || !REVISION_ID.test(body.sourceRevisionId)) return null;
  if (typeof body.sourceRevisionNumber !== "number" || !Number.isSafeInteger(body.sourceRevisionNumber)) return null;
  if (body.sourceRevisionNumber < 1) return null;
  return {
    updated: body.updated,
    sourceRevisionId: body.sourceRevisionId,
    sourceRevisionNumber: body.sourceRevisionNumber,
  };
};

export const refreshArtboardSource = async (
  designId: string,
  frameId: string,
): Promise<ArtboardRefreshResult | null> => {
  const result = await manageRequest(
    `/api/artifacts/${encodeURIComponent(designId)}/frames/${encodeURIComponent(frameId)}/source/refresh`,
    "POST",
    parseArtboardRefresh,
    {},
  );
  return result.ok ? result.value : null;
};

export type ArtboardPick = {
  readonly frameId: string;
  readonly revisionId: string;
  readonly nonce: string;
  readonly html: string;
};

export const parseArtboardPick = (body: unknown): ArtboardPick | null => {
  if (!record(body)) return null;
  if (typeof body.frameId !== "string" || body.frameId === "") return null;
  if (typeof body.revisionId !== "string" || !REVISION_ID.test(body.revisionId)) return null;
  if (typeof body.nonce !== "string" || body.nonce === "") return null;
  if (typeof body.html !== "string" || body.html === "") return null;
  return { frameId: body.frameId, revisionId: body.revisionId, nonce: body.nonce, html: body.html };
};

export const fetchArtboardPick = async (designId: string, frameId: string): Promise<ArtboardPick | null> => {
  const result = await manageRequest(
    `/api/artifacts/${encodeURIComponent(designId)}/frames/${encodeURIComponent(frameId)}/pick`,
    "GET",
    parseArtboardPick,
  );
  return result.ok ? result.value : null;
};
