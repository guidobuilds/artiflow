import assert from "node:assert/strict";
import { mock, test } from "node:test";

import {
  REVISION_GC_GRACE_MS,
  REVISION_GC_INTERVAL_MS,
  REVISION_GC_STARTUP_DELAY_MS,
  startRevisionGcLoop,
  type RevisionSweepResult,
} from "../apps/api/src/domain/gc.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";

const DAY_MS = 24 * 60 * 60_000;
type SweepCall = { at: number };
const database = {} as Database;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};
const emptySweep = (): RevisionSweepResult => ({
  examined: 0,
  candidates: 0,
  deleted: 0,
  failed: 0,
  listFailed: false,
});

const fakeSweep = (calls: SweepCall[], behavior?: (call: number) => Promise<RevisionSweepResult>) => {
  let index = 0;
  return async (): Promise<RevisionSweepResult> => {
    index += 1;
    calls.push({ at: Date.now() });
    return behavior ? behavior(index) : emptySweep();
  };
};

test("the cadence is one run per day and the grace window is one day", () => {
  assert.equal(REVISION_GC_INTERVAL_MS, DAY_MS, "the orphan sweep runs at most once a day");
  assert.equal(REVISION_GC_GRACE_MS, DAY_MS, "an object younger than a day is never a candidate");
  assert.equal(REVISION_GC_STARTUP_DELAY_MS > 0 && REVISION_GC_STARTUP_DELAY_MS < REVISION_GC_INTERVAL_MS, true);
});

test("the revision gc loop sweeps once shortly after start and then on its interval, and stop() ends both", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const calls: SweepCall[] = [];
    const loop = startRevisionGcLoop({
      database,
      storage: {} as never,
      sweepFn: fakeSweep(calls),
    });
    assert.deepEqual(calls, [], "nothing runs before the startup delay");
    mock.timers.tick(REVISION_GC_STARTUP_DELAY_MS);
    await flush();
    assert.equal(calls.length, 1, "one sweep shortly after start");
    mock.timers.tick(REVISION_GC_INTERVAL_MS);
    await flush();
    assert.equal(calls.length, 2, "the interval fires the next sweep");
    loop.stop();
    mock.timers.tick(REVISION_GC_INTERVAL_MS * 5);
    await flush();
    assert.equal(calls.length, 2, "stop() clears both timers");
  } finally {
    mock.timers.reset();
  }
});

test("a pending revision sweep never overlaps itself", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const calls: SweepCall[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = startRevisionGcLoop({
      database,
      storage: {} as never,
      sweepFn: fakeSweep(calls, async () => {
        await gate;
        return emptySweep();
      }),
    });
    mock.timers.tick(REVISION_GC_STARTUP_DELAY_MS);
    await flush();
    assert.equal(calls.length, 1, "the startup sweep is pending");
    mock.timers.tick(REVISION_GC_INTERVAL_MS);
    mock.timers.tick(REVISION_GC_INTERVAL_MS * 2);
    await flush();
    assert.equal(calls.length, 1, "interval ticks while a sweep is pending do not start another");
    release?.();
    await gate;
    await flush();
    loop.stop();
  } finally {
    mock.timers.reset();
  }
});

test("a throwing revision sweep is logged and never breaks the loop", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const calls: SweepCall[] = [];
    const lines: string[] = [];
    const loop = startRevisionGcLoop({
      database,
      storage: {} as never,
      sweepFn: fakeSweep(calls, async (call) => {
        if (call === 1) throw new Error("injected sweep crash");
        return { examined: 5, candidates: 2, deleted: 2, failed: 0, listFailed: false };
      }),
      log: (line) => lines.push(line),
    });
    mock.timers.tick(REVISION_GC_STARTUP_DELAY_MS);
    await flush();
    assert.match(lines[0] ?? "", /\[revision-gc\] sweep failed/, "the crash is logged, not raised");
    mock.timers.tick(REVISION_GC_INTERVAL_MS);
    await flush();
    assert.equal(calls.length, 2, "the loop survives the crash");
    assert.match(
      lines[1] ?? "",
      /^\[revision-gc\] examined=5 candidates=2 deleted=2 failed=0/,
      "the next run logs its counts",
    );
    loop.stop();
  } finally {
    mock.timers.reset();
  }
});
