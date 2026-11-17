import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import {
  deleteRevisionBytes,
  getRevisionBytes,
  isRevisionStorageKey,
  newRevisionStorageKey,
  putRevisionBytes,
  REVISION_KEY_PREFIX,
} from "../apps/api/src/adapters/storage/s3.ts";
import { MAX_ARTIFACT_BYTES } from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import { createStorage, type Storage } from "../apps/api/src/adapters/storage/client.ts";

const ENV_READY = Boolean(
  process.env.ARTIFLOW_S3_ENDPOINT &&
  process.env.ARTIFLOW_S3_BUCKET &&
  process.env.ARTIFLOW_S3_ACCESS_KEY_ID &&
  process.env.ARTIFLOW_S3_SECRET_ACCESS_KEY,
);
const storageTest = (name: string, run: (storage: Storage) => Promise<void>): void => {
  test(name, { skip: ENV_READY ? false : "S3 not configured; run with --env-file=.env.local" }, async () => {
    const endpoint = new URL(process.env.ARTIFLOW_S3_ENDPOINT ?? "");
    assert.equal(
      ["127.0.0.1", "localhost"].includes(endpoint.hostname) || process.env.ARTIFLOW_TEST_S3 === "1",
      true,
      "test storage must be loopback or ARTIFLOW_TEST_S3=1",
    );
    const storage = createStorage({
      endpoint: endpoint.origin,
      region: (process.env.ARTIFLOW_S3_REGION ?? "us-east-1").trim() || "us-east-1",
      bucket: process.env.ARTIFLOW_S3_BUCKET ?? "",
      accessKeyId: process.env.ARTIFLOW_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.ARTIFLOW_S3_SECRET_ACCESS_KEY ?? "",
      forcePathStyle: true,
    });
    try {
      await run(storage);
    } finally {
      storage.destroy();
    }
  });
};

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const payload = (size = 64): Buffer => randomBytes(size);

type FakeOptions = {
  headLength?: (key: string, actual: number) => number;
  failCommands?: readonly string[];
};

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
        return { ContentLength: (options.headLength ?? ((_key, actual) => actual))(key, stored.length) };
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

test("identical bytes written twice occupy two distinct keys, both digest-verified", async () => {
  const storage = fakeStorage();
  const bytes = payload(512);
  const sha256 = digestOf(bytes);
  const first = await putRevisionBytes({ storage, storageKey: newRevisionStorageKey(), sha256, bytes });
  const second = await putRevisionBytes({ storage, storageKey: newRevisionStorageKey(), sha256, bytes });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(first.value.storageKey, second.value.storageKey, "one key per write, never reused");
  for (const ref of [first.value, second.value]) {
    assert.equal(isRevisionStorageKey(ref.storageKey), true, "the key is prefix plus a lowercase id");
    assert.notEqual(ref.storageKey, `${REVISION_KEY_PREFIX}${sha256}`, "the key is never derived from the digest");
    assert.equal(ref.storageKey.includes(sha256), false, "the digest does not appear in the key");
    const got = await getRevisionBytes({ storage, storageKey: ref.storageKey, sha256 });
    assert.equal(got.ok, true, "both copies stay readable");
    if (got.ok) assert.deepEqual(Buffer.from(got.value.bytes), bytes);
  }
  assert.equal(storage.objects.size, 2, "two objects hold the same content");
  assert.equal((await deleteRevisionBytes({ storage, storageKey: first.value.storageKey })).ok, true);
  const gone = await getRevisionBytes({ storage, storageKey: first.value.storageKey, sha256 });
  assert.equal(gone.ok ? "ok" : gone.kind, "not_found");
  assert.equal(
    (await getRevisionBytes({ storage, storageKey: second.value.storageKey, sha256 })).ok,
    true,
    "deleting one key never reaches the other",
  );
});

test("stored bytes that disagree with the declared digest fail closed on read", async () => {
  const bytes = payload(256);
  const sha256 = digestOf(bytes);
  const storageKey = newRevisionStorageKey();
  const storage = fakeStorage();
  assert.equal((await putRevisionBytes({ storage, storageKey, sha256, bytes })).ok, true);
  storage.objects.set(storageKey, payload(256));
  const got = await getRevisionBytes({ storage, storageKey, sha256 });
  assert.equal(got.ok, false, "unverified bytes are never returned");
  if (got.ok) return;
  assert.equal(got.kind, "digest_mismatch");
  assert.equal(got.reason, "stored_bytes_do_not_match_declared_digest");
});

test("a mismatched declared digest is refused before any provider write", async () => {
  const storage = fakeStorage();
  const bytes = payload(64);
  const declared = digestOf(payload(64));
  const put = await putRevisionBytes({ storage, storageKey: newRevisionStorageKey(), sha256: declared, bytes });
  assert.equal(put.ok, false);
  if (!put.ok) assert.deepEqual([put.kind, put.reason], ["digest_mismatch", "payload_does_not_match_declared_digest"]);
  assert.equal(storage.objects.size, 0, "no object was created");
});

test("an invalid key shape or a foreign prefix is refused by put, get and delete", async () => {
  const storage = fakeStorage();
  const bytes = payload(32);
  const sha256 = digestOf(bytes);
  const invalid = [
    "",
    "artifacts",
    "artifacts/",
    "artifacts/UPPER",
    "artifacts/with_underscore",
    "artifacts/two/segments",
    "artifacts/../escape",
    `artifacts/${"a".repeat(200)}`,
    "staging/abcdef",
    "other/abcdef",
  ];
  for (const storageKey of invalid) {
    for (const result of [
      await putRevisionBytes({ storage, storageKey, sha256, bytes }),
      await getRevisionBytes({ storage, storageKey, sha256 }),
      await deleteRevisionBytes({ storage, storageKey }),
    ]) {
      assert.equal(result.ok, false, `refused key ${JSON.stringify(storageKey)}`);
      if (!result.ok) assert.deepEqual([result.kind, result.reason], ["validation", "storage_key_invalid"]);
    }
  }
  assert.equal(storage.objects.size, 0, "no provider call was made for a refused key");
});

test("an invalid declared digest is refused even with a well-formed key", async () => {
  const storage = fakeStorage();
  const bytes = payload(8);
  for (const sha256 of ["", "A".repeat(64), "a".repeat(63), "z".repeat(64)]) {
    const storageKey = newRevisionStorageKey();
    const put = await putRevisionBytes({ storage, storageKey, sha256, bytes });
    assert.equal(put.ok, false);
    if (!put.ok) assert.deepEqual([put.kind, put.reason], ["validation", "digest_not_lowercase_hex_sha256"]);
    const got = await getRevisionBytes({ storage, storageKey, sha256 });
    assert.equal(got.ok, false);
    if (!got.ok) assert.deepEqual([got.kind, got.reason], ["validation", "digest_not_lowercase_hex_sha256"]);
  }
  assert.equal(storage.objects.size, 0);
});

test("caps bound the write and both read paths", async () => {
  const storage = fakeStorage();
  const over = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
  const refused = await putRevisionBytes({
    storage,
    storageKey: newRevisionStorageKey(),
    sha256: digestOf(over),
    bytes: over,
  });
  assert.equal(refused.ok ? "ok" : refused.kind, "too_large");
  assert.equal(storage.objects.size, 0, "an over-cap payload creates no object");

  const bytes = payload(4096);
  const sha256 = digestOf(bytes);
  const storageKey = newRevisionStorageKey();
  assert.equal((await putRevisionBytes({ storage, storageKey, sha256, bytes })).ok, true);
  const capped = await getRevisionBytes({ storage, storageKey, sha256, maxBytes: 1024 });
  assert.equal(capped.ok ? "ok" : capped.kind, "too_large", "the head refuses a body above the cap");

  const lying = fakeStorage({}, { headLength: () => 64 });
  assert.equal((await putRevisionBytes({ storage: lying, storageKey, sha256, bytes })).ok, true);
  const streamed = await getRevisionBytes({ storage: lying, storageKey, sha256, maxBytes: 1024 });
  assert.equal(streamed.ok ? "ok" : streamed.kind, "too_large");
  if (!streamed.ok) assert.equal(streamed.reason, "streamed_object_exceeds_read_cap");

  for (const maxBytes of [0, -1, 1.5, MAX_ARTIFACT_BYTES + 1]) {
    const got = await getRevisionBytes({ storage, storageKey, sha256, maxBytes });
    assert.equal(got.ok, false);
    if (!got.ok) assert.deepEqual([got.kind, got.reason], ["validation", "max_bytes_out_of_range"]);
  }
});

test("a missing key is not_found and deleting an absent key is idempotent success", async () => {
  const storage = fakeStorage();
  const storageKey = newRevisionStorageKey();
  const sha256 = digestOf(payload(32));
  const got = await getRevisionBytes({ storage, storageKey, sha256 });
  assert.equal(got.ok, false);
  if (!got.ok) assert.deepEqual([got.kind, got.reason], ["not_found", "revision_not_stored"]);
  assert.equal((await deleteRevisionBytes({ storage, storageKey })).ok, true, "absent is the required end state");
  assert.equal((await deleteRevisionBytes({ storage, storageKey })).ok, true, "a retry stays success");
});

test("a provider failure is a retryable conflict, never a silent success", async () => {
  const bytes = payload(16);
  const sha256 = digestOf(bytes);
  const storageKey = newRevisionStorageKey();
  const failing = fakeStorage({}, { failCommands: ["PutObjectCommand"] });
  const put = await putRevisionBytes({ storage: failing, storageKey, sha256, bytes });
  assert.equal(put.ok, false);
  if (!put.ok) assert.deepEqual([put.kind, put.reason], ["conflict", "storage_request_failed"]);

  const seeded = fakeStorage({ [storageKey]: bytes }, { failCommands: ["GetObjectCommand"] });
  const got = await getRevisionBytes({ storage: seeded, storageKey, sha256 });
  assert.equal(got.ok, false);
  if (!got.ok) assert.deepEqual([got.kind, got.reason], ["conflict", "storage_request_failed"]);
});

type Stored = { storageKey: string; sha256: string };

async function putOwn(storage: Storage, bytes: Uint8Array): Promise<Stored> {
  const sha256 = digestOf(bytes);
  const storageKey = newRevisionStorageKey();
  const put = await putRevisionBytes({ storage, storageKey, sha256, bytes });
  assert.equal(put.ok, true, "owned S3 accepted one revision body");
  return { storageKey, sha256 };
}

async function expectZeroOwnKeys(storage: Storage, stored: Stored[]): Promise<number> {
  let remaining = 0;
  for (const { storageKey, sha256 } of stored) {
    await deleteRevisionBytes({ storage, storageKey });
    if ((await getRevisionBytes({ storage, storageKey, sha256 })).ok) remaining += 1;
  }
  return remaining;
}

storageTest("put then get returns the exact bytes for the declared digest", async (storage) => {
  const bytes = payload(4096);
  const sha256 = digestOf(bytes);
  const own = await putOwn(storage, bytes);
  try {
    const got = await getRevisionBytes({ storage, storageKey: own.storageKey, sha256 });
    assert.equal(got.ok, true);
    if (!got.ok) return;
    assert.equal(got.value.sizeBytes, bytes.length);
    assert.equal(got.value.storageKey, own.storageKey);
    assert.deepEqual(Buffer.from(got.value.bytes), bytes);
    assert.equal(digestOf(got.value.bytes), sha256);
  } finally {
    assert.deepEqual(await expectZeroOwnKeys(storage, [own]), 0);
  }
});

storageTest("an over-cap payload is refused without a write", async (storage) => {
  const over = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
  const sha256 = digestOf(over);
  const storageKey = newRevisionStorageKey();
  const put = await putRevisionBytes({ storage, storageKey, sha256, bytes: over });
  assert.equal(put.ok, false);
  if (put.ok) return;
  assert.equal(put.kind, "too_large");
  const got = await getRevisionBytes({ storage, storageKey, sha256 });
  assert.equal(got.ok, false);
  if (got.ok) return;
  assert.equal(got.kind, "not_found");
});

storageTest("an anonymous read of a stored revision is denied", async (storage) => {
  const bytes = payload(128);
  const sha256 = digestOf(bytes);
  const own = await putOwn(storage, bytes);
  try {
    const endpoint = (process.env.ARTIFLOW_S3_ENDPOINT ?? "").replace(/\/+$/, "");
    const response = await fetch(`${endpoint}/${storage.bucket}/${own.storageKey}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal([401, 403].includes(response.status), true, `anonymous read returned ${response.status}`);
    assert.equal((await getRevisionBytes({ storage, storageKey: own.storageKey, sha256 })).ok, true);
  } finally {
    assert.deepEqual(await expectZeroOwnKeys(storage, [own]), 0);
  }
});

storageTest("delete is idempotent and a deleted revision is not_found", async (storage) => {
  const bytes = payload(256);
  const sha256 = digestOf(bytes);
  const own = await putOwn(storage, bytes);
  try {
    assert.equal((await deleteRevisionBytes({ storage, storageKey: own.storageKey })).ok, true);
    const got = await getRevisionBytes({ storage, storageKey: own.storageKey, sha256 });
    assert.equal(got.ok, false);
    if (!got.ok) assert.equal(got.kind, "not_found");
    assert.equal((await deleteRevisionBytes({ storage, storageKey: own.storageKey })).ok, true);
  } finally {
    assert.deepEqual(await expectZeroOwnKeys(storage, [own]), 0);
  }
});
