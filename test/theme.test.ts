import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

afterEach(() => {
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

const fakeMatchMedia = (prefersLight: boolean) =>
  ((query: string) => ({ matches: query === "(prefers-color-scheme: light)" ? prefersLight : false })) as unknown;

const fakeStorage = (value: string | null) => {
  const store = new Map<string, string>(value === null ? [] : [["artiflow-theme", value]]);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, item: string) => void store.set(key, item),
    removeItem: (key: string) => void store.delete(key),
  } as unknown as Storage;
};

test("a stored theme is validated; junk storage is ignored, never trusted", async () => {
  const { parseStoredTheme } = await import("../apps/dashboard/src/theme.ts");
  assert.equal(parseStoredTheme("light"), "light");
  assert.equal(parseStoredTheme("dark"), "dark");
  assert.equal(parseStoredTheme("blue"), null);
  assert.equal(parseStoredTheme(null), null);
  assert.equal(parseStoredTheme('{"theme":"dark"}'), null);
});

test("the initial theme is the stored choice, else the OS preference, else dark", async () => {
  const { resolveInitialTheme } = await import("../apps/dashboard/src/theme.ts");
  fakeStorage("light");
  assert.equal(resolveInitialTheme(), "light");
  fakeStorage("blue");
  (globalThis as { matchMedia?: unknown }).matchMedia = fakeMatchMedia(true);
  assert.equal(resolveInitialTheme(), "light");
  fakeStorage(null);
  (globalThis as { matchMedia?: unknown }).matchMedia = fakeMatchMedia(false);
  assert.equal(resolveInitialTheme(), "dark");
  (globalThis as { matchMedia?: unknown }).matchMedia = undefined;
  assert.equal(resolveInitialTheme(), "dark");
});

test("applying a theme writes exactly one data-theme value", async () => {
  const { applyTheme } = await import("../apps/dashboard/src/theme.ts");
  const attrs: Record<string, string | undefined> = {};
  (globalThis as { document?: unknown }).document = {
    documentElement: { dataset: attrs },
  };
  applyTheme("light");
  assert.equal(attrs.theme, "light");
  applyTheme("dark");
  assert.equal(attrs.theme, "dark");
});
