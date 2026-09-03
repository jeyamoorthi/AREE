"use client";

/* ==========================================================================
   Spatial outlook — the observed NCR field on real geography.

   WHAT THIS MAP CLAIMS, AND WHAT IT REFUSES TO CLAIM
     It shows WHERE MONITORS ARE AND WHAT THEY MEASURED. Nothing else. There is
     no interpolation, no plume, no modelled extent and no spatial forecast,
     because AREE has none of those: the PM2.5 forecast is a single point at the
     NCR centroid. A map that implied otherwise would be the most convincing
     false claim in the product.

   WHY PROPORTIONAL SYMBOLS AND NOT HALOS
     This drew a 5-15 km translucent Circle around every station, sized by band.
     On screen that reads as a measured plume: "pollution extends fifteen
     kilometres around Anand Vihar". It does not. A proportional symbol - a
     hard-edged dot whose AREA scales with concentration - says "this station
     read this high" and cannot be mistaken for spatial extent.

     Radius uses sqrt(value) so that AREA, not radius, is proportional to the
     reading. Scaling radius linearly triples the visual weight of a value that
     is three times larger, which overstates it.

   COLOUR IS SEVERITY. FRESHNESS IS NOT COLOUR.
     The CPCB band arrives from the backend and is the only thing that sets
     colour. Data age is a separate fact and gets a separate, quieter cue - a
     dashed ring and a line in the tooltip - because a stale reading of 300 is
     still a reading of 300, and greying it out hides the severity behind a
     data-plumbing concern.
   ========================================================================== */

import "leaflet/dist/leaflet.css";

import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip } from "react-leaflet";
import type { LatLngBoundsExpression } from "leaflet";

import { bandColour, symbolRadius } from "@/lib/cpcb";

export interface SpatialStation {
  station: string;
  place: string;
  pm25: number;
  /** CPCB band, classified by the backend. The UI never re-derives it. */
  band: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Who measured it, e.g. "CPCB CAAQMS via data.gov.in". */
  source?: string | null;
}

/* The Delhi NCR domain, identical to ncr_observations.NCR_BBOX on the backend.
   The view is pinned to the REGION rather than fitted to the stations: on an hour
   when six monitors report, fitting to them zooms into a few square kilometres and
   the map stops being a map of the NCR. */
const NCR_BOUNDS: LatLngBoundsExpression = [
  [27.9, 76.5],
  [29.3, 77.9],
];

const CARTO_KEY = process.env.NEXT_PUBLIC_CARTO_KEY ?? "";
const BASEMAP_URL =
  "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png" +
  (CARTO_KEY ? `?key=${CARTO_KEY}` : "");

function ist(iso: string | undefined, withDate = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
  if (!withDate) return `${time} IST`;
  const day = d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
  return `${day} · ${time} IST`;
}

function ageLabel(hours: number | undefined): string | null {
  if (hours === undefined || hours === null || !Number.isFinite(hours)) return null;
  const minutes = Math.round(hours * 60);
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `${minutes} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

export default function SpatialOutlookMap({
  stations,
  height = 260,
  labelCount = 4,
  observedAt,
  ageHours,
}: {
  stations: SpatialStation[];
  height?: number;
  labelCount?: number;
  /** The hour every reading on this map describes. */
  observedAt?: string;
  /** How far before as_of that hour sits. */
  ageHours?: number;
}) {
  const pts = stations.filter((s) => s.latitude != null && s.longitude != null);

  // Age is a property of the HOUR, not of individual stations: every reading here
  // comes from the same timestamp. A dashed ring marks the whole set as ageing rather
  // than pretending to per-station freshness the payload does not carry.
  const stale = (ageHours ?? 0) >= 2;
  const age = ageLabel(ageHours);

  /* Permanent labels for the worst places, de-cluttered.
     Labelling by rank alone put four labels on top of each other whenever the
     reporting stations were clustered — six OpenAQ sensors inside Delhi produced four
     overlapping captions and no legible name. A label is now skipped if an
     already-labelled station sits within roughly nine kilometres, so the captions that
     survive are readable and the rest are one click away in the popup. */
  const LABEL_MIN_SEPARATION_DEG = 0.08;
  const labelledStations: SpatialStation[] = [];
  const labelled = new Set<string>();
  for (const s of [...pts].sort((a, b) => b.pm25 - a.pm25)) {
    if (labelledStations.length >= labelCount) break;
    if (labelled.has(s.place)) continue;
    const crowded = labelledStations.some(
      (o) =>
        Math.abs((o.latitude as number) - (s.latitude as number)) <
          LABEL_MIN_SEPARATION_DEG &&
        Math.abs((o.longitude as number) - (s.longitude as number)) <
          LABEL_MIN_SEPARATION_DEG,
    );
    if (crowded) continue;
    labelledStations.push(s);
    labelled.add(s.place);
  }
  const labelledKeys = new Set(labelledStations.map((s) => s.station));

  return (
    <MapContainer
      bounds={NCR_BOUNDS}
      /* Leaflet snaps fitBounds to whole zoom levels, so fitting a 1.4° box into a
         short wide card overshot to the next level out and framed Karnal to Alwar —
         twice the NCR — with the stations as a dot in the middle. Quarter-level snapping
         lets the fit land on the region it was given. */
      zoomSnap={0.25}
      minZoom={7}
      maxBounds={NCR_BOUNDS}
      maxBoundsViscosity={0.6}
      scrollWheelZoom={false}
      style={{ height, width: "100%", borderRadius: 8 }}
      attributionControl
      zoomControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url={BASEMAP_URL}
      />

      {/* Drawn largest-first so a small clean station is never hidden underneath a
          large severe one. */}
      {[...pts]
        .sort((a, b) => b.pm25 - a.pm25)
        .map((s) => {
          const colour = bandColour(s.band);
          const showLabel = labelledKeys.has(s.station);
          return (
            <CircleMarker
              key={s.station}
              center={[s.latitude as number, s.longitude as number]}
              radius={symbolRadius(s.pm25)}
              pathOptions={{
                color: "#ffffff",
                weight: 1.4,
                // Freshness cue: a dashed outline, never a different fill. A stale
                // reading of 300 is still 300.
                dashArray: stale ? "2 2" : undefined,
                fillColor: colour,
                fillOpacity: 0.82,
              }}
            >
              {showLabel && (
                <Tooltip
                  permanent
                  direction="right"
                  offset={[8, 0]}
                  className="aree-map-label"
                >
                  {s.place}
                </Tooltip>
              )}
              <Popup>
                <div style={{ minWidth: 190, fontSize: 12 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6, lineHeight: 1.3 }}>
                    {s.station}
                  </div>
                  <Row label="PM2.5" value={`${s.pm25.toFixed(0)} µg/m³`} bold />
                  <Row label="Band" value={s.band ?? "—"} colour={colour} bold />
                  <Row label="Observed" value={ist(observedAt)} />
                  {age ? <Row label="Age" value={age} /> : null}
                  <Row label="Source" value={s.source ?? "not recorded"} />
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
    </MapContainer>
  );
}

function Row({
  label,
  value,
  colour,
  bold,
}: {
  label: string;
  value: string;
  colour?: string;
  bold?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: 2,
      }}
    >
      <span style={{ color: "#64748b" }}>{label}</span>
      <span
        style={{
          color: colour ?? "#17231c",
          fontWeight: bold ? 700 : 500,
          textAlign: "right",
        }}
      >
        {value}
      </span>
    </div>
  );
}
