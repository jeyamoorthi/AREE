// AREE Visual Theme — Environmental Intelligence Command Center
// Light warm ivory/cream surface system with deep forest green brand identity.

export const COLORS = {
  bg: "#f5f4ed",
  bgSoft: "#edebe2",
  surface1: "#ffffff",
  surface2: "#faf9f4",
  surface3: "#f2efe6",
  surface4: "#e8e4d7",
  card: "#ffffff",
  cardRaised: "#ffffff",
  border: "#e4e0d4",
  borderStrong: "#cfcaba",
  text: "#17231c",
  body: "#2d3748",
  muted: "#64748b",
  dim: "#788796",
  faint: "#9ba8b5",
  forest: "#143828",
  accent: "#22c55e",
  green: "#16a34a",
  lime: "#65a30d",
  yellow: "#ca8a04",
  amber: "#d97706",
  orange: "#ea580c",
  red: "#dc2626",
  crimson: "#991b1b",
  teal: "#0d9488",
  cyan: "#0284c7",
  blue: "#2563eb",
} as const;

export function aqiColor(aqi: number | null | undefined): string {
  if (aqi === null || aqi === undefined) return COLORS.dim;
  if (aqi <= 50) return COLORS.green;
  if (aqi <= 100) return COLORS.lime;
  if (aqi <= 200) return COLORS.amber;
  if (aqi <= 300) return COLORS.orange;
  if (aqi <= 400) return COLORS.red;
  return COLORS.crimson;
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

export function modeLabel(mode: string | null | undefined): string {
  if (mode === "TRIGGERED") return "Triggered";
  if (mode === "WATCH") return "Watch";
  if (mode === "NORMAL") return "Within limits";
  return "—";
}
