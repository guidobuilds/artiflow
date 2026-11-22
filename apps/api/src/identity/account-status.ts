export const ACCOUNT_STATUSES = ["active", "deactivated"] as const;

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACTIVE_ACCOUNT_STATUS: AccountStatus = "active";

export const DEACTIVATED_ACCOUNT_STATUS: AccountStatus = "deactivated";

export function isAccountStatus(value: unknown): value is AccountStatus {
  return typeof value === "string" && (ACCOUNT_STATUSES as readonly string[]).includes(value);
}

export function isActiveAccount(status: string | null | undefined): boolean {
  return status === ACTIVE_ACCOUNT_STATUS;
}
