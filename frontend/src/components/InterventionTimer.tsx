"use client";

/* ==========================================================================
   The intervention window, as a clock rather than a number.

   WHY A CLOCK
     "6.5 h" is a measurement of the moment the payload was built. An officer
     reading it twenty minutes later is reading a number that is quietly wrong,
     and nothing on the screen says so. A countdown cannot drift silently: it
     either ticks down or it says ELAPSED.

   WHERE THE TIME COMES FROM
     The backend does not publish a window END. It publishes the window LENGTH
     (`atmosphere.ventilation_forecast.intervention_window_hours`) and the moment
     it was measured from (`as_of`). The deadline is the sum of those two, and
     nothing here invents either half — a null window stays null and renders as
     "no window", never as 00:00.

   REPLAY
     In a replay, "now" IS `as_of`: the page is describing that moment, not this
     one. Ticking the clock against the wall would count down from a 2024
     forecast to today and report a window that elapsed sixteen months ago. So
     replay freezes at the published length and labels itself as at that moment.
     The interval is not even started.
   ========================================================================== */

import { useEffect, useMemo, useState } from "react";

import { COLORS } from "@/lib/theme";
import type { OutlookMode } from "@/types";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Thresholds are lead-time bands, not severity bands: how long is left to act. */
const AMBER_HOURS = 12;
const RED_HOURS = 3;

export interface InterventionCountdown {
  /** False when the backend forecast no collapse, so there is no window at all. */
  available: boolean;
  /** True once the deadline has passed. */
  elapsed: boolean;
  /** Frozen at `as_of` because the page is describing a past moment. */
  frozen: boolean;
  /** "07:24". Null when there is no window. */
  hhmm: string | null;
  /** Whole hours remaining, for prose. Null when there is no window. */
  hoursRemaining: number | null;
  /** A theme colour — never a literal. */
  color: string;
  /** Screen-reader and tooltip text. */
  description: string;
}

function hhmmOf(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / MINUTE_MS);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Live remaining intervention window.
 *
 * @param asOf        The outlook's `as_of` — the instant the window was measured from.
 * @param windowHours `intervention_window_hours`. Null when no collapse is forecast.
 * @param mode        "live" ticks; "replay" freezes at `as_of`.
 */
export function useInterventionCountdown(
  asOf: string | null | undefined,
  windowHours: number | null | undefined,
  mode: OutlookMode | null | undefined,
): InterventionCountdown {
  const live = mode !== "replay";

  // One tick per minute, and only while the clock is actually running. setState
  // happens in the interval callback, never synchronously in the effect body.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNowMs(Date.now()), MINUTE_MS);
    return () => window.clearInterval(id);
  }, [live]);

  return useMemo<InterventionCountdown>(() => {
    const unavailable: InterventionCountdown = {
      available: false,
      elapsed: false,
      frozen: !live,
      hhmm: null,
      hoursRemaining: null,
      color: COLORS.dim,
      description: "No ventilation collapse forecast, so there is no intervention window.",
    };

    if (windowHours === null || windowHours === undefined || !Number.isFinite(windowHours)) {
      return unavailable;
    }

    const anchor = asOf ? Date.parse(asOf) : Number.NaN;
    if (Number.isNaN(anchor)) return unavailable;

    // Replay describes `as_of`, so the remaining window there is the published
    // length itself. Live measures the same deadline against the wall clock.
    const deadline = anchor + windowHours * HOUR_MS;
    const remainingMs = live ? deadline - nowMs : windowHours * HOUR_MS;
    const elapsed = remainingMs <= 0;
    const hours = remainingMs / HOUR_MS;

    const color = elapsed
      ? COLORS.crimson
      : hours < RED_HOURS
        ? COLORS.red
        : hours <= AMBER_HOURS
          ? COLORS.amber
          : COLORS.green;

    const hhmm = hhmmOf(remainingMs);
    const description = elapsed
      ? "The intervention window has elapsed — the atmosphere has stopped clearing."
      : `${hhmm.replace(":", " hours ")} minutes of intervention window remaining${
          live ? "" : " at the moment being replayed"
        }.`;

    return {
      available: true,
      elapsed,
      frozen: !live,
      hhmm,
      hoursRemaining: elapsed ? 0 : Math.floor(hours),
      color,
      description,
    };
  }, [asOf, windowHours, live, nowMs]);
}

/**
 * The countdown itself: HH:MM, or ELAPSED, or a dash when no window exists.
 *
 * Deliberately unstyled beyond size and colour so it can sit inside the existing
 * Stat cards, the status strip and the alert banner without any of them needing
 * a second visual language.
 */
export default function InterventionTimer({
  asOf,
  windowHours,
  mode,
  size = "md",
  showUnit = true,
  className = "",
}: {
  asOf: string | null | undefined;
  windowHours: number | null | undefined;
  mode: OutlookMode | null | undefined;
  size?: "sm" | "md" | "lg";
  showUnit?: boolean;
  className?: string;
}) {
  const countdown = useInterventionCountdown(asOf, windowHours, mode);

  const sizes = {
    sm: { value: "text-[13px]", unit: "text-[9px]" },
    md: { value: "text-[27px]", unit: "text-[12px]" },
    lg: { value: "text-[34px]", unit: "text-[13px]" },
  } as const;
  const s = sizes[size];

  if (!countdown.available) {
    return (
      <span
        className={`${s.value} font-bold leading-none tracking-tight ${className}`}
        style={{ color: COLORS.dim }}
        title={countdown.description}
      >
        None
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-baseline gap-1 ${className}`}
      // Not aria-live: a value that re-announces itself every minute is noise.
      // The label carries the meaning whenever the element is reached.
      role="timer"
      aria-label={countdown.description}
      title={countdown.description}
    >
      <span
        className={`${s.value} font-bold leading-none tracking-tight tabular-nums`}
        style={{ color: countdown.color }}
      >
        {countdown.elapsed ? "ELAPSED" : countdown.hhmm}
      </span>
      {showUnit && !countdown.elapsed ? (
        <span
          className={`${s.unit} font-semibold uppercase tracking-wide`}
          style={{ color: COLORS.muted }}
        >
          hh:mm
        </span>
      ) : null}
    </span>
  );
}
