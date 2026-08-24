/**
 * Presentation for the backend's `freshness_status`.
 *
 * The backend classifies; this module only supplies markers, labels and colours
 * so every surface renders the same state identically. No age is recomputed
 * here and no timezone is applied.
 */

import type { FreshnessStatus } from "@/types";

export interface FreshnessPresentation {
  /** Compact marker used in dense rows and the station selector. */
  marker: string;
  /** Short label, e.g. for the selector. */
  label: string;
  /** Emphasised label used on the AQI card badge. */
  badge: string;
  color: string;
}

const PRESENTATION: Record<FreshnessStatus, FreshnessPresentation> = {
  current: { marker: "●", label: "Current", badge: "CURRENT", color: "#22c55e" },
  aging: { marker: "◐", label: "Aging", badge: "AGING DATA", color: "#eab308" },
  stale: { marker: "⚠", label: "Stale", badge: "UPSTREAM DATA STALE", color: "#f97316" },
  unavailable: {
    marker: "×",
    label: "Unavailable",
    badge: "FEED UNAVAILABLE",
    color: "#94a3b8",
  },
};

export function freshness(status: FreshnessStatus | undefined | null): FreshnessPresentation {
  return PRESENTATION[status ?? "unavailable"] ?? PRESENTATION.unavailable;
}
