import { Hono } from "hono";

export type ProbeStatus = "ok" | "error";

export type HealthDeps = {
  checkDatabase: () => Promise<void> | void;
  checkStorage: () => Promise<void> | void;
};

export type HealthBody = {
  status: "ok" | "degraded";
  checks: {
    database: ProbeStatus;
    storage: ProbeStatus;
  };
};

async function runProbe(check: () => Promise<void> | void): Promise<ProbeStatus> {
  try {
    await check();
    return "ok";
  } catch {
    return "error";
  }
}

export function createHealthApp(deps: HealthDeps) {
  const app = new Hono();

  app.get("/api/health", async (c) => {
    const [database, storage] = await Promise.all([runProbe(deps.checkDatabase), runProbe(deps.checkStorage)]);
    const ready = database === "ok" && storage === "ok";
    const body: HealthBody = {
      status: ready ? "ok" : "degraded",
      checks: { database, storage },
    };

    c.header("Cache-Control", "no-store");
    return c.json(body, ready ? 200 : 503);
  });

  return app;
}
