/**
 * Clock rendering for backend-supplied instants.
 *
 * Presentation only. Every value here is derived from a timestamp the backend
 * produced (`server_time`); nothing is invented and no age is recomputed.
 */

const IST_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Render a backend ISO instant as "22:20 IST". */
export function istClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${IST_FORMAT.format(d)} IST`;
}

/** Render a backend ISO instant as "16:50:12 UTC". */
export function utcClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(11, 19)} UTC`;
}

/** Render a backend ISO instant as "22 Aug 2026, 22:20 IST". */
export function istDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d)}, ${IST_FORMAT.format(d)} IST`;
}
