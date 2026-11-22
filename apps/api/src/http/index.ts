import type { Context } from "hono";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (value: string): boolean => UUID_RE.test(value);

export const isJsonContentType = (value: string | undefined): boolean =>
  value !== undefined && /^application\/json(?:;\s*charset=utf-8)?$/i.test(value.trim());

export const cookieMutationGuard = (
  c: Context,
  publicOrigin: string,
): "origin_not_allowed" | "json_content_type_required" | null => {
  if (c.req.header("origin") !== publicOrigin) return "origin_not_allowed";
  if (!isJsonContentType(c.req.header("content-type"))) return "json_content_type_required";
  return null;
};

export const jsonError = (
  c: Context,
  error: string,
  status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 500,
): Response => c.json({ error }, status);

export type AuthenticatedSession = { userId: string; sessionId: string };

type SessionReader = {
  api: {
    getSession(args: { headers: Headers }): Promise<{ user?: { id?: unknown }; session?: { id?: unknown } } | null>;
  };
};

export const authenticatedSession = async (
  auth: SessionReader,
  headers: Headers,
): Promise<AuthenticatedSession | null> => {
  const session = await auth.api.getSession({ headers });
  const userId = session?.user?.id;
  const sessionId = session?.session?.id;
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  return { userId, sessionId };
};

export const sessionUserId = async (auth: SessionReader, headers: Headers): Promise<string | null> => {
  const session = await auth.api.getSession({ headers });
  const id = session?.user?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
};

export class Rollback<T> extends Error {
  readonly carried: T;
  constructor(carried: T) {
    super("transaction rolled back by a typed refusal");
    this.carried = carried;
  }
  static async through<R>(
    db: { transaction: (run: (tx: unknown) => Promise<R>) => Promise<R> },
    run: (tx: unknown) => Promise<R>,
  ): Promise<R> {
    try {
      return await db.transaction(run);
    } catch (error) {
      if (error instanceof Rollback) return error.carried;
      throw error;
    }
  }
}
