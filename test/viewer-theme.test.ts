import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  NOT_FOUND_PAGE,
  THEME_BOOTSTRAP,
  VIEWER_TOKENS,
  WRAPPER_CSP,
  wrapperPage,
} from "../apps/api/src/viewer/html.ts";
import { markdownViewerPage } from "../apps/api/src/viewer/markdown.ts";

const tokensCss = readFileSync(new URL("../apps/dashboard/src/styles/tokens.css", import.meta.url), "utf8");

const REFRESH = { plan: { kind: "reload" as const, metaUrl: "/api/artifacts/1111" }, revisionNumber: 1, sha256: "bbb" };

const USED = [
  "bg",
  "bg-raised",
  "surface",
  "line",
  "line-strong",
  "fg",
  "fg-muted",
  "fg-subtle",
  "danger-text",
  "accent",
  "accent-fg",
  "accent-text",
];

const parseDecls = (body: string): Record<string, string> =>
  Object.fromEntries(
    [...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [name ?? "", (value ?? "").trim()]),
  );

const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, "");

test("wrapper tokens carry the real values from tokens.css", () => {
  const shadow = VIEWER_TOKENS.split(':root[data-theme="light"]')[0] ?? "";
  const darkRoot = tokensCss.slice(0, tokensCss.indexOf("@media"));
  const dark = parseDecls(darkRoot);
  for (const name of USED) {
    assert.ok(dark[name], `tokens.css has no --${name} in :root`);
    assert.ok(
      shadow.includes(`--${name}:${normalize(dark[name])}`),
      `wrapper --${name} drifted from tokens.css (${dark[name]})`,
    );
  }
});

test("wrapper light block carries the light values from tokens.css", () => {
  const lightStart = tokensCss.lastIndexOf(':root[data-theme="light"]');
  const light = parseDecls(tokensCss.slice(lightStart));
  const lightBlock = VIEWER_TOKENS.split(':root[data-theme="light"]{')[1]?.split("}")[0] ?? "";
  for (const name of USED) {
    assert.ok(light[name], `tokens.css has no light --${name}`);
    assert.ok(
      lightBlock.includes(`--${name}:${normalize(light[name])}`),
      `wrapper light --${name} drifted (${light[name]})`,
    );
  }
});

test("bootstrap reads the stored side, matching index.html precedence", () => {
  assert.match(THEME_BOOTSTRAP, /localStorage\.getItem\("artiflow-theme"\)/);
  assert.doesNotMatch(THEME_BOOTSTRAP, /palette/);
  assert.doesNotMatch(VIEWER_TOKENS, /data-palette/);
  assert.match(THEME_BOOTSTRAP, /catch\(error\)\{document\.documentElement\.dataset\.theme="dark"\}/);

  const appBody = readFileSync(new URL("../apps/dashboard/index.html", import.meta.url), "utf8").match(
    /<script>([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(appBody, "index.html bootstrap not found");
  assert.match(appBody, /stored === "light" \|\| stored === "dark"\s*\n\s*\? stored/);
  assert.match(appBody, /matchMedia\("\(prefers-color-scheme: light\)"\)\.matches\s*\n\s*\? "light"\s*\n\s*: "dark"/);
  assert.doesNotMatch(appBody, /dataset\.palette/);
  assert.match(appBody, /localStorage\.removeItem\("artiflow-palette"\)/);
});

test("wrapperPage ships the theme bootstrap before its stylesheet", () => {
  const page = wrapperPage("<p>hi</p>", "/", { title: "x", version: 1 }, "full", REFRESH);
  const bootstrap = page.indexOf(THEME_BOOTSTRAP);
  const style = page.indexOf("<style>");
  assert.ok(bootstrap >= 0, "bootstrap script missing");
  assert.ok(style > bootstrap, "bootstrap must run before first paint");
});

test("the 404 and the markdown viewer keep the OS-following theme policy", () => {
  assert.ok(!NOT_FOUND_PAGE.includes("<script"), "the 404 ships no script by policy");
  assert.ok(NOT_FOUND_PAGE.includes(VIEWER_TOKENS));
  const markdown = markdownViewerPage("<h1>x</h1>", undefined, undefined, "anonymous", REFRESH).html;
  assert.ok(markdown.includes(VIEWER_TOKENS));
  assert.equal(
    markdown.includes("color-scheme:dark light;--doc-bg:#1c1c1c"),
    true,
    "the document canvas declares its own neutral tokens, independent of VIEWER_TOKENS",
  );
  assert.equal(markdown.includes(THEME_BOOTSTRAP), false, "the markdown viewer never sets data-theme in script");
  assert.equal(
    [...markdown.matchAll(/<script>/g)].length,
    1,
    "its one inline script is the freshness poller, which touches no theme state",
  );
  assert.doesNotMatch(markdown, /<script>[\s\S]*data-theme/);
  assert.doesNotMatch(markdown, /<script>[\s\S]*localStorage/);
});

test("wrapper CSP still authorizes the inline theme script", () => {
  assert.match(WRAPPER_CSP, /script-src 'unsafe-inline'/);
});
