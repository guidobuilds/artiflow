import { editsDocumentInApp, isArtifactKind, type ArtifactKind } from "@artiflow/domain/kinds";

import { manageRequest, type LocationTarget } from "./auth-client.ts";
import type { DetailWire } from "./lib/editor-freshness.ts";

export type Document = {
  artifactId: string;
  title: string;
  kind: ArtifactKind;
  revisionId: string;
  revisionNumber: number;
  text: string;
};
export type Revision = { id: string; revisionNumber: number; sizeBytes: number; createdAt: string };
export type SavedRevision = { revisionId: string; revisionNumber: number };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
const saved = (body: unknown): SavedRevision | null =>
  record(body) && typeof body.revisionId === "string" && body.revisionId !== "" && positive(body.revisionNumber)
    ? { revisionId: body.revisionId, revisionNumber: body.revisionNumber }
    : null;
const path = (id: string) => `/api/artifacts/${encodeURIComponent(id)}`;

const editableKind = (value: unknown): ArtifactKind | null => {
  const kind = typeof value === "string" ? value : "";
  return isArtifactKind(kind) && editsDocumentInApp(kind) ? kind : null;
};

export const getDocument = (id: string) =>
  manageRequest<Document>(`${path(id)}/document`, "GET", (body) => {
    const revision = saved(body);
    const kind = record(body) ? editableKind(body.kind) : null;
    return record(body) &&
      revision &&
      kind !== null &&
      typeof body.artifactId === "string" &&
      (body.title === null || typeof body.title === "string") &&
      typeof body.text === "string"
      ? {
          ...revision,
          kind,
          artifactId: body.artifactId,
          title: body.title || "Untitled document",
          text: body.text,
        }
      : null;
  });
export const listRevisions = (id: string) =>
  manageRequest<Revision[]>(`${path(id)}/revisions`, "GET", (body) => {
    if (!record(body) || !Array.isArray(body.revisions)) return null;
    const rows = body.revisions.map((row): Revision | null =>
      record(row) &&
      typeof row.id === "string" &&
      positive(row.revisionNumber) &&
      typeof row.sizeBytes === "number" &&
      typeof row.createdAt === "string"
        ? { id: row.id, revisionNumber: row.revisionNumber, sizeBytes: row.sizeBytes, createdAt: row.createdAt }
        : null,
    );
    return rows.every((row) => row !== null) ? rows : null;
  });
export const getArtifactDetail = (id: string) =>
  manageRequest<DetailWire>(path(id), "GET", (body) => {
    if (!record(body) || typeof body.id !== "string" || body.id === "") return null;
    if (body.revision === null) return { id: body.id, revision: null };
    const revision = record(body.revision) ? body.revision : null;
    return revision &&
      typeof revision.id === "string" &&
      revision.id !== "" &&
      positive(revision.revisionNumber) &&
      typeof revision.sha256 === "string" &&
      revision.sha256 !== "" &&
      typeof revision.sizeBytes === "number"
      ? {
          id: body.id,
          revision: {
            id: revision.id,
            revisionNumber: revision.revisionNumber,
            sha256: revision.sha256,
            sizeBytes: revision.sizeBytes,
          },
        }
      : null;
  });
export const saveDocument = (id: string, text: string, expectedRevisionId: string) =>
  manageRequest(`${path(id)}/document`, "PUT", saved, { text, expectedRevisionId });
export const restoreRevision = (id: string, revisionId: string, expectedRevisionId: string) =>
  manageRequest(`${path(id)}/revisions/${encodeURIComponent(revisionId)}/restore`, "POST", saved, {
    expectedRevisionId,
  });

export async function openArtifact(
  artifact: { id: string; viewerHref: string },
  target: LocationTarget,
): Promise<void> {
  const document = await getDocument(artifact.id);
  target.assign(document.ok ? `/edit/${encodeURIComponent(artifact.id)}` : artifact.viewerHref);
}
