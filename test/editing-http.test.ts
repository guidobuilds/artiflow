import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { getRevisionBytes, isRevisionStorageKey, newRevisionStorageKey } from "../apps/api/src/adapters/storage/s3.ts";
import { copyRevisionBytes } from "../apps/api/src/domain/commit-flow.ts";

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const payload = (size = 128): Buffer => randomBytes(size);

type FakeOptions = { failCommands?: readonly string[] };
type FakeStorage = Storage & { objects: Map<string, Uint8Array> };

const providerError = (status: number): Error =>
  Object.assign(new Error(`provider ${status}`), { $metadata: { httpStatusCode: status } });

function fakeStorage(seed: Record<string, Uint8Array> = {}, options: FakeOptions = {}): FakeStorage {
  const objects = new Map<string, Uint8Array>(Object.entries(seed));
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      const name = command.constructor.name;
      if (options.failCommands?.includes(name)) throw providerError(500);
      const key = String(command.input.Key ?? "");
      const stored = objects.get(key);
      if (name === "HeadObjectCommand") {
        if (!stored) throw providerError(404);
        return { ContentLength: stored.length };
      }
      if (name === "PutObjectCommand") {
        objects.set(key, Buffer.from(command.input.Body as Uint8Array));
        return {};
      }
      if (name === "GetObjectCommand") {
        if (!stored) throw providerError(404);
        return {
          Body: (async function* (): AsyncIterable<Uint8Array> {
            yield stored;
          })(),
        };
      }
      if (name === "DeleteObjectCommand") {
        objects.delete(key);
        return {};
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
  return {
    client: client as unknown as Storage["client"],
    bucket: "test-bucket",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
    objects,
  };
}

const pinned = (bytes: Uint8Array = payload()): { storageKey: string; sha256: string; bytes: Uint8Array } => ({
  storageKey: newRevisionStorageKey(),
  sha256: digestOf(bytes),
  bytes,
});

test("a restored revision is stored under its own key, never the pinned revision's key", async () => {
  const source = pinned(payload(512));
  const storage = fakeStorage({ [source.storageKey]: source.bytes });
  const copied = await copyRevisionBytes({
    storage,
    storageKey: source.storageKey,
    sha256: source.sha256,
  });
  assert.equal(copied.ok, true);
  if (!copied.ok) return;
  assert.notEqual(copied.value.storageKey, source.storageKey, "the restored revision names a different key");
  assert.equal(isRevisionStorageKey(copied.value.storageKey), true, "the new key keeps the revision key shape");
  assert.equal(copied.value.sha256, source.sha256, "identical bytes keep the pinned row's digest");
  assert.equal(storage.objects.size, 2, "the bytes exist under both keys: the pinned row keeps its own object");
  for (const key of [source.storageKey, copied.value.storageKey]) {
    const got = await getRevisionBytes({ storage, storageKey: key, sha256: source.sha256 });
    assert.equal(got.ok, true, "both revisions remain readable and digest-verified");
    if (got.ok) assert.deepEqual(Buffer.from(got.value.bytes), source.bytes);
  }
});

test("a repeated restore allocates a new key every time", async () => {
  const source = pinned(payload(256));
  const storage = fakeStorage({ [source.storageKey]: source.bytes });
  const keys = new Set([source.storageKey]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const copied = await copyRevisionBytes({ storage, storageKey: source.storageKey, sha256: source.sha256 });
    assert.equal(copied.ok, true);
    if (!copied.ok) return;
    assert.equal(keys.has(copied.value.storageKey), false, "a key is never reused across restores");
    keys.add(copied.value.storageKey);
  }
  assert.equal(storage.objects.size, 3, "three revisions of one content value, three objects");
});

test("a failed read stores nothing and returns the provider's failure kind", async () => {
  const source = pinned(payload(128));
  for (const storage of [
    fakeStorage({}, {}),
    fakeStorage({ [source.storageKey]: source.bytes }, { failCommands: ["GetObjectCommand"] }),
  ]) {
    const before = new Set(storage.objects.keys());
    const copied = await copyRevisionBytes({ storage, storageKey: source.storageKey, sha256: source.sha256 });
    assert.equal(copied.ok, false, "an unreadable pinned body fails the copy instead of storing anything");
    assert.deepEqual([...storage.objects.keys()], [...before], "no key was created");
  }
});

test("pinned bytes that disagree with the pinned row's digest are never re-stored", async () => {
  const source = pinned(payload(128));
  const tampered = payload(128);
  const storage = fakeStorage({ [source.storageKey]: tampered });
  const copied = await copyRevisionBytes({ storage, storageKey: source.storageKey, sha256: source.sha256 });
  assert.equal(copied.ok ? "ok" : copied.kind, "digest_mismatch");
  assert.deepEqual([...storage.objects.keys()], [source.storageKey], "the unverified bytes were not copied");
});

test("a failed put leaves the pinned key untouched and creates no second key", async () => {
  const source = pinned(payload(128));
  const storage = fakeStorage({ [source.storageKey]: source.bytes }, { failCommands: ["PutObjectCommand"] });
  const copied = await copyRevisionBytes({ storage, storageKey: source.storageKey, sha256: source.sha256 });
  assert.equal(copied.ok, false);
  assert.deepEqual([...storage.objects.keys()], [source.storageKey], "only the pinned revision's own object exists");
  const original = await getRevisionBytes({ storage, storageKey: source.storageKey, sha256: source.sha256 });
  assert.equal(original.ok, true, "the pinned revision is still readable");
});
