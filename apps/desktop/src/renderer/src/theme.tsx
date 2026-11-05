import { useState } from "react";

type Theme = "system" | "light" | "dark";
const KEY = "agent-together:theme";
const LABEL: Record<Theme, string> = { system: "外观：跟随系统", light: "外观：浅色", dark: "外观：深色" };
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

function saved(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** Sets the theme on <html>; "system" leaves it to prefers-color-scheme. */
export function applyTheme(theme: Theme = saved()) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/** One button that cycles 跟随系统 → 浅色 → 深色, remembered on this computer. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(saved);
  return (
    <button
      onClick={() => {
        const next = NEXT[theme];
        setTheme(next);
        applyTheme(next);
        try {
          localStorage.setItem(KEY, next);
        } catch {} // private storage unavailable: the choice lasts until the app closes
      }}
      title="切换浅色、深色，或跟随系统"
    >
      {LABEL[theme]}
    </button>
  );
}
