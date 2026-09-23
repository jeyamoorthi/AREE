/**
 * Reports generated on this browser.
 *
 * ⚠ TEMPORARY STORAGE, PENDING A DURABLE BACKEND.
 *   This is localStorage, and it is localStorage because there is nowhere else to put
 *   it yet. README.md is explicit under "What is not built yet": *"Durable storage —
 *   the escalation log lives in process memory. It does not survive a restart. There
 *   is no database behind it yet."* A report history has exactly the same problem, so
 *   until that database exists this keeps the record on the one machine that can hold
 *   it — the operator's own.
 *
 *   WHAT THAT MEANS, AND WHY THE UI HAS TO SAY IT
 *   This record is per-browser and per-device. It is not an audit trail, it is not
 *   shared with a colleague, and it will not appear on the next machine the same
 *   officer signs in from. The section that renders it says so, because a list of
 *   past regulatory documents that LOOKS authoritative and is in fact a browser cache
 *   is worse than no list at all. Replace this module with a real endpoint when one
 *   exists; the shape below is deliberately close to what such a row would be.
 *
 * WHAT IS STORED, AND WHY THESE FIELDS
 *   A snapshot of the conditions AT GENERATION TIME, not a pointer to live state.
 *   That is the opposite of the rule lib/recents follows — which stores identifiers
 *   only, precisely so nothing goes stale — and the difference is deliberate: a
 *   recent destination should always resolve to today's data, whereas a report is a
 *   document about one past moment and re-resolving it would rewrite history. Each
 *   row therefore carries its own AQI and stage and is never refreshed.
 *
 * EVERY ACCESS IS GUARDED
 *   localStorage throws outright in some contexts rather than returning null, and
 *   anything on the origin can rewrite it. Reads are wrapped, parsed defensively and
 *   shape-checked; a corrupted store degrades to "no history" and never to a crash.
 */

const STORAGE_KEY = "aree.reports.v1";

/** Kept small on purpose: this is a session aid, not an archive. */
export const MAX_HISTORY = 50;

export interface ReportRecord {
  /** UUID. Identifies the row, not the document — the engine mints no report ids. */
  id: string;
  /** Full engine station key, so the row can still be acted on. */
  station: string;
  /** ISO instant of generation, rendered in IST wherever it is displayed. */
  generatedAt: string;
  aqi: number | null;
  /**
   * The engine's exposure category at generation time.
   *
   * Its own vocabulary — "HIGH READINESS", "PRE-ESCALATION", "MONITOR",
   * "LOW READINESS" — not the severe/high/moderate/low ramp used elsewhere in the
   * UI, so it is displayed as text and never fed to riskLevelColor.
   */
  riskCategory: string | null;
  /**
   * The ERI score the category was derived from.
   *
   * Stored alongside the label because the label is the only thing that CANNOT be
   * coloured: eriColor thresholds the number, and deriving a colour from the words
   * would be a second classifier disagreeing with the engine's own banding.
   */
  eriScore: number | null;
  grapStage: string | null;
  /** The engine publishes one report format; the field exists for when it does not. */
  reportType: string;
}

function isRecord(value: unknown): value is ReportRecord {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    c.id.length > 0 &&
    c.id.length < 200 &&
    typeof c.station === "string" &&
    c.station.length > 0 &&
    c.station.length < 300 &&
    typeof c.generatedAt === "string" &&
    (c.aqi === null || typeof c.aqi === "number") &&
    (c.riskCategory === null || typeof c.riskCategory === "string") &&
    (c.eriScore === null || typeof c.eriScore === "number") &&
    (c.grapStage === null || typeof c.grapStage === "string") &&
    typeof c.reportType === "string"
  );
}

/* ── The store ────────────────────────────────────────────────────────────
   Two things read this list — the table that renders it and the download button
   that adds to it — and they are in different parts of the tree. Rather than lift
   the array into a provider, the module IS the store: React subscribes through
   useSyncExternalStore, which is also what keeps a value that already exists before
   the first render out of an effect.

   `cache` holds the snapshot because getSnapshot runs on every render and must
   return a stable reference; re-parsing localStorage each time would hand React a
   new array every time and re-render forever. */
const listeners = new Set<() => void>();
let cache: ReportRecord[] | null = null;

/** Stable empty array: the server has no localStorage and must render the same one. */
const EMPTY: ReportRecord[] = [];

export function subscribeReportHistory(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function getReportHistorySnapshot(): ReportRecord[] {
  if (cache === null) cache = readReportHistory();
  return cache;
}

/** What the server rendered, and therefore what hydration has to match. */
export function getReportHistoryServerSnapshot(): ReportRecord[] {
  return EMPTY;
}

function publish(next: ReportRecord[]): ReportRecord[] {
  cache = next;
  for (const listener of listeners) listener();
  return next;
}

/** Most recent first. Returns [] on the server, on absence, or on anything malformed. */
export function readReportHistory(): ReportRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord).slice(0, MAX_HISTORY);
  } catch {
    // Unreadable, unparseable, or storage refused. Either way: no history.
    return [];
  }
}

/** Prepend a record and cap the list. Returns the new list, [] on failure. */
export function appendReportRecord(record: ReportRecord): ReportRecord[] {
  if (typeof window === "undefined") return [];
  if (!isRecord(record)) return readReportHistory();
  /* NOT de-duplicated by station. Two briefs generated an hour apart describe two
     different sets of conditions, and collapsing them would delete the evidence that
     the second one was needed. */
  const next = [record, ...getReportHistorySnapshot()].slice(0, MAX_HISTORY);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A full or disabled store must not break the download that just succeeded.
    // The row still appears for this session; only its persistence is lost.
  }
  return publish(next);
}

export function clearReportHistory(): ReportRecord[] {
  if (typeof window === "undefined") return EMPTY;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: the list the caller renders is empty either way.
  }
  return publish(EMPTY);
}

/**
 * A fresh identifier for one generated report.
 *
 * crypto.randomUUID is not universally available — it needs a secure context, and
 * AREE is routinely opened over plain HTTP on a LAN — so there is a fallback. It is
 * used to key a list in a browser, not to secure anything, so a non-cryptographic
 * fallback is appropriate rather than a compromise.
 */
export function newReportId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
