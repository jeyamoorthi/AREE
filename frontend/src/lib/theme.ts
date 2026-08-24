// AREE visual identity. The semantic ramp (AQI bands, GRAP stages, freshness)
// is unchanged; the surface tokens mirror the CSS custom properties in
// globals.css so charts rendered in JS match the panels around them.

export const COLORS = {
  bg: "#070c15",
  bgSoft: "#0a0f1a",
  card: "#0e1523",
  cardRaised: "#131c2e",
  border: "#1b2740",
  borderStrong: "#2b3b57",
  text: "#f1f5f9",
  body: "#dbe4ef",
  muted: "#94a3b8",
  dim: "#64748b",
  faint: "#475569",
  accent: "#38bdf8",
  blue: "#3b82f6",
  cyan: "#00FFD1",
  teal: "#2dd4bf",
  green: "#22c55e",
  lime: "#84cc16",
  yellow: "#eab308",
  orange: "#f97316",
  red: "#ef4444",
  crimson: "#dc2626",
  amber: "#fbbf24",
} as const;

export function aqiColor(aqi: number | null | undefined): string {
  if (aqi === null || aqi === undefined) return COLORS.dim;
  if (aqi <= 50) return COLORS.green;
  if (aqi <= 100) return COLORS.lime;
  if (aqi <= 200) return COLORS.yellow;
  if (aqi <= 300) return COLORS.orange;
  if (aqi <= 400) return COLORS.red;
  return COLORS.crimson;
}

export function grapColor(stage: string | null | undefined): string {
  const s = String(stage ?? "");
  if (s.includes("IV")) return COLORS.crimson;
  if (s.includes("III")) return COLORS.red;
  if (s.includes("II")) return COLORS.orange;
  if (s.includes("I") && !s.includes("II") && !s.includes("IV")) return COLORS.yellow;
  return COLORS.green;
}

export function eriColor(score: number | null | undefined): string {
  const v = score ?? 0;
  if (v >= 76) return COLORS.crimson;
  if (v >= 51) return COLORS.red;
  if (v >= 26) return COLORS.yellow;
  return COLORS.green;
}

export function modeColor(mode: string | null | undefined): string {
  if (mode === "TRIGGERED") return COLORS.red;
  if (mode === "WATCH") return COLORS.orange;
  return COLORS.green;
}

export function riskLevelColor(level: string | null | undefined): string {
  switch (level) {
    case "severe":
      return COLORS.crimson;
    case "high":
      return COLORS.red;
    case "moderate":
      return COLORS.yellow;
    case "low":
      return COLORS.green;
    default:
      return COLORS.faint;
  }
}

/** Colour map used by the AI risk interpretation chips. */
export function llmValueColor(value: string | null | undefined): string {
  const map: Record<string, string> = {
    low: COLORS.green,
    moderate: COLORS.yellow,
    high: COLORS.red,
    severe: COLORS.crimson,
    unknown: COLORS.faint,
    rising: COLORS.red,
    stable: COLORS.yellow,
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
  if (v >= 50) return COLORS.yellow;
  return COLORS.red;
}

export function trendColor(direction: string | null | undefined): string {
  if (direction === "falling") return COLORS.green;
  if (direction === "rising") return COLORS.red;
  return COLORS.yellow;
}

export function urgencyColor(urgency: string | null | undefined): string {
  switch (urgency) {
    case "CRITICAL":
      return COLORS.crimson;
    case "HIGH":
      return COLORS.red;
    case "MODERATE":
      return COLORS.yellow;
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

/**
 * Ordinal severity of a GRAP stage string, for picking the worst stage across
 * the network. The backend owns stage assignment; this only orders labels.
 */
export function grapRank(stage: string | null | undefined): number {
  const s = String(stage ?? "").toUpperCase();
  if (s.includes("IV")) return 4;
  if (s.includes("III")) return 3;
  if (s.includes("II")) return 2;
  if (s.includes("I")) return 1;
  return 0;
}

/** Colour for a CPCB band label as reported by the backend. */
export function bandColor(band: string | null | undefined): string {
  const b = String(band ?? "").toLowerCase();
  if (b.includes("severe")) return COLORS.crimson;
  if (b.includes("very poor")) return COLORS.red;
  if (b.includes("poor")) return COLORS.orange;
  if (b.includes("moderate")) return COLORS.yellow;
  if (b.includes("satisfactory")) return COLORS.lime;
  if (b.includes("good")) return COLORS.green;
  return COLORS.dim;
}

/** Human label for the regulatory engine mode. */
export function modeLabel(mode: string | null | undefined): string {
  if (mode === "TRIGGERED") return "Triggered";
  if (mode === "WATCH") return "Watch";
  if (mode === "NORMAL") return "Within limits";
  return "—";
}
