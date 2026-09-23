"use client";

/**
 * National Regulatory Overview — Environmental Intelligence Command Center.
 * Layout strictly matching the provided reference system design:
 * Row 1: National Environmental Map + National Summary Grid
 * Row 2: AQI Distribution Donut + Top 5 Stations by AQI + Data Health Overview
 * Row 3: Recent Events Stream
 */

import { useMemo, useState } from "react";
import { Layers } from "lucide-react";

import StationMapLoader from "@/components/StationMapLoader";
import {
  AQIDistributionDonut,
  DataHealthOverviewCard,
  NationalSummaryPanel,
  RecentEventsRow,
  Top5StationsCard,
  useNetworkFacts,
} from "@/components/national/NationalPanels";
import { useStations, useSystemStatus } from "@/components/providers/LiveDataProvider";
import { EmptyState, ErrorState, SkeletonMap } from "@/components/ui/States";
import type { MapStation } from "@/components/StationMap";

/* One value for the map, its skeleton and the box that holds them, so the three
   cannot drift apart and make the page jump as the map loads. See StationMap for
   why this is a clamp and not a pixel count. */
const MAP_HEIGHT = "clamp(280px, 46vh, 440px)";

export default function HomePage() {
  const [focus, setFocus] = useState<string | null>(null);

  const stationsState = useStations();
  const statusState = useSystemStatus();

  const stations = stationsState.data;
  const status = statusState.data;
  const facts = useNetworkFacts(stations);

  const mapStations = useMemo<MapStation[]>(
    () =>
      (stations?.stations ?? [])
        .filter((s) => s.lat !== null && s.lon !== null)
        .map((s) => ({
          station: s.station,
          lat: s.lat as number,
          lon: s.lon as number,
          aqi: s.aqi,
          cpcb_band: s.cpcb_band,
          grap_stage: s.grap_stage,
          eri_score: s.eri_score,
          engine_mode: s.engine_mode,
          freshness_status: s.freshness_status,
          feed_id: s.feed_id,
          city: s.city,
        })),
    [stations],
  );

  return (
    <div className="space-y-4 max-w-[1600px] mx-auto w-full">
      {/* ── ROW 1: National Map + National Summary ── */}
      {stationsState.error && !stations ? (
        <ErrorState error={stationsState.error} onRetry={stationsState.refresh} />
      ) : (
        <div className="grid gap-4 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1.85fr)_minmax(340px,1.15fr)]">
          {/* Left Panel: National Environmental Map */}
          <div className="bg-aree-card border border-aree-border rounded-xl p-3 sm:p-5 shadow-xs flex flex-col justify-between">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="min-w-0">
                <h2 className="text-[12px] font-black tracking-wider uppercase text-aree-text font-sans">
                  DELHI NCR MONITORING NETWORK
                </h2>
                <p className="text-[11px] text-aree-dim mt-0.5">
                  Observed air quality and regulatory status across the NCR airshed
                </p>
              </div>
              <button
                type="button"
                className="shrink-0 p-1.5 rounded-lg border border-aree-border bg-aree-surface-2 hover:bg-aree-border text-aree-muted transition-colors"
                title="Layers"
              >
                <Layers className="w-4 h-4" />
              </button>
            </div>

            <div className="relative isolate rounded-lg overflow-hidden flex-1 min-h-[280px]">
              {stationsState.initialLoading ? (
                <SkeletonMap height={MAP_HEIGHT} />
              ) : mapStations.length === 0 ? (
                <EmptyState>
                  No station coordinates available yet. Markers appear as nodes come online.
                </EmptyState>
              ) : (
                <StationMapLoader
                  stations={mapStations}
                  selected={focus}
                  height={MAP_HEIGHT}
                  onSelect={setFocus}
                />
              )}

              {/* LEGEND — one row per ENCODING, not one row per concept.
                  This used to list the four freshness bands as coloured dots while
                  the markers on the map were coloured by AQI, so the key described
                  something the map was not doing. Colour and border are now separated
                  and each is named. */}
              {/* Sits ON the map, so it is constrained to the map's width and wraps
                  rather than pushing the card sideways. On a phone the two rows
                  become several; the alternative — a legend that overflows its own
                  map — is what the reader would have to scroll horizontally to read. */}
              <div className="absolute bottom-3 left-3 right-3 z-[1000] max-w-fit bg-aree-card/95 backdrop-blur-xs border border-aree-border px-3 py-2 rounded-lg shadow-sm text-[10px] sm:text-[10.5px] text-aree-text">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-bold uppercase tracking-wide text-[9px] text-aree-dim w-[52px]">
                    AQI
                  </span>
                  {[
                    ["0–50", "var(--aree-green)"],
                    ["51–100", "var(--aree-lime)"],
                    ["101–200", "var(--aree-amber)"],
                    ["201–300", "var(--aree-orange)"],
                    ["301–400", "var(--aree-red)"],
                    ["401+", "var(--aree-crimson)"],
                  ].map(([range, colour]) => (
                    <span key={range} className="flex items-center gap-1">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: colour }}
                      />
                      <span className="font-mono">{range}</span>
                    </span>
                  ))}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-aree-border pt-1.5">
                  <span className="font-bold uppercase tracking-wide text-[9px] text-aree-dim w-[52px]">
                    Data
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2.5 w-2.5 rounded-full border-2 border-solid border-aree-muted" />
                    Current
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2.5 w-2.5 rounded-full border-2 border-dashed border-aree-muted" />
                    Aging / stale
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2.5 w-2.5 rounded-full border-2 border-dotted border-aree-muted" />
                    No reading
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Panel: National Summary */}
          <NationalSummaryPanel
            facts={facts}
            status={status}
            stations={stations}
          />
        </div>
      )}

      {/* ── ROW 2: AQI Distribution + Top 5 Stations + Data Health Overview ── */}
      <div className="grid gap-4 grid-cols-[minmax(0,1fr)] md:grid-cols-2 lg:grid-cols-3">
        <AQIDistributionDonut facts={facts} />
        <Top5StationsCard facts={facts} />
        <DataHealthOverviewCard status={status} />
      </div>

      {/* ── ROW 3: Recent Events Stream ── */}
      <RecentEventsRow />
    </div>
  );
}
