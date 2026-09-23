"use client";

/* ==========================================================================
   The one alert that follows the operator.

   WHY IT EXISTS
     A station can enter TRIGGERED while the operator is reading the Report Centre,
     the Policy Console or a 2024 replay. Every surface that showed the escalation
     was a surface they had to already be looking at, so the first link of the
     decision chain — DETECT — depended on where the user happened to be. This is
     the only element in the application that is on screen regardless.

   WHAT IT IS NOT
     Not a second engine. TRIGGERED is read from `engine_mode`, the field the GRAP
     state machine writes; nothing here infers escalation from AQI or from a stage
     name. Not a second poller either: the station list it reads is the one
     LiveDataProvider already fetches for the header, the map and the palette.

   THE COUNTDOWN IS AIRSHED-WIDE, AND SAYS SO
     `StationSummary` carries no intervention window — the only one AREE publishes
     is the NCR-wide ventilation window on /api/aree/outlook. Rather than invent a
     per-station clock, the banner shows that window under its real name. The timer
     itself is the Change #1 component, so this clock and the one on the Atmospheric
     Outlook are the same code reading the same deadline and cannot disagree.
   ========================================================================== */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";

import InterventionTimer from "@/components/InterventionTimer";
import { useLiveOutlook, useStations } from "@/components/providers/LiveDataProvider";
import { freshness } from "@/lib/freshness";
import { stationLabel } from "@/lib/station";
import type { StationSummary } from "@/types";

/** Long enough to read a station, short enough that three cycle in fifteen seconds. */
const ROTATE_MS = 5000;

export default function CriticalAlertBanner() {
  const stationsState = useStations();
  const outlookState = useLiveOutlook();

  /* The engine's own classification. Not derived, not thresholded, not inferred. */
  const triggered = useMemo<StationSummary[]>(
    () => (stationsState.data?.stations ?? []).filter((s) => s.engine_mode === "TRIGGERED"),
    [stationsState.data],
  );

  const [index, setIndex] = useState(0);
  /* Rotation stops while the operator is pointing at or tabbing through the banner.
     Without this the link they are about to activate changes destination under them. */
  const [held, setHeld] = useState(false);

  const rotating = triggered.length > 1 && !held;

  useEffect(() => {
    // No timer for zero or one station: there would be nothing to rotate to.
    if (!rotating) return;
    const id = window.setInterval(() => setIndex((i) => i + 1), ROTATE_MS);
    return () => window.clearInterval(id);
  }, [rotating]);

  /* Clamped during render rather than reset in an effect. When the triggered set
     shrinks — the usual case, a station recovering — the index stays in range
     without a second render pass, and there is no window in which it points past
     the end of the array. */
  const current = triggered.length > 0 ? triggered[index % triggered.length] : null;

  /* Nothing triggered, or nothing known yet: render nothing at all. A container,
     a placeholder or a "no alerts" strip would each cost permanent vertical space
     to say that the normal case is normal. `initialLoading` matters on its own —
     an empty list before the first response must not read as "all clear", and a
     failed request must never manufacture one. */
  if (stationsState.initialLoading || !stationsState.data || !current) return null;

  const look = freshness(current.freshness_status);
  const currentIsStale = current.freshness_status !== "current";

  const outlook = outlookState.data;
  const windowHours =
    outlook?.atmosphere.ventilation_forecast.intervention_window_hours ?? null;
  /* "None" is an assertion that no collapse is forecast. Before the first outlook
     response there is no basis for that claim, so the slot holds a dash instead. */
  const windowKnown = Boolean(outlook);

  return (
    <div
      /* Below the command bar (z-30) and below the sidebar (z-40), so it can cover
         neither. Sticky beneath the bar's own height, which is a theme variable
         rather than a number repeated here. */
      className="sticky z-20 border-b"
      style={{
        top: "var(--aree-commandbar-height)",
        background: "var(--aree-red)",
        borderColor: "var(--aree-crimson)",
      }}
      role="region"
      aria-label="Critical environmental alerts"
    >
      {/* Announced ONCE per change of the triggered set, never on rotation: an
          alert that re-announces itself every five seconds is one a screen-reader
          user turns off. The rotating detail below is deliberately not live. */}
      <p className="sr-only" aria-live="assertive">
        {triggered.length === 1
          ? `Critical: 1 station is in a triggered regulatory state.`
          : `Critical: ${triggered.length} stations are in a triggered regulatory state.`}
      </p>

      <Link
        href={`/dashboard?station=${encodeURIComponent(current.station)}`}
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={() => setHeld(false)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-aree-on-solid transition-colors hover:bg-black/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-aree-on-solid sm:px-6"
      >
        {/* Never colour alone: the icon and the word both carry the state. */}
        <span className="flex shrink-0 items-center gap-1.5">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <span className="text-[11px] font-black uppercase tracking-[0.12em]">
            Critical
          </span>
        </span>

        <span className="h-3.5 w-px shrink-0 bg-aree-on-solid/40" aria-hidden />

        <span className="min-w-0 truncate text-[13px] font-bold">
          {stationLabel(current.station)}
        </span>

        {/* min-w-0 + wrap on the row above keeps this from forcing a horizontal
            scrollbar on a narrow screen; the group simply moves to a second line. */}
        <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] font-semibold text-aree-on-solid/90">
          <span className="aree-num">AQI {current.aqi ?? "—"}</span>
          <span aria-hidden>·</span>
          <span>{current.grap_stage ?? "Stage not computed"}</span>

          <span aria-hidden>·</span>
          {/* Named for what it actually is. AREE publishes no per-station window,
              and a bare clock beside a station name would read as one. */}
          <span className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wide text-aree-on-solid/70">
              NCR window
            </span>
            {windowKnown ? (
              <InterventionTimer
                asOf={outlook?.as_of}
                windowHours={windowHours}
                mode={outlook?.mode}
                size="sm"
                showUnit={false}
                className="text-aree-on-solid"
              />
            ) : (
              <span className="text-[13px] font-bold text-aree-on-solid/70" aria-label="Intervention window not yet loaded">
                —
              </span>
            )}
          </span>

          {/* TRIGGERED is not a claim that the reading is fresh. A stale feed is
              flagged rather than hidden — suppressing the station would suppress
              the escalation with it. */}
          {currentIsStale ? (
            <>
              <span aria-hidden>·</span>
              <span className="rounded bg-black/25 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
                {look.label} data
              </span>
            </>
          ) : null}
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-2">
          {triggered.length > 1 ? (
            <span className="aree-num rounded bg-black/25 px-1.5 py-0.5 text-[10px] font-bold">
              {(index % triggered.length) + 1} of {triggered.length}
            </span>
          ) : null}
          <span className="hidden items-center gap-1 text-[11px] font-semibold sm:flex">
            Open Command Center
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </span>
          <ArrowRight className="h-3.5 w-3.5 sm:hidden" aria-hidden />
        </span>
      </Link>
    </div>
  );
}
