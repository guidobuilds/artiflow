export type AuthRole = "member" | "administrator";
export type AuthUser = { id: string; name: string; email: string; image: string | null; role?: AuthRole };
export type SsoAccess = { displayName: string | null; fallbackAvailable: boolean };
export type Capabilities = {
  emailPassword: boolean;
  registration: boolean;
  socialProviders: string[];
  sso?: SsoAccess;
};
export type Credentials = { email: string; password: string };
export type SignUpInput = Credentials & { name: string };
export type AuthResult<T> = { ok: true; value: T } | { ok: false; error: string };

const BASE = "/api/auth";
const NETWORK = "Cannot reach the auth service. Check that the API is running, then retry.";
const UNEXPECTED = "The auth service answered unexpectedly. Nothing was changed.";
const REJECTED_SIGN_IN = "That email and password did not match an account.";
const REJECTED_SIGN_UP = "Could not create that account. Use a new email and at least 8 characters.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toUser(value: unknown): AuthUser | null {
  if (!isRecord(value) || !isRecord(value.user)) return null;
  const { id, name, email, image, role } = value.user;
  if (typeof id !== "string" || id === "") return null;
  if (typeof name !== "string" || name === "") return null;
  if (typeof email !== "string" || email === "") return null;
  const parsedRole = role === "administrator" || role === "member" ? role : null;
  return {
    id,
    name,
    email,
    image: typeof image === "string" && image !== "" ? image : null,
    ...(parsedRole === null ? {} : { role: parsedRole }),
  };
}

async function call(path: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(`${BASE}${path}`, { credentials: "same-origin", ...init });
  } catch {
    return null;
  }
}

function read(path: string): Promise<Response | null> {
  return call(path, {
    method: "GET",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
}

function send(path: string, body: unknown): Promise<Response | null> {
  return call(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text.trim() === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function toSsoAccess(value: unknown): SsoAccess | null {
  if (!isRecord(value) || typeof value.fallbackAvailable !== "boolean") return null;
  const name = typeof value.displayName === "string" ? value.displayName.trim() : "";
  return { displayName: name === "" ? null : name, fallbackAvailable: value.fallbackAvailable };
}

export async function getCapabilities(): Promise<AuthResult<Capabilities>> {
  const response = await read("/capabilities");
  if (!response) return { ok: false, error: NETWORK };
  if (!response.ok) return { ok: false, error: UNEXPECTED };
  const body = await readJson(response);
  if (
    !isRecord(body) ||
    typeof body.emailPassword !== "boolean" ||
    (body.registration !== undefined && typeof body.registration !== "boolean") ||
    !Array.isArray(body.socialProviders) ||
    !body.socialProviders.every((name) => typeof name === "string" && name !== "")
  ) {
    return { ok: false, error: UNEXPECTED };
  }
  const sso = body.sso === undefined ? null : toSsoAccess(body.sso);
  if (body.sso !== undefined && sso === null) return { ok: false, error: UNEXPECTED };
  return {
    ok: true,
    value: {
      emailPassword: body.emailPassword,
      registration: body.registration === true,
      socialProviders: body.socialProviders,
      ...(sso === null ? {} : { sso }),
    },
  };
}

export async function getSession(): Promise<AuthResult<AuthUser | null>> {
  const response = await read("/get-session");
  if (!response) return { ok: false, error: NETWORK };
  const body = await readJson(response);
  if (body === null) return { ok: true, value: null };
  if (!response.ok) return { ok: false, error: UNEXPECTED };
  const user = toUser(body);
  return user ? { ok: true, value: user } : { ok: false, error: UNEXPECTED };
}

async function confirmSession(): Promise<AuthResult<AuthUser>> {
  const session = await getSession();
  if (!session.ok) return session;
  if (session.value === null) return { ok: false, error: UNEXPECTED };
  return { ok: true, value: session.value };
}

async function authenticate(path: string, payload: unknown, rejected: string): Promise<AuthResult<AuthUser>> {
  const response = await send(path, payload);
  if (!response) return { ok: false, error: NETWORK };
  if (!response.ok) {
    const handled = response.status === 400 || response.status === 401 || response.status === 422;
    return { ok: false, error: handled ? rejected : UNEXPECTED };
  }
  return confirmSession();
}

export const signIn = (input: Credentials): Promise<AuthResult<AuthUser>> =>
  authenticate("/sign-in/email", { email: input.email, password: input.password }, REJECTED_SIGN_IN);

export const signUp = (input: SignUpInput): Promise<AuthResult<AuthUser>> =>
  authenticate("/sign-up/email", { ...input }, REJECTED_SIGN_UP);

export async function signOut(): Promise<AuthResult<null>> {
  const response = await send("/sign-out", {});
  if (!response) return { ok: false, error: NETWORK };
  if (!response.ok) return { ok: false, error: UNEXPECTED };
  const session = await getSession();
  if (!session.ok) return session;
  if (session.value !== null) return { ok: false, error: UNEXPECTED };
  return { ok: true, value: null };
}

export async function socialSignIn(provider: string, callbackURL: string): Promise<Continuation> {
  const response = await send("/sign-in/social", { provider, callbackURL });
  if (!response) return { ok: false, error: NETWORK, restartable: false };
  if (!response.ok) return { ok: false, error: UNEXPECTED, restartable: false };
  return toContinuation(await readJson(response));
}

export const SSO_PROVIDER_ID = "artiflow";
const SSO_UNREACHABLE = "Could not start the single sign-on sign-in. Reload the page and try again.";

export async function ssoSignIn(callbackURL: string, errorCallbackURL: string): Promise<Continuation> {
  const response = await send("/sign-in/sso", { providerId: SSO_PROVIDER_ID, callbackURL, errorCallbackURL });
  if (!response) return { ok: false, error: NETWORK, restartable: false };
  if (!response.ok) return { ok: false, error: SSO_UNREACHABLE, restartable: false };
  return toContinuation(await readJson(response));
}

export type PublicClient = { clientId: string; clientName: string; clientUri: string };
export type PublicClientResult =
  { ok: true; value: PublicClient } | { ok: false; error: string; signInRequired: boolean };
export type ConsentRequest = { clientId: string; scopes: string[]; resource: string; oauthQuery: string };
export type ConsentScope = { token: string; label: string };
export type ConsentResult = { ok: true; url: string } | { ok: false; error: string; signInRequired: boolean };
export type LocationTarget = { assign: (url: string) => void };

const NO_SESSION = "This browser has no signed-in account, so nothing can be approved. Sign in first.";
const CLIENT_FAILED = "Could not load the requesting application's details. Nothing was approved.";
const CONSENT_FAILED = "The authorization server did not return a redirect. Nothing was approved or denied.";

const SCOPE_LABELS: Record<string, string> = {
  "artifacts:read": "Read the artifacts you own",
  "artifacts:write": "Create and update the artifacts you own",
  offline_access: "Keep access without re-signing in",
  openid: "Confirm which account is signing in",
  profile: "See your name and profile details",
  email: "See your email address",
};

export function describeScopes(tokens: string[]): ConsentScope[] {
  return tokens.map((token) => ({ token, label: SCOPE_LABELS[token] ?? `Use the ${token} permission` }));
}

export function parseConsentSearch(search: string): ConsentRequest | null {
  const oauthQuery = search.startsWith("?") ? search.slice(1) : search;
  if (oauthQuery.trim() === "") return null;
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get("client_id");
  if (!clientId) return null;
  const scopes = (params.get("scope") ?? "").split(" ").filter((token) => token !== "");
  return { clientId, scopes, resource: params.get("resource") ?? "", oauthQuery };
}

export async function getPublicClient(clientId: string): Promise<PublicClientResult> {
  const response = await read(`/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`);
  if (!response) return { ok: false, error: NETWORK, signInRequired: false };
  if (response.status === 401) return { ok: false, error: NO_SESSION, signInRequired: true };
  if (!response.ok) return { ok: false, error: CLIENT_FAILED, signInRequired: false };
  const body = await readJson(response);
  if (!isRecord(body) || typeof body.client_id !== "string" || body.client_id === "") {
    return { ok: false, error: CLIENT_FAILED, signInRequired: false };
  }
  const name = typeof body.client_name === "string" && body.client_name !== "" ? body.client_name : body.client_id;
  return {
    ok: true,
    value: {
      clientId: body.client_id,
      clientName: name,
      clientUri: typeof body.client_uri === "string" ? body.client_uri : "",
    },
  };
}

export async function submitConsent(accept: boolean, oauthQuery: string): Promise<ConsentResult> {
  const response = await send("/oauth2/consent", { accept, oauth_query: oauthQuery });
  if (!response) return { ok: false, error: NETWORK, signInRequired: false };
  if (response.status === 401) return { ok: false, error: NO_SESSION, signInRequired: true };
  if (!response.ok) return { ok: false, error: CONSENT_FAILED, signInRequired: false };
  const body = await readJson(response);
  if (!isRecord(body) || body.redirect !== true || typeof body.url !== "string" || body.url === "") {
    return { ok: false, error: CONSENT_FAILED, signInRequired: false };
  }
  return { ok: true, url: body.url };
}

export function followConsent(url: string, target: LocationTarget): boolean {
  if (!/^https?:\/\//.test(url)) return false;
  target.assign(url);
  return true;
}

export type Continuation = { ok: true; url: string } | { ok: false; error: string; restartable: boolean };

const EXPIRED_QUERY =
  "This sign-in link has expired or was not issued by this server. Restart the sign-in for a fresh link.";
const INVALID_LINK = "This sign-in link has no authorization request. Open the link your MCP client gave you.";
export const FOLLOW_FAILED = "The authorization server returned a redirect this browser cannot follow.";
const SIGNED_ONLY = new Set(["sig", "exp", "ba_iat", "ba_pl"]);

export function authorizeUrlFromQuery(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (!params.get("client_id") || !params.get("redirect_uri")) return null;
  for (const key of new Set(params.keys())) {
    if (SIGNED_ONLY.has(key) || key.startsWith("ba_param")) params.delete(key);
  }
  return `${BASE}/oauth2/authorize?${params.toString()}`;
}

function toContinuation(body: unknown): Continuation {
  if (!isRecord(body) || body.redirect !== true || typeof body.url !== "string" || body.url === "") {
    return { ok: false, error: UNEXPECTED, restartable: false };
  }
  return { ok: true, url: body.url };
}

export async function continueAuthorization(search: string): Promise<Continuation> {
  const url = authorizeUrlFromQuery(search);
  if (url === null) return { ok: false, error: INVALID_LINK, restartable: false };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch {
    return { ok: false, error: NETWORK, restartable: false };
  }
  if (!response.ok) return { ok: false, error: UNEXPECTED, restartable: false };
  return toContinuation(await readJson(response));
}

export async function signInWithOAuthQuery(credentials: Credentials, search: string): Promise<Continuation> {
  const oauthQuery = search.startsWith("?") ? search.slice(1) : search;
  const response = await send("/sign-in/email", {
    email: credentials.email,
    password: credentials.password,
    oauth_query: oauthQuery,
  });
  if (!response) return { ok: false, error: NETWORK, restartable: false };
  if (response.status === 400) {
    const body = await readJson(response);
    return isRecord(body) && body.error === "invalid_signature"
      ? { ok: false, error: EXPIRED_QUERY, restartable: true }
      : { ok: false, error: REJECTED_SIGN_IN, restartable: false };
  }
  if (response.status === 401 || response.status === 422)
    return { ok: false, error: REJECTED_SIGN_IN, restartable: false };
  if (!response.ok) return { ok: false, error: UNEXPECTED, restartable: false };
  return toContinuation(await readJson(response));
}

export function followAuthorize(url: string, target: LocationTarget): boolean {
  if (/^\/(?![/\\])/.test(url)) {
    target.assign(url);
    return true;
  }
  return followConsent(url, target);
}

export type ArtifactSummary = {
  id: string;
  title: string;
  kind: "html" | "markdown";
  createdLabel: string;
  createdAt: string | null;
  updatedAt: string | null;
  sizeLabel: string;
  versionsLabel: string;
  verLabel: string;
  relLabel: string;
  viewerHref: string;
};
export type LibraryResult =
  { ok: true; value: ArtifactSummary[] } | { ok: false; error: string; signInRequired: boolean };
const NO_LIBRARY_SESSION = "This browser has no signed-in account, so the library cannot be listed. Sign in first.";
const LIBRARY_FAILED = "Could not load the library. No list is shown, because no answer was verified.";
export const LIBRARY_POLL_MS = 15_000;
export function startLibraryPolling(refresh: () => void, intervalMs: number = LIBRARY_POLL_MS): () => void {
  const timer = setInterval(refresh, Math.max(10_000, intervalMs));
  return () => clearInterval(timer);
}
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "size unknown";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb * 10) / 10} KB` : `${Math.round((kb / 1024) * 10) / 10} MB`;
}

function relativeLabel(value: string | null): string {
  const date = new Date(value ?? "");
  if (!Number.isFinite(date.getTime())) return "date unknown";
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function toSummary(value: unknown): ArtifactSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return null;
  const created = typeof value.createdAt === "string" ? value.createdAt.slice(0, 10) : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const size = typeof value.observedSizeBytes === "number" ? value.observedSizeBytes : null;
  const count = typeof value.revisionCount === "number" ? value.revisionCount : 0;
  const unit = count === 1 ? "version" : "versions";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : null;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : null;
  const revision =
    typeof value.revisionNumber === "number" && Number.isInteger(value.revisionNumber) && value.revisionNumber > 0
      ? value.revisionNumber
      : null;
  return {
    id: value.id,
    title: title === "" ? "Untitled artifact" : title,
    kind: value.kind === "markdown" ? "markdown" : "html",
    createdLabel: /^\d{4}-\d{2}-\d{2}$/.test(created) ? created : "date unknown",
    createdAt,
    updatedAt,
    sizeLabel: formatBytes(size),
    versionsLabel: count === 0 ? "no version yet" : `${count} ${unit}`,
    verLabel: revision === null ? "" : `v${revision}`,
    relLabel: relativeLabel(updatedAt ?? createdAt),
    viewerHref: `/artifact/${encodeURIComponent(value.id)}`,
  };
}

export function parseArtifactList(body: unknown): ArtifactSummary[] | null {
  if (!isRecord(body) || !Array.isArray(body.artifacts)) return null;
  const rows = body.artifacts.map(toSummary);
  return rows.every((row) => row !== null) ? rows : null;
}
export async function fetchArtifacts(): Promise<LibraryResult> {
  let response: Response;
  try {
    response = await fetch("/api/artifacts", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch {
    return { ok: false, error: NETWORK, signInRequired: false };
  }
  if (response.status === 401) return { ok: false, error: NO_LIBRARY_SESSION, signInRequired: true };
  if (!response.ok) return { ok: false, error: LIBRARY_FAILED, signInRequired: false };
  const rows = parseArtifactList(await readJson(response));
  return rows ? { ok: true, value: rows } : { ok: false, error: LIBRARY_FAILED, signInRequired: false };
}

export type SharedArtifactSummary = ArtifactSummary & { sharedBy: string };
export type SharedLibraryResult =
  { ok: true; value: SharedArtifactSummary[] } | { ok: false; error: string; signInRequired: boolean };
function toSharedSummary(value: unknown): SharedArtifactSummary | null {
  const base = toSummary(value);
  const sharer = isRecord(value) && isRecord(value.sharedBy) ? value.sharedBy.email : undefined;
  return base !== null && typeof sharer === "string" && sharer !== "" ? { ...base, sharedBy: sharer } : null;
}
export function parseSharedArtifactList(body: unknown): SharedArtifactSummary[] | null {
  if (!isRecord(body) || !Array.isArray(body.artifacts)) return null;
  const rows = body.artifacts.map(toSharedSummary);
  return rows.every((row) => row !== null) ? rows : null;
}
export async function fetchSharedArtifacts(): Promise<SharedLibraryResult> {
  let response: Response;
  try {
    response = await fetch("/api/artifacts/shared", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch {
    return { ok: false, error: NETWORK, signInRequired: false };
  }
  if (response.status === 401) return { ok: false, error: NO_LIBRARY_SESSION, signInRequired: true };
  if (!response.ok) return { ok: false, error: LIBRARY_FAILED, signInRequired: false };
  const rows = parseSharedArtifactList(await readJson(response));
  return rows ? { ok: true, value: rows } : { ok: false, error: LIBRARY_FAILED, signInRequired: false };
}

export type ShareGrant = { id: string; email: string; createdLabel: string };
export type PublicLinkRow = {
  id: string;
  createdLabel: string;
  revokedLabel: string | null;
  showComments: boolean;
};
export type RevealedLink = { linkId: string; url: string; token: string };
export type ManageResult<T> =
  { ok: true; value: T } | { ok: false; error: string; code: string; signInRequired: boolean };
type Failure = Extract<ManageResult<never>, { ok: false }>;

const ARTIFACTS = "/api/artifacts";
const NO_MANAGE_SESSION = "This browser has no signed-in account, so nothing can be shared or deleted. Sign in first.";
const MANAGE_FAILED = "The server did not confirm that change, so nothing is shown as done.";
const NODE_FIXTURE_ORIGIN = "http://127.0.0.1:5173";
type LocationLike = { origin?: unknown };
const pageOrigin: unknown = (globalThis as { location?: LocationLike }).location?.origin;
export const MUTATION_ORIGIN = typeof pageOrigin === "string" && pageOrigin !== "" ? pageOrigin : NODE_FIXTURE_ORIGIN;
const SHARE_MESSAGES: Record<string, string> = {
  invalid_email: "Enter one valid email address, then try again.",
  recipient_not_found: "No user with that email address has an account here.",
  invalid_recipient: "You cannot share an artifact with your own account.",
  already_shared: "That account can already read this artifact.",
  not_found: "This artifact is not yours, or it no longer exists.",
};
const DELETE_GONE = "This artifact was already deleted, or it is not yours. The list is reloaded instead of guessed.";

export function shareMessage(code: string): string {
  return SHARE_MESSAGES[code] ?? MANAGE_FAILED;
}

const failure = (code: string, error: string, signInRequired = false): Failure => ({
  ok: false,
  error,
  code,
  signInRequired,
});
const pathOf = (artifactId: string, suffix = ""): string => `${ARTIFACTS}/${encodeURIComponent(artifactId)}${suffix}`;
function sentCode(body: unknown, status: number): string {
  return isRecord(body) && typeof body.error === "string" ? body.error : `http_${status}`;
}

export async function manageRequest<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  parse: (body: unknown) => T | null,
  body: unknown = {},
): Promise<ManageResult<T>> {
  let response: Response;
  try {
    const init: RequestInit =
      method === "GET"
        ? { method, credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } }
        : {
            method,
            credentials: "same-origin",
            cache: "no-store",
            body: JSON.stringify(body),
            headers: { "content-type": "application/json", accept: "application/json", origin: MUTATION_ORIGIN },
          };
    response = await fetch(path, init);
  } catch {
    return failure("network", NETWORK);
  }
  const payload = await readJson(response);
  if (response.status === 401) return failure("unauthorized", NO_MANAGE_SESSION, true);
  if (!response.ok) return failure(sentCode(payload, response.status), MANAGE_FAILED);
  const value = parse(payload);
  return value === null ? failure("unreadable_answer", MANAGE_FAILED) : { ok: true, value };
}

function dayLabel(value: unknown): string {
  const iso = typeof value === "string" ? value : "";
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "date unknown";
}
function toShareGrant(value: unknown): ShareGrant | null {
  if (!isRecord(value)) return null;
  const email = isRecord(value.sharedWith) ? value.sharedWith.email : undefined;
  if (typeof value.id !== "string" || value.id === "" || typeof email !== "string" || email === "") return null;
  return { id: value.id, email, createdLabel: dayLabel(value.createdAt) };
}
function toLinkRow(value: unknown): PublicLinkRow | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return null;
  return {
    id: value.id,
    createdLabel: dayLabel(value.createdAt),
    revokedLabel: typeof value.revokedAt === "string" ? dayLabel(value.revokedAt) : null,
    showComments: value.showComments === true,
  };
}
export function parseShareList(body: unknown): ShareGrant[] | null {
  if (!isRecord(body) || !Array.isArray(body.shares)) return null;
  const rows = body.shares.map(toShareGrant);
  return rows.every((row) => row !== null) ? rows : null;
}
export function parseLinkList(body: unknown): PublicLinkRow[] | null {
  if (!isRecord(body) || !Array.isArray(body.links)) return null;
  const rows = body.links.map(toLinkRow);
  return rows.every((row) => row !== null) ? rows : null;
}
export function parseReveal(body: unknown): RevealedLink | null {
  if (!isRecord(body) || typeof body.id !== "string" || body.id === "") return null;
  const { url, token } = body;
  if (typeof url !== "string" || !(url.startsWith("/") || /^https?:\/\//.test(url))) return null;
  return typeof token === "string" && token !== "" ? { linkId: body.id, url, token } : null;
}
const confirmed = (body: unknown): "confirmed" | null => (isRecord(body) && body.ok === true ? "confirmed" : null);

export const listShares = (artifactId: string) => manageRequest(pathOf(artifactId, "/shares"), "GET", parseShareList);
export const listLinks = (artifactId: string) => manageRequest(pathOf(artifactId, "/links"), "GET", parseLinkList);
export const revokeShare = (artifactId: string, shareId: string) =>
  manageRequest(`${pathOf(artifactId, "/shares")}/${encodeURIComponent(shareId)}`, "DELETE", confirmed);
export const revokeLink = (artifactId: string, linkId: string) =>
  manageRequest(`${pathOf(artifactId, "/links")}/${encodeURIComponent(linkId)}`, "DELETE", confirmed);
export const createLink = (artifactId: string) => manageRequest(pathOf(artifactId, "/links"), "POST", parseReveal);
export const setLinkShowComments = (artifactId: string, linkId: string, showComments: boolean) =>
  manageRequest(
    `${pathOf(artifactId, "/links")}/${encodeURIComponent(linkId)}`,
    "PATCH",
    (body) => (isRecord(body) && body.showComments === showComments ? "confirmed" : null),
    { showComments },
  );
export const rotateLink = (artifactId: string, linkId: string) =>
  manageRequest(`${pathOf(artifactId, "/links")}/${encodeURIComponent(linkId)}/rotate`, "POST", parseReveal);

export async function createShare(artifactId: string, email: string): Promise<ManageResult<ShareGrant>> {
  const result = await manageRequest(pathOf(artifactId, "/shares"), "POST", toShareGrant, { email });
  const keep = result.ok || ["network", "unauthorized", "unreadable_answer"].includes(result.code);
  return keep ? result : { ...result, error: shareMessage(result.code) };
}

export async function deleteArtifact(artifactId: string): Promise<ManageResult<"deleted">> {
  const result = await manageRequest(pathOf(artifactId), "DELETE", (body) =>
    isRecord(body) && body.ok === true ? ("deleted" as const) : null,
  );
  return !result.ok && result.code === "not_found" ? { ...result, error: DELETE_GONE } : result;
}

export type DeleteConfirm = "idle" | "armed";
export const DELETE_LABEL: Record<DeleteConfirm, string> = { idle: "Delete artifact", armed: "Confirm delete" };
export async function pressDelete(
  state: DeleteConfirm,
  remove: () => Promise<ManageResult<"deleted">>,
): Promise<{ state: DeleteConfirm; result: ManageResult<"deleted"> | null }> {
  if (state === "idle") return { state: "armed", result: null };
  return { state: "armed", result: await remove() };
}

export type TokenReveal = { kind: "hidden" } | { kind: "revealed"; url: string; token: string };
export const HIDDEN_REVEAL: TokenReveal = { kind: "hidden" };
export const revealToken = (link: RevealedLink): TokenReveal => ({
  kind: "revealed",
  url: link.url,
  token: link.token,
});
export const dismissToken = (): TokenReveal => HIDDEN_REVEAL;
export function tokenNotice(state: TokenReveal): { url: string; warning: string } | null {
  return state.kind === "revealed"
    ? {
        url: state.url,
        warning: "This URL is shown once and is never stored. After you dismiss it, rotate the link to get a new one.",
      }
    : null;
}

export type InvitationPreview = { email: string };
export type InvitationCompletion = { created: true };
export type InvitationInput = { token: string; name: string; password: string };

const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const INVITE_REFUSED = "This invitation is invalid, expired or already used. Ask the operator for a new one.";
export const INVITE_NAME = "Enter your name before creating the account.";
export const INVITE_PASSWORD = "Passwords have at least 8 characters and at most 128.";
const PASSWORD_POLICY_REFUSED = "That password does not meet the policy.";

function refusedPasswordMessage(body: unknown, fallback: string): string {
  const missing = isRecord(body) ? body.missing : undefined;
  if (!Array.isArray(missing) || missing.length === 0) return fallback;
  const named: string[] = [];
  for (const rule of missing) {
    if (!isRecord(rule) || typeof rule.message !== "string" || rule.message === "") return fallback;
    named.push(rule.message);
  }
  return `${PASSWORD_POLICY_REFUSED} ${named.join(" ")}`;
}

export function tokenFromFragment(hash: string): string | null {
  if (!hash.startsWith("#")) return null;
  const token = new URLSearchParams(hash.slice(1)).get("token");
  return token !== null && INVITE_TOKEN.test(token) ? token : null;
}

export async function previewInvitation(token: string): Promise<AuthResult<InvitationPreview>> {
  const response = await send("/registration/preview", { token });
  if (!response) return { ok: false, error: NETWORK };
  if (response.status === 400) return { ok: false, error: INVITE_REFUSED };
  if (!response.ok) return { ok: false, error: UNEXPECTED };
  const body = await readJson(response);
  const email = isRecord(body) ? body.email : undefined;
  if (typeof email !== "string" || email.trim() === "") return { ok: false, error: UNEXPECTED };
  return { ok: true, value: { email } };
}

export async function completeInvitation(input: InvitationInput): Promise<AuthResult<InvitationCompletion>> {
  const { token, name, password } = input;
  const response = await send("/registration/complete", { token, name, password });
  if (!response) return { ok: false, error: NETWORK };
  if (response.status === 400) {
    const body = await readJson(response);
    const code = isRecord(body) && typeof body.code === "string" ? body.code : "";
    if (code === "INVALID_NAME") return { ok: false, error: INVITE_NAME };
    if (code === "INVALID_PASSWORD") return { ok: false, error: refusedPasswordMessage(body, INVITE_PASSWORD) };
    return { ok: false, error: INVITE_REFUSED };
  }
  if (!response.ok) return { ok: false, error: UNEXPECTED };
  const body = await readJson(response);
  if (!isRecord(body) || body.ok !== true) return { ok: false, error: UNEXPECTED };
  return { ok: true, value: { created: true } };
}

export type ResetPreview = { email: string };
export type ResetCompletion = { reset: true };

export const RESET_REFUSED =
  "This password reset link is invalid, expired or already used. Ask the operator for a new one.";
export const RESET_PASSWORD = "Passwords have at least 8 characters and at most 128.";
export const RESET_PASSWORD_MISMATCH = "The two passwords do not match.";

export function resetPasswordError(password: string, confirmation: string): string | null {
  if (password.length < 8 || password.length > 128) return RESET_PASSWORD;
  return password === confirmation ? null : RESET_PASSWORD_MISMATCH;
}

export async function previewPasswordReset(token: string): Promise<AuthResult<ResetPreview>> {
  const response = await send("/password-reset/preview", { token });
  if (!response) return { ok: false, error: NETWORK };
  if (response.status === 400) return { ok: false, error: RESET_REFUSED };
  if (!response.ok) return { ok: false, error: UNEXPECTED };
  const body = await readJson(response);
  const email = isRecord(body) ? body.email : undefined;
  if (typeof email !== "string" || email.trim() === "") return { ok: false, error: UNEXPECTED };
  return { ok: true, value: { email } };
}

export async function completePasswordReset(token: string, newPassword: string): Promise<AuthResult<ResetCompletion>> {
  const response = await send("/password-reset/complete", { token, newPassword });
  if (!response) return { ok: false, error: NETWORK };
  if (response.status === 400) {
    const body = await readJson(response);
    const code = isRecord(body) && typeof body.code === "string" ? body.code : "";
    if (code === "PASSWORD_INVALID") return { ok: false, error: refusedPasswordMessage(body, RESET_PASSWORD) };
    return { ok: false, error: RESET_REFUSED };
  }
  if (!response.ok) return { ok: false, error: UNEXPECTED };
  const body = await readJson(response);
  if (!isRecord(body) || body.status !== "ok") return { ok: false, error: UNEXPECTED };
  return { ok: true, value: { reset: true } };
}
