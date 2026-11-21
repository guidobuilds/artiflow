import assert from "node:assert/strict";
import { test } from "node:test";

import { createSequenceGuard, createThreadsRefetcher } from "../apps/dashboard/src/viewer-thread-sync.ts";

type Payload = { version: number };

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("only the newest refresh may write, even when an older one resolves last", async () => {
  const guard = createSequenceGuard();
  const applied: Payload[] = [];
  const failures: string[] = [];
  const pending: Array<ReturnType<typeof deferred<Payload>>> = [];
  const refetch = createThreadsRefetcher<Payload>({
    guard,
    load: () => {
      const next = deferred<Payload>();
      pending.push(next);
      return next.promise;
    },
    apply: (value) => applied.push(value),
    fail: (message) => failures.push(message),
  });

  const first = refetch();
  const second = refetch();
  pending[1]!.resolve({ version: 2 });
  await second;
  pending[0]!.resolve({ version: 1 });
  await first;

  assert.deepEqual(applied, [{ version: 2 }]);
  assert.deepEqual(failures, []);
});

test("an older refresh that fails never reports an error over a newer success", async () => {
  const guard = createSequenceGuard();
  const applied: Payload[] = [];
  const failures: string[] = [];
  const pending: Array<ReturnType<typeof deferred<Payload>>> = [];
  const refetch = createThreadsRefetcher<Payload>({
    guard,
    load: () => {
      const next = deferred<Payload>();
      pending.push(next);
      return next.promise;
    },
    apply: (value) => applied.push(value),
    fail: (message) => failures.push(message),
  });

  const first = refetch();
  const second = refetch();
  pending[1]!.resolve({ version: 2 });
  await second;
  pending[0]!.reject(new Error("stale boom"));
  await first;

  assert.deepEqual(applied, [{ version: 2 }]);
  assert.deepEqual(failures, []);
});

test("the latest refresh reports its failure once", async () => {
  const guard = createSequenceGuard();
  const applied: Payload[] = [];
  const failures: string[] = [];
  const refetch = createThreadsRefetcher<Payload>({
    guard,
    load: () => Promise.reject(new Error("network down")),
    apply: (value) => applied.push(value),
    fail: (message) => failures.push(message),
  });

  await refetch();

  assert.deepEqual(applied, []);
  assert.deepEqual(failures, ["network down"]);
});
