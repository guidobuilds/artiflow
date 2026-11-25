import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const integrationConfigExample = path.join(repoRoot, "test/integration-config.example");

export function integrationEnvNames(text) {
  const names = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const name = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function missingIntegrationEnv(env, names) {
  return names.filter((name) => (env[name] ?? "").trim() === "");
}

export function readIntegrationEnvNames(file = integrationConfigExample) {
  const names = integrationEnvNames(readFileSync(file, "utf8"));
  if (names.length === 0) {
    throw new Error(`integration: ${file} declares no variables`);
  }
  return names;
}

export function readsIntegrationEnv(source, names) {
  return names.some((name) => name !== "NODE_ENV" && new RegExp(`\\b${name}\\b`).test(source));
}

export function integrationTestFiles(root = repoRoot, names = readIntegrationEnvNames()) {
  const testDir = path.join(root, "test");
  const files = readdirSync(testDir).sort();
  const gatedUnits = files.filter(
    (file) => file.endsWith(".test.ts") && readsIntegrationEnv(readFileSync(path.join(testDir, file), "utf8"), names),
  );
  const suites = files.filter((file) => file.endsWith(".integration.ts"));
  return [...gatedUnits, ...suites].map((file) => path.join("test", file));
}
