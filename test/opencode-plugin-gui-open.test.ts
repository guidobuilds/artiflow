import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { artifactIdFromTab, embedKey } from "../plugins/opencode/src/gui-display.ts";

function host(tokenReply?: () => Promise<string | null>) {
  const source = readFileSync(new URL("../plugins/opencode/src/gui.tsx", import.meta.url), "utf8");
  const start = source.indexOf("    async function openViewer(");
  const end = source.indexOf("    createEffect(", start);
  const closeVersions = new Map<string, number>();
  const calls: unknown[] = [];
  const disposed: unknown[] = [];
  let resolveToken!: (token: string) => void;
  let resolveOpen!: (id: string) => void;
  let rejectOpen!: (error: Error) => void;
  const token = new Promise<string>((resolve) => {
    resolveToken = resolve;
  });
  const opened = new Promise<string>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  const bridge = {
    open(input: unknown) {
      calls.push(input);
      return opened;
    },
    async dispose(input: unknown) {
      disposed.push(input);
    },
  };
  const ctx = {
    signal: new AbortController().signal,
    client: { rpc: () => ({ "viewer.token": tokenReply ?? (() => token) }) },
  };
  const openViewer = compileFunction(
    `const inFlight = new Map();\n${stripTypeScriptTypes(source.slice(start, end))}\nreturn openViewer;`,
    ["ctx", "bridge", "Associated", "artifactIdFromTab", "embedKey", "closeVersions"],
  )(ctx, bridge, {}, artifactIdFromTab, embedKey, closeVersions);
  return { openViewer, closeVersions, calls, disposed, resolveToken, resolveOpen, rejectOpen };
}

test("renderer concurrent opens share one bridge call and id; settled requests can reload", async () => {
  const h = host();
  const first = h.openViewer("s", "artifact:a");
  const second = h.openViewer("s", "artifact:a");
  h.resolveToken("token");
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
  h.resolveOpen("embed");
  assert.deepEqual(await Promise.all([first, second]), ["embed", "embed"]);
  assert.deepEqual(h.disposed, []);
  assert.equal(await h.openViewer("s", "artifact:a", true), "embed");
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1], { key: embedKey("s", "artifact:a"), artifactId: "a", token: "token", reload: true });
});

test("closing during a shared bridge open invalidates both callers and disposes the stale embed", async () => {
  const h = host();
  const first = h.openViewer("s", "artifact:a");
  h.resolveToken("token");
  await Promise.resolve();
  h.closeVersions.set(embedKey("s", "artifact:a"), 1);
  const second = h.openViewer("s", "artifact:a");
  h.resolveOpen("stale");
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.disposed, [{ key: embedKey("s", "artifact:a") }]);
});

test("renderer clears rejected opens so a later request can retry", async () => {
  const h = host();
  const first = h.openViewer("s", "artifact:a");
  const second = h.openViewer("s", "artifact:a");
  h.resolveToken("token");
  await Promise.resolve();
  h.rejectOpen(new Error("bridge unavailable"));
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "rejected"],
  );
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.openViewer("s", "artifact:a"), /bridge unavailable/);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.disposed, []);
});

test("renderer does not coalesce different embed keys", async () => {
  const h = host();
  const first = h.openViewer("s", "artifact:a");
  const second = h.openViewer("other", "artifact:a");
  h.resolveToken("token");
  await Promise.resolve();
  assert.equal(h.calls.length, 2);
  h.resolveOpen("embed");
  await Promise.all([first, second]);
  assert.deepEqual(h.disposed, []);
});

test("a rejected token RPC is no credential, so reload still reaches the host with a null token", async () => {
  const h = host(() => Promise.reject(new Error("viewer.token rejected (HTTP 400)")));
  const reload = h.openViewer("s", "artifact:a", true);
  h.resolveOpen("embed");
  assert.equal(await reload, "embed");
  assert.deepEqual(h.calls, [{ key: embedKey("s", "artifact:a"), artifactId: "a", token: null, reload: true }]);
  assert.deepEqual(h.disposed, []);
});

test("a null token response reaches the host without any secret or rejection", async () => {
  const h = host(async () => null);
  const reload = h.openViewer("s", "artifact:a", true);
  h.resolveOpen("embed");
  assert.equal(await reload, "embed");
  assert.deepEqual(h.calls, [{ key: embedKey("s", "artifact:a"), artifactId: "a", token: null, reload: true }]);
});

test("closing during token fetch still prevents bridge creation", async () => {
  const h = host();
  const pending = h.openViewer("s", "artifact:a");
  h.closeVersions.set(embedKey("s", "artifact:a"), 1);
  h.resolveToken("token");
  assert.equal(await pending, undefined);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.disposed, []);
});
