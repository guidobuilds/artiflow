import type { AdminRole, AdminUserFilter, AdminUserMethod, AdminUserStatus } from "./admin-users-client.ts";

export type LibraryFilter = "all" | "mine" | "shared";
export type LibrarySearch = { filter: LibraryFilter };
export type LibrarySearchParams = Partial<LibrarySearch>;
export type AdminUsersSearchParams = Partial<AdminUserFilter>;

export const LIBRARY_FILTERS = ["all", "mine", "shared"] as const satisfies readonly LibraryFilter[];
export const ADMIN_ROLES = ["member", "administrator"] as const satisfies readonly AdminRole[];
export const ADMIN_STATUSES = ["active", "deactivated"] as const satisfies readonly AdminUserStatus[];
export const ADMIN_METHODS = [
  "credential",
  "google",
  "github",
  "artiflow",
] as const satisfies readonly AdminUserMethod[];
export const FIRST_ADMIN_USERS_FILTER: AdminUserFilter = {
  page: 1,
  search: "",
  role: null,
  status: null,
  method: null,
};

function memberOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : null;
}

function pageOf(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : FIRST_ADMIN_USERS_FILTER.page;
}

export function parseLibrarySearch(search: Record<string, unknown>): LibrarySearch {
  return { filter: memberOf(LIBRARY_FILTERS, search.filter) ?? "all" };
}

export function parseAdminUsersSearch(search: Record<string, unknown>): AdminUserFilter {
  return {
    page: pageOf(search.page),
    search: typeof search.search === "string" ? search.search.trim() : "",
    role: memberOf(ADMIN_ROLES, search.role),
    status: memberOf(ADMIN_STATUSES, search.status),
    method: memberOf(ADMIN_METHODS, search.method),
  };
}

export function librarySearch(filter: LibraryFilter): LibrarySearchParams {
  return filter === "all" ? {} : { filter };
}

export function adminUsersSearch(filter: AdminUserFilter): AdminUsersSearchParams {
  const search: AdminUsersSearchParams = { page: filter.page };
  if (filter.search !== "") search.search = filter.search;
  if (filter.role !== null) search.role = filter.role;
  if (filter.status !== null) search.status = filter.status;
  if (filter.method !== null) search.method = filter.method;
  return search;
}
