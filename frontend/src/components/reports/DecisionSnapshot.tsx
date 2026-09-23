"use client";

/**
 * The complete state of the AREE decision engine for one station, at the moment a
 * report is about to be generated.
 *
 * WHY IT SITS BETWEEN THE PREVIEW AND THE GENERATE BUTTON
 *   The panel above it answers "what is this station reading". This answers "what has
 *   the engine concluded from it", which is the question the brief exists to carry.
 *   An authority pressing generate should be able to state, from this screen alone,
 *   what conditions the document they are about to file describes.
 *
 * EVERY FIELD IS THE ENGINE'S OWN ANSWER
 *   The band, the mode, the dominant pollutant, the trend direction, the exposure
 *   category and the GRAP stage are all read off the payload. Nothing here classifies
 *   anything. That matters more on this panel than anywhere else in the application:
 *   it is the summary an officer would quote, so a value invented here would be
 *   quoted as the engine's.
 *
 * WHERE THE METEOROLOGY COMES FROM
 *   /api/ventilation/forecast, not the station payload — dispersion is a property of
 *   the regional atmosphere and the backend models it for NCR as a whole, not per
 *   monitor. It is polled separately and slowly for that reason, and its own word for
 *   the state is printed rather than remapped onto a second vocabulary.
 */

import { MoveRight, TrendingDown, TrendingUp, Wind } from "lucide-react";
import type { ReactNode } from "react";

import { SkeletonBar } from "@/components/ui/States";
import { usePolling, type PollingState } from "@/hooks/usePolling";
import { api } from "@/lib/api";
import { pollutantLabel } from "@/lib/station";
import {
  aqiColor,
  bandColor,
  eriColor,
  grapColor,
  modeColor,
  modeLabel,
  orDash,
  trendColor,
} from "@/lib/theme";
import type { StationDetail, VentilationForecast } from "@/types";

/* Regional and slow-moving: the boundary layer is modelled hourly, so polling it at
   the station cadence would be traffic for a number that cannot have changed. */
const VENTILATION_POLL_MS = 120000;
const VENTILATION_TIMEOUT_MS = 10000;

/**
 * Colour for the backend's lead-time state.
 *
 * The states describe how much time is left to act, not how bad the air is, so the
 * ramp runs by URGENCY: collapsed and imminent are the two that mean the window is
 * gone or going. Unrecognised values fall through to the neutral tone rather than
 * being guessed at — this is presentation for a vocabulary the backend owns.
 */
function ventilationColor(state: string | null | undefined): string {
  switch (state) {
    case "collapsed":
      return "var(--aree-crimson)";
    case "imminent":
      return "var(--aree-red)";
    case "approaching":
      return "var(--aree-orange)";
    case "watch":
      return "var(--aree-yellow)";
    case "clear":
      return "var(--aree-green)";
    default:
      return "var(--aree-dim)";
  }
}

/** "collapsed" -> "Collapsed". The word is the backend's; only the case changes. */
function titleCase(value: string): string {
  return value.replace(/^\w/, (c) => c.toUpperCase());
}

function Field({
  label,
  value,
  color,
  detail,
  icon,
}: {
  label: string;
  value: ReactNode;
  color?: string;
  detail?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="border-b border-aree-border py-2.5 last:border-b-0 sm:border-b-0 sm:py-0">
      <dt className="aree-eyebrow text-[9.5px]">{label}</dt>
      <dd
        className="mt-1 flex items-center gap-1.5 text-[14px] font-bold leading-tight"
        style={color ? { color } : undefined}
      >
        {icon}
        {value}
      </dd>
      {detail ? (
        <div className="mt-0.5 text-[11px] leading-snug text-aree-muted">{detail}</div>
      ) : null}
    </div>
  );
}

export default function DecisionSnapshot({
  state,
}: {
  /** The station payload, polled once by the reports page for every panel on it. */
  state: PollingState<StationDetail>;
}) {
  const ventilation = usePolling<VentilationForecast>(
    (signal) => api.ventilationForecast(undefined, signal),
    { intervalMs: VENTILATION_POLL_MS, timeoutMs: VENTILATION_TIMEOUT_MS },
  );

  const data = state.data;

  if (state.initialLoading) {
    return (
      <div className="grid gap-4 grid-cols-[minmax(0,1fr)] sm:grid-cols-2 lg:grid-cols-4" role="status" aria-live="polite">
        <span className="sr-only">Loading the decision snapshot</span>
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <SkeletonBar key={i} height={44} />
        ))}
      </div>
    );
  }

  /* No panel at all rather than a grid of dashes. The preview directly above already
     states why there is nothing — repeating it here as seven empty fields would read
     as seven failed measurements. */
  if (!data || !data.has_data) return null;

  const direction = data.forecast?.direction ?? null;
  const TrendIcon =
    direction === "rising" ? TrendingUp : direction === "falling" ? TrendingDown : MoveRight;

  /* Only what the forecast block actually carries. A rate is published per minute;
     it is restated here in the same unit rather than converted into an hourly figure
     the engine never computed. */
  const trendRate = data.forecast?.rate_per_min ?? null;

  const ventState = ventilation.data?.available ? (ventilation.data.state ?? null) : null;
  const windowHours = ventilation.data?.available
    ? ventilation.data.intervention_window_hours
    : null;

  const eri = data.eri_score ?? null;

  return (
    <dl
      className="grid gap-x-6 gap-y-4"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))" }}
    >
      <Field
        label="Air quality index"
        value={data.aqi ?? "—"}
        color={aqiColor(data.aqi)}
        detail={
          data.cpcb_band ? (
            <span style={{ color: bandColor(data.cpcb_band) }}>{data.cpcb_band}</span>
          ) : null
        }
      />

      <Field
        label="Engine status"
        value={data.engine_mode ? modeLabel(data.engine_mode) : "—"}
        color={data.engine_mode ? modeColor(data.engine_mode) : undefined}
        detail={data.engine_mode ?? null}
      />

      <Field
        label="Primary pollutant"
        value={data.dominant_pollutant ? pollutantLabel(data.dominant_pollutant) : "—"}
        detail={data.dominant_pollutant ? "Leads the published index" : null}
      />

      <Field
        label="Trend"
        value={direction ? titleCase(direction) : "—"}
        color={direction ? trendColor(direction) : undefined}
        icon={
          direction ? (
            <TrendIcon className="h-4 w-4 shrink-0" aria-hidden />
          ) : null
        }
        detail={
          trendRate !== null ? (
            <span className="aree-num">
              {trendRate > 0 ? "+" : ""}
              {trendRate.toFixed(2)} AQI/min
            </span>
          ) : null
        }
      />

      <Field
        label="Meteorological risk"
        value={
          ventilation.initialLoading
            ? "…"
            : ventState
              ? titleCase(ventState)
              : "—"
        }
        color={ventState ? ventilationColor(ventState) : undefined}
        icon={ventState ? <Wind className="h-4 w-4 shrink-0" aria-hidden /> : null}
        detail={
          windowHours !== null && windowHours !== undefined
            ? `Ventilation · ${windowHours} h intervention window`
            : ventState
              ? "Ventilation state, NCR-wide"
              : null
        }
      />

      <Field
        label="Exposure risk"
        value={eri !== null ? eri : "—"}
        color={eri !== null ? eriColor(eri) : undefined}
        detail={data.eri_category ? `ERI · ${data.eri_category}` : null}
      />

      <Field
        label="Recommended GRAP action"
        value={orDash(data.grap_stage)}
        color={grapColor(data.grap_stage)}
        detail={data.grap_description ?? null}
      />
    </dl>
  );
}
