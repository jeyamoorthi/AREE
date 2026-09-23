"use client";

/**
 * Name what a printed page is ABOUT.
 *
 * The print header in globals.css is one rule shared by every route, so it cannot
 * know which station — if any — the page in front of it describes. A page that has
 * a subject declares it here; the value lands in a CSS custom property that the
 * `#main-content::before` rule concatenates into the running header.
 *
 * WHY A CSS VARIABLE AND NOT A RENDERED ELEMENT
 *   A print header has to repeat on every sheet, and only generated content can do
 *   that. An element rendered into the page would appear once, at the top of the
 *   first sheet, which is exactly what it must not do on a four-page brief.
 *
 * WHY IT IS CLEARED ON UNMOUNT
 *   The property lives on <html> and outlives the component that set it. Without the
 *   teardown, printing the national overview after visiting a station would title
 *   the network-wide page with that station's name.
 */

import { useEffect } from "react";

const SUBJECT_VAR = "--aree-print-subject";

/**
 * Quote a value for use in a CSS `content` string.
 *
 * The subject is a station name, which comes from the backend rather than from this
 * file, so it is escaped rather than trusted: an unescaped quote would terminate the
 * string and leave the header rendering CSS fragments.
 *
 * JSON.stringify does exactly this job — it wraps the value in double quotes and
 * escapes the two characters, the quote and the backslash, that CSS strings escape
 * the same way. Writing the escaping out by hand would be the same work with
 * somewhere to get it wrong.
 */
function cssString(value: string): string {
  return JSON.stringify(value);
}

/** Pass null on a page that has no single subject. */
export function usePrintSubject(subject: string | null | undefined): void {
  useEffect(() => {
    const root = document.documentElement;
    if (!subject) {
      root.style.removeProperty(SUBJECT_VAR);
      return;
    }
    root.style.setProperty(SUBJECT_VAR, cssString(` · ${subject}`));
    // Braced, because removeProperty returns the old value and an expression-bodied
    // cleanup would hand React a string where it expects nothing.
    return () => {
      root.style.removeProperty(SUBJECT_VAR);
    };
  }, [subject]);
}
