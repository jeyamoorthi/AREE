/**
 * Human-readable duration formatting for feed staleness.
 *
 * Presentation only. The backend remains the sole authority for `stale_seconds`,
 * `waqi_timestamp` and `feed_last_sync`; nothing here recomputes an age or
 * applies a timezone correction.
 */

/**
 * Format an age in seconds as a compact operator-facing duration.
 *
 * 2_520   -> "42 m"
 * 4_680   -> "1 h 18 m"
 * 82_547  -> "22 h 56 m"
 * 187_200 -> "2 d 4 h"
 */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return null;
  }

  // Round to whole minutes first: rounding the remainder afterwards could
  // otherwise yield "60 m" (e.g. 3599 s).
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  // Beyond a day, minutes stop being useful — days and hours read better.
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} m`;
  return `${minutes} m`;
}

/** Same value with a trailing "behind", for staleness copy. */
export function formatAgeBehind(seconds: number | null | undefined): string | null {
  const value = formatDuration(seconds);
  return value === null ? null : `${value} behind`;
}

/**
 * Render a backend-supplied UTC ISO string ("2026-08-21T16:06:49Z") as
 * "2026-08-21 16:06 UTC". This is string slicing, not a timezone conversion —
 * the backend already normalised the instant to UTC.
 */
export function formatUtcIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}
