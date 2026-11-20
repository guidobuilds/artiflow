import type { UserRole } from "../identity/roles.ts";

export const ADMIN_EVENTS = ["role.granted", "role.revoked"] as const;

export type AdminEventName = (typeof ADMIN_EVENTS)[number];

export type AdminEventInput = {
  event: AdminEventName;
  actorId: string;
  actorRole: UserRole | "console";
  subjectId: string;
  outcome: "applied" | "refused";
  requestId?: string;
};

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
    subjectId: input.subjectId,
    outcome: input.outcome,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });
}

export function recordAdminEvent(input: AdminEventInput, write: WriteLine = writeLine, at: Date = new Date()): void {
  write(adminEventLine(input, at));
}
