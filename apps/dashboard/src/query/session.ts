import { queryOptions, useQuery } from "@tanstack/react-query";

import { getSession, type AuthUser } from "../auth-client.ts";
import { queryKeys } from "./keys.ts";

export const sessionQueryOptions = queryOptions({
  queryKey: queryKeys.auth.session,
  queryFn: async (): Promise<AuthUser | null> => {
    const result = await getSession();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  staleTime: 30_000,
});

export function useSession() {
  return useQuery(sessionQueryOptions);
}

export function useSessionUser(): AuthUser | null {
  return useQuery(sessionQueryOptions).data ?? null;
}
