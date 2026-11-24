import { queryOptions, type QueryClient } from "@tanstack/react-query";

import {
  fetchArtifacts,
  fetchSharedArtifacts,
  LIBRARY_POLL_MS,
  type ArtifactSummary,
  type LibraryResult,
  type SharedArtifactSummary,
  type SharedLibraryResult,
} from "../auth-client.ts";
import { queryKeys } from "./keys.ts";

const polling = {
  refetchInterval: LIBRARY_POLL_MS,
  refetchIntervalInBackground: true,
} as const;

export const libraryOwnedQuery = queryOptions({
  queryKey: queryKeys.library.owned,
  queryFn: () => fetchArtifacts(),
  ...polling,
});

export const librarySharedQuery = queryOptions({
  queryKey: queryKeys.library.shared,
  queryFn: () => fetchSharedArtifacts(),
  ...polling,
});

export function invalidateLibrary(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: queryKeys.library.all });
}

export type LibraryView =
  | { kind: "loading" }
  | { kind: "ready"; artifacts: ArtifactSummary[]; shared: SharedArtifactSummary[] }
  | { kind: "error"; detail: string; shared: SharedArtifactSummary[] };

export function libraryView(owned: LibraryResult | undefined, shared: SharedLibraryResult | undefined): LibraryView {
  if (owned === undefined || shared === undefined) return { kind: "loading" };
  const sharedRows = shared.ok ? shared.value : [];
  if (!owned.ok) return { kind: "error", detail: owned.error, shared: sharedRows };
  return { kind: "ready", artifacts: owned.value, shared: sharedRows };
}
