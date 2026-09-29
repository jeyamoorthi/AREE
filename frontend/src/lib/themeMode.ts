/**
 * The persisted display-mode preference.
 *
 * WHY THIS IS ITS OWN MODULE RATHER THAN A CONSTANT IN ThemeProvider
 *   Two very different things read this key: the React provider, which is a client
 *   component, and the pre-paint bootstrap script embedded by app/layout.tsx, which
 *   is a SERVER component. Every export of a "use client" module reaches a server
 *   component as a client reference, not as its value — so a string declared beside
 *   the provider would arrive at the layout as an opaque proxy and the bootstrap
 *   script would be written with the wrong key. Neither side owns it; lib/ does.
 */

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "aree.theme.v1";

/**
 * The browser-chrome colour (<meta name="theme-color">) for each theme — --aree-bg
 * in each palette, as literals because a meta tag cannot read a custom property.
 * Keep in step with globals.css.
 */
export const THEME_CHROME_COLORS: Record<Theme, string> = {
  light: "#f5f4ed",
  dark: "#100f0c",
};

/** Point the browser chrome at the given theme. Safe to call before hydration. */
export function applyThemeChromeColor(theme: Theme): void {
  if (typeof document === "undefined") return;
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => meta.setAttribute("content", THEME_CHROME_COLORS[theme]));
}

/** True for the one stored value that means anything other than the default. */
export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}
