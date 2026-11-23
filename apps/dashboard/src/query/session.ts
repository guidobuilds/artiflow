import { queryOptions, useQuery } from "@tanstack/react-query";

import { getSession } from "../auth-client.ts";
import { queryKeys } from "./keys.ts";

export const sessionQueryOptions = queryOptions({
  queryKey: queryKeys.auth.session,
  queryFn: () => getSession(),
  staleTime: Infinity,
});

export function useSession() {
  return useQuery(sessionQueryOptions);
}
