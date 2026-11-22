import type { AppDb } from "../adapters/postgres/db/client.ts";
import { isActiveAccount } from "../identity/account-status.ts";
import type { UserRole } from "../identity/roles.ts";
import { canonicalizeEmail, isEmailAddress } from "../invites/token.ts";
import { recordAdminEvent } from "../logging/admin-events.ts";
import { issuePasswordReset } from "../password-reset/service.ts";
import { resetPasswordUrl } from "../password-reset/token.ts";
import { findAccountByEmail } from "./accounts.ts";

export type IssueResetLinkInput = {
  db: AppDb;
  email: string;
  actorId: string;
  actorRole: UserRole;
  publicOrigin: string;
  requestId?: string;
  now?: Date;
};

export type IssueResetLinkOutcome =
  | { kind: "issued"; link: string; expiresAt: string }
  | { kind: "invalid-email" }
  | { kind: "no-account" }
  | { kind: "account-deactivated" };

export async function issueAdminResetLink(input: IssueResetLinkInput): Promise<IssueResetLinkOutcome> {
  const email = canonicalizeEmail(input.email);
  if (!isEmailAddress(email)) return { kind: "invalid-email" };

  const account = await findAccountByEmail(input.db, email);
  if (account === null) return { kind: "no-account" };
  if (!isActiveAccount(account.status)) return { kind: "account-deactivated" };

  const issued = await issuePasswordReset(input.db, email, {
    createdBy: input.actorId,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (issued.kind !== "issued") return { kind: "no-account" };

  recordAdminEvent({
    event: "password.reset.issued",
    actorId: input.actorId,
    actorRole: input.actorRole,
    subjectId: account.id,
    outcome: "applied",
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });
  return {
    kind: "issued",
    link: resetPasswordUrl(input.publicOrigin, issued.token),
    expiresAt: issued.expiresAt.toISOString(),
  };
}
