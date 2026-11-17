import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { skillFilePath } from "../plugins/opencode/src/skill-files.ts";

const entry = new URL("../plugins/opencode/src/index.ts", import.meta.url);
const packageRoot = fileURLToPath(new URL("../plugins/opencode", import.meta.url));
const rootSkill = (name: string) => new URL(`../skills/${name}/SKILL.md`, import.meta.url);

for (const name of ["creating-artifacts", "using-artiflow"])
  test(`bundled ${name} resolves from the plugin package root and is byte-identical to the root skill`, () => {
    const path = skillFilePath(entry, name);
    assert.ok(
      path === join(packageRoot, "skills", name, "SKILL.md") || path === fileURLToPath(rootSkill(name)),
      `${path} is neither the package-local nor the repository-root skill`,
    );
    assert.ok(existsSync(path));
    assert.ok(readFileSync(path).equals(readFileSync(rootSkill(name))));
    assert.equal(skillFilePath(fileURLToPath(entry), name), path);
  });

async function temporaryLayout(local: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "artiflow-skills-layout-"));
  const module = join(root, "plugins/opencode/src/index.ts");
  await mkdir(dirname(module), { recursive: true });
  await writeFile(module, "");
  await writeFile(join(root, "plugins/opencode/package.json"), "{}");
  await mkdir(join(root, "skills/using-artiflow"), { recursive: true });
  await writeFile(join(root, "skills/using-artiflow/SKILL.md"), "# repository root skill\n");
  if (local) {
    const staged = join(root, "plugins/opencode/skills/using-artiflow");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "SKILL.md"), readFileSync(rootSkill("using-artiflow")));
  }
  return root;
}

test("a package-local skill ships with the tarball and wins over the repository root", async () => {
  const root = await temporaryLayout(true);
  try {
    const path = skillFilePath(join(root, "plugins/opencode/src/index.ts"), "using-artiflow");
    assert.equal(path, join(root, "plugins/opencode/skills/using-artiflow/SKILL.md"));
    assert.ok(readFileSync(path).equals(readFileSync(rootSkill("using-artiflow"))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a package without skills falls back to the repository root layout", async () => {
  const root = await temporaryLayout(false);
  try {
    const path = skillFilePath(join(root, "plugins/opencode/src/index.ts"), "using-artiflow");
    assert.equal(path, join(root, "skills/using-artiflow/SKILL.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing skill file is a clear error naming both candidates", async () => {
  const root = await temporaryLayout(false);
  try {
    const packageDirectory = join(root, "plugins/opencode");
    const expected = [
      join(packageDirectory, "skills/missing-skill/SKILL.md"),
      join(root, "skills/missing-skill/SKILL.md"),
    ].join(" or ");
    assert.throws(() => skillFilePath(join(packageDirectory, "src/index.ts"), "missing-skill"), {
      message: `Artiflow skill missing-skill: expected skill file not found: ${expected}`,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
