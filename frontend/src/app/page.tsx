"use client";

/**
 * National Regulatory Overview — the hero screen.
 *
 * The first viewport answers the operator's first three questions at once:
 * where the problem is (map), how serious it is (national summary) and
 * whether the data behind it is current (freshness split out from regulatory
 * state). Everything below adds depth, never the headline.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, Layers } from "lucide-react";

import CarbonCard from "@/components/CarbonCard";
import { NationalDataHealth } from "@/components/DataHealth";
import EscalationHistory from "@/components/EscalationHistory";
import RankingTable from "@/components/RankingTable";
import StationMapLoader, { MapLegend } from "@/components/StationMapLoader";
import {
  AQIDistribution,
  NationalSummaryPanel,
  NetworkSummaryCards,
  WorstStations,
  useNetworkFacts,
} from "@/components/national/NationalPanels";
import { useStations, useSystemStatus } from "@/components/providers/LiveDataProvider";
import { Panel, Pill, SectionHeader } from "@/components/ui/Card";
import { EmptyState, ErrorState, SkeletonMap } from "@/components/ui/States";
import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";
import { stationLabel } from "@/lib/station";
import { COLORS } from "@/lib/theme";
import type { DashboardResponse } from "@/types";
import type { MapStation } from "@/components/StationMap";

export default function HomePage() {
  const [focus, setFocus] = useState<string | null>(null);

  const stationsState = useStations();
  const statusState = useSystemStatus();
  const overview = usePolling<DashboardResponse>((signal) => api.dashboard(signal), {
    intervalMs: 10000,
  });

  const stations = stationsState.data;
  const status = statusState.data;
  const facts = useNetworkFacts(stations);

  // The map is driven by /api/stations rather than the dashboard's map points:
  // that payload carries the freshness classification, so unavailable and
  // stale nodes stay visible instead of silently dropping off the map.
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

  const selected = focus ? stations?.stations.find((s) => s.station === focus) : undefined;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="aree-page-title">National Environmental Status</h1>
          <p className="text-aree-dim mt-1 text-[12px]">
            Live regulatory picture across every configured monitoring node.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* With no station payload the escalation count is unknown, and
              claiming "none" would be a guess. */}
          {!stations ? (
            <Pill color={COLORS.dim}>Escalation state unknown</Pill>
          ) : facts.triggered > 0 ? (
            <Pill color={COLORS.red} filled>
              {facts.triggered} escalation{facts.triggered === 1 ? "" : "s"} active
            </Pill>
          ) : (
            <Pill color={COLORS.green}>No active escalation</Pill>
          )}
          {(status?.stale_stations ?? 0) > 0 ? (
            <Pill color={COLORS.orange} filled>
              ⚠ {status?.stale_stations} stations on stale upstream data
            </Pill>
          ) : null}
        </div>
      </div>

      {stationsState.error && !stations ? (
        <ErrorState error={stationsState.error} onRetry={stationsState.refresh} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
          <Panel
            title="Live station network"
            icon={<Layers className="h-3.5 w-3.5" />}
            accent={COLORS.teal}
            padding="p-3"
            right={
              selected ? (
                <Link
                  href={`/stations/${encodeURIComponent(selected.station)}`}
                  className="text-aree-accent hover:text-aree-cyan flex items-center gap-1.5 text-[11px] font-bold tracking-[0.08em] uppercase transition-colors"
                >
                  Open {stationLabel(selected.station)}
                  <ArrowRight className="h-3 w-3" aria-hidden />
                </Link>
              ) : (
                <span className="text-aree-dim text-[11px]">Select a marker</span>
              )
            }
          >
            {stationsState.initialLoading ? (
              <SkeletonMap height={480} />
            ) : mapStations.length === 0 ? (
              <EmptyState>
                No station coordinates available yet. Markers appear as nodes come online.
              </EmptyState>
            ) : (
              <StationMapLoader
                stations={mapStations}
                selected={focus}
                height={480}
                onSelect={setFocus}
              />
            )}
            <MapLegend className="mt-3 px-1" />
          </Panel>

          <NationalSummaryPanel facts={facts} status={status} stations={stations} />
        </div>
      )}

      <SectionHeader index="01">Network summary</SectionHeader>
      <NetworkSummaryCards facts={facts} status={status} stations={stations} />

      <SectionHeader index="02">Air quality intelligence</SectionHeader>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)]">
        <AQIDistribution facts={facts} />
        <WorstStations facts={facts} />
      </div>

      <SectionHeader index="03">Regulatory risk ranking</SectionHeader>
      {overview.error && !overview.data ? (
        <ErrorState error={overview.error} onRetry={overview.refresh} />
      ) : overview.data ? (
        <RankingTable rankings={overview.data.rankings} highlight={focus} />
      ) : (
        <EmptyState>Cross-station ranking becomes available once windows close.</EmptyState>
      )}

      <SectionHeader index="04">Data health</SectionHeader>
      <NationalDataHealth />

      <SectionHeader index="05">Recent escalations</SectionHeader>
      <EscalationHistory />

      <SectionHeader index="06">Compute footprint</SectionHeader>
      <CarbonCard carbon={overview.data?.carbon ?? null} />
    </>
  );
}
