#!/usr/bin/env node
import { missingIntegrationEnv, readIntegrationEnvNames } from "./integration-env.mjs";

const usage = `usage: node --env-file=test/integration-config.example scripts/wait-integration-services.mjs [--timeout-ms N] [--interval-ms N]

Waits until the disposable database answers SELECT 1 and the configured bucket
answers HeadBucket. Exits 1 when a required variable is missing or the deadline
passes. Does not create a bucket or a role.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { timeoutMs: 90_000, intervalMs: 1_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true, ...options };
    if (arg !== "--timeout-ms" && arg !== "--interval-ms") {
      throw new UsageError(`integration services: unknown option ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
      throw new UsageError(`integration services: ${arg} must be a positive integer`);
    }
    if (arg === "--timeout-ms") options.timeoutMs = Number(value);
    else options.intervalMs = Number(value);
    index += 1;
  }
  return { help: false, ...options };
}

function describe(error, secrets) {
  let message = error instanceof Error ? error.message : String(error);
  if (!message) message = error instanceof Error ? error.name : "unknown error";
  for (const secret of secrets) {
    if (secret.length > 0) message = message.split(secret).join("[redacted]");
  }
  return message.slice(0, 300);
}

function databasePassword(connectionString) {
  try {
    return new URL(connectionString).password;
  } catch {
    return "";
  }
}

async function probeDatabase(createDatabase, connectionString) {
  const database = createDatabase(connectionString);
  try {
    await database.check();
  } finally {
    await database.close().catch(() => undefined);
  }
}

async function probeBucket(createStorage, storage) {
  const client = createStorage(storage);
  try {
    await client.checkBucket();
  } finally {
    client.destroy();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    return 2;
  }
  if (options.help) {
    console.log(usage);
    return 0;
  }

  const missing = missingIntegrationEnv(process.env, readIntegrationEnvNames());
  if (missing.length > 0) {
    console.error(`integration services: missing required environment: ${missing.join(", ")}`);
    return 1;
  }

  const { loadConfig, ConfigError } = await import("../apps/api/src/config.ts");
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    const message =
      error instanceof ConfigError ? error.message : error instanceof Error ? error.message : String(error);
    console.error(`integration services: ${message}`);
    return 1;
  }

  const secrets = [databasePassword(config.databaseUrl), config.storage.secretAccessKey, config.authSecret].filter(
    (value) => value.length > 0,
  );
  const { createDatabase } = await import("../apps/api/src/adapters/postgres/db/client.ts");
  const { createStorage } = await import("../apps/api/src/adapters/storage/client.ts");
  const deadline = Date.now() + options.timeoutMs;
  let databaseError = "not attempted";
  let storageError = "not attempted";

  while (true) {
    try {
      await probeDatabase(createDatabase, config.databaseUrl);
      databaseError = "";
    } catch (error) {
      databaseError = describe(error, secrets);
    }
    try {
      await probeBucket(createStorage, config.storage);
      storageError = "";
    } catch (error) {
      storageError = describe(error, secrets);
    }
    if (databaseError === "" && storageError === "") {
      console.log("integration services: database ok, bucket ok");
      return 0;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(options.intervalMs, Math.max(deadline - Date.now(), 0)));
  }

  console.error("integration services: database or bucket did not become ready");
  if (databaseError) console.error(`integration services: database: ${databaseError}`);
  if (storageError) console.error(`integration services: storage: ${storageError}`);
  return 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
