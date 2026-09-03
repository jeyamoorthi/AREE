"use client";

/**
 * Keep the replay preset and the address bar in step.
 *
 * WHY
 *   The backend has always accepted `?at=2024-11-02T06:00:00Z` and reconstructs that
 *   moment deterministically. The UI did not: the preset was component state, so the
 *   replay a judge was looking at had no address, could not be linked, bookmarked or
 *   reopened, and survived neither a reload nor a screenshot.
 *
 *   That matters beyond convenience. "You can reproduce any past assessment" is one of
 *   the system's load-bearing claims, and the most direct way to demonstrate it is to
 *   paste a timestamp into the address bar and watch the same numbers come back. Until
 *   the page reads the parameter, that demonstration is a description.
 *
 * WHY NOT useSearchParams()
 *   In this Next.js version useSearchParams() forces the subtree into a Suspense
 *   boundary. Reading location once on mount and writing with replaceState keeps this a
 *   local concern of the two outlook pages rather than a change to their route files,
 *   and avoids a hydration mismatch: the first client render matches the server's
 *   (preset 0), and the URL is applied immediately afterwards.
 */

import { useEffect, useRef } from "react";

export interface PresetLike {
  label: string;
  /** undefined = live. */
  at?: string;
}

export function useSyncPresetToUrl(
  presets: readonly PresetLike[],
  preset: number,
  setPreset: (index: number) => void,
): void {
  // Guards the first effect run: without it, mounting would immediately overwrite the
  // incoming ?at= with the default preset's (absent) value.
  const applied = useRef(false);

  // 1. URL -> state, once on mount.
  useEffect(() => {
    if (applied.current) return;
    applied.current = true;

    const at = new URLSearchParams(window.location.search).get("at");
    if (!at) return;

    const index = presets.findIndex((p) => p.at === at);
    if (index >= 0 && index !== preset) {
      setPreset(index);
    }
    // An `at` that matches no preset is left alone rather than silently rounded to the
    // nearest one: quietly showing a different moment than the URL names is exactly the
    // class of substitution this project is careful to avoid elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. State -> URL, on every change after mount.
  useEffect(() => {
    if (!applied.current) return;

    const at = presets[preset]?.at;
    const url = new URL(window.location.href);
    if (at) {
      url.searchParams.set("at", at);
    } else {
      url.searchParams.delete("at");
    }
    if (url.toString() !== window.location.href) {
      window.history.replaceState(null, "", url.toString());
    }
  }, [presets, preset]);
}
