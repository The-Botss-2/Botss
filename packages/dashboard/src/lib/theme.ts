import { useCallback, useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "botss.theme";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function apply(pref: ThemePref): "light" | "dark" {
  const dark =
    pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const t = dark ? "dark" : "light";
  document.documentElement.dataset.theme = t;
  return t;
}

const listeners = new Set<(t: "light" | "dark") => void>();

export function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function useTheme(): { pref: ThemePref; theme: "light" | "dark"; setPref: (p: ThemePref) => void } {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);
  useEffect(() => {
    const l = (t: "light" | "dark") => setTheme(t);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => {
      if (readPref() === "system") for (const l of listeners) l(apply("system"));
    };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const setPref = useCallback((p: ThemePref) => {
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* ignore */
    }
    setPrefState(p);
    const t = apply(p);
    for (const l of listeners) l(t);
  }, []);
  return { pref, theme, setPref };
}

/** Subscribe to the resolved theme only (for mermaid / diff colour schemes). */
export function useResolvedTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);
  useEffect(() => {
    const l = (t: "light" | "dark") => setTheme(t);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return theme;
}

export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);
  return now;
}
