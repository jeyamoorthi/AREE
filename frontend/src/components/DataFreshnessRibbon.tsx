"use client";

/* ==========================================================================
   Is what I am looking at current?

   WHY IT IS A RIBBON AND NOT A NUMBER SOMEWHERE
     The freshness breakdown already exists on the National Overview, which is the
     one page an operator is least likely to be on when it matters. Everywhere else
     — a station command centre, the report centre — the interface presented values
     with no indication of whether the network behind them was reporting. This states
     it once, on every page.

   IT COUNTS NOTHING AND CLASSIFIES NOTHING
     There is no aggregation here at all: /api/stations already returns `current`,
     `aging`, `stale` and `unavailable` alongside the station array, computed by the
     same backend that classified each station. The ribbon renders those integers.
     No timestamp is compared against the browser clock anywhere in this file — that
     would be a second classifier, and the one on screen would be the unvalidated one.

   THE SEVERITY RULE IS BORROWED, NOT INVENTED
     stale -> aging -> current, exactly as DataHealthOverviewCard already resolves the
     network state. `unavailable` is deliberately NOT a rung on that ladder: the type
     definition is explicit that availability and staleness are different questions
     and "an unavailable feed is never merely stale", so it is reported beside the
     state rather than folded into it.
   ========================================================================== */

import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";

import { useStations } from "@/components/providers/LiveDataProvider";
import { useOutlookMode } from "@/components/providers/OutlookModeProvider";
import { formatAgeBehind } from "@/lib/duration";
import { freshness } from "@/lib/freshness";
import type { FreshnessStatus } from "@/types";

export default function DataFreshnessRibbon() {
  const stationsState = useStations();
  const { mode: pageMode } = useOutlookMode();

  const data = stationsState.data;

  /* REPLAY.
     This ribbon describes the LIVE station network. A replay is a reconstruction of a
     past hour and does not render the station network at all, so a "data current"
     strip beside it would be answering a question the page never asked — and would
     read as a claim about the 2024 figures on screen. The application has no replay
     freshness representation to fall back on, so rather than pretend, the ribbon
     stands down. (Reading the mode only; the replay UI itself is Change #14.) */
  if (pageMode === "replay") return null;

  /* Nothing known yet, or the request failed with nothing cached: say so plainly.
     Silence here would read as "all clear", which is the one thing it must not do. */
  if (!data) {
    return (
      <Ribbon
        status="unavailable"
        headline={stationsState.initialLoading ? "Checking station network" : "Station network unreachable"}
        detail={
          stationsState.initialLoading
            ? "Freshness unknown until the first response."
            : "Freshness cannot be established. Values on screen may be out of date."
        }
        prominent={!stationsState.initialLoading}
      />
    );
  }

  const { current, aging, stale, unavailable, total } = data;

  /* The oldest reading behind the network, from the backend's own per-station
     `stale_seconds`. This is a max over values the server computed, not an age this
     file worked out; formatAgeBehind is the application's existing formatter. */
  const oldestSeconds = data.stations.reduce<number | null>((worst, s) => {
    const age = s.stale_seconds;
    if (age === null || age === undefined || !Number.isFinite(age)) return worst;
    return worst === null || age > worst ? age : worst;
  }, null);
  const oldest = formatAgeBehind(oldestSeconds);

  const reporting = `${current + aging + stale} of ${total} stations reporting`;

  if (stale > 0) {
    return (
      <Ribbon
        status="stale"
        headline={`Data stale · ${stale} station${stale === 1 ? "" : "s"}`}
        detail={[reporting, oldest ? `oldest ${oldest}` : null]
          .filter(Boolean)
          .join(" · ")}
        unavailable={unavailable}
        prominent
      />
    );
  }

  if (aging > 0) {
    return (
      <Ribbon
        status="aging"
        headline={`Data aging · ${aging} station${aging === 1 ? "" : "s"}`}
        detail={[reporting, oldest ? `oldest ${oldest}` : null]
          .filter(Boolean)
          .join(" · ")}
        unavailable={unavailable}
        prominent
      />
    );
  }

  return (
    <Ribbon
      status="current"
      headline="Data current"
      detail={reporting}
      unavailable={unavailable}
    />
  );
}

/**
 * The strip itself.
 *
 * Colour comes from `freshness()`, so the ribbon, the map markers, the station
 * selector and the AQI card all take the same hue from the same status. Nothing is
 * carried by colour alone: the marker glyph, the icon and the wording each state it.
 */
function Ribbon({
  status,
  headline,
  detail,
  unavailable = 0,
  prominent = false,
}: {
  status: FreshnessStatus;
  headline: string;
  detail: string;
  unavailable?: number;
  prominent?: boolean;
}) {
  const look = freshness(status);
  const Icon =
    status === "current" ? CheckCircle2 : status === "aging" ? Clock : AlertTriangle;

  return (
    /* Deliberately NOT role="status": that implies aria-live="polite", and the counts
       change on every 15-second station poll, so it would narrate the network at a
       screen-reader user indefinitely. A labelled region is discoverable without
       announcing itself. */
    <div
      role="region"
      aria-label="Data freshness"
      className="border-b border-aree-border px-4 py-1.5 sm:px-6"
      style={{
        // A quiet tint when something is behind; the plain surface when all is well,
        // so "current" is visible without being another coloured bar to tune out.
        background: prominent
          ? `color-mix(in srgb, ${look.color} 10%, var(--aree-bg))`
          : "var(--aree-surface-2)",
      }}
    >
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px]">
        <span
          className="flex shrink-0 items-center gap-1.5 font-bold uppercase tracking-[0.08em]"
          style={{ color: look.color }}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
          <span aria-hidden>{look.marker}</span>
          {headline}
        </span>
        <span className="text-aree-muted">{detail}</span>
        {unavailable > 0 ? (
          <>
            <span className="text-aree-faint" aria-hidden>
              ·
            </span>
            {/* Reported beside the state, never as a rung of it — an unavailable feed
                is a different fact from a late one. */}
            <span className="text-aree-dim">
              {unavailable} feed{unavailable === 1 ? "" : "s"} unavailable
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}
