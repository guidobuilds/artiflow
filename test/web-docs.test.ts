import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const webRoot = path.join(repoRoot, "apps/web");
const contentRoot = path.join(webRoot, "src/content/docs");

function readJson(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, ...segments), "utf8")) as Record<string, unknown>;
}

function webFile(...segments: string[]): string {
  const file = path.join(webRoot, ...segments);
  assert.ok(existsSync(file), `missing ${path.relative(repoRoot, file)}`);
  return readFileSync(file, "utf8");
}

function scripts(pkg: Record<string, unknown>): Record<string, string> {
  return (pkg.scripts ?? {}) as Record<string, string>;
}

function dependencies(pkg: Record<string, unknown>, field: string): Record<string, string> {
  return (pkg[field] ?? {}) as Record<string, string>;
}

function configKeys(source: string): string[] {
  return [...source.matchAll(/^ {2}([A-Za-z]+):/gm)].map((match) => match[1] as string);
}

function markdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(full));
    else if (/\.(md|mdx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function resolvesToPage(url: string): boolean {
  const slug = url.replace(/^\/docs\/?/, "").replace(/\/$/, "");
  const base = path.join(contentRoot, "docs", slug);
  return (
    [".md", ".mdx"].some((ext) => existsSync(base + ext)) ||
    [".md", ".mdx"].some((ext) => existsSync(path.join(base, "index" + ext)))
  );
}

function linkTargets(file: string): string[] {
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  return [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1] as string);
}

test("root scripts delegate to the web workspace without replacing the dashboard entry points", () => {
  const scriptsUnderTest = scripts(readJson("package.json"));

  for (const [script, target] of [
    ["web:dev", "dev"],
    ["web:build", "build"],
    ["web:check", "check"],
  ] as const) {
    assert.equal(scriptsUnderTest[script], `bun run --filter '@artiflow/web' ${target}`, script);
  }

  assert.equal(
    scriptsUnderTest["web:verify"],
    "bun run web:check && bun run web:build && bun run --filter '@artiflow/web' verify",
  );

  assert.equal(scriptsUnderTest["dev:web"], "vite --config apps/dashboard/vite.config.ts");
  assert.equal(
    scriptsUnderTest.build,
    "bun run check:docs && bun run check:boundaries && bun run check:comments && bun run check:effects && vite build --config apps/dashboard/vite.config.ts && tsc -p tsconfig.api.json --noEmit",
  );
  assert.equal(scriptsUnderTest.test, "node --test test/*.test.ts");
});

test("the web workspace declares the docs toolchain and no server adapter", () => {
  const pkg = readJson("apps/web/package.json");

  assert.equal(pkg.name, "@artiflow/web");
  assert.equal(pkg.private, true);
  const declared = scripts(pkg);
  for (const script of ["dev", "build", "preview", "check"]) {
    assert.equal(typeof declared[script], "string", script);
  }
  assert.equal(declared.verify, "node scripts/check-built.mjs && node scripts/check-reference.mjs");
  const runtime = dependencies(pkg, "dependencies");
  assert.match(runtime.astro ?? "", /^[\^~]?\d/);
  assert.match(runtime["@astrojs/starlight"] ?? "", /^[\^~]?\d/);
  assert.equal(typeof dependencies(pkg, "devDependencies")["@astrojs/check"], "string");
  assert.deepEqual(
    Object.keys(runtime).filter((name) => name.startsWith("@astrojs/") && name !== "@astrojs/starlight"),
    [],
  );
});

test("astro config publishes the site at artiflow.dev with no global base path", () => {
  const source = webFile("astro.config.mjs");

  assert.match(source, /site:\s*["']https:\/\/artiflow\.dev["']/);
  const keys = configKeys(source);
  assert.ok(keys.includes("integrations"), keys.join(","));
  assert.ok(!keys.includes("base"), "the docs mount must not use a global Astro base");
  assert.ok(!keys.includes("adapter"), "static output only");
  assert.match(source, /starlight\(\{/);
});

test("starlight sidebar, css and content collection resolve to files that exist", () => {
  const config = webFile("astro.config.mjs");
  const customCss = config.match(/customCss:\s*\[([^\]]*)\]/);
  assert.ok(customCss?.[1], "customCss lists the Artiflow stylesheet");
  for (const match of (customCss[1] as string).matchAll(/["']([^"']+)["']/g)) {
    const target = path.resolve(webRoot, match[1] as string);
    assert.ok(existsSync(target), `customCss target ${match[1]}`);
  }
  assert.match(config, /^\s+sidebar,$/m, "starlight receives the exported sidebar");

  const collection = webFile("src/content.config.ts");
  assert.match(collection, /docsLoader/);
  assert.match(collection, /docsSchema/);
  assert.match(collection, /docs:\s*defineCollection/);
});

type SidebarEntry = { label?: string; link?: string; autogenerate?: { directory: string }; items?: SidebarEntry[] };

const sidebarLabels = [
  "Start here",
  "Connect tools",
  "Concepts",
  "Artifact types",
  "Guides",
  "Reference",
  "Self-hosting",
  "Contribute",
];

test("the sidebar groups every docs section in reading order under /docs", async () => {
  const config = (await import(pathToFileURL(path.join(webRoot, "astro.config.mjs")).href)) as {
    sidebar?: SidebarEntry[];
  };
  const sidebar = config.sidebar ?? [];

  assert.deepEqual(
    sidebar.map((group) => group.label),
    sidebarLabels,
  );

  const invalid: string[] = [];
  const directories: string[] = [];
  const links: string[] = [];
  for (const group of sidebar) {
    const items = group.items ?? [];
    if (group.autogenerate !== undefined) invalid.push(`${group.label}: autogenerate needs a labelled group`);
    if (items.length === 0) invalid.push(`${group.label}: empty group`);
    for (const item of items) {
      if (item.items !== undefined) invalid.push(`${group.label}: nested groups are not used`);
      else if (item.autogenerate !== undefined) {
        if (item.label !== undefined || item.link !== undefined) {
          invalid.push(`${group.label}: autogenerate mixed with label or link`);
        }
        directories.push(item.autogenerate.directory);
      } else if (item.link !== undefined) links.push(item.link);
      else invalid.push(`${group.label}: entry needs a link or an autogenerate object`);
    }
  }
  assert.deepEqual(invalid, []);

  const sections = readdirSync(path.join(contentRoot, "docs"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `docs/${entry.name}`)
    .sort();
  assert.deepEqual([...directories].sort(), sections, "each authored section is autogenerated once");
  assert.equal(new Set(directories).size, directories.length, "no section is autogenerated twice");

  for (const directory of directories) {
    assert.ok(directory.startsWith("docs/"), `${directory} stays under the /docs route`);
    const dir = path.join(contentRoot, directory);
    assert.ok(existsSync(dir), `${directory} exists in the content collection`);
    assert.ok(markdownFiles(dir).length > 0, `${directory} has authored pages`);
  }

  assert.ok(links.length > 0, "the docs home is reachable from the sidebar");
  for (const link of links) {
    assert.ok(link.startsWith("/docs/"), `${link} stays under /docs`);
    assert.ok(resolvesToPage(link), `${link} resolves to an authored page`);
  }
});

test("the docs home is served at /docs and every docs link resolves to a real page", () => {
  const pages = markdownFiles(contentRoot);
  const home = path.join(contentRoot, "docs/index.md");
  assert.ok(pages.includes(home), "docs content lives under src/content/docs/docs so its route is /docs/");
  const frontmatter = readFileSync(home, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  assert.match(frontmatter, /^title: \S/m, "docs home needs a title");
  assert.match(frontmatter, /^description: \S/m, "docs home needs a description");

  const broken: string[] = [];
  for (const file of pages) {
    for (const target of linkTargets(file)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
      const url = target.split("#")[0] as string;
      if (!url.startsWith("/docs/") || !resolvesToPage(url)) {
        broken.push(`${path.relative(repoRoot, file)}: ${target}`);
      }
    }
  }
  assert.deepEqual(broken, [], "internal docs links are absolute /docs/ routes that resolve to an authored page");
});

test("the site root renders the landing page and links into the docs", () => {
  const page = webFile("src/pages/index.astro");

  assert.doesNotMatch(page, /Astro\.redirect\(/, "the root is a page, not a redirect");
  assert.match(page, /href="\/docs\/"/, "the landing links to the docs home");
  const docsLinks = [...page.matchAll(/["'](\/docs\/[^"'#]*)["']/g)].map((match) => match[1] as string);
  assert.ok(docsLinks.length > 0);
  for (const link of docsLinks) {
    assert.ok(resolvesToPage(link), `${link} resolves to an authored page`);
  }
});
