"use client";

import { useEffect, useState } from "react";
import { Segmented } from "./Segmented";

export type Theme = "dark" | "light";
export const THEME_KEY = "serv-theme";

/** Runs before the first paint: the saved theme, or dark (Serv's default). */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");document.documentElement.dataset.theme=t==="light"?"light":"dark"}catch(e){}`;

/** Dark (default, as on servtech.co) or light, remembered in this browser. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    const t = setTimeout(() => setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark"), 0);
    return () => clearTimeout(t);
  }, []);
  const pick = (t: Theme) => {
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      // Private windows may refuse storage; the theme still applies to this page.
    }
  };
  return (
    <Segmented
      label="Theme"
      value={theme}
      onChange={pick}
      options={[
        { value: "dark", label: "Dark" },
        { value: "light", label: "Light" },
      ]}
    />
  );
}
