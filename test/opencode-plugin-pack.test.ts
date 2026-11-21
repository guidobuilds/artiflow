import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { skillFilePath } from "../plugins/opencode/src/skill-files.ts";

const run = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("../plugins/opencode", import.meta.url));
const skillsDirectory = fileURLToPath(new URL("../skills", import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as {
  exports: Record<string, string>;
  files: string[];
};

const SKILLS = ["creating-artifacts", "using-artiflow", "opencode-large-artifacts"];

before(async () => {
  const bundle = (name: string) => existsSync(join(packageDirectory, "dist", name));
  if (!bundle("server.mjs") || !bundle("gui-experimental.cjs")) {
    await run("npm", ["run", "build"], { cwd: packageDirectory });
    await run("npm", ["run", "build:server"], { cwd: packageDirectory });
  }
});

async function packLayout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "artiflow-pack-"));
  await mkdir(join(root, "plugins"), { recursive: true });
  await cp(packageDirectory, join(root, "plugins/opencode"), {
    recursive: true,
    filter: (source) => !source.includes("node_modules"),
  });
  await cp(skillsDirectory, join(root, "skills"), { recursive: true });
  return root;
}

async function installLayout(root: string): Promise<string> {
  const site = join(root, "site");
  const installed = join(site, "node_modules/artiflow-opencode-plugin");
  await mkdir(installed, { recursive: true });
  await cp(join(root, "plugins/opencode/package.json"), join(installed, "package.json"));
  for (const entry of manifest.files)
    await cp(join(root, "plugins/opencode", entry), join(installed, entry), { recursive: true });
  return installed;
}

test("the tarball manifest ships the plugin-scoped skills", () => {
  assert.ok(manifest.files.includes("skills"), "the packaged files must include the plugin skills");
  assert.equal(existsSync(join(skillsDirectory, "using-artiflow", "SKILL.md")), true);
});

test("a packed install resolves the plugin-scoped skills and both export entries", async () => {
  const root = await packLayout();
  const installed = join(root, "site/node_modules/artiflow-opencode-plugin");
  try {
    await installLayout(root);
    for (const [name, target] of Object.entries(manifest.exports))
      assert.ok(existsSync(join(installed, target)), `export ${name} is missing from the packed files`);
    for (const name of SKILLS) {
      const path = skillFilePath(join(installed, "src/index.ts"), name);
      assert.equal(path, join(installed, "skills", name, "SKILL.md"));
      assert.ok(
        readFileSync(path).equals(readFileSync(join(packageDirectory, "skills", name, "SKILL.md"))),
        `${name} was not packed from the plugin package`,
      );
    }
    for (const name of ["creating-artifacts", "using-artiflow"])
      assert.ok(
        !readFileSync(join(installed, "skills", name, "SKILL.md")).equals(
          readFileSync(join(skillsDirectory, name, "SKILL.md")),
        ),
        `${name} shipped the repository MCP skill instead of the plugin adaptation`,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the prepack guard accepts the plugin-scoped skills", async () => {
  const root = await packLayout();
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [join(root, "plugins/opencode/scripts/pack-plugin.mjs"), "verify"],
      { cwd: join(root, "plugins/opencode") },
    );
    assert.equal(stdout.trim(), "");
    assert.equal(stderr.trim(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the prepack guard refuses a skill that reintroduces the MCP surface", async () => {
  const root = await packLayout();
  try {
    const target = join(root, "plugins/opencode/skills/creating-artifacts/SKILL.md");
    await appendFile(target, "\nCall `artifact_write` for small payloads.\n");
    await assert.rejects(
      run(process.execPath, [join(root, "plugins/opencode/scripts/pack-plugin.mjs"), "verify"], {
        cwd: join(root, "plugins/opencode"),
      }),
      /plugin skill creating-artifacts is not plugin-scoped/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
