/**
 * The last live outlook this browser received, for the minutes the backend cannot answer.
 *
 * WHY THIS IS NOT THE CACHED AQI lib/recents.ts REFUSES TO KEEP
 *   That objection is to a stored value with no freshness field on it, which outlives
 *   its reading silently. An outlook carries `as_of`, the hour it describes, and the
 *   workspace never shows a cached one without saying so: it renders under a banner
 *   naming that hour and its age, and the authorisation panel is held until a live
 *   answer replaces it. A payload older than MAX_AGE_MS is not shown at all.
 *
 * WHY IT EXISTS
 *   The backend runs on an instance that sleeps and loses its store. A cold start is
 *   30-60 s before the first byte, and a viewer was shown "Loading outlook…" and then a
 *   warm-up notice for all of it. The forecast they saw last is still a better answer
 *   than a blank page, provided it says exactly how old it is.
 *
 * Live mode only. A replay describes a fixed moment and has nothing to go stale.
 * Every access is guarded: localStorage throws outright in some contexts.
 */

import type { OutlookResponse } from "@/types";

const STORAGE_KEY = "aree.outlook.live.v1";

/** Older than this and the forecast is history, not a stand-in for the present. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CachedOutlook {
  payload: OutlookResponse;
  /** When this browser received it, epoch ms. */
  savedAt: number;
}

export function saveLiveOutlook(payload: OutlookResponse): void {
  if (typeof window === "undefined" || payload.mode !== "live") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ savedAt: Date.now(), payload }),
    );
  } catch {
    // Quota, blocked storage, private mode: the page works without it.
  }
}

export function readLiveOutlook(now: number = Date.now()): CachedOutlook | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { savedAt, payload } = parsed as Partial<CachedOutlook>;
    if (typeof savedAt !== "number" || !payload || typeof payload !== "object") return null;
    if (payload.mode !== "live" || typeof payload.as_of !== "string") return null;
    const asOf = Date.parse(payload.as_of);
    if (!Number.isFinite(asOf) || now - asOf > MAX_AGE_MS) return null;
    // Shape-check the parts every view dereferences unconditionally, so an entry
    // written by an older build degrades to "no cache" rather than to a crash.
    if (!payload.forecast?.series || !payload.risk || !payload.decision || !payload.timeline) {
      return null;
    }
    return { payload, savedAt };
  } catch {
    return null;
  }
}
