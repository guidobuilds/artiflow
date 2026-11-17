import assert from "node:assert/strict";
import { test } from "node:test";

import type { ArtifactMetadata } from "@artiflow/contracts/artifacts";
import * as freshness from "@artiflow/domain/freshness";
import { createSdkClient } from "@artiflow/sdk/client";
import {
  createArtifactPoller,
  type PollerScheduler,
  type PollerTransport,
  type PollerUpdate,
  type PollerVisibility,
} from "@artiflow/sdk/poll";

type Query = { artifactId: string; revisionId?: string };
type ContentQuery = { artifactId: string; revisionId: string };

const md = (revisionNumber: number, sha256: string, revisionId = `rev-${revisionNumber}`): ArtifactMetadata => ({
  artifactId: "art-1",
  revisionId,
  revisionNumber,
  kind: "markdown",
  sha256,
  sizeBytes: 12,
});

const ref = (revisionNumber: number, sha256: string) => ({
  revisionId: `rev-${revisionNumber}`,
  revisionNumber,
  sha256,
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeTransport(handlers: {
  metadata: (query: Query) => Promise<ArtifactMetadata>;
  content?: (query: ContentQuery) => Promise<{ sha256: string; content: string }>;
}) {
  const metadataQueries: Query[] = [];
  const contentQueries: ContentQuery[] = [];
  const transport: PollerTransport<string> = {
    getMetadata: (query) => {
      metadataQueries.push(query);
      return handlers.metadata(query);
    },
    getContent: (query) => {
      contentQueries.push(query);
      return handlers.content ? handlers.content(query) : Promise.reject(new Error("unexpected content read"));
    },
  };
  return { transport, metadataQueries, contentQueries };
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

test("a visible poller schedules its cycle no later than ten seconds out", () => {
  const byDefault = fakeScheduler();
  const poller = createArtifactPoller({
    transport: fakeTransport({ metadata: async () => md(1, "bytes-A") }).transport,
    target: { artifactId: "art-1" },
    freshness,
    initialReference: ref(1, "bytes-A"),
    scheduler: byDefault.scheduler,
  });
  poller.start();
  assert.equal(byDefault.pendingDelay(), 8_000);
  poller.stop();

  const clamped = fakeScheduler();
  const slow = createArtifactPoller({
    transport: fakeTransport({ metadata: async () => md(1, "bytes-A") }).transport,
    target: { artifactId: "art-1" },
    freshness,
    initialReference: ref(1, "bytes-A"),
    intervalMs: 60_000,
    scheduler: clamped.scheduler,
  });
  slow.start();
  assert.equal(clamped.pendingDelay(), 10_000);
  slow.stop();
});

test("a same-byte revision emits metadata only, and content is read only when the digest changes", async () => {
  const observed = [md(2, "bytes-A"), md(3, "bytes-B")];
  const transport = fakeTransport({
    metadata: async () => observed.shift() ?? md(3, "bytes-B"),
    content: async (query) => ({ sha256: "bytes-B", content: `content@${query.revisionId}` }),
  });
  const updates: PollerUpdate<string>[] = [];
  const poller = createArtifactPoller({
    transport: transport.transport,
    target: { artifactId: "art-1" },
    freshness,
    initialReference: ref(1, "bytes-A"),
    scheduler: fakeScheduler().scheduler,
  });
  poller.subscribe((update) => updates.push(update));
  poller.start();

  poller.flush();
  await tick();
  assert.deepEqual(
    updates.map((update) => update.kind),
    ["metadata"],
  );
  assert.equal(transport.contentQueries.length, 0);
  assert.equal(poller.state().reference?.revisionNumber, 2);

  poller.flush();
  await tick();
  assert.deepEqual(
    updates.map((update) => update.kind),
    ["metadata", "content"],
  );
  assert.deepEqual(transport.contentQueries, [{ artifactId: "art-1", revisionId: "rev-3" }]);
  const delivered = updates[1];
  if (!delivered || delivered.kind !== "content") throw new Error("expected a content update");
  assert.equal(delivered.content, "content@rev-3");
  assert.equal(poller.state().reference?.revisionNumber, 2);
  assert.equal(poller.state().pending?.revisionNumber, 3);
  poller.stop();
});

test("a pinned target stays pinned and never follows the latest revision", async () => {
  const transport = fakeTransport({
    metadata: async (query) => (query.revisionId === "rev-2" ? md(2, "bytes-B") : md(9, "bytes-Z")),
    content: async () => ({ sha256: "bytes-Z", content: "latest" }),
  });
  const updates: PollerUpdate<string>[] = [];
  const poller = createArtifactPoller({
    transport: transport.transport,
    target: { artifactId: "art-1", revisionId: "rev-2" },
    freshness,
    initialReference: ref(2, "bytes-B"),
    scheduler: fakeScheduler().scheduler,
  });
  poller.subscribe((update) => updates.push(update));
  poller.start();

  poller.flush();
  await tick();
  poller.flush();
  await tick();
  assert.deepEqual(transport.metadataQueries, [
    { artifactId: "art-1", revisionId: "rev-2" },
    { artifactId: "art-1", revisionId: "rev-2" },
  ]);
  assert.equal(transport.contentQueries.length, 0);
  assert.deepEqual(updates, []);
  poller.stop();
});

test("following latest is an explicit option, never implicit", async () => {
  const transport = fakeTransport({
    metadata: async (query) => (query.revisionId === undefined ? md(9, "bytes-Z") : md(2, "bytes-B")),
    content: async () => ({ sha256: "bytes-Z", content: "latest" }),
  });
  const updates: PollerUpdate<string>[] = [];
  const poller = createArtifactPoller({
    transport: transport.transport,
    target: { artifactId: "art-1", revisionId: "rev-2" },
    followLatest: true,
    freshness,
    initialReference: ref(2, "bytes-B"),
    scheduler: fakeScheduler().scheduler,
  });
  poller.subscribe((update) => updates.push(update));
  poller.start();

  poller.flush();
  await tick();
  assert.deepEqual(transport.metadataQueries, [{ artifactId: "art-1" }]);
  assert.deepEqual(transport.contentQueries, [{ artifactId: "art-1", revisionId: "rev-9" }]);
  assert.deepEqual(
    updates.map((update) => update.kind),
    ["content"],
  );
  poller.stop();
});

test("a hidden document pauses polling and becoming visible resumes it immediately", async () => {
  const visibility = fakeVisibility(true);
  const scheduler = fakeScheduler();
  const transport = fakeTransport({ metadata: async () => md(1, "bytes-A") });
  const poller = createArtifactPoller({
    transport: transport.transport,
    target: { artifactId: "art-1" },
    freshness,
    initialReference: ref(1, "bytes-A"),
    scheduler: scheduler.scheduler,
    visibility: visibility.port,
  });
  poller.start();
  assert.equal(scheduler.hasPending(), false);
  assert.equal(transport.metadataQueries.length, 0);

  visibility.set(false);
  await tick();
  assert.equal(transport.metadataQueries.length, 1);
  assert.equal(scheduler.pendingDelay(), 8_000);

  visibility.set(true);
  assert.equal(scheduler.hasPending(), false);

  poller.stop();
  assert.equal(visibility.listenerCount(), 0);
});

test("a hidden document can back off instead of pausing", () => {
  const visibility = fakeVisibility(true);
  const scheduler = fakeScheduler();
  const poller = createArtifactPoller({
    transport: fakeTransport({ metadata: async () => md(1, "bytes-A") }).transport,
    target: { artifactId: "art-1" },
    freshness,
    initialReference: ref(1, "bytes-A"),
    hiddenIntervalMs: 30_000,
    scheduler: scheduler.scheduler,
    visibility: visibility.port,
  });
  poller.start();
  assert.equal(scheduler.pendingDelay(), 30_000);
  poller.stop();
});

test("only one cycle is in flight at a time", async () => {
  const pendingMetadata = deferred<ArtifactMetadata>();
  const transport = fakeTransport({ metadata: () => pendingMetadata.promise });
  const poller = createArtifactPoller({
    transport: transport.transport,
    target: { artifactId: "art-1" },
    freshness,
    initialReference: ref(1, "bytes-A"),
    scheduler: fakeScheduler().scheduler,
  });
  poller.start();

  poller.flush();
  poller.flush();
  assert.equal(transport.metadataQueries.length, 1);

  pendingMetadata.resolve(md(1, "bytes-A"));
  await tick();
  poller.flush();
  assert.equal(transport.metadataQueries.length, 2);
  poller.stop();
});

test("a late response after stop is discarded", async () => {
  const scheduler = fakeScheduler();
  const pendingMetadata = deferred<ArtifactMetadata>();
  const transport = fakeTransport({ metadata: () => pendingMetadata.promise });
  const updates: PollerUpdate<string>[] = [];
  const poller = createArtifactPoller({
    transport: transport.transport,
    target: { artifactId: "art-1" },
    freshness,
    initialReference: ref(1, "bytes-A"),
    scheduler: scheduler.scheduler,
  });
  poller.subscribe((update) => updates.push(update));
  poller.start();
  poller.flush();
  poller.stop();

  pendingMetadata.resolve(md(9, "bytes-Z"));
  await tick();
  assert.deepEqual(updates, []);
  assert.equal(poller.state().stopped, true);
  assert.equal(scheduler.hasPending(), false);
  assert.equal(transport.contentQueries.length, 0);
});

test("a failed poll retries the same pointer and applies the content when it succeeds", async () => {
  let attempt = 0;
  const transport = fakeTransport({
    metadata: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return md(3, "bytes-B");
    },
    content: async () => ({ sha256: "bytes-B", content: "recovered" }),
  });
  const updates: PollerUpdate<string>[] = [];
  const poller = createArtifactPoller({
    transport: transport.transport,
    target: { artifactId: "art-1" },
    freshness,
    initialReference: ref(1, "bytes-A"),
    scheduler: fakeScheduler().scheduler,
  });
  poller.subscribe((update) => updates.push(update));
  poller.start();

  poller.flush();
  await tick();
  assert.deepEqual(
    updates.map((update) => update.kind),
    ["error"],
  );

  poller.flush();
  await tick();
  assert.deepEqual(transport.metadataQueries, [{ artifactId: "art-1" }, { artifactId: "art-1" }]);
  assert.deepEqual(transport.contentQueries, [{ artifactId: "art-1", revisionId: "rev-3" }]);
  assert.deepEqual(
    updates.map((update) => update.kind),
    ["error", "content"],
  );
  poller.stop();
});

test("duplicate metadata resolution emits one content update and reads content once", async () => {
  const transport = fakeTransport({
    metadata: async () => md(3, "bytes-B"),
    content: async () => ({ sha256: "bytes-B", content: "once" }),
  });
  const updates: PollerUpdate<string>[] = [];
  const poller = createArtifactPoller({
    transport: transport.transport,
    target: { artifactId: "art-1" },
    freshness,
    initialReference: ref(1, "bytes-A"),
    scheduler: fakeScheduler().scheduler,
  });
  poller.subscribe((update) => updates.push(update));
  poller.start();

  poller.flush();
  await tick();
  poller.flush();
  await tick();
  poller.flush();
  await tick();
  assert.equal(transport.contentQueries.length, 1);
  assert.deepEqual(
    updates.map((update) => update.kind),
    ["content"],
  );
  poller.stop();
});

test("markApplied moves the reference to the bytes the consumer applied and never rewinds it", async () => {
  const transport = fakeTransport({
    metadata: async () => md(3, "bytes-B"),
    content: async () => ({ sha256: "bytes-B", content: "applied" }),
  });
  const poller = createArtifactPoller({
    transport: transport.transport,
    target: { artifactId: "art-1" },
    freshness,
    initialReference: ref(1, "bytes-A"),
    scheduler: fakeScheduler().scheduler,
  });
  poller.start();
  poller.flush();
  await tick();

  poller.markApplied(md(3, "bytes-B"));
  assert.equal(poller.state().reference?.revisionNumber, 3);
  assert.equal(poller.state().pending, null);

  poller.markApplied(md(1, "bytes-A"));
  assert.equal(poller.state().reference?.revisionNumber, 3);

  poller.flush();
  await tick();
  assert.equal(transport.contentQueries.length, 1);
  poller.stop();
});

test("the existing sdk subpath exports keep resolving", () => {
  assert.equal(typeof createSdkClient, "function");
});
