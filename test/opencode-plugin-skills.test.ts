import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "../plugins/opencode/src/index.ts";
import { skillFilePath } from "../plugins/opencode/src/skill-files.ts";
import { toolDefinitions } from "../plugins/opencode/src/tool-definitions.ts";

const entry = new URL("../plugins/opencode/src/index.ts", import.meta.url);
const packageRoot = fileURLToPath(new URL("../plugins/opencode", import.meta.url));
const rootSkill = (name: string) => new URL(`../skills/${name}/SKILL.md`, import.meta.url);
const pluginSkill = (name: string) => join(packageRoot, "skills", name, "SKILL.md");

const SKILLS = ["creating-artifacts", "using-artiflow", "opencode-large-artifacts"];
const NATIVE_TOOLS = [...toolDefinitions.map((definition) => `artiflow_${definition.name}`), "artiflow_viewer_url"];
const UNSERVED = [
  "artiflow_add_comment",
  "artiflow_reply_comment",
  "artiflow_resolve_comment",
  "artiflow_unresolve_comment",
  "artiflow_update_metadata",
  "artiflow_start_upload",
  "artiflow_put_chunk",
  "artiflow_commit",
];

async function withInstanceUrl(body: () => Promise<void>) {
  const saved = process.env.ARTIFLOW_URL;
  process.env.ARTIFLOW_URL = "https://artiflow.example";
  try {
    await body();
  } finally {
    if (saved === undefined) delete process.env.ARTIFLOW_URL;
    else process.env.ARTIFLOW_URL = saved;
  }
}

function harness() {
  const stored = new Map<string, unknown>();
  const skills: {
    id: string;
    name: string;
    description?: string;
    path: string;
    content: string;
  }[] = [];
  const registration = { dispose: async () => {}, events: { emit: async () => {} } };
  const ctx = {
    options: {},
    storage: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
      remove: async () => {},
      scan: async () => ({ entries: [] }),
    },
    rpc: { register: async () => registration },
    command: { transform: async () => registration },
    skill: {
      transform: async (callback: (editor: { add: (value: (typeof skills)[number]) => void }) => void) => {
        callback({ add: (value) => skills.push(value) });
        return registration;
      },
    },
    tool: {
      transform: async (
        callback: (editor: { namespace: (value: unknown) => void; add: (value: unknown) => void }) => void,
      ) => {
        callback({ namespace: () => {}, add: () => {} });
        return registration;
      },
    },
    session: { synthetic: async () => ({}) },
  };
  return { ctx, skills };
}

async function registeredSkills() {
  const { ctx, skills } = harness();
  let captured: typeof skills = [];
  await withInstanceUrl(async () => {
    ctx.skill.transform = async (callback) => {
      callback({ add: (value) => skills.push(value) });
      captured = skills;
      return { dispose: async () => {} };
    };
    await plugin.setup(ctx as never);
  });
  return captured;
}

test("the server registers one plugin-scoped skill per bundled skill directory", async () => {
  const skills = await registeredSkills();
  assert.deepEqual(
    skills.map((skill) => skill.id),
    SKILLS.map((name) => `artiflow:${name}`),
  );
  assert.deepEqual(
    skills.map((skill) => skill.name),
    SKILLS,
  );
  for (const skill of skills) {
    assert.equal(skill.path, pluginSkill(skill.name), `${skill.name} must resolve inside the plugin package`);
    assert.equal(skill.content, readFileSync(pluginSkill(skill.name), "utf8"));
    assert.equal(skill.description, skill.content.match(/^description: (.+)$/m)?.[1]);
    assert.ok(skill.description && skill.description.length > 0, `${skill.name} has no frontmatter description`);
  }
});

for (const name of SKILLS) {
  test(`registered ${name} carries no MCP instructions`, () => {
    const content = readFileSync(pluginSkill(name), "utf8");
    assert.doesNotMatch(
      content,
      /\bartifact_(write|commit|get|get_markdown|edit_lines|start_upload|put_chunk|list_comments|add_comment|reply_comment|resolve_comment|unresolve_comment|update_metadata)\b/,
      `${name} still names MCP tools`,
    );
    assert.doesNotMatch(content, /\bMCP\b/, `${name} still mentions MCP`);
    assert.doesNotMatch(content, /ui:\/\//, `${name} still points at an MCP Apps resource`);
    for (const tool of UNSERVED) assert.ok(!content.includes(tool), `${name} names unserved tool ${tool}`);
    assert.doesNotMatch(content, /staged upload/i, `${name} still describes the staged upload flow`);
  });

  test(`registered ${name} only names tools the plugin actually exposes`, () => {
    const content = readFileSync(pluginSkill(name), "utf8");
    const named = [...content.matchAll(/artiflow_[a-z][a-z_]*/g)].map((match) => match[0]);
    assert.ok(named.length > 0, `${name} names no native tool`);
    assert.deepEqual(
      [...new Set(named)].filter((tool) => !NATIVE_TOOLS.includes(tool)),
      [],
      `${name} names a tool the plugin does not expose`,
    );
  });
}

for (const [name, expected] of [
  ["creating-artifacts", NATIVE_TOOLS],
  ["using-artiflow", NATIVE_TOOLS],
  ["opencode-large-artifacts", ["artiflow_write", "artiflow_write_file", "artiflow_viewer_url"]],
] as const)
  test(`registered ${name} documents its native tools`, () => {
    const content = readFileSync(pluginSkill(name), "utf8");
    for (const tool of expected) assert.ok(content.includes(tool), `${name} does not name ${tool}`);
  });

test("the canonical root skills keep their MCP-consumer content untouched", () => {
  for (const name of ["creating-artifacts", "using-artiflow"]) {
    const canonical = readFileSync(rootSkill(name), "utf8");
    for (const marker of [
      "artifact_get",
      "artifact_get_markdown",
      "artifact_edit_lines",
      "artifact_start_upload",
      "artifact_put_chunk",
      "artifact_commit",
    ])
      assert.ok(canonical.includes(marker), `root skill ${name} lost its MCP consumer content: ${marker}`);
    assert.notEqual(canonical, readFileSync(pluginSkill(name), "utf8"), `${name} is a plugin-scoped adaptation`);
    assert.match(canonical, /\bMCP\b/, `root skill ${name} is still written for MCP consumers`);
  }
  assert.match(
    readFileSync(rootSkill("creating-artifacts"), "utf8"),
    /ui:\/\/artiflow\/artifact-viewer/,
    "the canonical creation skill keeps its MCP Apps resource",
  );
});

for (const name of ["creating-artifacts", "using-artiflow"])
  test(`the plugin package resolves ${name} without reaching for the repository skills`, () => {
    const path = skillFilePath(entry, name);
    assert.equal(path, join(packageRoot, "skills", name, "SKILL.md"));
    assert.equal(skillFilePath(fileURLToPath(entry), name), path);
    assert.ok(existsSync(path));
    assert.ok(!readFileSync(path).equals(readFileSync(rootSkill(name))));
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
    await writeFile(join(staged, "SKILL.md"), readFileSync(pluginSkill("using-artiflow")));
  }
  return root;
}

test("a package-local skill ships with the tarball and is the only resolved source", async () => {
  const root = await temporaryLayout(true);
  try {
    const path = skillFilePath(join(root, "plugins/opencode/src/index.ts"), "using-artiflow");
    assert.equal(path, join(root, "plugins/opencode/skills/using-artiflow/SKILL.md"));
    assert.ok(readFileSync(path).equals(readFileSync(pluginSkill("using-artiflow"))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a package without its own skill file never falls back to the repository root skills", async () => {
  const root = await temporaryLayout(false);
  try {
    const packageDirectory = join(root, "plugins/opencode");
    assert.throws(() => skillFilePath(join(packageDirectory, "src/index.ts"), "using-artiflow"), {
      message: `Artiflow skill using-artiflow: expected plugin skill file not found: ${join(packageDirectory, "skills/using-artiflow/SKILL.md")}`,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing skill file is a clear error naming its plugin path", async () => {
  const root = await temporaryLayout(false);
  try {
    const packageDirectory = join(root, "plugins/opencode");
    assert.throws(() => skillFilePath(join(packageDirectory, "src/index.ts"), "missing-skill"), {
      message: `Artiflow skill missing-skill: expected plugin skill file not found: ${join(packageDirectory, "skills/missing-skill/SKILL.md")}`,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
