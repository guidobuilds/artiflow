import type { UserRole } from "../identity/roles.ts";

export const ADMIN_EVENTS = [
  "role.granted",
  "role.revoked",
  "access.methods.updated",
  "password.policy.updated",
  "user.updated",
  "user.deactivated",
  "user.reactivated",
] as const;

export type AdminEventName = (typeof ADMIN_EVENTS)[number];

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
  event: "access.methods.updated" | "password.policy.updated";
  settingKey: string;
};
export type UserAdminEvent = AdminEventBase & {
  event: "user.updated";
  subjectId: string;
  emailChange?: { before: string; after: string };
};

export type UserLifecycleAdminEvent = AdminEventBase & {
  event: "user.deactivated" | "user.reactivated";
  subjectId: string;
};

export type AdminEventInput = RoleAdminEvent | SettingAdminEvent | UserAdminEvent | UserLifecycleAdminEvent;

type WriteLine = (line: string) => void;

const writeLine: WriteLine = (line) => {
  process.stdout.write(`${line}\n`);
};

function detailsOf(input: AdminEventInput): Record<string, string> {
  if ("settingKey" in input) return { settingKey: input.settingKey };
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
