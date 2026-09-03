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
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.85fr)_minmax(340px,1.15fr)]">
          {/* Left Panel: National Environmental Map */}
          <div className="bg-white border border-[#e4e0d4] rounded-xl p-5 shadow-xs flex flex-col justify-between">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-[12px] font-black tracking-wider uppercase text-[#17231c] font-sans">
                  DELHI NCR MONITORING NETWORK
                </h2>
                <p className="text-[11px] text-[#788796] mt-0.5">
                  Observed air quality and regulatory status across the NCR airshed
                </p>
              </div>
              <button
                type="button"
                className="p-1.5 rounded-lg border border-[#e4e0d4] bg-[#faf9f4] hover:bg-[#f0eee4] text-[#64748b] transition-colors"
                title="Layers"
              >
                <Layers className="w-4 h-4" />
              </button>
            </div>

            <div className="relative rounded-lg overflow-hidden flex-1 min-h-[380px]">
              {stationsState.initialLoading ? (
                <SkeletonMap height={400} />
              ) : mapStations.length === 0 ? (
                <EmptyState>
                  No station coordinates available yet. Markers appear as nodes come online.
                </EmptyState>
              ) : (
                <StationMapLoader
                  stations={mapStations}
                  selected={focus}
                  height={400}
                  onSelect={setFocus}
                />
              )}

              {/* LEGEND — one row per ENCODING, not one row per concept.
                  This used to list the four freshness bands as coloured dots while
                  the markers on the map were coloured by AQI, so the key described
                  something the map was not doing. Colour and border are now separated
                  and each is named. */}
              <div className="absolute bottom-3 left-3 z-[1000] bg-white/95 backdrop-blur-xs border border-[#e4e0d4] px-3 py-2 rounded-lg shadow-sm text-[10.5px] text-[#17231c]">
                <div className="flex items-center gap-3">
                  <span className="font-bold uppercase tracking-wide text-[9px] text-[#788796] w-[52px]">
                    AQI
                  </span>
                  {[
                    ["0–50", "#16a34a"],
                    ["51–100", "#65a30d"],
                    ["101–200", "#d97706"],
                    ["201–300", "#ea580c"],
                    ["301–400", "#dc2626"],
                    ["401+", "#991b1b"],
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
                <div className="mt-1.5 flex items-center gap-3 border-t border-[#f0eee4] pt-1.5">
                  <span className="font-bold uppercase tracking-wide text-[9px] text-[#788796] w-[52px]">
                    Data
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2.5 w-2.5 rounded-full border-2 border-solid border-[#64748b]" />
                    Current
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2.5 w-2.5 rounded-full border-2 border-dashed border-[#64748b]" />
                    Aging / stale
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2.5 w-2.5 rounded-full border-2 border-dotted border-[#64748b]" />
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
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <AQIDistributionDonut facts={facts} />
        <Top5StationsCard facts={facts} />
        <DataHealthOverviewCard status={status} />
      </div>

      {/* ── ROW 3: Recent Events Stream ── */}
      <RecentEventsRow />
    </div>
  );
}
