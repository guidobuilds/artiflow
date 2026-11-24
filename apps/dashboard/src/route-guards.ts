import type { QueryClient } from "@tanstack/react-query";

import { safeInternalPath } from "./lib/utils.ts";
import { sessionQueryOptions } from "./query/session.ts";

export const LOGIN_PATH = "/login";

export type LoginTarget = { to: typeof LOGIN_PATH; search: { return: string } };

export function continuationOf(pathname: string, search: string): string {
  return safeInternalPath(`${pathname}${search}`) ?? "/";
}

export function loginTarget(pathname: string, search: string): LoginTarget {
  return { to: LOGIN_PATH, search: { return: continuationOf(pathname, search) } };
}

export function loginHref(pathname: string, search: string): string {
  return `${LOGIN_PATH}?return=${encodeURIComponent(continuationOf(pathname, search))}`;
}

export async function signedOutRedirect(
  queryClient: QueryClient,
  pathname: string,
  search: string,
): Promise<LoginTarget | null> {
  const session = await queryClient.ensureQueryData(sessionQueryOptions);
  return session === null ? loginTarget(pathname, search) : null;
}
