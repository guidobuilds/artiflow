import assert from "node:assert/strict";
import { test } from "node:test";

import { Hono } from "hono";

import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { createLibraryApp, type LibraryOptions } from "../apps/api/src/routes/library.ts";

const ARTIFACT = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "http://localhost";
const JSON_TYPE = { "content-type": "application/json" };

const untouched = (): Database =>
  ({
    db: new Proxy(
      {},
      {
        get: (_target, name) => () => {
          throw new Error(`the request reached the database: ${String(name)}`);
        },
      },
    ),
  }) as unknown as Database;

const storage = (): Storage =>
  ({
    client: {},
    bucket: "unused",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
  }) as unknown as Storage;

const auth = (userId: string | null): LibraryOptions["auth"] =>
  ({
    api: {
      getSession: async () => (userId === null ? null : { user: { id: userId }, session: { id: "session-one" } }),
    },
  }) as unknown as LibraryOptions["auth"];

type Reply = { status: number; text: string };
type Wiring = { userId?: string | null; publicOrigin?: string | null; deletion?: boolean };

const harness = (wiring: Wiring = {}) => {
  const userId = wiring.userId === undefined ? "user-owner" : wiring.userId;
  const origin = wiring.publicOrigin === undefined ? ORIGIN : wiring.publicOrigin;
  const app = new Hono();
  app.route(
    "/",
    createLibraryApp({
      database: untouched(),
      auth: auth(userId),
      storage: storage(),
      ...(origin === null ? {} : { publicOrigin: origin }),
      ...(wiring.deletion === true ? { deletion: { publicOrigin: origin ?? ORIGIN } } : {}),
    }),
  );
  const read = async (path: string, init: RequestInit = {}): Promise<Reply> => {
    const response = await app.request(path, init);
    return { status: response.status, text: await response.text() };
  };
  return { read };
};

const rename = (read: (path: string, init?: RequestInit) => Promise<Reply>, headers: Record<string, string>) =>
  read(`/api/artifacts/${ARTIFACT}/metadata`, { method: "PATCH", headers, body: JSON.stringify({ title: "New" }) });

const remove = (read: (path: string, init?: RequestInit) => Promise<Reply>, headers: Record<string, string>) =>
  read(`/api/artifacts/${ARTIFACT}`, { method: "DELETE", headers, body: "{}" });

test("the metadata rename is a cookie mutation guarded exactly like the delete", async () => {
  const { read } = harness({ deletion: true });
  const seats: Array<[string, Record<string, string>]> = [
    ["no origin", JSON_TYPE],
    ["a foreign origin", { ...JSON_TYPE, origin: "http://127.0.0.1:1" }],
    ["a plain-text body", { origin: ORIGIN, "content-type": "text/plain" }],
  ];
  for (const [label, headers] of seats) {
    const renamed = await rename(read, headers);
    const deleted = await remove(read, headers);
    assert.deepEqual(
      [renamed.status, renamed.text],
      [deleted.status, deleted.text],
      `${label} is refused by the rename with the answer the delete gives`,
    );
  }
  assert.deepEqual(
    [
      (await rename(read, JSON_TYPE)).status,
      (await rename(read, { origin: ORIGIN, "content-type": "text/plain" })).status,
    ],
    [403, 415],
    "missing origin is 403 and a non-JSON body is 415",
  );
});

test("the guard runs before authentication, so a guest learns nothing else", async () => {
  const { read } = harness({ userId: null, deletion: true });
  assert.deepEqual(
    [(await rename(read, JSON_TYPE)).text, (await remove(read, JSON_TYPE)).text],
    ['{"error":"origin_not_allowed"}', '{"error":"origin_not_allowed"}'],
    "the mutation guard answers a guest before the session is read",
  );
  assert.deepEqual(
    [
      (await rename(read, { origin: ORIGIN, ...JSON_TYPE })).status,
      (await remove(read, { origin: ORIGIN, ...JSON_TYPE })).status,
    ],
    [401, 401],
    "and a guarded guest request is unauthorized",
  );
});

test("a bearer token renames nothing: the endpoint is a session mutation only", async () => {
  const { read } = harness({ userId: null });
  const bearer = await read(`/api/artifacts/${ARTIFACT}/metadata`, {
    method: "PATCH",
    headers: { origin: ORIGIN, ...JSON_TYPE, authorization: "Bearer one" },
    body: JSON.stringify({ title: "New" }),
  });
  assert.deepEqual([bearer.status, bearer.text], [401, '{"error":"unauthorized"}'], "a bearer is not a session");
});

test("an app built without deletion wiring still mounts and guards the rename", async () => {
  const { read } = harness();
  assert.deepEqual(
    [
      (await rename(read, JSON_TYPE)).status,
      (await rename(read, { origin: ORIGIN, "content-type": "text/plain" })).status,
    ],
    [403, 415],
    "the rename answers its own cookie guard with no deletion wiring in the options at all",
  );
  assert.deepEqual(
    [
      (await rename(read, { origin: ORIGIN, ...JSON_TYPE })).status,
      (await remove(read, { origin: ORIGIN, ...JSON_TYPE })).status,
    ],
    [500, 405],
    "the guarded rename reaches the domain while the delete stays exactly where it was",
  );
});

test("without a configured origin the rename is not mounted, so nothing is renamed unguarded", async () => {
  const { read } = harness({ publicOrigin: null, deletion: true });
  const unguarded = await rename(read, { origin: ORIGIN, ...JSON_TYPE });
  assert.deepEqual(
    [unguarded.status, unguarded.text],
    [405, '{"error":"method_not_allowed"}'],
    "no origin means no mutation route, and no request reaches the database",
  );
  const deleted = await remove(read, { origin: ORIGIN, ...JSON_TYPE });
  assert.equal(deleted.status, 500, "the delete keeps the origin its own wiring carries");
});

test("the library app still answers every method it answered before", async () => {
  const { read } = harness();
  const unsupported = await read(`/api/artifacts/${ARTIFACT}`, { method: "PUT", headers: JSON_TYPE });
  assert.deepEqual(
    [unsupported.status, unsupported.text],
    [405, '{"error":"method_not_allowed"}'],
    "an unsupported method on an owned path is still refused",
  );
  assert.deepEqual(
    [(await read(`/api/artifacts/${ARTIFACT}`, { method: "DELETE", headers: JSON_TYPE })).status],
    [405],
    "a delete with no deletion wiring is still not mounted",
  );
  const guest = harness({ userId: null });
  assert.deepEqual(
    [
      (await guest.read("/api/artifacts")).status,
      (await guest.read(`/api/artifacts/${ARTIFACT}`)).status,
      (await guest.read(`/artifact/${ARTIFACT}`)).status,
    ],
    [401, 401, 401],
    "the read paths still refuse a guest",
  );
});
