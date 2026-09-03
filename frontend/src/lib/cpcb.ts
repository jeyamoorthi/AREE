/**
 * CPCB PM2.5 breakpoints (24-hour), the national standard.
 *
 * WHY THIS LIVES IN lib/ AND NOT IN THE MAP COMPONENT
 *   The legend on the Atmospheric Outlook and the symbols on the Leaflet map must
 *   agree, so the table has one home. It cannot be the map component: that module
 *   imports `leaflet/dist/leaflet.css` and react-leaflet, both of which need the DOM,
 *   which is why it is only ever reached through SpatialOutlookMapLoader with
 *   ssr:false. Importing the table from there would drag Leaflet into a server render.
 *
 * WHAT THIS TABLE IS FOR, AND WHAT IT IS NOT FOR
 *   It supplies a COLOUR and a numeric RANGE for a band name. It does not classify:
 *   which band a station is in always arrives from the backend (`station.band`,
 *   set by intelligence.pm25_band). Two classifiers would eventually disagree, and
 *   the one on the screen would be the one nobody validated.
 *
 *   The boundaries mirror intelligence.PM25_BANDS. They are the national standard —
 *   not a palette choice — so an officer can check a colour against the scale their
 *   own bulletins use.
 */

export interface CpcbBand {
  band: string;
  from: number;
  /** null = open-ended (Severe has no upper bound). */
  to: number | null;
  colour: string;
}

export const CPCB_PM25_BANDS: CpcbBand[] = [
  { band: "Good", from: 0, to: 30, colour: "#65ad5f" },
  { band: "Satisfactory", from: 30, to: 60, colour: "#9cbf54" },
  { band: "Moderate", from: 60, to: 90, colour: "#f4b942" },
  { band: "Poor", from: 90, to: 120, colour: "#f28c28" },
  { band: "Very Poor", from: 120, to: 250, colour: "#ef5b22" },
  { band: "Severe", from: 250, to: null, colour: "#d62828" },
];

const BAND_COLOUR: Record<string, string> = Object.fromEntries(
  CPCB_PM25_BANDS.map((b) => [b.band, b.colour]),
);

/** Slate, for a reading whose band the backend did not supply. */
export const UNKNOWN_BAND_COLOUR = "#94a3b8";

export function bandColour(band: string | null | undefined): string {
  return (band && BAND_COLOUR[band]) || UNKNOWN_BAND_COLOUR;
}

export const BAND_ORDER = CPCB_PM25_BANDS.map((b) => b.band);

/** "120–250 µg/m³", or "250+ µg/m³" for the open-ended top band. */
export function bandRange(b: CpcbBand): string {
  return b.to === null ? `${b.from}+ µg/m³` : `${b.from}–${b.to} µg/m³`;
}

/**
 * Symbol radius in PIXELS — never metres.
 *
 * Area ∝ concentration, so radius ∝ √concentration. Scaling the radius linearly would
 * make a station reading three times higher look nine times heavier.
 *
 * Bounded at both ends: below the floor the symbol is unclickable, and above the
 * ceiling neighbouring stations merge into a blob that starts to read as coverage —
 * which is the impression this whole encoding exists to avoid.
 */
export function symbolRadius(pm25: number): number {
  if (!Number.isFinite(pm25) || pm25 <= 0) return 4;
  return Math.max(4.5, Math.min(19, 3 + Math.sqrt(pm25) * 0.78));
}
