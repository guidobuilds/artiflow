import assert from "node:assert/strict";
import { test } from "node:test";

import type { ArtifactMetadata } from "@artiflow/contracts/artifacts";
import type { PollerScheduler, PollerVisibility } from "@artiflow/sdk/poll";
import { createArtifactApi } from "@artiflow/plugin-core/core";
import { createArtifactTransport, createArtifactWatcher } from "../plugins/opencode/src/freshness.ts";

const md = (artifactNumber: number, sha256: string, revisionId = `rev-${artifactNumber}`): ArtifactMetadata => ({
  artifactId: "art-1",
  revisionId,
  revisionNumber: artifactNumber,
  kind: "markdown",
  sha256,
  sizeBytes: 12,
});

const settle = async () => {
  for (let turn = 0; turn < 6; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

function fakeMetadata(handler: (artifactId: string) => Promise<unknown>) {
  const reads: { artifactId: string; signal: AbortSignal }[] = [];
  return {
    reads,
    metadata: (artifactId: string, signal: AbortSignal) => {
      reads.push({ artifactId, signal });
      return handler(artifactId);
    },
  };
}

function fakeScheduler() {
  let pending: { handle: number; handler: () => void; delay: number } | null = null;
  let sequence = 0;
  const scheduler: PollerScheduler = {
    schedule(handler, delayMs) {
      const handle = ++sequence;
      pending = { handle, handler, delay: delayMs };
      return handle;
    },
    cancel(handle) {
      if (pending !== null && pending.handle === handle) pending = null;
    },
  };
  return {
    scheduler,
    hasPending: () => pending !== null,
    pendingDelay: () => pending?.delay ?? null,
    run: () => {
      const current = pending;
      pending = null;
      current?.handler();
    },
  };
}

function fakeVisibility(initiallyHidden: boolean) {
  let hidden = initiallyHidden;
  const listeners = new Set<() => void>();
  const port: PollerVisibility = {
    hidden: () => hidden,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    port,
    set(next: boolean) {
      hidden = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

test("the host transport parses the canonical projection it is handed", async () => {
  const metadata = md(2, "bytes-B");
  const fake = fakeMetadata(async () => metadata);
  const transport = createArtifactTransport({
    artifactId: "art-1",
    metadata: fake.metadata,
    signal: new AbortController().signal,
  });

  assert.deepEqual(await transport.getMetadata({ artifactId: "art-1" }), metadata);
  assert.deepEqual(
    fake.reads.map((entry) => entry.artifactId),
    ["art-1"],
  );
});

test("the content read echoes the observed digest and never fetches bytes", async () => {
  const fake = fakeMetadata(async () => md(3, "bytes-C"));
  const transport = createArtifactTransport({
    artifactId: "art-1",
    metadata: fake.metadata,
    signal: new AbortController().signal,
  });
  await transport.getMetadata({ artifactId: "art-1" });

  assert.deepEqual(await transport.getContent({ artifactId: "art-1", revisionId: "rev-3" }), {
    sha256: "bytes-C",
    content: null,
  });
  assert.equal(fake.reads.length, 1);
  assert.equal(fake.reads[0]!.artifactId, "art-1");
});

test("a content read without metadata for that revision is refused", async () => {
  const transport = createArtifactTransport({
    artifactId: "art-1",
    metadata: fakeMetadata(async () => md(3, "bytes-C")).metadata,
    signal: new AbortController().signal,
  });
  await assert.rejects(
    () => transport.getContent({ artifactId: "art-1", revisionId: "rev-9" }),
    /without matching metadata/,
  );
});

test("non-canonical metadata and another artifact's metadata are rejected", async () => {
  const partial = createArtifactTransport({
    artifactId: "art-1",
    metadata: fakeMetadata(async () => ({ artifactId: "art-1" })).metadata,
    signal: new AbortController().signal,
  });
  await assert.rejects(() => partial.getMetadata({ artifactId: "art-1" }));

  const other = createArtifactTransport({
    artifactId: "art-1",
    metadata: fakeMetadata(async () => ({ ...md(1, "bytes-A"), artifactId: "art-2" })).metadata,
    signal: new AbortController().signal,
  });
  await assert.rejects(() => other.getMetadata({ artifactId: "art-1" }), /expected art-1/);
});

test("a newer revision with different bytes reloads the page once and applies that digest", async () => {
  const scheduler = fakeScheduler();
  const observed = [md(1, "bytes-A"), md(2, "bytes-B"), md(2, "bytes-B")];
  const fake = fakeMetadata(async () => observed.shift() ?? md(2, "bytes-B"));
  const reloads: unknown[] = [];
  const watcher = createArtifactWatcher({
    artifactId: "art-1",
    metadata: fake.metadata,
    reload: () => reloads.push(reloads.length + 1),
    scheduler: scheduler.scheduler,
  });

  watcher.start();
  await settle();
  assert.equal(reloads.length, 0);
  assert.equal(fake.reads.length, 1);

  scheduler.run();
  await settle();
  assert.equal(reloads.length, 1);

  scheduler.run();
  await settle();
  assert.equal(reloads.length, 1);
  watcher.stop();
});

test("a newer revision that carries the same bytes, or only a new revisionId, never reloads", async () => {
  const scheduler = fakeScheduler();
  const observed = [md(1, "bytes-A"), md(2, "bytes-A"), md(3, "bytes-A", "rev-3-recreated"), md(4, "bytes-A")];
  const fake = fakeMetadata(async () => observed.shift() ?? md(4, "bytes-A"));
  const reloads: unknown[] = [];
  const watcher = createArtifactWatcher({
    artifactId: "art-1",
    metadata: fake.metadata,
    reload: () => reloads.push(reloads.length + 1),
    scheduler: scheduler.scheduler,
  });

  watcher.start();
  await settle();
  for (let cycle = 0; cycle < 3; cycle += 1) {
    scheduler.run();
    await settle();
  }
  assert.equal(reloads.length, 0);
  watcher.stop();
});

test("an older or divergent revision never reloads the page", async () => {
  const scheduler = fakeScheduler();
  const observed = [
    md(5, "bytes-E"),
    md(4, "bytes-D"),
    { ...md(5, "bytes-E"), sha256: "bytes-other" },
  ];
  const fake = fakeMetadata(async () => observed.shift() ?? md(5, "bytes-E"));
  const reloads: unknown[] = [];
  const errors: unknown[] = [];
  const watcher = createArtifactWatcher({
    artifactId: "art-1",
    metadata: fake.metadata,
    reload: () => reloads.push(reloads.length + 1),
    onError: (error) => errors.push(error),
    scheduler: scheduler.scheduler,
  });

  watcher.start();
  await settle();
  for (let cycle = 0; cycle < 2; cycle += 1) {
    scheduler.run();
    await settle();
  }
  assert.equal(reloads.length, 0);
  assert.deepEqual(errors, []);
  watcher.stop();
});

test("a hidden viewer pauses polling and becoming visible polls at once", async () => {
  const scheduler = fakeScheduler();
  const visibility = fakeVisibility(true);
  const fake = fakeMetadata(async () => md(1, "bytes-A"));
  const watcher = createArtifactWatcher({
    artifactId: "art-1",
    metadata: fake.metadata,
    reload: () => {},
    scheduler: scheduler.scheduler,
    visibility: visibility.port,
  });

  watcher.start();
  await settle();
  assert.equal(fake.reads.length, 1);
  assert.equal(scheduler.hasPending(), false);

  visibility.set(false);
  await settle();
  assert.equal(fake.reads.length, 2);
  assert.equal(scheduler.pendingDelay(), 8_000);

  visibility.set(true);
  assert.equal(scheduler.hasPending(), false);
  watcher.stop();
  assert.equal(visibility.listenerCount(), 0);
});

test("stop releases timers and visibility and discards a late read", async () => {
  let resolveRead!: (value: unknown) => void;
  const fake = fakeMetadata(() => new Promise((resolve) => (resolveRead = resolve)));
  const visibility = fakeVisibility(false);
  const reloads: unknown[] = [];
  const errors: unknown[] = [];
  const watcher = createArtifactWatcher({
    artifactId: "art-1",
    metadata: fake.metadata,
    reload: () => reloads.push(reloads.length + 1),
    onError: (error) => errors.push(error),
    visibility: visibility.port,
    scheduler: fakeScheduler().scheduler,
  });

  watcher.start();
  watcher.stop();
  assert.equal(fake.reads[0]!.signal.aborted, true);
  assert.equal(visibility.listenerCount(), 0);

  resolveRead(md(9, "bytes-Z"));
  await settle();
  assert.deepEqual(reloads, []);
  assert.deepEqual(errors, []);
});

test("a failed read is reported without reloading and the next cycle recovers", async () => {
  const scheduler = fakeScheduler();
  let attempt = 0;
  const fake = fakeMetadata(async () => {
    attempt += 1;
    if (attempt === 2) throw new Error("network down");
    return attempt === 1 ? md(1, "bytes-A") : md(2, "bytes-B");
  });
  const reloads: unknown[] = [];
  const errors: unknown[] = [];
  const watcher = createArtifactWatcher({
    artifactId: "art-1",
    metadata: fake.metadata,
    reload: () => reloads.push(reloads.length + 1),
    onError: (error) => errors.push(error),
    scheduler: scheduler.scheduler,
  });

  watcher.start();
  await settle();
  scheduler.run();
  await settle();
  assert.equal(reloads.length, 0);
  assert.equal(errors.length, 1);
  assert.ok(String(errors[0]).includes("network down"));

  scheduler.run();
  await settle();
  assert.equal(reloads.length, 1);
  watcher.stop();
});

test("the metadata read never carries a bearer credential", async () => {
  const scheduler = fakeScheduler();
  const fake = fakeMetadata(async () => md(2, "bytes-B"));
  const watcher = createArtifactWatcher({
    artifactId: "art-1",
    metadata: fake.metadata,
    reload: () => {},
    scheduler: scheduler.scheduler,
  });

  watcher.start();
  await settle();
  scheduler.run();
  await settle();
  const surface = JSON.stringify(fake.reads.map((entry) => entry.artifactId));
  assert.ok(!/bearer|authorization|token/i.test(surface), surface);
  assert.deepEqual(
    fake.reads.map((entry) => entry.artifactId),
    ["art-1", "art-1"],
  );
  watcher.stop();
});

const base = "https://a.example";
const artifactDetail = (overrides: Record<string, unknown> = {}) => ({
  id: "art-1",
  title: null,
  kind: "markdown",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  observedSizeBytes: 12,
  revision: { id: "rev-1", revisionNumber: 1, sha256: "bytes-A", sizeBytes: 12 },
  ...overrides,
});
const v1Revision = (revisionNumber: number, sha256: string, id = `rev-${revisionNumber}`) => ({
  id,
  revisionNumber,
  sha256,
  sizeBytes: 12,
});

function v1Metadata(next: () => unknown) {
  const urls: string[] = [];
  const request: typeof fetch = async (url) => {
    urls.push(String(url));
    return Response.json(next());
  };
  return {
    urls,
    metadata: (artifactId: string, signal: AbortSignal) =>
      createArtifactApi({ base, token: "access", request, signal }).metadata({ artifactId }),
  };
}

test("the watcher consumes the real v1 detail: same bytes never reload, new bytes reload once", async () => {
  const scheduler = fakeScheduler();
  const observed = [
    artifactDetail(),
    artifactDetail({ revision: v1Revision(2, "bytes-A") }),
    artifactDetail({ revision: v1Revision(3, "bytes-B") }),
    artifactDetail({ revision: v1Revision(3, "bytes-B") }),
  ];
  const fake = v1Metadata(() => observed.shift() ?? artifactDetail({ revision: v1Revision(3, "bytes-B") }));
  const reloads: unknown[] = [];
  const errors: unknown[] = [];
  const watcher = createArtifactWatcher({
    artifactId: "art-1",
    metadata: fake.metadata,
    reload: () => reloads.push(reloads.length + 1),
    onError: (error) => errors.push(error),
    scheduler: scheduler.scheduler,
  });

  watcher.start();
  await settle();
  assert.equal(reloads.length, 0);

  scheduler.run();
  await settle();
  assert.equal(reloads.length, 0);

  scheduler.run();
  await settle();
  assert.equal(reloads.length, 1);

  scheduler.run();
  await settle();
  assert.equal(reloads.length, 1);
  assert.deepEqual(errors, []);
  assert.equal(fake.urls.length, 4);
  assert.deepEqual(fake.urls, Array.from({ length: 4 }, () => `${base}/api/v1/artifacts/art-1`));
  watcher.stop();
});

test("a v1 detail with an unknown kind is the wrong_kind refusal: no reload, one surfaced error", async () => {
  const fake = v1Metadata(() => artifactDetail({ kind: "unknown" }));
  const reloads: unknown[] = [];
  const errors: unknown[] = [];
  const watcher = createArtifactWatcher({
    artifactId: "art-1",
    metadata: fake.metadata,
    reload: () => reloads.push(reloads.length + 1),
    onError: (error) => errors.push(error),
    scheduler: fakeScheduler().scheduler,
  });

  watcher.start();
  await settle();
  assert.deepEqual(reloads, []);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /artifact_kind_mismatch/);
  watcher.stop();
});

test("a v1 detail without a current revision is the no_current_revision refusal: no reload, one error", async () => {
  const fake = v1Metadata(() => artifactDetail({ revision: null }));
  const reloads: unknown[] = [];
  const errors: unknown[] = [];
  const watcher = createArtifactWatcher({
    artifactId: "art-1",
    metadata: fake.metadata,
    reload: () => reloads.push(reloads.length + 1),
    onError: (error) => errors.push(error),
    scheduler: fakeScheduler().scheduler,
  });

  watcher.start();
  await settle();
  assert.deepEqual(reloads, []);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /artifact_has_no_current_revision/);
  watcher.stop();
});
