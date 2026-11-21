import { manageRequest } from "./auth-client.ts";

export type AdminRole = "member" | "administrator";
export type AdminUserStatus = "active" | "deactivated";
export type AdminUserRow = {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  status: AdminUserStatus;
  accessMethods: string[];
  lastActivityAt: string | null;
};
export type AdminUserPage = { users: AdminUserRow[]; total: number; page: number; pageSize: number };
export type AdminUserFilter = {
  page: number;
  search: string;
  role: AdminRole | null;
  status: AdminUserStatus | null;
};
export type AdminUserFailure = { ok: false; code: string; error: string; signInRequired: boolean };
export type AdminUserList = { ok: true; value: AdminUserPage } | AdminUserFailure;
export type AdminUserSave = { ok: true; value: AdminUserRow } | AdminUserFailure;
export type AdminRoleChange = { id: string; role: AdminRole; changed: boolean };
export type AdminRoleSave = { ok: true; value: AdminRoleChange } | AdminUserFailure;
export type AdminStatusChange = { id: string; status: AdminUserStatus };
export type AdminStatusSave = { ok: true; value: AdminStatusChange } | AdminUserFailure;
export type AdminUserEdit = { name: string; email: string };
export type DirectoryRead = { page: AdminUserPage | null; failure: string; signInRequired: boolean };

export const EMPTY_DIRECTORY: DirectoryRead = { page: null, failure: "", signInRequired: false };

export const ADMIN_USERS_PATH = "/api/admin/users";
export const ADMIN_USERS_PAGE_SIZE = 20;

const SIGN_IN_REQUIRED =
  "This browser has no signed-in account, so the directory cannot be shown. Sign in first.";
const UNRECOGNIZED = "The server refused that without a reason this page recognizes. Nothing was changed.";

const REFUSALS: Record<string, string> = {
  administrator_required: "Only an administrator can manage accounts. This page is not available to your account.",
  sign_in_required: SIGN_IN_REQUIRED,
  unauthorized: SIGN_IN_REQUIRED,
  invalid_query: "The server refused that search, so no account is listed. Change the search and try again.",
  invalid_body: "The server refused the request as incomplete. Nothing was saved.",
  invalid_name: "Enter a name before saving. Nothing was saved.",
  invalid_email: "That is not a valid email address. Nothing was saved.",
  email_in_use: "Another account already uses that email address. Nothing was saved.",
  user_not_found: "That account no longer exists. Reload the directory to see who is here.",
  invalid_role: "The server refused that role. Nothing was changed.",
  status_unchanged:
    "That account already has that status, so nothing was changed. Reload the directory to see the stored state.",
  network: "The server could not be reached, so nothing was saved.",
  unreadable_answer: "The server answered unexpectedly, so nothing was shown as saved.",
};

export function adminUserRefusalMessage(code: string): string {
  return REFUSALS[code] ?? UNRECOGNIZED;
}

const ROLE_LABELS: Record<AdminRole, string> = { member: "Member", administrator: "Administrator" };

export function roleLabel(role: AdminRole): string {
  return ROLE_LABELS[role];
}

const STATUS_ACTIONS: Record<AdminUserStatus, string> = {
  active: "Reactivate account",
  deactivated: "Deactivate account",
};

export function statusActionLabel(status: AdminUserStatus): string {
  return STATUS_ACTIONS[status];
}

const STATUS_LABELS: Record<AdminUserStatus, string> = { active: "Active", deactivated: "Deactivated" };

export function statusLabel(status: AdminUserStatus): string {
  return STATUS_LABELS[status];
}

export function nextStatus(status: AdminUserStatus): AdminUserStatus {
  return status === "active" ? "deactivated" : "active";
}

export const DEACTIVATION_CONSEQUENCES =
  "That account can no longer sign in by any method: password, social sign-in and SSO all refuse it. Every session that is open ends now, and the shared content the person can open closes with it. The public links to that person's artifacts are revoked, so anyone holding one loses access. Nothing is deleted: artifacts, comments and the shares the person issued keep their rows, and the people they shared with keep reading them.";

export const REACTIVATION_CONSEQUENCES =
  "Reactivating restores the account's access: the person can sign in again with the methods this instance allows. It restores neither the sessions that ended nor the public links that were revoked; a link that is still needed has to be issued again.";

export function statusConfirmation(status: AdminUserStatus): string {
  return status === "deactivated" ? DEACTIVATION_CONSEQUENCES : REACTIVATION_CONSEQUENCES;
}

export function statusConfirmationTitle(who: string, status: AdminUserStatus): string {
  return `${status === "deactivated" ? "Deactivate" : "Reactivate"} ${who}?`;
}

const METHOD_LABELS: Record<string, string> = {
  credential: "Password",
  google: "Google",
  github: "GitHub",
};

export function accessMethodsLabel(methods: string[]): string {
  if (methods.length === 0) return "No sign-in method yet";
  return methods.map((method) => METHOD_LABELS[method] ?? method).join(", ");
}

export function lastActivityLabel(value: string | null): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "Never signed in";
}

export function directorySummary(page: AdminUserPage): string {
  const size = page.pageSize < 1 ? ADMIN_USERS_PAGE_SIZE : page.pageSize;
  const pages = Math.max(1, Math.ceil(page.total / size));
  const noun = page.total === 1 ? "account" : "accounts";
  return `${page.total} ${noun} · page ${page.page} of ${pages}`;
}

export function directoryEmptyMessage(filter: {
  search: string;
  role: AdminRole | null;
  status?: AdminUserStatus | null;
}): string {
  if (filter.search.trim() !== "")
    return "No account matches that search. Clear the search or try a different name or email.";
  if (filter.role !== null) return "No account holds that role. Clear the role filter to see everyone.";
  if (filter.status !== null && filter.status !== undefined)
    return "No account holds that status. Clear the status filter to see everyone.";
  return "No accounts yet. Issue the first invitation from the console with bun run user:invite EMAIL.";
}

export function buildAdminUserSearch(filter: AdminUserFilter): string {
  const params = new URLSearchParams();
  params.set("page", String(Math.max(1, Math.trunc(filter.page))));
  params.set("pageSize", String(ADMIN_USERS_PAGE_SIZE));
  const search = filter.search.trim();
  if (search !== "") params.set("search", search);
  if (filter.role !== null) params.set("role", filter.role);
  if (filter.status !== null) params.set("status", filter.status);
  return `${ADMIN_USERS_PATH}?${params.toString()}`;
}

export function applyDirectoryRead(current: DirectoryRead, result: AdminUserList): DirectoryRead {
  if (result.ok) return { page: result.value, failure: "", signInRequired: false };
  return { page: current.page, failure: result.error, signInRequired: result.signInRequired };
}

export function replaceAdminUserRow(page: AdminUserPage, row: AdminUserRow): AdminUserPage {
  return { ...page, users: page.users.map((entry) => (entry.id === row.id ? row : entry)) };
}

export function replaceAdminUserRole(page: AdminUserPage, id: string, role: AdminRole): AdminUserPage {
  return { ...page, users: page.users.map((entry) => (entry.id === id ? { ...entry, role } : entry)) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRole(value: unknown): value is AdminRole {
  return value === "member" || value === "administrator";
}

function isCount(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min;
}

function toRow(value: unknown): AdminUserRow | null {
  if (!isRecord(value)) return null;
  const { id, name, email, role, status, accessMethods, lastActivityAt } = value;
  if (typeof id !== "string" || id === "") return null;
  if (typeof name !== "string" || typeof email !== "string" || email === "") return null;
  if (!isRole(role)) return null;
  if (!isStatus(status)) return null;
  if (!Array.isArray(accessMethods) || !accessMethods.every((entry) => typeof entry === "string" && entry !== ""))
    return null;
  if (lastActivityAt !== null && typeof lastActivityAt !== "string") return null;
  return { id, name, email, role, status, accessMethods, lastActivityAt };
}

export function parseAdminUserPage(body: unknown): AdminUserPage | null {
  if (!isRecord(body) || !Array.isArray(body.users)) return null;
  const users: AdminUserRow[] = [];
  for (const entry of body.users) {
    const row = toRow(entry);
    if (row === null) return null;
    users.push(row);
  }
  const { total, page, pageSize } = body;
  if (!isCount(total, 0) || !isCount(page, 1) || !isCount(pageSize, 1)) return null;
  return { users, total, page, pageSize };
}

function parseAdminUser(body: unknown): AdminUserRow | null {
  return isRecord(body) ? toRow(body.user) : null;
}

function isStatus(value: unknown): value is AdminUserStatus {
  return value === "active" || value === "deactivated";
}

export function parseAdminStatusChange(body: unknown): AdminStatusChange | null {
  if (!isRecord(body) || !isRecord(body.user)) return null;
  const { id, status } = body.user;
  if (typeof id !== "string" || id === "" || !isStatus(status)) return null;
  return { id, status };
}

export function parseAdminRoleChange(body: unknown): AdminRoleChange | null {
  if (!isRecord(body) || !isRecord(body.user)) return null;
  const { id, role } = body.user;
  if (typeof id !== "string" || id === "" || !isRole(role) || typeof body.changed !== "boolean") return null;
  return { id, role, changed: body.changed };
}

export function buildAdminUserEdit(edit: AdminUserEdit): AdminUserEdit {
  return { name: edit.name.trim(), email: edit.email.trim() };
}

export async function readAdminUserPage(filter: AdminUserFilter): Promise<AdminUserList> {
  const result = await manageRequest(buildAdminUserSearch(filter), "GET", parseAdminUserPage);
  if (result.ok) return result;
  return {
    ok: false,
    code: result.code,
    error: adminUserRefusalMessage(result.code),
    signInRequired: result.signInRequired,
  };
}

export async function saveAdminUser(id: string, edit: AdminUserEdit): Promise<AdminUserSave> {
  const result = await manageRequest(
    `${ADMIN_USERS_PATH}/${encodeURIComponent(id)}`,
    "PATCH",
    parseAdminUser,
    buildAdminUserEdit(edit),
  );
  if (result.ok) return result;
  return {
    ok: false,
    code: result.code,
    error: adminUserRefusalMessage(result.code),
    signInRequired: result.signInRequired,
  };
}

export async function setAdminUserStatus(id: string, status: AdminUserStatus): Promise<AdminStatusSave> {
  const result = await manageRequest(
    `${ADMIN_USERS_PATH}/${encodeURIComponent(id)}/status`,
    "POST",
    parseAdminStatusChange,
    { status },
  );
  if (result.ok) return result;
  return {
    ok: false,
    code: result.code,
    error: adminUserRefusalMessage(result.code),
    signInRequired: result.signInRequired,
  };
}

export async function changeAdminUserRole(id: string, role: AdminRole): Promise<AdminRoleSave> {
  const result = await manageRequest(
    `${ADMIN_USERS_PATH}/${encodeURIComponent(id)}/role`,
    "POST",
    parseAdminRoleChange,
    { role },
  );
  if (result.ok) return result;
  return {
    ok: false,
    code: result.code,
    error: adminUserRefusalMessage(result.code),
    signInRequired: result.signInRequired,
  };
}
