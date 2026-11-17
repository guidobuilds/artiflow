import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { applyTheme, hasStoredTheme, persistTheme, resolveInitialTheme, type ThemeChoice } from "@/theme.ts";

type ThemeContextValue = {
  theme: ThemeChoice;
  setTheme: (theme: ThemeChoice) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>(() => resolveInitialTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (typeof globalThis.matchMedia !== "function") return;
    const media = globalThis.matchMedia("(prefers-color-scheme: light)");
    const follow = (event: MediaQueryListEvent) => {
      setThemeState((current) => {
        if (hasStoredTheme()) return current;
        return event.matches ? "light" : "dark";
      });
    };
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, []);

  const setTheme = (next: ThemeChoice) => {
    persistTheme(next);
    setThemeState(next);
  };

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}
