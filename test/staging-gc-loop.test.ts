import assert from "node:assert/strict";
import { mock, test } from "node:test";

import {
  startStagingGcLoop,
  STAGING_GC_INTERVAL_MS,
  STAGING_GC_STARTUP_DELAY_MS,
  type StagingSweepResult,
} from "../apps/api/src/domain/gc.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";

type SweepCall = { at: number };
const database = {} as Database;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

const fakeSweep = (calls: SweepCall[], behavior?: (call: number) => Promise<StagingSweepResult>) => {
  let index = 0;
  return async (): Promise<StagingSweepResult> => {
    index += 1;
    calls.push({ at: Date.now() });
    return behavior ? behavior(index) : { expiredUploads: 0, candidates: 0, deleted: 0, failed: 0 };
  };
};

test("the gc loop sweeps once shortly after start and then on its interval, and stop() ends both", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const calls: SweepCall[] = [];
    const loop = startStagingGcLoop({
      database,
      storage: {} as never,
      sweepFn: fakeSweep(calls),
    });
    assert.deepEqual(calls, [], "nothing runs before the startup delay");
    mock.timers.tick(STAGING_GC_STARTUP_DELAY_MS);
    await flush();
    assert.equal(calls.length, 1, "one sweep shortly after start");
    mock.timers.tick(STAGING_GC_INTERVAL_MS);
    await flush();
    assert.equal(calls.length, 2, "the interval fires the next sweep");
    loop.stop();
    mock.timers.tick(STAGING_GC_INTERVAL_MS * 5);
    await flush();
    assert.equal(calls.length, 2, "stop() clears the interval");
  } finally {
    mock.timers.reset();
  }
});

test("a pending sweep never overlaps itself", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const calls: SweepCall[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = startStagingGcLoop({
      database,
      storage: {} as never,
      sweepFn: fakeSweep(calls, async () => {
        await gate;
        return { expiredUploads: 0, candidates: 0, deleted: 0, failed: 0 };
      }),
    });
    mock.timers.tick(STAGING_GC_STARTUP_DELAY_MS);
    await flush();
    assert.equal(calls.length, 1, "the startup sweep is pending");
    mock.timers.tick(STAGING_GC_INTERVAL_MS);
    mock.timers.tick(STAGING_GC_INTERVAL_MS * 2);
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

test("a throwing sweep is logged and never breaks the loop", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const calls: SweepCall[] = [];
    const lines: string[] = [];
    const loop = startStagingGcLoop({
      database,
      storage: {} as never,
      sweepFn: fakeSweep(calls, async (call) => {
        if (call === 1) throw new Error("injected sweep crash");
        return { expiredUploads: 2, candidates: 3, deleted: 3, failed: 0 };
      }),
      log: (line) => lines.push(line),
    });
    mock.timers.tick(STAGING_GC_STARTUP_DELAY_MS);
    await flush();
    assert.match(lines[0] ?? "", /sweep failed/, "the crash is logged, not raised");
    mock.timers.tick(STAGING_GC_INTERVAL_MS);
    await flush();
    assert.equal(calls.length, 2, "the loop survives the crash");
    assert.match(lines[1] ?? "", /expiredUploads=2/, "the next sweep logs its counts");
    loop.stop();
  } finally {
    mock.timers.reset();
  }
});
