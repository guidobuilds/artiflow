import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { findExecutable, resolveDevApi } from "../scripts/dev-runtime.ts";

const underBun = { bun: "1.3.10", node: "24.3.0" };
const underNode = { node: "24.17.0" };

function selector(found: Record<string, string | undefined>) {
  const calls: string[] = [];
  return {
    calls,
    findBinary: (name: string) => {
      calls.push(name);
      return found[name];
    },
  };
}

test("no preference means bun, run from the script's own runtime when that already is bun", () => {
  const { findBinary, calls } = selector({});
  const chosen = resolveDevApi({
    env: {},
    execPath: "/opt/bun/bin/bun",
    versions: underBun,
    findBinary,
  });

  assert.deepEqual(chosen, { runtime: "bun", binary: "/opt/bun/bin/bun" });
  assert.deepEqual(calls, [], "the parent bun binary is reused instead of searched for");
});

test("no preference under node resolves bun from PATH", () => {
  const { findBinary, calls } = selector({ bun: "/tmp/bin/bun" });
  const chosen = resolveDevApi({
    env: {},
    execPath: "/usr/local/bin/node",
    versions: underNode,
    findBinary,
  });

  assert.deepEqual(chosen, { runtime: "bun", binary: "/tmp/bin/bun" });
  assert.deepEqual(calls, ["bun"]);
});

test("ARTIFLOW_DEV_RUNTIME=node falls back to node resolved from PATH when the parent runs bun", () => {
  const { findBinary, calls } = selector({ node: "/tmp/bin/node" });
  const chosen = resolveDevApi({
    env: { ARTIFLOW_DEV_RUNTIME: "node" },
    execPath: "/opt/bun/bin/bun",
    versions: underBun,
    findBinary,
  });

  assert.deepEqual(chosen, { runtime: "node", binary: "/tmp/bin/node" });
  assert.deepEqual(calls, ["node"]);
});

test("ARTIFLOW_DEV_RUNTIME=node keeps the parent node binary when already running node", () => {
  const { findBinary, calls } = selector({});
  const chosen = resolveDevApi({
    env: { ARTIFLOW_DEV_RUNTIME: " node " },
    execPath: "/usr/local/bin/node",
    versions: underNode,
    findBinary,
  });

  assert.deepEqual(chosen, { runtime: "node", binary: "/usr/local/bin/node" });
  assert.deepEqual(calls, []);
});

test("an unsupported preference is refused before anything starts", () => {
  const { findBinary } = selector({});
  assert.throws(
    () =>
      resolveDevApi({
        env: { ARTIFLOW_DEV_RUNTIME: "deno" },
        execPath: "/opt/bun/bin/bun",
        versions: underBun,
        findBinary,
      }),
    (error: Error) => error.message.includes('ARTIFLOW_DEV_RUNTIME="deno"') && error.message.includes("bun, node"),
  );
});

test("a missing bun is refused with the declared node fallback", () => {
  const { findBinary } = selector({});
  assert.throws(
    () =>
      resolveDevApi({
        env: {},
        execPath: "/usr/local/bin/node",
        versions: underNode,
        findBinary,
      }),
    (error: Error) => error.message.includes("ARTIFLOW_DEV_RUNTIME=node"),
  );
});

test("findExecutable resolves a real binary from PATH and reports a missing one as undefined", () => {
  const bun = findExecutable("bun", process.env);
  assert.equal(typeof bun, "string");
  assert.equal(existsSync(bun as string), true);
  assert.equal(findExecutable("artiflow-definitely-not-a-binary", process.env), undefined);
});
