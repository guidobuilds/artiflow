import { ADMIN_USERS_PATH } from "./admin-users-client.ts";
import { manageRequest } from "./auth-client.ts";

export type SessionRow = {
  id: string;
  startedAt: string;
  lastUsedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
};

export type SessionFailure = { ok: false; code: string; error: string; signInRequired: boolean };
export type SessionListResult = { ok: true; value: SessionRow[] } | SessionFailure;
export type SessionRevokeResult = { ok: true; value: { id: string } } | SessionFailure;
export type SessionsRevokeResult = { ok: true; value: { revoked: number } } | SessionFailure;

export type SessionListRead = { sessions: SessionRow[] | null; failure: string; signInRequired: boolean };

export const EMPTY_SESSION_READ: SessionListRead = { sessions: null, failure: "", signInRequired: false };

export const ACCOUNT_SESSIONS_PATH = "/api/account/sessions";
export const REVOKE_OTHERS_PATH = `${ACCOUNT_SESSIONS_PATH}/revoke-others`;
export const LOGIN_PATH = "/login";

const SIGN_IN_REQUIRED =
  "This browser has no signed-in account, so your sessions cannot be shown. Sign in first.";
const UNRECOGNIZED = "The server refused that without a reason this page recognizes. Nothing was changed.";

const REFUSALS: Record<string, string> = {
  administrator_required:
    "Only an administrator can manage another account's sessions. This page is not available to your account.",
  sign_in_required: SIGN_IN_REQUIRED,
  unauthorized: SIGN_IN_REQUIRED,
  session_not_found:
    "That session no longer exists, so there was nothing to close. The list is read again instead of guessed.",
  user_not_found: "That account no longer exists, so its sessions cannot be shown. Reload the directory to see who is here.",
  origin_not_allowed: "This page was opened from an address the server does not accept for changes, so nothing was closed.",
  json_content_type_required: "The server refused the request as incomplete. Nothing was closed.",
  invalid_body: "The server refused the request as incomplete. Nothing was closed.",
  network: "The server could not be reached, so nothing was changed.",
  unreadable_answer: "The server answered with something this page does not accept, so nothing is shown as closed.",
};

export function sessionRefusalMessage(code: string): string {
  return REFUSALS[code] ?? UNRECOGNIZED;
}

const MOMENT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

export function sessionMomentLabel(value: string): string {
  const match = MOMENT.exec(value);
  return match === null ? "an unknown moment" : `${match[1]} ${match[2]} UTC`;
}

export function sessionAddressLabel(value: string | null): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "Not recorded";
}

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/CriOS\//, "Chrome"],
  [/FxiOS\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Firefox\//, "Firefox"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

function firstLabel(value: string, table: [RegExp, string][]): string | null {
  for (const [pattern, label] of table) {
    if (pattern.test(value)) return label;
  }
  return null;
}

export function sessionBrowserLabel(value: string | null): string {
  if (typeof value !== "string" || value.trim() === "") return "Not recorded";
  const browser = firstLabel(value, BROWSERS);
  const system = firstLabel(value, SYSTEMS);
  if (browser !== null && system !== null) return `${browser} on ${system}`;
  if (browser !== null) return browser;
  if (system !== null) return system;
  return "An unrecognized browser";
}

export type RevokeOutcome = "signed_out" | "closed";

export function revokeOutcome(row: SessionRow): RevokeOutcome {
  return row.current ? "signed_out" : "closed";
}

export function closeOwnSessionTitle(row: SessionRow): string {
  return row.current ? "Close this session and sign out?" : "Close that session?";
}

export function closeOwnSessionConfirmation(row: SessionRow): string {
  if (row.current)
    return "This is the session this browser is using. Closing it signs this browser out and returns you to the login page. Nothing else about your account changes, and any other session stays open.";
  return `That session ends now: the browser using ${sessionAddressLabel(row.ipAddress)} with ${sessionBrowserLabel(row.userAgent)} needs to sign in again. This browser stays signed in.`;
}

export function closeOtherSessionsTitle(count: number): string {
  return count === 1 ? "Close the other session?" : `Close the other ${count} sessions?`;
}

export function closeOtherSessionsConfirmation(count: number): string {
  const noun = count === 1 ? "session" : "sessions";
  return `Every other session of your account ends now (${count} ${noun}), so each of those browsers needs to sign in again. This browser stays signed in, and nothing else about your account changes.`;
}

export function sessionsRevokedNotice(revoked: number): string {
  if (revoked === 0) return "There was no other session to close. This browser stays signed in.";
  const noun = revoked === 1 ? "session" : "sessions";
  return `Closed ${revoked} other ${noun}. Each of those browsers needs to sign in again; this browser stays signed in.`;
}

export function otherSessionsSummary(rows: SessionRow[]): string {
  if (rows.length === 0) return "No other session is open.";
  const labels = rows.map((row) => `${sessionBrowserLabel(row.userAgent)} from ${sessionAddressLabel(row.ipAddress)}`);
  return `Other sessions: ${labels.join(", ")}.`;
}

export function adminSessionRevokeTitle(who: string, row: SessionRow): string {
  return row.current ? "Close your own session?" : `Close a session of ${who}?`;
}

export function adminSessionRevokeConfirmation(who: string, row: SessionRow): string {
  if (row.current)
    return `That session belongs to your own account: closing it signs this browser out and this page returns to the login screen, so the next request needs a new sign-in. Nothing else about ${who} changes, and the other sessions stay open.`;
  return `That session of ${who} ends now: the browser using ${sessionAddressLabel(row.ipAddress)} with ${sessionBrowserLabel(row.userAgent)} needs a new sign-in on its next request. The account, its password and everything it owns stay as they are, and the other sessions stay open.`;
}

export function adminSessionsRevokeTitle(who: string): string {
  return `Close every session of ${who}?`;
}

export function adminSessionsRevokeConfirmation(who: string, count: number): string {
  const noun = count === 1 ? "session" : "sessions";
  return `All ${count} ${noun} of ${who} end now: every browser signed in as that account needs a new sign-in on its next request. The account, its password, the artifacts and the shares it holds stay as they are, and a session that already ended changes nothing.`;
}

export function accountSessionClosedNotice(row: SessionRow): string {
  return row.current
    ? "Closed your own session. This browser is signed out."
    : "Closed one session. That browser needs a sign-in again; the other sessions stay open.";
}

export function accountSessionsClosedNotice(revoked: number, who: string): string {
  if (revoked === 0) return `${who} had no open session to close.`;
  const noun = revoked === 1 ? "session" : "sessions";
  return `Closed ${revoked} ${noun} of ${who}. Each of those browsers needs a sign-in again.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function carriesCredential(value: Record<string, unknown>): boolean {
  return "token" in value || "sessionToken" in value;
}

function isMoment(value: unknown): value is string {
  return typeof value === "string" && MOMENT.test(value);
}

function toSession(value: unknown): SessionRow | null {
  if (!isRecord(value) || carriesCredential(value)) return null;
  const { id, startedAt, lastUsedAt, ipAddress, userAgent, current } = value;
  if (typeof id !== "string" || id === "") return null;
  if (!isMoment(startedAt) || !isMoment(lastUsedAt)) return null;
  if (ipAddress !== null && typeof ipAddress !== "string") return null;
  if (userAgent !== null && typeof userAgent !== "string") return null;
  if (typeof current !== "boolean") return null;
  return { id, startedAt, lastUsedAt, ipAddress, userAgent, current };
}

export function parseSessionList(body: unknown): SessionRow[] | null {
  if (!isRecord(body) || !Array.isArray(body.sessions)) return null;
  const sessions: SessionRow[] = [];
  for (const entry of body.sessions) {
    const row = toSession(entry);
    if (row === null) return null;
    sessions.push(row);
  }
  return sessions;
}

export function parseRevokedSession(body: unknown): { id: string } | null {
  if (!isRecord(body) || !isRecord(body.session) || carriesCredential(body.session)) return null;
  const { id } = body.session;
  return typeof id === "string" && id !== "" ? { id } : null;
}

export function parseRevokedCount(body: unknown): { revoked: number } | null {
  if (!isRecord(body) || carriesCredential(body)) return null;
  const { revoked } = body;
  if (typeof revoked !== "number" || !Number.isInteger(revoked) || revoked < 0) return null;
  return { revoked };
}

export function applySessionRead(current: SessionListRead, result: SessionListResult): SessionListRead {
  if (result.ok) return { sessions: result.value, failure: "", signInRequired: false };
  return { sessions: current.sessions, failure: result.error, signInRequired: result.signInRequired };
}

function refused(result: { code: string; signInRequired: boolean }): SessionFailure {
  return {
    ok: false,
    code: result.code,
    error: sessionRefusalMessage(result.code),
    signInRequired: result.signInRequired,
  };
}

export function adminSessionsPath(userId: string): string {
  return `${ADMIN_USERS_PATH}/${encodeURIComponent(userId)}/sessions`;
}

async function readList(path: string): Promise<SessionListResult> {
  const result = await manageRequest(path, "GET", parseSessionList);
  return result.ok ? result : refused(result);
}

async function revokeOne(path: string): Promise<SessionRevokeResult> {
  const result = await manageRequest(path, "POST", parseRevokedSession);
  return result.ok ? result : refused(result);
}

async function revokeMany(path: string): Promise<SessionsRevokeResult> {
  const result = await manageRequest(path, "POST", parseRevokedCount);
  return result.ok ? result : refused(result);
}

export function readOwnSessions(): Promise<SessionListResult> {
  return readList(ACCOUNT_SESSIONS_PATH);
}

export function revokeOwnSession(sessionId: string): Promise<SessionRevokeResult> {
  return revokeOne(`${ACCOUNT_SESSIONS_PATH}/${encodeURIComponent(sessionId)}/revoke`);
}

export function revokeOtherOwnSessions(): Promise<SessionsRevokeResult> {
  return revokeMany(REVOKE_OTHERS_PATH);
}

export function readAccountSessions(userId: string): Promise<SessionListResult> {
  return readList(adminSessionsPath(userId));
}

export function revokeAccountSession(userId: string, sessionId: string): Promise<SessionRevokeResult> {
  return revokeOne(`${adminSessionsPath(userId)}/${encodeURIComponent(sessionId)}/revoke`);
}

export function revokeAccountSessions(userId: string): Promise<SessionsRevokeResult> {
  return revokeMany(`${adminSessionsPath(userId)}/revoke`);
}
