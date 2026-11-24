import assert from "node:assert/strict";
import test from "node:test";
import { QueryObserver } from "@tanstack/react-query";

import type { ArtifactSummary } from "../apps/dashboard/src/auth-client.ts";
import { createQueryClient } from "../apps/dashboard/src/query/client.ts";
import {
  invalidateLibrary,
  libraryOwnedQuery,
  librarySharedQuery,
  libraryView,
} from "../apps/dashboard/src/query/library.ts";

const artifact = (id: string): ArtifactSummary => ({
  id,
  title: id,
  kind: "html",
  createdLabel: "1 Nov 2026",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  sizeLabel: "1 KB",
  versionsLabel: "1 version",
  verLabel: "v1",
  relLabel: "today",
  viewerHref: `/artifact/${id}`,
});

test("the library view waits for both lists, keeps a failed share list empty, and redirects on sign-in", () => {
  assert.equal(libraryView(undefined, undefined).kind, "loading");
  assert.equal(
    libraryView({ ok: true, value: [] }, undefined).kind,
    "loading",
    "an owned list does not render while the shared list is still in flight",
  );
  const signedOut = libraryView({ ok: false, error: "Sign in", signInRequired: true }, { ok: true, value: [] });
  assert.equal(signedOut.kind, "error", "the route guard owns the sign-in redirect, so the list reports the read");
  const sharedOnly = libraryView(
    { ok: true, value: [artifact("mine")] },
    { ok: false, error: "down", signInRequired: false },
  );
  assert.equal(sharedOnly.kind, "ready");
  assert.deepEqual(sharedOnly.kind === "ready" ? sharedOnly.shared : null, []);
  const ownedDown = libraryView(
    { ok: false, error: "The library failed", signInRequired: false },
    { ok: true, value: [{ ...artifact("theirs"), sharedBy: "ada@example.com" }] },
  );
  assert.equal(ownedDown.kind, "error");
  assert.equal(ownedDown.kind === "error" ? ownedDown.shared.length : 0, 1);
});

test("invalidating the library refetches the active owned and shared queries", async () => {
  let ownedReads = 0;
  let sharedReads = 0;
  const client = createQueryClient();
  const owned = new QueryObserver(client, {
    ...libraryOwnedQuery,
    queryFn: async () => {
      ownedReads += 1;
      return { ok: true as const, value: [artifact("mine")] };
    },
    refetchInterval: false,
  });
  const shared = new QueryObserver(client, {
    ...librarySharedQuery,
    queryFn: async () => {
      sharedReads += 1;
      return { ok: true as const, value: [] };
    },
    refetchInterval: false,
  });
  const stopOwned = owned.subscribe(() => {});
  const stopShared = shared.subscribe(() => {});
  await owned.refetch();
  await shared.refetch();
  const before = { owned: ownedReads, shared: sharedReads };
  await invalidateLibrary(client);
  assert.equal(ownedReads, before.owned + 1);
  assert.equal(sharedReads, before.shared + 1);
  const data = owned.getCurrentResult().data;
  assert.equal(data !== undefined && data.ok ? data.value[0]?.id : undefined, "mine");
  stopOwned();
  stopShared();
});
