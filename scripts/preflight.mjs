#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";

const MINIMUM_NODE_MAJOR = 24;
const major = Number(process.versions.node.split(".")[0]);

if (!Number.isFinite(major) || major < MINIMUM_NODE_MAJOR) {
  console.error(`Artiflow requires Node ${MINIMUM_NODE_MAJOR} or newer; this process is ${process.versions.node}.`);
  console.error("Use the version in .nvmrc (`nvm use`) and run `bun install --frozen-lockfile` again.");
  process.exit(1);
}

const pluginSources = path.join(process.cwd(), "plugins", "opencode", "package.json");
const pluginModules = path.join(process.cwd(), "node_modules");
if (!existsSync(pluginSources) || !existsSync(pluginModules)) {
  console.error("The OpenCode plugin workspace dependencies are missing.");
  console.error("Run `bun install --frozen-lockfile` (or `bun run setup:plugin`), then retry.");
  process.exit(1);
}
