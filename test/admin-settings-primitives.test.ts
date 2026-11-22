import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { ADMIN_SECTIONS, adminSectionLabel, adminSectionPath } from "../apps/dashboard/src/admin-entry.ts";

const UI = "../apps/dashboard/src/components/ui";
const ADMIN_SHELL = "../apps/dashboard/src/components/app/admin-shell.tsx";

const read = (path: string): string => {
  const file = new URL(path, import.meta.url);
  assert.ok(existsSync(file), `missing ${path}`);
  return readFileSync(file, "utf8");
};

test("every administration section resolves to its own path and label", () => {
  assert.equal(new Set(ADMIN_SECTIONS.map((section) => section.key)).size, ADMIN_SECTIONS.length);
  for (const section of ADMIN_SECTIONS) {
    assert.equal(adminSectionPath(section.key), section.href);
    assert.equal(adminSectionLabel(section.key), section.label);
  }
});

test("the administration navigation marks the current section and keeps narrow screens usable", () => {
  const shell = read(ADMIN_SHELL);
  assert.match(shell, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(shell, /SECTION_ICONS: Record<AdminSection, IconName>/);
  assert.match(shell, /max-\[760px\]:overflow-x-auto/);
  assert.match(shell, /Back to library/);
  assert.doesNotMatch(shell, /#[0-9a-f]{3,8}\b/i, "the shell uses tokens, never raw colours");
});

test("the switch is a real switch that keyboards and screen readers can operate", () => {
  const source = read(`${UI}/switch.tsx`);
  assert.match(source, /type="button"/);
  assert.match(source, /role="switch"/);
  assert.match(source, /aria-checked=\{checked\}/);
  assert.match(source, /onCheckedChange\(!checked\)/);
  assert.match(source, /focus-visible:ring/);
  assert.match(source, /disabled:cursor-not-allowed/);
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b/i);
});

test("a settings row names its control so the control can point at the label", () => {
  const source = read(`${UI}/settings.tsx`);
  assert.match(source, /export function settingIds/);
  assert.match(source, /id=\{ids\.label\}/);
  assert.match(source, /id=\{ids\.description\}/);
  assert.match(source, /aria-labelledby=\{`\$\{id\}-heading`\}/);
});

test("the save bar only appears with pending changes and never hides the save while it runs", () => {
  const source = read(`${UI}/save-bar.tsx`);
  assert.match(source, /if \(!dirty && !saving\) return null;/);
  assert.match(source, /aria-label="Unsaved changes"/);
  assert.match(source, /Discard/);
  assert.match(source, /saving \? "Saving…" : saveLabel/);
  assert.match(source, /sticky bottom-4/);
});
