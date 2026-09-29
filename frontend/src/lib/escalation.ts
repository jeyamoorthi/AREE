/**
 * One line describing where a station stands in the escalation chain.
 *
 * WHO DECIDES, AND WHO ONLY RENDERS
 *   The classification is the ENGINE's: `engine_mode` arrives on the payload as
 *   TRIGGERED, WATCH or NORMAL and is never recomputed here. PersistenceCard draws
 *   the same state as a full banner with a progress bar, but it derives its own
 *   triggered/watch test from the configured thresholds — this deliberately does
 *   not, because a second classifier on the same screen is a second thing that can
 *   disagree with the engine about whether a station has escalated.
 *
 * WHAT IT ADDS TO THE MODE
 *   The mode alone answers "is this station escalating"; the counts answer "how far
 *   along", which is the question an authority asks next and the one a one-line
 *   summary is worth writing for. Every number in it comes from the payload; nothing
 *   is projected, rounded up, or filled in when absent.
 */

import { modeColor } from "@/lib/theme";
import type { StationDetail } from "@/types";

export interface EscalationSummary {
  /** Short state word, matching the engine's own vocabulary. */
  headline: string;
  /** The rest of the sentence. Empty when the payload supports nothing further. */
  detail: string;
  color: string;
}

export function escalationSummary(data: StationDetail): EscalationSummary {
  const mode = data.engine_mode ?? null;
  const consecutive = data.consecutive_windows ?? null;
  const remaining = data.remaining_windows ?? null;
  const projected = data.projected_trigger_time ?? null;
  const color = modeColor(mode);

  if (mode === "TRIGGERED") {
    return {
      headline: "Escalation triggered",
      detail:
        consecutive !== null
          ? `${consecutive} consecutive high windows recorded. Regulatory activation is due.`
          : "Regulatory activation is due.",
      color,
    };
  }

  if (mode === "WATCH") {
    const parts = [
      consecutive !== null && remaining !== null
        ? `${consecutive} high window${consecutive === 1 ? "" : "s"} recorded, ${remaining} more would trigger`
        : null,
      projected ? `projected trigger ${projected}` : null,
    ].filter(Boolean);
    return {
      headline: "Escalation watch",
      detail: parts.length > 0 ? `${parts.join(" · ")}.` : "Approaching the escalation threshold.",
      color,
    };
  }

  if (mode === "NORMAL") {
    return {
      headline: "Within limits",
      detail: "No escalation pending for this station.",
      color,
    };
  }

  /* No mode on the payload. Nothing is claimed — see the standing rule that an
     authority is shown confirmed facts or nothing, never a guess dressed as one. */
  return { headline: "", detail: "", color };
}

/**
 * Escalation events, newest first.
 *
 * The backend is meant to return them in that order, but every "recent events" view
 * takes a slice off the front, and a list that arrives oldest-first would then show
 * the five OLDEST transitions under a "recent" heading. Sorting here costs nothing
 * and makes the order a property of the view rather than an assumption about the
 * server. An event with no parseable timestamp sorts last; ties keep server order.
 */
export function newestFirst<T extends { timestamp?: string | null }>(
  events: readonly T[],
): T[] {
  const at = (e: T) => {
    const ms = e.timestamp ? Date.parse(e.timestamp) : NaN;
    return Number.isFinite(ms) ? ms : -Infinity;
  };
  return events
    .map((event, index) => ({ event, index, ms: at(event) }))
    .sort((a, b) => (b.ms === a.ms ? a.index - b.index : b.ms - a.ms))
    .map((x) => x.event);
}
