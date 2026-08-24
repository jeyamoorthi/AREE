"use client";

/**
 * National station map.
 *
 * Markers carry two independent facts at once, because the operator needs
 * both: the fill colour is the AQI band, and the glyph is the backend's
 * freshness classification (● current, ◐ aging, ⚠ stale, × unavailable).
 * Neither is ever inferred here — both come straight from the API.
 *
 * Leaflet touches `window`, so this module is only loaded through
 * next/dynamic with ssr:false (see StationMapLoader).
 */

import "leaflet/dist/leaflet.css";

import L from "leaflet";
import { useEffect, useMemo } from "react";
import { MapContainer, Marker, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";

import { freshness } from "@/lib/freshness";
import { feedLabel, stationLabel } from "@/lib/station";
import { aqiColor, eriColor, modeColor } from "@/lib/theme";
import type { EngineMode, FreshnessStatus } from "@/types";

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

const INDIA_CENTER: [number, number] = [20.5937, 78.9629];

function markerSize(station: MapStation): number {
  const aqi = station.aqi ?? 0;
  if (aqi >= 400) return 34;
  if (aqi >= 300) return 30;
  if (aqi >= 200) return 27;
  if (aqi >= 100) return 24;
  if (aqi > 0) return 21;
  return 18;
}

/** Escape values interpolated into the marker's HTML. */
function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function buildIcon(station: MapStation, selected: boolean): L.DivIcon {
  const look = freshness(station.freshness_status);
  const unavailable = station.freshness_status === "unavailable";
  const color = unavailable ? "#64748b" : aqiColor(station.aqi);
  const size = markerSize(station);
  const ring = station.freshness_status === "current" ? color : look.color;

  // A divIcon renders a div, not an image, so the marker carries its own role
  // and label — the glyph alone must never be the whole message.
  const label = esc(
    `${stationLabel(station.station)}. AQI ${station.aqi ?? "unavailable"}. Data ${look.label}.`,
  );

  return L.divIcon({
    className: "aree-map-marker",
    html: `
      <div role="img" aria-label="${label}" class="${selected ? "aree-marker-focus" : ""}" style="
        width:${size}px;height:${size}px;border-radius:9999px;
        display:flex;align-items:center;justify-content:center;
        background:${unavailable ? "rgba(100,116,139,0.14)" : `color-mix(in srgb, ${color} 32%, transparent)`};
        border:2px solid ${ring};
        box-shadow:0 0 0 1px rgba(7,12,21,0.9)${selected ? `, 0 0 14px 2px color-mix(in srgb, ${color} 55%, transparent)` : ""};
        color:${ring};font-size:${Math.round(size * 0.42)}px;font-weight:700;line-height:1;
      ">${look.marker}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

/**
 * Keeps the viewport in step with the data without remounting the map:
 * fit every marker by default, fly to the selection when there is one.
 * Fitting bounds is what makes a scattered network legible — an averaged
 * centre with a fixed zoom can leave every marker off screen.
 */
function ViewController({
  points,
  focus,
}: {
  points: [number, number][];
  focus: [number, number] | null;
}) {
  const map = useMap();
  const key = JSON.stringify({ points, focus });

  // Base tiles are decorative; the markers carry the information and their own
  // labels. Hiding the tile pane keeps screen readers off a wall of image URLs.
  useEffect(() => {
    map.getPane("tilePane")?.setAttribute("aria-hidden", "true");
  }, [map]);

  useEffect(() => {
    if (focus) {
      map.flyTo(focus, Math.max(map.getZoom(), 11), { duration: 0.6 });
      return;
    }
    if (points.length === 0) return;
    if (points.length === 1) {
      map.flyTo(points[0], 11, { duration: 0.6 });
      return;
    }
    map.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 12 });
    // `key` is the stable identity of points/focus; the arrays themselves are
    // rebuilt on every poll and would otherwise refit the map continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);

  return null;
}

export default function StationMap({
  stations,
  height = 460,
  selected,
  onSelect,
}: {
  stations: MapStation[];
  height?: number;
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

  const initialCenter = focus ?? points[0] ?? INDIA_CENTER;

  return (
    <div
      className="border-aree-border relative overflow-hidden rounded-xl border"
      style={{ height }}
      role="region"
      aria-label={`Station map — ${stations.length} monitoring node${stations.length === 1 ? "" : "s"}`}
    >
      <MapContainer
        center={initialCenter}
        zoom={points.length === 0 ? 4 : 9}
        scrollWheelZoom={false}
        style={{ height: "100%", width: "100%" }}
        attributionControl
      >
        <ViewController points={points} focus={focus} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />

        {stations.map((station) => {
          const isSelected = station.station === selected;
          const look = freshness(station.freshness_status);
          const color =
            station.freshness_status === "unavailable"
              ? "#64748b"
              : aqiColor(station.aqi);
          return (
            <Marker
              key={station.station}
              position={[station.lat, station.lon]}
              icon={buildIcon(station, isSelected)}
              // Where markers overlap, the worst reading has to stay on top.
              zIndexOffset={(isSelected ? 1000 : 0) + (station.aqi ?? 0)}
              eventHandlers={
                onSelect ? { click: () => onSelect(station.station) } : undefined
              }
              alt={`${stationLabel(station.station)} — AQI ${station.aqi ?? "unavailable"} — data ${look.label}`}
            >
              <Tooltip direction="top" offset={[0, -8]} opacity={1}>
                <span style={{ color }}>
                  <strong>{stationLabel(station.station)}</strong> — AQI{" "}
                  {station.aqi ?? "—"} · {look.label}
                </span>
              </Tooltip>
              <Popup>
                <div style={{ minWidth: 210 }}>
                  <div
                    style={{ fontWeight: 700, color: "#f1f5f9", marginBottom: 2 }}
                  >
                    {stationLabel(station.station)}
                  </div>
                  {feedLabel(station.feed_id) ? (
                    <div style={{ color: "#64748b", fontSize: 11, marginBottom: 8 }}>
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
                      color: "#38bdf8",
                      display: "inline-block",
                      marginTop: 8,
                      fontSize: 11,
                      fontWeight: 600,
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
  color = "#e2e8f0",
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 14 }}>
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <span style={{ color, fontWeight: 600 }}>{value}</span>
    </div>
  );
}
