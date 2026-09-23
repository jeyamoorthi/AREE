/**
 * Recently reached places, for the command palette.
 *
 * WHAT IS STORED, AND WHY SO LITTLE
 *   Identifiers only — a station key or a route — and at most five. Nothing that was
 *   measured, observed or decided goes in here. A cached AQI in localStorage would
 *   outlive the reading it came from and there would be no freshness field on it to
 *   say so, which is the one failure mode this application spends most of its effort
 *   avoiding. The palette resolves these ids against live data every time it opens;
 *   an id that no longer matches anything is simply dropped.
 *
 * EVERY ACCESS IS GUARDED
 *   localStorage throws outright in some contexts (a browser set to block site data,
 *   some private modes) rather than returning null, and its contents are attacker-
 *   adjacent in the sense that anything on the origin can rewrite them. So reads are
 *   wrapped, parsed defensively and shape-checked; a corrupted value degrades to "no
 *   recents" and never to a crash.
 */

export type RecentKind = "station" | "nav";

export interface RecentEntry {
  kind: RecentKind;
  /** Station key, or route path. Never a label — labels come from live data. */
  id: string;
}

const STORAGE_KEY = "aree.recent.v1";
const MAX_RECENTS = 5;

function isEntry(value: unknown): value is RecentEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.kind === "station" || candidate.kind === "nav") &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    candidate.id.length < 300
  );
}

/** Most recent first. Returns [] on the server, on absence, or on anything malformed. */
export function readRecents(): RecentEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).slice(0, MAX_RECENTS);
  } catch {
    // Unreadable, unparseable, or storage refused. Either way: no recents.
    return [];
  }
}

/** Move an entry to the front, de-duplicated, capped. Silent on failure. */
export function rememberRecent(entry: RecentEntry): void {
  if (typeof window === "undefined") return;
  if (!isEntry(entry)) return;
  try {
    const next = [
      entry,
      ...readRecents().filter((e) => !(e.kind === entry.kind && e.id === entry.id)),
    ].slice(0, MAX_RECENTS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A full or disabled store is not worth interrupting a navigation for.
  }
}
