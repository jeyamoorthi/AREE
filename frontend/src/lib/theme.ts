// AREE Visual Theme — Environmental Intelligence Command Center
// Light warm ivory/cream surface system with deep forest green brand identity.

export const COLORS = {
  bg: "var(--aree-bg)",
  bgSoft: "var(--aree-bg-soft)",
  surface1: "var(--aree-surface-1)",
  surface2: "var(--aree-surface-2)",
  surface3: "var(--aree-surface-3)",
  surface4: "var(--aree-surface-4)",
  card: "var(--aree-card)",
  cardRaised: "var(--aree-card-raised)",
  border: "var(--aree-border)",
  borderStrong: "var(--aree-border-strong)",
  text: "var(--aree-text)",
  body: "var(--aree-body)",
  muted: "var(--aree-muted)",
  dim: "var(--aree-dim)",
  faint: "var(--aree-faint)",
  forest: "var(--aree-forest)",
  accent: "var(--aree-accent)",
  green: "var(--aree-green)",
  lime: "var(--aree-lime)",
  yellow: "var(--aree-yellow)",
  amber: "var(--aree-amber)",
  orange: "var(--aree-orange)",
  red: "var(--aree-red)",
  crimson: "var(--aree-crimson)",
  teal: "var(--aree-teal)",
  cyan: "var(--aree-cyan)",
  blue: "var(--aree-blue)",
} as const;

/**
 * The CPCB AQI bands and their colours — the ONE mapping every AQI surface uses.
 *
 * The map legend, the donut, the gauge and every band label all derive from this
 * table, so a band cannot be amber in one place and yellow in another. Severe is
 * crimson and Very Poor is red, everywhere.
 */
export const AQI_BANDS = [
  { key: "good", label: "Good", min: 0, max: 50, range: "0–50", color: COLORS.green },
  { key: "satisfactory", label: "Satisfactory", min: 51, max: 100, range: "51–100", color: COLORS.lime },
  { key: "moderate", label: "Moderate", min: 101, max: 200, range: "101–200", color: COLORS.amber },
  { key: "poor", label: "Poor", min: 201, max: 300, range: "201–300", color: COLORS.orange },
  { key: "very poor", label: "Very Poor", min: 301, max: 400, range: "301–400", color: COLORS.red },
  { key: "severe", label: "Severe", min: 401, max: Infinity, range: "401+", color: COLORS.crimson },
] as const;

export type AqiBand = (typeof AQI_BANDS)[number];

/** The band an AQI value falls in, or null when there is no value. */
export function aqiBand(aqi: number | null | undefined): AqiBand | null {
  if (aqi === null || aqi === undefined || Number.isNaN(aqi)) return null;
  return AQI_BANDS.find((b) => aqi <= b.max) ?? AQI_BANDS[AQI_BANDS.length - 1];
}

export function aqiColor(aqi: number | null | undefined): string {
  return aqiBand(aqi)?.color ?? COLORS.dim;
}

export function grapColor(stage: string | null | undefined): string {
  const s = String(stage ?? "");
  if (s.includes("IV")) return COLORS.crimson;
  if (s.includes("III")) return COLORS.red;
  if (s.includes("II")) return COLORS.orange;
  if (s.includes("I") && !s.includes("II") && !s.includes("IV")) return COLORS.amber;
  return COLORS.green;
}

export function eriColor(score: number | null | undefined): string {
  const v = score ?? 0;
  if (v >= 76) return COLORS.crimson;
  if (v >= 51) return COLORS.red;
  if (v >= 26) return COLORS.amber;
  return COLORS.green;
}

export function modeColor(mode: string | null | undefined): string {
  if (mode === "TRIGGERED") return COLORS.red;
  if (mode === "WATCH") return COLORS.amber;
  return COLORS.green;
}

export function riskLevelColor(level: string | null | undefined): string {
  switch (level) {
    case "severe":
      return COLORS.crimson;
    case "high":
      return COLORS.red;
    case "moderate":
      return COLORS.amber;
    case "low":
      return COLORS.green;
    default:
      return COLORS.faint;
  }
}

export function llmValueColor(value: string | null | undefined): string {
  const map: Record<string, string> = {
    low: COLORS.green,
    moderate: COLORS.amber,
    high: COLORS.red,
    severe: COLORS.crimson,
    unknown: COLORS.faint,
    rising: COLORS.red,
    stable: COLORS.amber,
    falling: COLORS.green,
  };
  return map[value ?? "unknown"] ?? COLORS.faint;
}

export const TRANSPORT_LABELS: Record<string, { color: string; text: string }> = {
  regional_transport: { color: COLORS.red, text: "Regional Transport Likely" },
  possible_transport: { color: COLORS.orange, text: "Possible Transport" },
  local_emission: { color: COLORS.green, text: "Local Emission Dominant" },
  calm: { color: COLORS.dim, text: "Wind Calm — Transport Unlikely" },
  none: { color: COLORS.dim, text: "No High-Confidence Thermal Anomalies Detected" },
};

export function transportLabel(label: string | null | undefined) {
  return (
    TRANSPORT_LABELS[label ?? "none"] ?? {
      color: COLORS.dim,
      text: "Awaiting Satellite Data",
    }
  );
}

export function confidenceColor(score: number | null | undefined): string {
  const v = score ?? 0;
  if (v >= 70) return COLORS.green;
  if (v >= 50) return COLORS.amber;
  return COLORS.red;
}

export function trendColor(direction: string | null | undefined): string {
  if (direction === "falling") return COLORS.green;
  if (direction === "rising") return COLORS.red;
  return COLORS.amber;
}

export function urgencyColor(urgency: string | null | undefined): string {
  switch (urgency) {
    case "CRITICAL":
      return COLORS.crimson;
    case "HIGH":
      return COLORS.red;
    case "MODERATE":
      return COLORS.amber;
    default:
      return COLORS.green;
  }
}

export function formatNumber(value: number | null | undefined, fallback = "—"): string {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  return value.toLocaleString();
}

export function orDash(value: unknown, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

export function grapRank(stage: string | null | undefined): number {
  const s = String(stage ?? "").toUpperCase();
  if (s.includes("IV")) return 4;
  if (s.includes("III")) return 3;
  if (s.includes("II")) return 2;
  if (s.includes("I")) return 1;
  return 0;
}

/** A CPCB band NAME's colour — the same table as aqiColor, looked up by label. */
export function bandColor(band: string | null | undefined): string {
  const b = String(band ?? "").toLowerCase();
  // "very poor" before "poor": the longer name must win the substring match.
  const match =
    AQI_BANDS.find((x) => x.key === "very poor" && b.includes(x.key)) ??
    AQI_BANDS.find((x) => b.includes(x.key));
  return match?.color ?? COLORS.dim;
}

export function modeLabel(mode: string | null | undefined): string {
  if (mode === "TRIGGERED") return "Triggered";
  if (mode === "WATCH") return "Watch";
  if (mode === "NORMAL") return "Within limits";
  return "—";
}
