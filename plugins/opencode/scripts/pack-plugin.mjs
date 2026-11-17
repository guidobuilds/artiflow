#!/usr/bin/env node
import { existsSync } from "node:fs";
import { cp, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = ["creating-artifacts", "using-artiflow"];
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const staged = join(packageRoot, "skills");

async function stage() {
  await clean();
  for (const name of SKILLS) {
    const source = join(repositoryRoot, "skills", name);
    if (!existsSync(join(source, "SKILL.md")))
      throw new Error(`Artiflow packaging: repository skill not found: ${join(source, "SKILL.md")}`);
    await cp(source, join(staged, name), { recursive: true });
  }
}

async function clean() {
  for (const name of SKILLS) await rm(join(staged, name), { recursive: true, force: true });
  await rmdir(staged).catch(() => {});
}

const commands = { stage, clean };
const command = process.argv[2];
if (!(command in commands)) throw new Error("Usage: pack-plugin.mjs <stage|clean>");
await commands[command]();
