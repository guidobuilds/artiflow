import { serve } from "@hono/node-server";

import { startRevisionGcLoop, startStagingGcLoop } from "./domain/gc.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { emailPasswordEnabled } from "./auth.ts";
import { createDatabase } from "./adapters/postgres/db/client.ts";
import { createApiApp } from "./app.ts";
import { createStorage } from "./adapters/storage/client.ts";
import { seedAccessMethods } from "./settings/seed.ts";

function readConfig() {
  try {
    return loadConfig(process.env);
  } catch (error) {
    const reason = error instanceof ConfigError ? error.message : "unexpected configuration failure";
    console.error(`[api] configuration error: ${reason}`);
    process.exit(1);
  }
}

const config = readConfig();
const database = createDatabase(config.databaseUrl);
const storage = createStorage(config.storage);

await database.check();
try {
  await seedAccessMethods({ db: database.db, config });
} catch (error) {
  const reason = error instanceof Error ? error.message : "unexpected seed failure";
  console.error(`[api] access configuration seed failed: ${reason}`);
  await database.close().catch(() => undefined);
  process.exit(1);
}

const app = createApiApp({ config, database, storage });

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.apiHost,
    port: config.apiPort,
  },
  (info) => {
    console.log(`[api] listening on http://${config.apiHost}:${info.port}`);
    console.log(`[api] public origin ${config.publicOrigin}`);
    console.log(
      emailPasswordEnabled(config)
        ? `[api] email/password auth enabled (login at /api/auth/*, public sign-up closed${config.nodeEnv === "production" ? "; production profile" : "; development loopback demo profile"})`
        : "[api] email/password auth disabled (requires production, or development with ARTIFLOW_DEMO_AUTH=1 and a loopback origin)",
    );
  },
);

const stagingGc = startStagingGcLoop({ database, storage });
const revisionGc = startRevisionGcLoop({ database, storage });

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[api] ${signal} received, shutting down`);

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  stagingGc.stop();
  revisionGc.stop();
  await database.close().catch((error: unknown) => {
    console.error(`[api] database pool shutdown failed: ${error instanceof Error ? error.name : "unknown error"}`);
  });
  storage.destroy();
  process.exitCode = 0;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
