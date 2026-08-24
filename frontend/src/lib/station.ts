/**
 * Station naming.
 *
 * The engine's station key embeds the WAQI feed — "Pooth Khurd — @11267".
 * The key stays authoritative everywhere (routing, API calls, reports); these
 * helpers only split it for display so the name and the feed are not repeated
 * next to each other.
 */

/** Station key with the trailing feed suffix removed. Never changes the key. */
export function stationLabel(station: string | null | undefined): string {
  if (!station) return "—";
  return station.replace(/\s+[—-]\s+@?[A-Za-z0-9_.-]+\s*$/u, "").trim() || station;
}

/** Feed id rendered with exactly one leading "@". */
export function feedLabel(feedId: string | null | undefined): string | null {
  if (!feedId) return null;
  const trimmed = feedId.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

/** Pollutant keys as WAQI reports them, rendered the way regulators write them. */
const POLLUTANT_LABELS: Record<string, string> = {
  pm25: "PM2.5",
  pm10: "PM10",
  no2: "NO₂",
  so2: "SO₂",
  o3: "O₃",
  co: "CO",
};

export function pollutantLabel(key: string | null | undefined): string {
  if (!key) return "—";
  return POLLUTANT_LABELS[key.toLowerCase()] ?? key.toUpperCase();
}
