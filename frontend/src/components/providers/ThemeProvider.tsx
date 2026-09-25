"use client";

/**
 * Light / dark theme, for the whole application.
 *
 * WHAT IT ACTUALLY DOES
 *   Writes one attribute — data-theme="dark" — on <html>, and remembers the choice
 *   in localStorage. Everything visible follows from the [data-theme="dark"] block
 *   in globals.css, which redeclares the --aree-* token values and nothing else.
 *   No component branches on the theme, and none should: the moment one does there
 *   are two definitions of what a card looks like and they drift.
 *
 * THE FLASH, AND WHY THE ATTRIBUTE IS ALREADY THERE BEFORE REACT RUNS
 *   This provider cannot be what first applies the theme. It mounts after paint, so
 *   a dark-mode operator would get one white frame on every navigation that reloads
 *   the document. app/layout.tsx carries a tiny inline script that reads the same
 *   key and sets the same attribute before the first paint; this provider READS what
 *   that script decided rather than deciding again.
 *
 * WHY useSyncExternalStore AND NOT useState + useEffect
 *   The theme does not live in React. It lives in two places React does not own —
 *   an attribute on <html> and a localStorage key — and it is already set before the
 *   first render. Mirroring it into state means writing that state from an effect,
 *   which is a cascading render on every mount and is exactly what React now warns
 *   about. useSyncExternalStore is the primitive for this shape: getServerSnapshot
 *   returns the light theme the server necessarily rendered, getSnapshot returns
 *   what the document actually has, and React reconciles the two itself.
 *
 * WHY CONSUMERS GET `mounted`
 *   The server has no way to know the stored preference, so the markup it produces
 *   is always the light one. A toggle that commits to an icon before hydration is
 *   therefore committing to the wrong one half the time. `mounted` is false during
 *   that first render and true afterwards, so the toggle can hold its space and draw
 *   nothing until the answer is known.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { isTheme, THEME_STORAGE_KEY, type Theme } from "@/lib/themeMode";

export type { Theme };

export interface ThemeState {
  theme: Theme;
  /** False for the first (server-shaped) render, true once hydrated. */
  mounted: boolean;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

/* ── The external store ────────────────────────────────────────────────────
   Module scope, because there is exactly one document and one preference. The
   snapshot is cached rather than recomputed per call: getSnapshot runs on every
   render and must return a stable value or React re-renders forever. */

const listeners = new Set<() => void>();
let snapshot: Theme | null = null;

/** Guarded exactly like lib/recents: localStorage throws outright in some contexts. */
function readStoredTheme(): Theme | null {
  try {
    const raw: unknown = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : null;
  } catch {
    return null;
  }
}

function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A full or disabled store is not worth interrupting a theme change for.
  }
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): Theme {
  if (snapshot === null) {
    // The stored preference is authoritative; the attribute is the bootstrap
    // script's reading of it, and the fallback when storage is unreadable.
    snapshot =
      readStoredTheme() ??
      (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
  }
  return snapshot;
}

/** What the server rendered, and therefore what hydration has to match. */
function getServerSnapshot(): Theme {
  return "light";
}

function publish(next: Theme): void {
  snapshot = next;
  applyTheme(next);
  storeTheme(next);
  for (const listener of listeners) listener();
}

const alwaysTrue = () => true;
const alwaysFalse = () => false;

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const mounted = useSyncExternalStore(subscribe, alwaysTrue, alwaysFalse);

  const setTheme = useCallback((next: Theme) => publish(next), []);
  const toggleTheme = useCallback(
    () => publish(getSnapshot() === "dark" ? "light" : "dark"),
    [],
  );

  const value = useMemo<ThemeState>(
    () => ({ theme, mounted, setTheme, toggleTheme }),
    [theme, mounted, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used inside a ThemeProvider");
  }
  return value;
}
