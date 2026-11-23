import type { QueryClient } from "@tanstack/react-query";

import type { ManageResult } from "../auth-client.ts";
import { queryKeys } from "./keys.ts";

export type ShareRows<T> = { kind: "loading" } | { kind: "ready"; rows: T[] } | { kind: "error"; detail: string };

export function shareRows<T>(result: ManageResult<T[]> | undefined): ShareRows<T> {
  if (result === undefined) return { kind: "loading" };
  return result.ok ? { kind: "ready", rows: result.value } : { kind: "error", detail: result.error };
}

export function invalidateShareList(client: QueryClient, artifactId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: queryKeys.shares(artifactId) });
}

export function invalidateLinkList(client: QueryClient, artifactId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: queryKeys.links(artifactId) });
}
