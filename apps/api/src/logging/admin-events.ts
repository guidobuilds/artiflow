import type { UserRole } from "../identity/roles.ts";

export const ADMIN_EVENTS = [
  "role.granted",
  "role.revoked",
  "access.methods.updated",
  "access.sso.updated",
  "password.policy.updated",
  "user.registered",
  "user.updated",
  "user.deactivated",
  "user.reactivated",
  "user.purged",
  "invitation.created",
  "invitation.revoked",
  "invitation.regenerated",
  "password.reset.issued",
  "session.revoked",
  "sessions.revoked",
  "login.fallback.used",
] as const;

export type AdminEventName = (typeof ADMIN_EVENTS)[number];

export const UNATTRIBUTED_FALLBACK_ACTOR = "unattributed";

type AdminEventBase = {
  actorId: string;
  actorRole: UserRole | "console";
  outcome: "applied" | "refused";
  requestId?: string;
};

export type RoleAdminEvent = AdminEventBase & {
  event: "role.granted" | "role.revoked";
  subjectId: string;
};

export type SettingAdminEvent = AdminEventBase & {
  event: "access.methods.updated" | "access.sso.updated" | "password.policy.updated";
  settingKey: string;
};
export type UserAdminEvent = AdminEventBase & {
  event: "user.updated";
  subjectId: string;
  emailChange?: { before: string; after: string };
};

export type UserRegistrationAdminEvent = AdminEventBase & {
  event: "user.registered";
  subjectId: string;
};

export type UserLifecycleAdminEvent = AdminEventBase & {
  event: "user.deactivated" | "user.reactivated";
  subjectId: string;
};

export type UserPurgeAdminEvent = AdminEventBase & {
  event: "user.purged";
  subjectId: string;
};

export type InvitationAdminEvent = AdminEventBase & {
  event: "invitation.created" | "invitation.revoked" | "invitation.regenerated";
  subjectId: string;
};

export type PasswordResetAdminEvent = AdminEventBase & {
  event: "password.reset.issued";
  subjectId: string;
};

export type SessionAdminEvent = AdminEventBase &
  (
    | { event: "session.revoked"; subjectId: string; sessionId: string }
    | { event: "sessions.revoked"; subjectId: string }
  );

export type FallbackAdminEvent = {
  event: "login.fallback.used";
  actorId: string;
  actorRole: UserRole | "anonymous";
  subjectId: string;
  outcome: "applied" | "refused";
  requestId?: string;
};

export type AdminEventInput =
  | RoleAdminEvent
  | SettingAdminEvent
  | UserAdminEvent
  | UserRegistrationAdminEvent
  | UserLifecycleAdminEvent
  | UserPurgeAdminEvent
  | InvitationAdminEvent
  | PasswordResetAdminEvent
  | SessionAdminEvent
  | FallbackAdminEvent;

type WriteLine = (line: string) => void;

const writeLine: WriteLine = (line) => {
  process.stdout.write(`${line}\n`);
};

const writeDiagnosticLine: WriteLine = (line) => {
  process.stderr.write(`${line}\n`);
};

function detailsOf(input: AdminEventInput): Record<string, string> {
  if ("settingKey" in input) return { settingKey: input.settingKey };
  if (input.event === "session.revoked") return { subjectId: input.subjectId, sessionId: input.sessionId };
  if (input.event === "user.updated" && input.emailChange !== undefined) {
    return { subjectId: input.subjectId, emailBefore: input.emailChange.before, emailAfter: input.emailChange.after };
  }
  return { subjectId: input.subjectId };
}

export function adminEventLine(input: AdminEventInput, at: Date = new Date()): string {
  return JSON.stringify({
    ts: at.toISOString(),
    level: "info",
    event: input.event,
    actorId: input.actorId,
    actorRole: input.actorRole,
    ...detailsOf(input),
    outcome: input.outcome,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });
}

export function recordAdminEvent(input: AdminEventInput, write: WriteLine = writeLine, at: Date = new Date()): void {
  write(adminEventLine(input, at));
}

export function recordConsoleAdminEvent(input: AdminEventInput, at: Date = new Date()): void {
  recordAdminEvent(input, writeDiagnosticLine, at);
}
