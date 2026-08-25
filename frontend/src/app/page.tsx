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
                  NATIONAL ENVIRONMENTAL MAP
                </h2>
                <p className="text-[11px] text-[#788796] mt-0.5">
                  Live air quality and regulatory status across India
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

              {/* Floating Bottom Freshness Legend matching image */}
              <div className="absolute bottom-3 left-3 z-[1000] bg-white/95 backdrop-blur-xs border border-[#e4e0d4] px-3 py-1.5 rounded-lg shadow-sm flex items-center gap-4 text-[11px] font-semibold text-[#17231c]">
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#16a34a]" />
                  <span>Current</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#ca8a04]" />
                  <span>Aging</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#ea580c]" />
                  <span>Stale</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-[#788796]">⊗</span>
                  <span>Unavailable</span>
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
