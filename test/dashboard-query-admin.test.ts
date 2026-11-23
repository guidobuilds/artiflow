import assert from "node:assert/strict";
import test from "node:test";
import { QueryObserver } from "@tanstack/react-query";

import { EMPTY_SESSION_READ, applySessionRead, type SessionRow } from "../apps/dashboard/src/sessions-client.ts";
import { createQueryClient } from "../apps/dashboard/src/query/client.ts";
import { nextHeld } from "../apps/dashboard/src/query/held.ts";
import { queryKeys } from "../apps/dashboard/src/query/keys.ts";

const row: SessionRow = {
  id: "sess-1",
  startedAt: "2026-11-20T10:00:00.000Z",
  lastUsedAt: "2026-11-20T10:05:00.000Z",
  ipAddress: null,
  userAgent: null,
  current: true,
};

test("a failed reread keeps the sessions already on screen", () => {
  const loaded = applySessionRead(EMPTY_SESSION_READ, { ok: true, value: [row] });
  const seen = { ok: true as const, value: [row] };
  const held = nextHeld(EMPTY_SESSION_READ, undefined, seen, applySessionRead);
  assert.deepEqual(held.held.sessions, loaded.sessions);
  const failed = { ok: false as const, error: "The list could not be read.", code: "network", signInRequired: false };
  const again = nextHeld(held.held, seen, failed, applySessionRead);
  assert.deepEqual(again.held.sessions, [row]);
  assert.equal(again.held.failure, failed.error);
  const gap = nextHeld(again.held, failed, undefined, applySessionRead);
  assert.deepEqual(gap.held.sessions, [row]);
  assert.equal(gap.seen, undefined);
});

test("invalidating one account's sessions does not refetch another account", async () => {
  const reads = new Map<string, number>();
  const client = createQueryClient();
  const watch = (userId: string) =>
    new QueryObserver(client, {
      queryKey: queryKeys.admin.sessions(userId),
      queryFn: async () => {
        reads.set(userId, (reads.get(userId) ?? 0) + 1);
        return { ok: true as const, value: [row] };
      },
    });
  const ada = watch("ada");
  const grace = watch("grace");
  const stopAda = ada.subscribe(() => {});
  const stopGrace = grace.subscribe(() => {});
  await ada.refetch();
  await grace.refetch();
  const beforeAda = reads.get("ada") ?? 0;
  const beforeGrace = reads.get("grace") ?? 0;
  await client.invalidateQueries({ queryKey: queryKeys.admin.sessions("ada") });
  assert.equal(reads.get("ada"), beforeAda + 1);
  assert.equal(reads.get("grace"), beforeGrace);
  stopAda();
  stopGrace();
});
