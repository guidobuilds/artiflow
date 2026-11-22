import { manageRequest } from "./auth-client.ts";

export type InvitationIssuer = { id: string; name: string; email: string };
export type AdminInvitation = {
  id: string;
  email: string;
  expiresAt: string;
  createdAt: string;
  issuedBy: InvitationIssuer | null;
};
export type IssuedInvitation = { invitation: AdminInvitation; link: string; reactivated: boolean };
export type RegeneratedInvitation = { invitation: AdminInvitation; link: string };
export type RevokedInvitation = { id: string; revokedAt: string };
export type ResetLink = { link: string; expiresAt: string };

export type InvitationFailure = { ok: false; code: string; error: string; signInRequired: boolean };
export type InvitationListResult = { ok: true; value: AdminInvitation[] } | InvitationFailure;
export type InvitationIssueResult = { ok: true; value: IssuedInvitation } | InvitationFailure;
export type InvitationRegenerateResult = { ok: true; value: RegeneratedInvitation } | InvitationFailure;
export type InvitationRevokeResult = { ok: true; value: RevokedInvitation } | InvitationFailure;
export type ResetLinkResult = { ok: true; value: ResetLink } | InvitationFailure;

export type InvitationListRead = {
  invitations: AdminInvitation[] | null;
  failure: string;
  signInRequired: boolean;
};

export const EMPTY_INVITATION_READ: InvitationListRead = { invitations: null, failure: "", signInRequired: false };

export const ADMIN_INVITATIONS_PATH = "/api/admin/invitations";
export const ADMIN_RESET_LINKS_PATH = "/api/admin/reset-links";

const SIGN_IN_REQUIRED = "This browser has no signed-in account, so invitations cannot be shown. Sign in first.";
const UNRECOGNIZED = "The server refused that without a reason this page recognizes. Nothing was issued.";

const REFUSALS: Record<string, string> = {
  administrator_required: "Only an administrator can manage invitations. This page is not available to your account.",
  sign_in_required: SIGN_IN_REQUIRED,
  unauthorized: SIGN_IN_REQUIRED,
  invalid_email: "That is not a valid email address, so nothing was issued.",
  email_in_use: "That address already holds an active account, so no invitation was created.",
  invitation_not_found: "That invitation no longer exists. Reload the list to see what is pending.",
  invitation_consumed: "That invitation was already used to create the account, so it cannot be revoked or renewed.",
  invitation_expired: "That invitation has expired. Issue a new one for the same address instead.",
  invitation_revoked: "That invitation was already revoked. Issue a new one for the same address instead.",
  user_not_found: "No account uses that email address, so no reset link was issued.",
  account_deactivated: "That account is deactivated, so no reset link was issued. Reactivate the account first.",
  invalid_body: "The server refused the request as incomplete. Nothing was issued.",
  network: "The server could not be reached, so nothing was issued.",
  unreadable_answer: "The server answered unexpectedly, so nothing was shown as issued.",
};

export function invitationRefusalMessage(code: string): string {
  return REFUSALS[code] ?? UNRECOGNIZED;
}

export const INVITATION_LINK_WARNING =
  "This link is shown once and cannot be seen again. It is not stored anywhere: copy it now and share it outside Artiflow, because a reload loses it.";

export const RESET_LINK_WARNING =
  "This link is shown once and cannot be seen again. It is not stored anywhere: copy it now and send it to the person outside Artiflow, because a reload loses it.";

export const RESET_LINK_ACTIVE_ACCOUNT =
  "Only an active account can receive a reset link. A deactivated account refuses one, so reactivate it first.";

const INVITATION_LINK_REUSED =
  "It expires in 24 hours, works once, and the previous link for that address stopped working.";

export type LinkReveal = { kind: "hidden" } | { kind: "revealed"; url: string; warning: string };

export const HIDDEN_LINK: LinkReveal = { kind: "hidden" };

export function revealInvitationLink(link: string): LinkReveal {
  return { kind: "revealed", url: link, warning: INVITATION_LINK_WARNING };
}

export function revealResetLink(link: string): LinkReveal {
  return { kind: "revealed", url: link, warning: RESET_LINK_WARNING };
}

export function dismissLink(): LinkReveal {
  return HIDDEN_LINK;
}

export function linkNotice(state: LinkReveal): { url: string; warning: string } | null {
  return state.kind === "revealed" ? { url: state.url, warning: state.warning } : null;
}

export function buildEmailRequest(email: string): { email: string } {
  return { email: email.trim() };
}

export function issuerLabel(issuedBy: InvitationIssuer | null): string {
  if (issuedBy === null) return "Issued from the console";
  return `Issued by ${issuedBy.name.trim() || issuedBy.email}`;
}

export function dayLabel(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "an unknown date";
}

export function issuedNotice(issued: IssuedInvitation): string {
  if (issued.reactivated)
    return `${issued.invitation.email} held a deactivated account. It is active again, and this invitation sets its password while the stored name stays as it is.`;
  return `Invitation issued for ${issued.invitation.email}. It expires in 24 hours and works once.`;
}

export function regeneratedNotice(invitation: AdminInvitation): string {
  return `New link for ${invitation.email}. ${INVITATION_LINK_REUSED}`;
}

export function revokedNotice(email: string): string {
  return `Revoked the invitation for ${email}. The link that was shared with that person no longer works.`;
}

export function resetIssuedNotice(email: string, expiresAt: string): string {
  return `Reset link issued for ${email}. It expires in one hour, works once, and replaces any pending reset link of that account. It was created on ${dayLabel(expiresAt)} and expires then.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toIssuer(value: unknown): InvitationIssuer | null {
  if (!isRecord(value)) return null;
  const { id, name, email } = value;
  if (typeof id !== "string" || id === "") return null;
  if (typeof name !== "string" || typeof email !== "string") return null;
  return { id, name, email };
}

function toInvitation(value: unknown): AdminInvitation | null {
  if (!isRecord(value)) return null;
  const { id, email, expiresAt, createdAt } = value;
  if (typeof id !== "string" || id === "") return null;
  if (typeof email !== "string" || email === "") return null;
  if (typeof expiresAt !== "string" || typeof createdAt !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(expiresAt) || !/^\d{4}-\d{2}-\d{2}T/.test(createdAt)) return null;
  let issuedBy: InvitationIssuer | null = null;
  if (value.issuedBy !== null && value.issuedBy !== undefined) {
    issuedBy = toIssuer(value.issuedBy);
    if (issuedBy === null) return null;
  }
  return { id, email, expiresAt, createdAt, issuedBy };
}

function toLink(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function parseInvitationList(body: unknown): AdminInvitation[] | null {
  if (!isRecord(body) || !Array.isArray(body.invitations)) return null;
  const invitations: AdminInvitation[] = [];
  for (const entry of body.invitations) {
    const invitation = toInvitation(entry);
    if (invitation === null) return null;
    invitations.push(invitation);
  }
  return invitations;
}

export function parseIssuedInvitation(body: unknown): IssuedInvitation | null {
  if (!isRecord(body)) return null;
  const invitation = toInvitation(body.invitation);
  const link = toLink(body.link);
  if (invitation === null || link === null || typeof body.reactivated !== "boolean") return null;
  return { invitation, link, reactivated: body.reactivated };
}

export function parseRegeneratedInvitation(body: unknown): RegeneratedInvitation | null {
  if (!isRecord(body)) return null;
  const invitation = toInvitation(body.invitation);
  const link = toLink(body.link);
  return invitation === null || link === null ? null : { invitation, link };
}

export function parseRevokedInvitation(body: unknown): RevokedInvitation | null {
  if (!isRecord(body) || !isRecord(body.invitation)) return null;
  const { id, revokedAt } = body.invitation;
  if (typeof id !== "string" || id === "") return null;
  if (typeof revokedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(revokedAt)) return null;
  return { id, revokedAt };
}

export function parseResetLink(body: unknown): ResetLink | null {
  if (!isRecord(body)) return null;
  const link = toLink(body.link);
  const { expiresAt } = body;
  if (link === null || typeof expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(expiresAt)) return null;
  return { link, expiresAt };
}

export function applyInvitationRead(current: InvitationListRead, result: InvitationListResult): InvitationListRead {
  if (result.ok) return { invitations: result.value, failure: "", signInRequired: false };
  return { invitations: current.invitations, failure: result.error, signInRequired: result.signInRequired };
}

function refused(result: { code: string; signInRequired: boolean }): InvitationFailure {
  return {
    ok: false,
    code: result.code,
    error: invitationRefusalMessage(result.code),
    signInRequired: result.signInRequired,
  };
}

export async function readPendingInvitations(): Promise<InvitationListResult> {
  const result = await manageRequest(ADMIN_INVITATIONS_PATH, "GET", parseInvitationList);
  return result.ok ? result : refused(result);
}

export async function issueInvitation(email: string): Promise<InvitationIssueResult> {
  const result = await manageRequest(ADMIN_INVITATIONS_PATH, "POST", parseIssuedInvitation, buildEmailRequest(email));
  return result.ok ? result : refused(result);
}

export async function revokeInvitation(id: string): Promise<InvitationRevokeResult> {
  const result = await manageRequest(
    `${ADMIN_INVITATIONS_PATH}/${encodeURIComponent(id)}/revoke`,
    "POST",
    parseRevokedInvitation,
  );
  return result.ok ? result : refused(result);
}

export async function regenerateInvitation(id: string): Promise<InvitationRegenerateResult> {
  const result = await manageRequest(
    `${ADMIN_INVITATIONS_PATH}/${encodeURIComponent(id)}/regenerate`,
    "POST",
    parseRegeneratedInvitation,
  );
  return result.ok ? result : refused(result);
}

export async function issueResetLink(email: string): Promise<ResetLinkResult> {
  const result = await manageRequest(ADMIN_RESET_LINKS_PATH, "POST", parseResetLink, buildEmailRequest(email));
  return result.ok ? result : refused(result);
}
