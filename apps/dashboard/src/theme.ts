export type ThemeChoice = "light" | "dark";

const STORAGE_KEY = "artiflow-theme";

type MinimalGlobals = {
  matchMedia?: (query: string) => { matches: boolean };
  localStorage?: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
  document?: { documentElement: { dataset: { theme?: string } } };
};
const browser = globalThis as unknown as MinimalGlobals;

export function parseStoredTheme(value: string | null): ThemeChoice | null {
  return value === "light" || value === "dark" ? value : null;
}

export function resolveInitialTheme(): ThemeChoice {
  try {
    const stored = parseStoredTheme(browser.localStorage?.getItem(STORAGE_KEY) ?? null);
    if (stored) return stored;
  } catch {
  }
  const prefersLight = browser.matchMedia?.("(prefers-color-scheme: light)")?.matches === true;
  return prefersLight ? "light" : "dark";
}

export function applyTheme(theme: ThemeChoice): void {
  const root = browser.document?.documentElement;
  if (root) root.dataset.theme = theme;
}

export function persistTheme(theme: ThemeChoice): void {
  try {
    browser.localStorage?.setItem(STORAGE_KEY, theme);
  } catch {
  }
}

export function hasStoredTheme(): boolean {
  try {
    return parseStoredTheme(browser.localStorage?.getItem(STORAGE_KEY) ?? null) !== null;
  } catch {
    return false;
  }
}
