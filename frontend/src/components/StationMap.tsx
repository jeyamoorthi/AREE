"use client";

/**
 * National station map — Environmental Command Platform.
 * Light/terrain basemap with color-coded station nodes.
 */

import "leaflet/dist/leaflet.css";

import L from "leaflet";
import { useEffect, useMemo } from "react";
import { MapContainer, Marker, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import MapResizeSync from "@/components/MapResizeSync";
import { freshness } from "@/lib/freshness";
import { feedLabel, stationLabel } from "@/lib/station";
import { aqiColor, eriColor, modeColor } from "@/lib/theme";
import type { EngineMode, FreshnessStatus } from "@/types";

/* CARTO raster basemap.
 *
 * The key lives in the environment, not in this file. It is a browser-side
 * basemap key so it is inherently visible in the bundle - that is how tile
 * auth works - but keeping it out of source control means it is not shared
 * with anyone who clones the repository, which is what CARTO asks.
 *
 * Without a key the tiles still render, watermarked. So a missing key degrades
 * the map's appearance and nothing else, and the app does not need to care.
 *
 * NOTE: CARTO are retiring raster in favour of vector tiles (sharper at any
 * zoom, fresher data, restyleable). The key already covers vector, so that
 * migration is a URL and layer change here when we choose to make it.
 */
const CARTO_KEY = process.env.NEXT_PUBLIC_CARTO_KEY ?? "";
const BASEMAP_URL =
  "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png" +
  (CARTO_KEY ? `?key=${CARTO_KEY}` : "");

export interface MapStation {
  station: string;
  lat: number;
  lon: number;
  aqi: number | null;
  cpcb_band: string | null;
  grap_stage: string | null;
  eri_score: number | null;
  engine_mode: EngineMode | null;
  freshness_status: FreshnessStatus;
  feed_id?: string | null;
  city?: string | null;
}

/* The network is Delhi NCR, not India. Opening on the country centroid at zoom 5 put
   71 NCR stations in one indistinguishable clump somewhere north of the middle of the
   frame, and the title said "across India" over it. Bounds match
   ncr_observations.NCR_BBOX on the backend. */
/* Opening view. Fitting the whole NCR box lands at zoom ~8, where the ~50 stations
   inside Delhi/Gurugram/Noida/Faridabad collapse into one clump. Zoom 10 on the core
   spreads them out; the outlying towns (Meerut, Sonipat, Rewari) are a pan away. */
const NCR_CORE_CENTER: [number, number] = [28.6, 77.15];
const NCR_CORE_ZOOM = 10;
const NCR_BOUNDS: [[number, number], [number, number]] = [
  [27.9, 76.5],
  [29.3, 77.9],
];

/**
 * Marker diameter in pixels.
 *
 * Roughly thirty of the NCR's monitors sit inside twenty kilometres of central Delhi,
 * and at 20-28 px they merged into one blob at the region zoom — the densest, most
 * important part of the network was the least readable part of the map. The range is
 * now 14-22 px, which separates them at zoom 9 while keeping the severity ramp legible.
 *
 * Size still tracks AQI so the eye is drawn to the worst nodes, but the spread is
 * deliberately narrow: on this map severity is carried by COLOUR, and size is only a
 * secondary emphasis. The Atmospheric Outlook's map is the one where size is the
 * quantitative encoding.
 */
function markerSize(station: MapStation): number {
  const aqi = station.aqi ?? 0;
  if (aqi >= 400) return 22;
  if (aqi >= 300) return 20;
  if (aqi >= 200) return 18;
  if (aqi >= 100) return 16;
  return 14;
}

/**
 * Marker opacity by freshness.
 *
 * The third channel after colour (severity) and border style (freshness): a marker
 * whose reading has stopped moving is dimmed so the eye lands on the live ones
 * first. The floor stays well above invisible — an unavailable station is still a
 * station on the network, and losing it from the map would misreport coverage.
 */
const FRESHNESS_EMPHASIS: Record<FreshnessStatus, number> = {
  current: 1,
  aging: 0.85,
  stale: 0.7,
  unavailable: 0.5,
};

function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function buildIcon(station: MapStation, selected: boolean): L.DivIcon {
  // COLOUR IS SEVERITY, ALWAYS.
  //
  // This used to substitute grey whenever freshness was "unavailable", which put two
  // unrelated meanings on one channel: a reader could not tell a clean station from a
  // station whose feed had stopped, and the legend underneath listed the freshness
  // bands while the markers were actually coloured by AQI. Freshness now rides on the
  // BORDER STYLE, so an ageing reading of 380 stays red and merely looks provisional.
  //
  // aqiColor(null) already returns the neutral tone, so a station with no reading is
  // still visually distinct without the override.
  const color = aqiColor(station.aqi);
  const size = markerSize(station);
  const fresh = station.freshness_status;

  const borderStyle =
    fresh === "current" ? "solid" : fresh === "unavailable" ? "dotted" : "dashed";
  // A station with no usable AQI gets a hollow centre rather than a different hue.
  const centre =
    fresh === "unavailable"
      ? ""
      : `<div style="width:6px;height:6px;border-radius:9999px;background:${color};"></div>`;

  const freshLabel =
    fresh === "current"
      ? "current"
      : fresh === "unavailable"
        ? "no usable reading"
        : `${fresh} data`;
  const label = esc(
    `${stationLabel(station.station)}. AQI ${station.aqi ?? "unavailable"}, ${freshLabel}.`,
  );

  /* A selected station is never dimmed: the operator has just asked for it, and a
     faded answer to a direct request reads as a failure rather than as a caveat. */
  const emphasis = selected ? 1 : FRESHNESS_EMPHASIS[fresh];

  return L.divIcon({
    className: "aree-map-marker",
    html: `
      <div role="img" aria-label="${label}" style="
        width:${size}px;height:${size}px;border-radius:9999px;
        display:flex;align-items:center;justify-content:center;
        background:var(--aree-surface-1);
        border:3px ${borderStyle} ${color};
        opacity:${emphasis};
        box-shadow:0 2px 5px rgba(0,0,0,0.25)${selected ? `, 0 0 0 3px var(--aree-forest)` : ""};
      ">
        ${centre}
      </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

function ViewController({
  points,
  focus,
}: {
  points: [number, number][];
  focus: [number, number] | null;
}) {
  const map = useMap();
  const key = JSON.stringify({ points, focus });

  useEffect(() => {
    map.getPane("tilePane")?.setAttribute("aria-hidden", "true");
  }, [map]);

  /* Wheel zoom only after the operator clicks into the map, and off again when the
     pointer leaves, so scrolling the page past the map never hijacks into a zoom. */
  useEffect(() => {
    const enable = () => map.scrollWheelZoom.enable();
    const disable = () => map.scrollWheelZoom.disable();
    map.on("click", enable);
    map.on("mouseout", disable);
    return () => {
      map.off("click", enable);
      map.off("mouseout", disable);
    };
  }, [map]);

  useEffect(() => {
    if (focus) {
      map.flyTo(focus, Math.max(map.getZoom(), 10), { duration: 0.6 });
      return;
    }
    if (points.length === 0) return;
    if (points.length === 1) {
      map.flyTo(points[0], 10, { duration: 0.6 });
      return;
    }
    map.setView(NCR_CORE_CENTER, NCR_CORE_ZOOM);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);

  return null;
}

/**
 * Default height.
 *
 * A fixed pixel height is the wrong unit for a map that has to work on a 360px
 * phone and a 1600px desk monitor: 480px is two thirds of a phone's viewport, so
 * the map fills the screen and the page appears to end at it. `clamp` keeps the
 * map proportional to the viewport between a floor that is still a usable map and
 * a ceiling that leaves the cards below it visible on a laptop.
 */
const DEFAULT_HEIGHT = "clamp(280px, 46vh, 480px)";

export default function StationMap({
  stations,
  height = DEFAULT_HEIGHT,
  selected,
  onSelect,
}: {
  stations: MapStation[];
  /** A number is treated as pixels; a string is passed to CSS untouched. */
  height?: number | string;
  selected?: string | null;
  onSelect?: (station: string) => void;
}) {
  const points = useMemo<[number, number][]>(
    () => stations.map((s) => [s.lat, s.lon] as [number, number]),
    [stations],
  );

  const focus = useMemo<[number, number] | null>(() => {
    const match = selected ? stations.find((s) => s.station === selected) : undefined;
    return match ? [match.lat, match.lon] : null;
  }, [stations, selected]);

  const initialCenter = focus ?? NCR_CORE_CENTER;

  return (
    <div
      className="relative overflow-hidden rounded-xl border border-aree-border shadow-xs"
      style={{ height }}
      role="region"
      aria-label={`Station map — ${stations.length} monitoring node${stations.length === 1 ? "" : "s"}`}
    >
      <MapContainer
        center={initialCenter}
        zoom={NCR_CORE_ZOOM}
        minZoom={7}
        maxBounds={NCR_BOUNDS}
        maxBoundsViscosity={0.7}
        scrollWheelZoom={false}
        style={{ height: "100%", width: "100%" }}
        attributionControl
      >
        <ViewController points={points} focus={focus} />
        <MapResizeSync />
        {/* CARTO Voyager / OpenStreetMap light terrain tiles.

            The attribution below is not decoration: keeping the CARTO and
            OpenStreetMap credit visible is the condition of the free tier, so
            it must not be removed or moved behind a control. */}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url={BASEMAP_URL}
        />

        {stations.map((station) => {
          const isSelected = station.station === selected;
          const look = freshness(station.freshness_status);
          // Same rule as the icon: severity sets the colour, freshness is its own row.
          const color = aqiColor(station.aqi);
          return (
            <Marker
              key={station.station}
              position={[station.lat, station.lon]}
              icon={buildIcon(station, isSelected)}
              zIndexOffset={(isSelected ? 1000 : 0) + (station.aqi ?? 0)}
              eventHandlers={
                onSelect ? { click: () => onSelect(station.station) } : undefined
              }
              alt={`${stationLabel(station.station)} — AQI ${station.aqi ?? "unavailable"}`}
            >
              <Tooltip direction="top" offset={[0, -8]} opacity={1}>
                <span style={{ color: "var(--aree-text)", fontWeight: 600 }}>
                  <strong>{stationLabel(station.station)}</strong> — AQI{" "}
                  {station.aqi ?? "—"}
                </span>
              </Tooltip>
              <Popup>
                <div style={{ minWidth: 200, fontFamily: "var(--font-sans)", padding: "4px 0" }}>
                  <div
                    style={{ fontWeight: 800, color: "var(--aree-text)", marginBottom: 2, fontSize: 13 }}
                  >
                    {stationLabel(station.station)}
                  </div>
                  {feedLabel(station.feed_id) ? (
                    <div style={{ color: "var(--aree-muted)", fontSize: 11, marginBottom: 8 }}>
                      {feedLabel(station.feed_id)}
                      {station.city ? ` · ${station.city}` : ""}
                    </div>
                  ) : null}
                  <Row label="AQI" value={station.aqi ?? "—"} color={color} />
                  <Row label="Band" value={station.cpcb_band ?? "—"} />
                  <Row label="GRAP" value={station.grap_stage ?? "—"} />
                  <Row
                    label="ERI"
                    value={station.eri_score ?? "—"}
                    color={eriColor(station.eri_score)}
                  />
                  <Row
                    label="Regulatory"
                    value={station.engine_mode ?? "—"}
                    color={modeColor(station.engine_mode)}
                  />
                  <Row
                    label="Data"
                    value={`${look.marker} ${look.label}`}
                    color={look.color}
                  />
                  <a
                    href={`/stations/${encodeURIComponent(station.station)}`}
                    style={{
                      color: "var(--aree-forest)",
                      display: "inline-block",
                      marginTop: 10,
                      fontSize: 11.5,
                      fontWeight: 700,
                      textDecoration: "none"
                    }}
                  >
                    Open command center →
                  </a>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}

function Row({
  label,
  value,
  color = "var(--aree-text)",
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="flex justify-between gap-3 mb-1 text-xs">
      <span className="text-aree-muted">{label}</span>
      <span className="font-bold" style={{ color }}>{value}</span>
    </div>
  );
}
