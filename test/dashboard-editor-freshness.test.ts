import assert from "node:assert/strict";
import { test } from "node:test";

import type { ArtifactMetadata } from "@artiflow/contracts/artifacts";
import type { MetadataQuery, PollerScheduler, PollerVisibility } from "@artiflow/sdk/poll";

import {
  createEditorFreshness,
  loadRemoteText,
  metadataFromDetail,
  type DetailWire,
  type EditorFreshnessDeps,
  type RemoteText,
} from "../apps/dashboard/src/lib/editor-freshness.ts";

const settle = async () => {
  for (let round = 0; round < 3; round += 1) await new Promise<void>((done) => setImmediate(done));
};

const md = (revisionNumber: number, sha256: string, revisionId = `rev-${revisionNumber}`): ArtifactMetadata => ({
  artifactId: "art-1",
  revisionId,
  revisionNumber,
  kind: "markdown",
  sha256,
  sizeBytes: 12,
});

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

function editorWorld(options: { text?: string; dirty?: boolean } = {}) {
  const text = options.text ?? "local text";
  const world = {
    current: md(1, "bytes-A"),
    texts: new Map<string, string>([["rev-1", text]]) as Map<string, string>,
    metadataQueries: [] as MetadataQuery[],
    documentReads: 0,
    buffer: text,
    writes: [] as string[],
    sequences: [] as number[],
    notices: [] as (ArtifactMetadata | null)[],
    pending: null as ArtifactMetadata | null,
    dirty: options.dirty === true,
    published(metadata: ArtifactMetadata, nextText: string) {
      world.current = metadata;
      world.texts.set(metadata.revisionId, nextText);
      return metadata;
    },
    lastNotice: () => world.notices[world.notices.length - 1] ?? null,
  };
  return world;
}

function depsOf(
  world: ReturnType<typeof editorWorld>,
  options: { scheduler?: PollerScheduler; visibility?: PollerVisibility; followLatest?: boolean } = {},
): EditorFreshnessDeps {
  return {
    artifactId: "art-1",
    kind: "markdown",
    initial: { revisionId: "rev-1", revisionNumber: 1 },
    readMetadata: async (query) => {
      world.metadataQueries.push(query);
      return world.current;
    },
    readDocument: async () => {
      world.documentReads += 1;
      const text = world.texts.get(world.current.revisionId);
      if (text === undefined) throw new Error("content unavailable");
      return { text, metadata: world.current, seq: 7 } satisfies RemoteText;
    },
    isDirty: () => world.dirty,
    writeRemote: (remote) => {
      world.buffer = remote.text;
      world.writes.push(remote.text);
      world.sequences.push(remote.seq);
    },
    onPending: (pending) => {
      world.pending = pending;
      world.notices.push(pending);
    },
    scheduler: options.scheduler ?? fakeScheduler().scheduler,
    visibility: options.visibility,
    followLatest: options.followLatest,
  };
}

test("a dirty editor keeps its local text when a newer revision is observed", async () => {
  const world = editorWorld({ dirty: true });
  const freshness = await createEditorFreshness(depsOf(world));
  freshness.start();

  world.published(md(5, "bytes-B"), "remote text");
  freshness.flush();
  await settle();

  assert.equal(world.buffer, "local text");
  assert.deepEqual(world.writes, []);
  assert.equal(world.pending?.revisionNumber, 5);
  assert.equal(world.lastNotice()?.revisionNumber, 5);
  assert.equal(freshness.expectedRevisionId(), "rev-1");

  freshness.flush();
  await settle();
  assert.equal(world.documentReads, 1);
  assert.equal(world.buffer, "local text");
  freshness.stop();
});

test("a clean editor applies the newer revision and moves the CAS base", async () => {
  const world = editorWorld();
  const freshness = await createEditorFreshness(depsOf(world));
  freshness.start();

  world.published(md(5, "bytes-B"), "remote text");
  freshness.flush();
  await settle();

  assert.deepEqual(world.writes, ["remote text"]);
  assert.deepEqual(world.sequences, [7], "the applied remote text carries the sequence it was read at");
  assert.equal(world.buffer, "remote text");
  assert.equal(world.pending, null);
  assert.equal(world.lastNotice(), null);
  assert.equal(freshness.expectedRevisionId(), "rev-5");
  freshness.stop();
});

test("a dirty editor resolves explicitly: keep-local defers, accept-remote reloads and advances", async () => {
  const world = editorWorld({ dirty: true });
  const freshness = await createEditorFreshness(depsOf(world));
  freshness.start();

  world.published(md(5, "bytes-B"), "remote text");
  freshness.flush();
  await settle();
  assert.equal(world.pending?.revisionNumber, 5);

  assert.equal(await freshness.resolve("keep-local"), "kept");
  assert.equal(world.buffer, "local text");
  assert.equal(world.pending?.revisionNumber, 5);
  assert.equal(freshness.expectedRevisionId(), "rev-1");

  const readsBefore = world.documentReads;
  assert.equal(await freshness.resolve("accept-remote"), "applied");
  assert.equal(world.documentReads, readsBefore + 1);
  assert.equal(world.buffer, "remote text");
  assert.equal(world.pending, null);
  assert.equal(world.lastNotice(), null);
  assert.equal(freshness.expectedRevisionId(), "rev-5");
  freshness.stop();
});

test("a same-byte revision moves the CAS base without swapping content or reading bytes", async () => {
  const world = editorWorld();
  const freshness = await createEditorFreshness(depsOf(world));
  freshness.start();

  world.published(md(5, "bytes-A"), "same bytes re-saved");
  freshness.flush();
  await settle();

  assert.equal(world.documentReads, 0);
  assert.deepEqual(world.writes, []);
  assert.equal(world.buffer, "local text");
  assert.equal(world.pending, null);
  assert.equal(freshness.expectedRevisionId(), "rev-5");
  freshness.stop();
});

test("a revision applied through the editor's own path clears the notice and moves the base", async () => {
  const world = editorWorld({ dirty: true });
  const freshness = await createEditorFreshness(depsOf(world));
  freshness.start();

  world.published(md(5, "bytes-B"), "remote text");
  freshness.flush();
  await settle();
  assert.equal(world.pending?.revisionNumber, 5);

  freshness.adopt(world.current);
  assert.equal(world.pending, null);
  assert.equal(world.lastNotice(), null);
  assert.equal(freshness.expectedRevisionId(), "rev-5");
  freshness.stop();
});

test("a hidden tab pauses polling and becoming visible resumes it immediately", async () => {
  const world = editorWorld();
  const visibility = fakeVisibility(true);
  const scheduler = fakeScheduler();
  const freshness = await createEditorFreshness(
    depsOf(world, { scheduler: scheduler.scheduler, visibility: visibility.port }),
  );
  freshness.start();

  const seedReads = world.metadataQueries.length;
  assert.equal(scheduler.hasPending(), false);
  world.published(md(2, "bytes-B"), "remote text");
  await settle();
  assert.equal(world.metadataQueries.length, seedReads);

  visibility.set(false);
  await settle();
  assert.equal(world.metadataQueries.length, seedReads + 1);
  assert.equal(scheduler.pendingDelay(), 8_000);
  assert.equal(world.buffer, "remote text");

  visibility.set(true);
  assert.equal(scheduler.hasPending(), false);

  freshness.stop();
  assert.equal(visibility.listenerCount(), 0);
});

test("the poll target stays pinned to the edited revision unless followLatest is set", async () => {
  const pinned = editorWorld({ dirty: true });
  const freshness = await createEditorFreshness(depsOf(pinned));
  freshness.start();
  freshness.flush();
  await settle();
  freshness.flush();
  await settle();
  assert.deepEqual(pinned.metadataQueries.slice(1), [
    { artifactId: "art-1", revisionId: "rev-1" },
    { artifactId: "art-1", revisionId: "rev-1" },
  ]);
  assert.equal(freshness.expectedRevisionId(), "rev-1");
  freshness.stop();

  const following = editorWorld();
  const latest = await createEditorFreshness(depsOf(following, { followLatest: true }));
  latest.start();
  latest.flush();
  await settle();
  assert.deepEqual(following.metadataQueries.slice(1), [{ artifactId: "art-1" }]);
  latest.stop();
});

test("a pointer that moved before the wiring started reloads instead of being skipped", async () => {
  const world = editorWorld();
  world.published(md(5, "bytes-B"), "remote text");

  const freshness = await createEditorFreshness(depsOf(world));

  assert.equal(world.buffer, "remote text");
  assert.equal(freshness.expectedRevisionId(), "rev-5");
  freshness.stop();
});

test("the dashboard projection drops the wire kind, so the editor's loaded kind supplies it", () => {
  const detail: DetailWire = {
    id: "art-1",
    revision: { id: "rev-7", revisionNumber: 7, sha256: "bytes-G", sizeBytes: 21 },
  };
  assert.deepEqual(metadataFromDetail(detail, "markdown"), {
    artifactId: "art-1",
    revisionId: "rev-7",
    revisionNumber: 7,
    kind: "markdown",
    sha256: "bytes-G",
    sizeBytes: 21,
  });
  assert.equal(metadataFromDetail({ id: "art-1", revision: null }, "markdown"), null);
  assert.equal("kind" in detail, false);
});

test("text is paired with the digest of the revision that served it, or not at all", async () => {
  let attempt = 0;
  const retried = await loadRemoteText({
    document: async () => {
      attempt += 1;
      return attempt === 1
        ? { text: "stale text", revisionId: "rev-4", revisionNumber: 4, seq: 6 }
        : { text: "remote text", revisionId: "rev-5", revisionNumber: 5, seq: 7 };
    },
    detail: async () => md(5, "bytes-B"),
  });
  assert.deepEqual(retried, { text: "remote text", metadata: md(5, "bytes-B"), seq: 7 });

  const unpaired = await loadRemoteText({
    document: async () => ({ text: "text", revisionId: "rev-4", revisionNumber: 4, seq: 6 }),
    detail: async () => md(5, "bytes-B"),
  });
  assert.equal(unpaired, null);

  assert.equal(await loadRemoteText({ document: async () => null, detail: async () => md(1, "bytes-A") }), null);
  assert.equal(
    await loadRemoteText({
      document: async () => ({ text: "text", revisionId: "rev-1", revisionNumber: 1, seq: 7 }),
      detail: async () => null,
    }),
    null,
  );
});
