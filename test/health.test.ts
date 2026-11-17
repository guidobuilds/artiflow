import assert from "node:assert/strict";
import test from "node:test";

import { createHealthApp } from "../apps/api/src/routes/health.ts";

type Probe = () => Promise<void>;

function probes(options: { database?: Probe; storage?: Probe; calls?: { database: number; storage: number } }) {
  const calls = options.calls ?? { database: 0, storage: 0 };
  return {
    calls,
    checkDatabase: async () => {
      calls.database += 1;
      if (options.database) await options.database();
    },
    checkStorage: async () => {
      calls.storage += 1;
      if (options.storage) await options.storage();
    },
  };
}

test("reports healthy only after both real probes succeed", async () => {
  const deps = probes({});
  const app = createHealthApp(deps);

  const response = await app.request("/api/health");
  const body = (await response.json()) as {
    status: string;
    checks: { database: string; storage: string };
  };

  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.deepEqual(body.checks, { database: "ok", storage: "ok" });
  assert.deepEqual(deps.calls, { database: 1, storage: 1 });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("returns 503 when PostgreSQL is not ready", async () => {
  const deps = probes({
    database: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    },
  });
  const app = createHealthApp(deps);

  const response = await app.request("/api/health");
  const body = (await response.json()) as {
    status: string;
    checks: { database: string; storage: string };
  };

  assert.equal(response.status, 503);
  assert.equal(body.status, "degraded");
  assert.deepEqual(body.checks, { database: "error", storage: "ok" });
  assert.deepEqual(deps.calls, { database: 1, storage: 1 });
});

test("returns 503 when the private bucket probe fails and redacts details", async () => {
  const secretDetail = "HeadBucket failed for postgres://artiflow:local-db-secret@127.0.0.1";
  const deps = probes({
    storage: async () => {
      throw new Error(secretDetail);
    },
  });
  const app = createHealthApp(deps);

  const response = await app.request("/api/health");
  const raw = await response.text();
  const body = JSON.parse(raw) as {
    status: string;
    checks: { database: string; storage: string };
  };

  assert.equal(response.status, 503);
  assert.equal(body.status, "degraded");
  assert.deepEqual(body.checks, { database: "ok", storage: "error" });
  assert.ok(!raw.includes("local-db-secret"));
  assert.ok(!raw.includes("postgres://"));
});
