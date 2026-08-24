"use client";

/**
 * National station map — Environmental Command Platform.
 * Light/terrain basemap with color-coded station nodes and freshness halos.
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

const INDIA_CENTER: [number, number] = [22.5937, 78.9629];

function markerSize(station: MapStation): number {
  const aqi = station.aqi ?? 0;
  if (aqi >= 400) return 28;
  if (aqi >= 300) return 26;
  if (aqi >= 200) return 24;
  if (aqi >= 100) return 22;
  return 20;
}

function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function buildIcon(station: MapStation, selected: boolean): L.DivIcon {
  const unavailable = station.freshness_status === "unavailable";
  const color = unavailable ? "#788796" : aqiColor(station.aqi);
  const size = markerSize(station);

  const label = esc(
    `${stationLabel(station.station)}. AQI ${station.aqi ?? "unavailable"}.`,
  );

  return L.divIcon({
    className: "aree-map-marker",
    html: `
      <div role="img" aria-label="${label}" style="
        width:${size}px;height:${size}px;border-radius:9999px;
        display:flex;align-items:center;justify-content:center;
        background:#ffffff;
        border:3px solid ${color};
        box-shadow:0 2px 5px rgba(0,0,0,0.25)${selected ? `, 0 0 0 3px #143828` : ""};
      ">
        <div style="width:6px;height:6px;border-radius:9999px;background:${color};"></div>
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

  useEffect(() => {
    if (focus) {
      map.flyTo(focus, Math.max(map.getZoom(), 10), { duration: 0.6 });
      return;
    }
    if (points.length === 0) return;
    if (points.length === 1) {
      map.flyTo(points[0], 9, { duration: 0.6 });
      return;
    }
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 10 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);

  return null;
}

export default function StationMap({
  stations,
  height = 480,
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

  const initialCenter = focus ?? INDIA_CENTER;

  return (
    <div
      className="relative overflow-hidden rounded-xl border border-[#e4e0d4] shadow-xs"
      style={{ height }}
      role="region"
      aria-label={`Station map — ${stations.length} monitoring node${stations.length === 1 ? "" : "s"}`}
    >
      <MapContainer
        center={initialCenter}
        zoom={5}
        scrollWheelZoom={false}
        style={{ height: "100%", width: "100%" }}
        attributionControl
      >
        <ViewController points={points} focus={focus} />
        {/* CARTO Voyager / OpenStreetMap light terrain tiles */}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
        />

        {stations.map((station) => {
          const isSelected = station.station === selected;
          const look = freshness(station.freshness_status);
          const color =
            station.freshness_status === "unavailable"
              ? "#788796"
              : aqiColor(station.aqi);
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
                <span style={{ color: "#17231c", fontWeight: 600 }}>
                  <strong>{stationLabel(station.station)}</strong> — AQI{" "}
                  {station.aqi ?? "—"}
                </span>
              </Tooltip>
              <Popup>
                <div style={{ minWidth: 200, fontFamily: "var(--font-sans)", padding: "4px 0" }}>
                  <div
                    style={{ fontWeight: 800, color: "#17231c", marginBottom: 2, fontSize: 13 }}
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
                      color: "#143828",
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
  color = "#17231c",
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="flex justify-between gap-3 mb-1 text-xs">
      <span className="text-[#64748b]">{label}</span>
      <span className="font-bold" style={{ color }}>{value}</span>
    </div>
  );
}
