import type { UserRole } from "../identity/roles.ts";

export const ADMIN_EVENTS = ["role.granted", "role.revoked", "access.methods.updated"] as const;

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
  event: "access.methods.updated";
  settingKey: string;
};

export type AdminEventInput = RoleAdminEvent | SettingAdminEvent;

type WriteLine = (line: string) => void;

const writeLine: WriteLine = (line) => {
  process.stdout.write(`${line}\n`);
};

export function adminEventLine(input: AdminEventInput, at: Date = new Date()): string {
  return JSON.stringify({
    ts: at.toISOString(),
    level: "info",
    event: input.event,
    actorId: input.actorId,
    actorRole: input.actorRole,
    ...(input.event === "access.methods.updated" ? { settingKey: input.settingKey } : { subjectId: input.subjectId }),
    outcome: input.outcome,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });
}

export function recordAdminEvent(input: AdminEventInput, write: WriteLine = writeLine, at: Date = new Date()): void {
  write(adminEventLine(input, at));
}
