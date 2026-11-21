import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, isNull } from "drizzle-orm";

import type { AdminInvitation } from "@artiflow/contracts/admin";

import { registrationInvite } from "../adapters/postgres/db/invite-schema.ts";
import { user } from "../adapters/postgres/db/schema.ts";
import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import { ACTIVE_ACCOUNT_STATUS } from "../identity/account-status.ts";
import type { UserRole } from "../identity/roles.ts";
import { canonicalizeEmail, createInviteToken, inviteUrl, isEmailAddress } from "../invites/token.ts";
import { recordAdminEvent } from "../logging/admin-events.ts";
import { findAccountByEmail } from "./accounts.ts";
import { reactivateAccount } from "./lifecycle.ts";

type Query = AppDb | AppTx;

export type InvitationRefusal =
  | "invitation_not_found"
  | "invitation_consumed"
  | "invitation_expired"
  | "invitation_revoked";

type StoredInvitation = {
  id: string;
  email: string;
  userId: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
};

type InvitationViewRow = {
  id: string;
  email: string;
  expiresAt: Date;
  createdAt: Date;
  issuerId: string | null;
  issuerName: string | null;
  issuerEmail: string | null;
};

const storedColumns = {
  id: registrationInvite.id,
  email: registrationInvite.email,
  userId: registrationInvite.userId,
  expiresAt: registrationInvite.expiresAt,
  consumedAt: registrationInvite.consumedAt,
  revokedAt: registrationInvite.revokedAt,
};

const viewColumns = {
  id: registrationInvite.id,
  email: registrationInvite.email,
  expiresAt: registrationInvite.expiresAt,
  createdAt: registrationInvite.createdAt,
  issuerId: user.id,
  issuerName: user.name,
  issuerEmail: user.email,
};

function iso(value: Date): string {
  return value.toISOString();
}

function toAdminInvitation(row: InvitationViewRow): AdminInvitation {
  return {
    id: row.id,
    email: row.email,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
    issuedBy:
      row.issuerId === null
        ? null
        : { id: row.issuerId, name: row.issuerName ?? "", email: row.issuerEmail ?? "" },
  };
}

function invitationViews(db: Query) {
  return db
    .select(viewColumns)
    .from(registrationInvite)
    .leftJoin(user, eq(user.id, registrationInvite.createdBy));
}

function pendingAt(at: Date) {
  return and(
    isNull(registrationInvite.consumedAt),
    isNull(registrationInvite.revokedAt),
    gt(registrationInvite.expiresAt, at),
  );
}

async function readInvitationView(db: Query, invitationId: string): Promise<AdminInvitation | null> {
  const rows = await invitationViews(db).where(eq(registrationInvite.id, invitationId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toAdminInvitation(row);
}

async function readStoredInvitation(db: Query, invitationId: string): Promise<StoredInvitation | null> {
  const rows = await db
    .select(storedColumns)
    .from(registrationInvite)
    .where(eq(registrationInvite.id, invitationId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listPendingInvitations(input: { db: AppDb; now?: Date }): Promise<AdminInvitation[]> {
  const rows = await invitationViews(input.db)
    .where(pendingAt(input.now ?? new Date()))
    .orderBy(asc(registrationInvite.expiresAt), asc(registrationInvite.id));
  return rows.map(toAdminInvitation);
}

function stateOf(row: StoredInvitation, at: Date): "pending" | "consumed" | "expired" | "revoked" {
  if (row.revokedAt !== null) return "revoked";
  if (row.consumedAt !== null) return "consumed";
  return row.expiresAt.getTime() > at.getTime() ? "pending" : "expired";
}

function refusalOf(state: "pending" | "consumed" | "expired" | "revoked"): InvitationRefusal {
  if (state === "consumed") return "invitation_consumed";
  if (state === "expired") return "invitation_expired";
  if (state === "revoked") return "invitation_revoked";
  return "invitation_not_found";
}

async function refusalReason(db: Query, invitationId: string, at: Date): Promise<InvitationRefusal> {
  const row = await readStoredInvitation(db, invitationId);
  return row === null ? "invitation_not_found" : refusalOf(stateOf(row, at));
}

export type CreateInvitationInput = {
  db: AppDb;
  email: string;
  actorId: string;
  actorRole: UserRole;
  publicOrigin: string;
  requestId?: string;
  now?: Date;
};

export type CreateInvitationOutcome =
  | { kind: "created"; invitation: AdminInvitation; link: string; reactivated: boolean }
  | { kind: "invalid-email" }
  | { kind: "email-in-use" };

export async function createInvitation(input: CreateInvitationInput): Promise<CreateInvitationOutcome> {
  const email = canonicalizeEmail(input.email);
  if (!isEmailAddress(email)) return { kind: "invalid-email" };
  const at = input.now ?? new Date();

  const existing = await findAccountByEmail(input.db, email);
  if (existing !== null && existing.status === ACTIVE_ACCOUNT_STATUS) return { kind: "email-in-use" };

  let reactivated = false;
  if (existing !== null) {
    const change = await reactivateAccount({
      db: input.db,
      userId: existing.id,
      actorId: input.actorId,
      actorRole: input.actorRole,
      at,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    if (change.kind !== "changed") return { kind: "email-in-use" };
    reactivated = true;
  }

  const issued = createInviteToken(at);
  const invitation = await input.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(registrationInvite)
      .values({
        id: randomUUID(),
        email,
        tokenHash: issued.tokenHash,
        expiresAt: issued.expiresAt,
        createdBy: input.actorId,
        ...(existing === null ? {} : { userId: existing.id }),
      })
      .returning({ id: registrationInvite.id });
    const row = inserted[0];
    if (row === undefined) throw new Error("the invitation insert returned no row");
    recordAdminEvent({
      event: "invitation.created",
      actorId: input.actorId,
      actorRole: input.actorRole,
      subjectId: row.id,
      outcome: "applied",
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    const view = await readInvitationView(tx, row.id);
    if (view === null) throw new Error("the created invitation cannot be read back");
    return view;
  });

  return { kind: "created", invitation, link: inviteUrl(input.publicOrigin, issued.token), reactivated };
}

export type InvitationChangeInput = {
  db: AppDb;
  invitationId: string;
  actorId: string;
  actorRole: UserRole;
  publicOrigin: string;
  requestId?: string;
  now?: Date;
};

export type RevokeInvitationOutcome =
  | { kind: "revoked"; invitation: { id: string; revokedAt: string } }
  | { kind: "refused"; reason: InvitationRefusal };

export async function revokeInvitation(input: InvitationChangeInput): Promise<RevokeInvitationOutcome> {
  const at = input.now ?? new Date();
  return await input.db.transaction(async (tx) => {
    const revoked = await tx
      .update(registrationInvite)
      .set({ revokedAt: at })
      .where(and(eq(registrationInvite.id, input.invitationId), pendingAt(at)))
      .returning({ id: registrationInvite.id });
    if (revoked.length === 0)
      return { kind: "refused" as const, reason: await refusalReason(tx, input.invitationId, at) };

    recordAdminEvent({
      event: "invitation.revoked",
      actorId: input.actorId,
      actorRole: input.actorRole,
      subjectId: input.invitationId,
      outcome: "applied",
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return { kind: "revoked" as const, invitation: { id: input.invitationId, revokedAt: iso(at) } };
  });
}

export type RegenerateInvitationOutcome =
  | { kind: "regenerated"; invitation: AdminInvitation; link: string }
  | { kind: "refused"; reason: InvitationRefusal };

export async function regenerateInvitation(input: InvitationChangeInput): Promise<RegenerateInvitationOutcome> {
  const at = input.now ?? new Date();
  const issued = createInviteToken(at);
  return await input.db.transaction(async (tx) => {
    const current = await readStoredInvitation(tx, input.invitationId);
    if (current === null) return { kind: "refused" as const, reason: "invitation_not_found" as const };
    const state = stateOf(current, at);
    if (state !== "pending") return { kind: "refused" as const, reason: refusalOf(state) };

    const revoked = await tx
      .update(registrationInvite)
      .set({ revokedAt: at })
      .where(and(eq(registrationInvite.id, input.invitationId), pendingAt(at)))
      .returning({ id: registrationInvite.id });
    if (revoked.length === 0)
      return { kind: "refused" as const, reason: await refusalReason(tx, input.invitationId, at) };

    const inserted = await tx
      .insert(registrationInvite)
      .values({
        id: randomUUID(),
        email: current.email,
        tokenHash: issued.tokenHash,
        expiresAt: issued.expiresAt,
        createdBy: input.actorId,
        ...(current.userId === null ? {} : { userId: current.userId }),
      })
      .returning({ id: registrationInvite.id });
    const row = inserted[0];
    if (row === undefined) throw new Error("the invitation insert returned no row");

    recordAdminEvent({
      event: "invitation.regenerated",
      actorId: input.actorId,
      actorRole: input.actorRole,
      subjectId: row.id,
      outcome: "applied",
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    const view = await readInvitationView(tx, row.id);
    if (view === null) throw new Error("the regenerated invitation cannot be read back");
    return { kind: "regenerated" as const, invitation: view, link: inviteUrl(input.publicOrigin, issued.token) };
  });
}
