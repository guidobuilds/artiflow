import { createHash, randomBytes } from "node:crypto";

import { Hono, type Context } from "hono";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import { getRevisionBytes } from "../adapters/storage/s3.ts";
import type { createAuth } from "../auth.ts";
import {
  artifacts,
  artifactShares,
  artifactPublicLinks,
  artifactRevisions,
  MAX_ARTIFACT_BYTES,
} from "../adapters/postgres/db/artifact-schema.ts";
import type { AppDb, AppTx, Database } from "../adapters/postgres/db/client.ts";
import { user } from "../adapters/postgres/db/schema.ts";
import type { Storage } from "../adapters/storage/client.ts";
import { escapeAttribute, NOT_FOUND_HEADERS, NOT_FOUND_PAGE, VIEWER_HEADERS, wrapperPage } from "../viewer/html.ts";
import { markdownViewerPage, renderMarkdownFragment } from "../viewer/markdown.ts";
import { decodeMarkdownText } from "@artiflow/domain/markdown";
import { cookieMutationGuard, Rollback, sessionUserId } from "../http/index.ts";
import { readPrincipal } from "../http/principal.ts";
import type { LinkListResponse, LinkReveal, ShareListResponse } from "@artiflow/contracts/shares";

type SharingAuth = ReturnType<typeof createAuth>;
export type SharingOptions = {
  database: Database;
  auth: SharingAuth;
  publicOrigin: string;
  principal?: true;
};

export function readableArtifactPredicate(userId: string) {
  return and(
    isNull(artifacts.deletedAt),
    or(
      eq(artifacts.ownerId, userId),
      sql`exists (select 1 from ${artifactShares} where ${artifactShares.artifactId} = ${artifacts.id} and ${artifactShares.sharedWithUserId} = ${userId})`,
    ),
  );
}

async function listShares(db: AppDb, artifactId: string) {
  return db
    .select({
      id: artifactShares.id,
      sharedWithUserId: artifactShares.sharedWithUserId,
      email: user.email,
      createdAt: artifactShares.createdAt,
    })
    .from(artifactShares)
    .innerJoin(user, eq(user.id, artifactShares.sharedWithUserId))
    .where(eq(artifactShares.artifactId, artifactId))
    .orderBy(asc(artifactShares.createdAt), asc(artifactShares.id))
    .limit(200);
}

async function findRecipient(db: AppDb, email: string) {
  return (
    await db
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(sql`lower(${user.email}) = lower(${email})`)
  )[0];
}

async function grantShare(db: AppDb, artifactId: string, recipientId: string, ownerId: string) {
  return (
    await db
      .insert(artifactShares)
      .values({ artifactId, sharedWithUserId: recipientId, grantedByUserId: ownerId })
      .onConflictDoNothing({ target: [artifactShares.artifactId, artifactShares.sharedWithUserId] })
      .returning({ id: artifactShares.id, createdAt: artifactShares.createdAt })
  )[0];
}

async function revokeShare(db: AppDb, shareId: string, artifactId: string) {
  return db
    .delete(artifactShares)
    .where(and(eq(artifactShares.id, shareId), eq(artifactShares.artifactId, artifactId)))
    .returning({ id: artifactShares.id });
}

async function listLinks(db: AppDb, artifactId: string) {
  return db
    .select({
      id: artifactPublicLinks.id,
      createdAt: artifactPublicLinks.createdAt,
      revokedAt: artifactPublicLinks.revokedAt,
    })
    .from(artifactPublicLinks)
    .where(eq(artifactPublicLinks.artifactId, artifactId))
    .orderBy(asc(artifactPublicLinks.createdAt), asc(artifactPublicLinks.id))
    .limit(200);
}

async function insertLink(db: AppDb | AppTx, artifactId: string, tokenHash: string, rotatedFromId: string | null) {
  return (
    await db
      .insert(artifactPublicLinks)
      .values({ artifactId, tokenHash, rotatedFromId })
      .returning({ id: artifactPublicLinks.id, createdAt: artifactPublicLinks.createdAt })
  )[0];
}

async function linkState(db: AppDb | AppTx, linkId: string, artifactId: string) {
  return (
    await db
      .select({ id: artifactPublicLinks.id, revokedAt: artifactPublicLinks.revokedAt })
      .from(artifactPublicLinks)
      .where(and(eq(artifactPublicLinks.id, linkId), eq(artifactPublicLinks.artifactId, artifactId)))
  )[0];
}

async function revokeLink(db: AppDb | AppTx, linkId: string, artifactId: string) {
  return db
    .update(artifactPublicLinks)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(artifactPublicLinks.id, linkId),
        eq(artifactPublicLinks.artifactId, artifactId),
        isNull(artifactPublicLinks.revokedAt),
      ),
    )
    .returning({ id: artifactPublicLinks.id });
}

type LinkRefusal = "not_found" | "already_revoked";
class RollbackLink extends Rollback<LinkRefusal> {}

async function rotateLink(db: AppDb, linkId: string, artifactId: string) {
  try {
    return await db.transaction(async (tx) => {
      const current = await linkState(tx, linkId, artifactId);
      if (!current) throw new RollbackLink("not_found");
      if (current.revokedAt !== null) throw new RollbackLink("already_revoked");
      const { token, tokenHash } = generateLinkToken();
      const inserted = await insertLink(tx, artifactId, tokenHash, current.id);
      await revokeLink(tx, current.id, artifactId);
      return { ok: true as const, id: inserted?.id, token };
    });
  } catch (error) {
    if (error instanceof RollbackLink) return { ok: false as const, error: error.carried };
    throw error;
  }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function publicArtifact(db: AppDb, tokenHash: string) {
  return (
    await db
      .select({
        storageKey: artifactRevisions.storageKey,
        sha256: artifactRevisions.sha256,
        revisionNumber: artifactRevisions.revision,
        sizeBytes: artifactRevisions.sizeBytes,
        kind: artifacts.kind,
      })
      .from(artifactPublicLinks)
      .innerJoin(artifacts, eq(artifacts.id, artifactPublicLinks.artifactId))
      .leftJoin(artifactRevisions, eq(artifactRevisions.id, artifacts.currentRevisionId))
      .where(
        and(
          eq(artifactPublicLinks.tokenHash, tokenHash),
          isNull(artifactPublicLinks.revokedAt),
          isNull(artifacts.deletedAt),
        ),
      )
  )[0];
}
const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export type ShareViewerOptions = {
  database: Database;
  storage: Storage;
  maxArtifactBytes?: number;
};

async function ownedArtifactId(db: AppDb, artifactId: string, ownerId: string): Promise<string | undefined> {
  return (
    await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.ownerId, ownerId), isNull(artifacts.deletedAt)))
  )[0]?.id;
}

export async function canReadArtifact(db: AppDb, userId: string, artifactId: string): Promise<boolean> {
  return (
    (
      await db
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(and(eq(artifacts.id, artifactId), readableArtifactPredicate(userId)))
    ).length > 0
  );
}

const TOKEN_BYTES = 32;
export function hashLinkToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateLinkToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashLinkToken(token) };
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  return email.length >= 3 && email.length <= 254 && /^[^@\s]+@[^@\s]+$/.test(email) ? email : null;
}

function guard(c: Context, publicOrigin: string, bearerServed: boolean): Response | null {
  if (bearerServed) return null;
  const rejected = cookieMutationGuard(c, publicOrigin);
  return rejected === null
    ? null
    : rejected === "origin_not_allowed"
      ? c.json({ error: rejected }, 403)
      : c.json({ error: rejected }, 415);
}

export function createSharingApp(options: SharingOptions): Hono {
  const { database, auth, publicOrigin } = options;
  const db = database.db;
  const app = new Hono();
  const shareUrl = (token: string): string => `${publicOrigin}/share/${token}`;
  const linkParam = (c: Context): string | null => {
    const linkId = c.req.param("linkId");
    return linkId !== undefined && UUID_RE.test(linkId) ? linkId : null;
  };

  app.get("/api/artifacts/:id/shares", async (c) => {
    const ownerId = readPrincipal(c.req.raw.headers)?.userId ?? (await sessionUserId(auth, c.req.raw.headers));
    if (!ownerId) return c.json({ error: "unauthorized" }, 401);
    if (!(await ownedArtifactId(db, c.req.param("id"), ownerId))) return c.json({ error: "not_found" }, 404);
    const rows = await listShares(db, c.req.param("id"));
    const shares = rows.map((row) => ({
      id: row.id,
      sharedWithUserId: row.sharedWithUserId,
      sharedWith: { email: row.email },
      createdAt: row.createdAt.toISOString(),
    }));
    return c.json({ shares } satisfies ShareListResponse);
  });

  app.post("/api/artifacts/:id/shares", async (c) => {
    const rejected = guard(c, publicOrigin, options.principal === true);
    if (rejected) return rejected;
    const ownerId = readPrincipal(c.req.raw.headers)?.userId ?? (await sessionUserId(auth, c.req.raw.headers));
    if (!ownerId) return c.json({ error: "unauthorized" }, 401);
    if (!(await ownedArtifactId(db, c.req.param("id"), ownerId))) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
    const email = normalizeEmail(body?.email);
    if (!email) return c.json({ error: "invalid_email" }, 400);
    const recipient = await findRecipient(db, email);
    if (!recipient) return c.json({ error: "recipient_not_found" }, 404);
    if (recipient.id === ownerId) return c.json({ error: "invalid_recipient" }, 400);
    const row = await grantShare(db, c.req.param("id"), recipient.id, ownerId);
    if (!row) return c.json({ error: "already_shared" }, 409);
    return c.json({ id: row.id, sharedWith: { email: recipient.email }, createdAt: row.createdAt.toISOString() }, 201);
  });

  app.delete("/api/artifacts/:id/shares/:shareId", async (c) => {
    const rejected = guard(c, publicOrigin, options.principal === true);
    if (rejected) return rejected;
    const ownerId = readPrincipal(c.req.raw.headers)?.userId ?? (await sessionUserId(auth, c.req.raw.headers));
    if (!ownerId) return c.json({ error: "unauthorized" }, 401);
    const artifactId = c.req.param("id");
    if (!(await ownedArtifactId(db, artifactId, ownerId))) return c.json({ error: "not_found" }, 404);
    const shareId = c.req.param("shareId");
    if (!UUID_RE.test(shareId)) return c.json({ error: "not_found" }, 404);
    const revoked = await revokeShare(db, shareId, artifactId);
    return revoked.length === 0 ? c.json({ error: "not_found" }, 404) : c.json({ ok: true }, 200);
  });

  app.get("/api/artifacts/:id/links", async (c) => {
    const ownerId = readPrincipal(c.req.raw.headers)?.userId ?? (await sessionUserId(auth, c.req.raw.headers));
    if (!ownerId) return c.json({ error: "unauthorized" }, 401);
    if (!(await ownedArtifactId(db, c.req.param("id"), ownerId))) return c.json({ error: "not_found" }, 404);
    const rows = await listLinks(db, c.req.param("id"));
    const links = rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    }));
    return c.json({ links } satisfies LinkListResponse);
  });

  app.post("/api/artifacts/:id/links", async (c) => {
    const rejected = guard(c, publicOrigin, options.principal === true);
    if (rejected) return rejected;
    const ownerId = readPrincipal(c.req.raw.headers)?.userId ?? (await sessionUserId(auth, c.req.raw.headers));
    if (!ownerId) return c.json({ error: "unauthorized" }, 401);
    if (!(await ownedArtifactId(db, c.req.param("id"), ownerId))) return c.json({ error: "not_found" }, 404);
    const { token, tokenHash } = generateLinkToken();
    const created = await insertLink(db, c.req.param("id"), tokenHash, null);
    return c.json({ id: created?.id, url: shareUrl(token), token } satisfies LinkReveal, 201);
  });

  app.post("/api/artifacts/:id/links/:linkId/rotate", async (c) => {
    const rejected = guard(c, publicOrigin, options.principal === true);
    if (rejected) return rejected;
    const ownerId = readPrincipal(c.req.raw.headers)?.userId ?? (await sessionUserId(auth, c.req.raw.headers));
    if (!ownerId) return c.json({ error: "unauthorized" }, 401);
    const artifactId = c.req.param("id");
    if (!(await ownedArtifactId(db, artifactId, ownerId))) return c.json({ error: "not_found" }, 404);
    const linkId = linkParam(c);
    if (!linkId) return c.json({ error: "not_found" }, 404);
    const rotated = await rotateLink(db, linkId, artifactId);
    if (!rotated.ok) return c.json({ error: rotated.error }, rotated.error === "not_found" ? 404 : 409);
    return c.json({ id: rotated.id, url: shareUrl(rotated.token), token: rotated.token } satisfies LinkReveal, 201);
  });

  app.delete("/api/artifacts/:id/links/:linkId", async (c) => {
    const rejected = guard(c, publicOrigin, options.principal === true);
    if (rejected) return rejected;
    const ownerId = readPrincipal(c.req.raw.headers)?.userId ?? (await sessionUserId(auth, c.req.raw.headers));
    if (!ownerId) return c.json({ error: "unauthorized" }, 401);
    const artifactId = c.req.param("id");
    if (!(await ownedArtifactId(db, artifactId, ownerId))) return c.json({ error: "not_found" }, 404);
    const linkId = linkParam(c);
    if (!linkId) return c.json({ error: "not_found" }, 404);
    const revoked = await revokeLink(db, linkId, artifactId);
    if (revoked.length > 0) return c.json({ ok: true }, 200);
    const state = await linkState(db, linkId, artifactId);
    return !state ? c.json({ error: "not_found" }, 404) : c.json({ error: "already_revoked" }, 409);
  });

  return app;
}

export function createShareViewerApp(options: ShareViewerOptions): Hono {
  const { database, storage } = options;
  const db = database.db;
  const maxBytes = Math.min(options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES);
  const app = new Hono();

  app.get("/share/:token", async (c) => {
    const token = c.req.param("token");
    if (!LINK_TOKEN_RE.test(token)) return c.html(NOT_FOUND_PAGE, 404, NOT_FOUND_HEADERS);
    const meta = new URL(c.req.url).searchParams.getAll("meta");
    if (meta.length > 1 || (meta.length === 1 && meta[0] !== "1"))
      return c.html(NOT_FOUND_PAGE, 404, NOT_FOUND_HEADERS);
    const row = await publicArtifact(db, hashLinkToken(token));
    if (!row?.storageKey || !row.sha256 || row.revisionNumber === null || row.sizeBytes === null)
      return c.html(NOT_FOUND_PAGE, 404, NOT_FOUND_HEADERS);
    if (meta.length === 1)
      return c.json(
        { revisionNumber: row.revisionNumber, sha256: row.sha256, sizeBytes: row.sizeBytes, kind: row.kind },
        200,
        { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex" },
      );
    const read = await getRevisionBytes({ storage, storageKey: row.storageKey, sha256: row.sha256, maxBytes });
    if (!read.ok) return c.html(NOT_FOUND_PAGE, 404, NOT_FOUND_HEADERS);
    const refresh = {
      metaUrl: `/share/${token}?meta=1`,
      revisionNumber: row.revisionNumber,
      sha256: row.sha256,
    };
    if (row.kind === "markdown") {
      const decoded = decodeMarkdownText(read.value.bytes);
      if (!decoded.ok) return c.html(NOT_FOUND_PAGE, 404, NOT_FOUND_HEADERS);
      return c.html(markdownViewerPage(renderMarkdownFragment(decoded.text), undefined, undefined, false, refresh), 200, {
        ...VIEWER_HEADERS,
        "x-robots-tag": "noindex",
      });
    }
    const escaped = escapeAttribute(new TextDecoder().decode(read.value.bytes));
    return c.html(wrapperPage(escaped, undefined, undefined, false, refresh), 200, {
      ...VIEWER_HEADERS,
      "x-robots-tag": "noindex",
    });
  });
  return app;
}
