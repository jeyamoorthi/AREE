"use client";

/**
 * Environmental Command Center for one station.
 */

import Link from "next/link";
import { useMemo } from "react";
import { ArrowLeft, MapPin, ChevronRight } from "lucide-react";

import AdvisoryCard, {
  DecisionTraceCard,
  MethodologyCard,
  PolicyRetrievalCard,
} from "@/components/AdvisoryCard";
import AIAnalysis from "@/components/AIAnalysis";
import {
  DataSourceTransparency,
  IngestionErrorBanner,
  PollutantGrid,
  StaleDataBanner,
  WindowAggregates,
} from "@/components/AQICard";
import { StationDataHealth } from "@/components/DataHealth";
import EscalationHistory from "@/components/EscalationHistory";
import ForecastCard from "@/components/ForecastCard";
import { GRAPTimeline, LiveRegulatoryState, RegulatoryContext } from "@/components/GRAPCard";
import HealthForecast from "@/components/HealthForecast";
import PersistenceCard from "@/components/PersistenceCard";
import PolicyConsole from "@/components/PolicyConsole";
import RankingTable from "@/components/RankingTable";
import ReportDownload from "@/components/ReportDownload";
import RiskChart from "@/components/RiskChart";
import SatelliteCard from "@/components/SatelliteCard";
import StationMapLoader from "@/components/StationMapLoader";
import AQIHero from "@/components/station/AQIHero";
import StationHeader from "@/components/station/StationHeader";
import { RecommendedAction, RiskExplain } from "@/components/station/RiskIntelligence";
import { Disclosure, IntelligencePanel, SectionHeader } from "@/components/ui/Card";
import {
  AnalysisSkeleton,
  ErrorState,
  SectionState,
  SkeletonCard,
} from "@/components/ui/States";
import { useEngineConfig } from "@/hooks/useEngineConfig";
import { useLiveChannel } from "@/hooks/useLiveChannel";
import { usePolling } from "@/hooks/usePolling";
import { ApiError, api } from "@/lib/api";
import type { MapStation } from "@/components/StationMap";
import type {
  AdvisoryResponse,
  AIResponse,
  DashboardResponse,
  ForecastResponse,
  HealthImpactResponse,
  StationDetail,
} from "@/types";

const POLL_MS = 5000;

export default function StationDashboard({ station }: { station: string }) {
  const config = useEngineConfig();

  const live = useLiveChannel(station);
  const refreshKey = live.revision;

  const detail = usePolling<StationDetail>((signal) => api.station(station, signal), {
    intervalMs: POLL_MS,
    deps: [station],
    refreshKey,
  });
  const advisory = usePolling<AdvisoryResponse>(
    (signal) => api.advisory(station, signal),
    { intervalMs: POLL_MS, deps: [station], refreshKey },
  );
  const forecast = usePolling<ForecastResponse>(
    (signal) => api.forecast(station, signal),
    { intervalMs: POLL_MS, deps: [station], refreshKey },
  );
  const health = usePolling<HealthImpactResponse>(
    (signal) => api.healthImpact(station, signal),
    { intervalMs: POLL_MS, deps: [station], refreshKey },
  );
  const ai = usePolling<AIResponse>((signal) => api.ai(station, signal), {
    intervalMs: POLL_MS,
    deps: [station],
    refreshKey,
  });
  const overview = usePolling<DashboardResponse>((signal) => api.dashboard(signal), {
    intervalMs: 15000,
  });

  const data = detail.data;

  const mapStations = useMemo<MapStation[]>(() => {
    if (!data || data.lat === null || data.lat === undefined) return [];
    if (data.lon === null || data.lon === undefined) return [];
    return [
      {
        station,
        lat: data.lat,
        lon: data.lon,
        aqi: data.aqi ?? null,
        cpcb_band: data.cpcb_band ?? null,
        grap_stage: data.grap_stage ?? null,
        eri_score: data.eri_score ?? null,
        engine_mode: data.engine_mode ?? null,
        freshness_status: data.freshness_status ?? "unavailable",
        feed_id: data.feed_id,
        city: data.city ?? null,
      },
    ];
  }, [data, station]);

  const feedDown =
    detail.error instanceof ApiError && detail.error.isFeedUnavailable
      ? detail.error
      : null;

  if (feedDown) {
    return (
      <div className="flex flex-col max-w-[1400px] mx-auto pb-12">
        <StationHeader station={station} data={data} liveStatus={live.status} />
        <ErrorState error={feedDown} />
        <IntelligencePanel title="What this means" className="mt-6">
          <div className="p-6">
            <p className="text-[#64748b] text-[14px] leading-relaxed">
              This station publishes no usable AQI, so the engine computes no regulatory
              state for it and the intelligence sections are not shown.
            </p>
          </div>
        </IntelligencePanel>
        <BackLink />
      </div>
    );
  }

  return (
    <div className="flex flex-col max-w-[1400px] mx-auto pb-12 space-y-12">
      <div>
        <StationHeader station={station} data={data} liveStatus={live.status} />
        <div className="mt-6 flex flex-wrap items-center gap-3 bg-white p-3 rounded-lg border border-[#e4e0d4] inline-flex shadow-xs">
          <ReportDownload station={station} />
          <div className="w-px h-6 bg-[#e4e0d4] mx-2"></div>
          <Link
            href="/reports"
            className="text-[#64748b] hover:text-[#143828] px-3 py-1.5 text-sm font-semibold transition-colors flex items-center gap-1.5"
          >
            Report Centre <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
      </div>

      <div className="space-y-6">
        <SectionHeader index="01">Air quality intelligence</SectionHeader>
        <SectionState
          state={detail}
          skeletonRows={5}
          loadingLabel="Loading AQI…"
          skeleton={<SkeletonCard rows={5} label="Loading AQI…" />}
        >
          {(d) => (
            <div className="space-y-6">
              <StaleDataBanner data={d} config={config.data} />
              <IngestionErrorBanner data={d} />

              <div className="grid gap-6 xl:grid-cols-[minmax(0,1.85fr)_minmax(280px,1fr)]">
                <AQIHero data={d} />
                <IntelligencePanel
                  title="Station location"
                  variant="default"
                  className="h-full flex flex-col"
                >
                  <div className="p-4 flex-1">
                    {mapStations.length > 0 ? (
                      <div className="rounded-lg overflow-hidden h-full min-h-[260px]">
                        <StationMapLoader
                          stations={mapStations}
                          selected={station}
                          height={260}
                        />
                      </div>
                    ) : (
                      <div className="text-[#788796] flex h-full min-h-[260px] flex-col items-center justify-center text-center text-[13px] bg-[#faf9f4] rounded-lg">
                        <MapPin className="w-8 h-8 mb-2 opacity-50" />
                        No coordinates available
                      </div>
                    )}
                  </div>
                </IntelligencePanel>
              </div>

              <div>
                <PollutantGrid data={d} />
              </div>

              <IntelligencePanel title="Source health">
                <div className="p-5">
                  <StationDataHealth detail={d} ai={ai.data} advisory={advisory.data} />
                </div>
              </IntelligencePanel>
            </div>
          )}
        </SectionState>
      </div>

      <div className="space-y-6">
        <SectionHeader index="02">Live regulatory state</SectionHeader>
        <SectionState state={detail} skeletonRows={3} loadingLabel="Loading regulatory state…">
          {(d) => <LiveRegulatoryState data={d} config={config.data} />}
        </SectionState>
      </div>

      <div className="space-y-6">
        <SectionHeader index="03">Regulatory risk</SectionHeader>
        <SectionState state={detail} skeletonRows={4} loadingLabel="Loading GRAP status…">
          {(d) => <GRAPTimeline data={d} config={config.data} />}
        </SectionState>
      </div>

      <div className="space-y-6">
        <SectionHeader index="04">Persistence analysis</SectionHeader>
        <SectionState state={detail} skeletonRows={4} loadingLabel="Loading persistence engine…">
          {(d) => <PersistenceCard data={d} config={config.data} />}
        </SectionState>
      </div>

      <div className="space-y-6">
        <SectionHeader index="05">Forecast intelligence</SectionHeader>
        <div className="space-y-6">
          <SectionState state={forecast} skeletonRows={4} loadingLabel="Loading forecast…">
            {(f) => (
              <ForecastCard forecast={f} highThreshold={config.data?.high_aqi_threshold} />
            )}
          </SectionState>
          <SectionState state={health} skeletonRows={3} loadingLabel="Loading health impact…">
            {(h) => <HealthForecast health={h} />}
          </SectionState>
        </div>
      </div>

      <div className="space-y-6">
        <SectionHeader index="06">Satellite intelligence</SectionHeader>
        <SectionState state={detail} skeletonRows={3} loadingLabel="Loading satellite intelligence…">
          {(d) => <SatelliteCard data={d} />}
        </SectionState>
      </div>

      <div className="space-y-6">
        <SectionHeader index="07">Risk explainability</SectionHeader>
        <div className="space-y-6">
          <SectionState state={detail} skeletonRows={4} loadingLabel="Loading risk factors…">
            {(d) => (
              <div className="grid gap-6 lg:grid-cols-2">
                <RiskExplain data={d} advisory={advisory.data} />
                <RecommendedAction advisory={advisory.data} health={health.data} />
              </div>
            )}
          </SectionState>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <SectionState state={detail} skeletonRows={3}>
              {(d) => <RiskChart data={d} />}
            </SectionState>
            <SectionState state={overview} skeletonRows={3} loadingLabel="Loading comparison…">
              {(o) => (
                <IntelligencePanel title="Cross-station comparison">
                  <div className="p-5">
                    <RankingTable rankings={o.rankings} highlight={station} />
                  </div>
                </IntelligencePanel>
              )}
            </SectionState>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <SectionHeader index="08">AI risk interpretation</SectionHeader>
        <SectionState
          state={ai}
          skeleton={<AnalysisSkeleton />}
          emptyMessage="No interpretation available for this station yet."
        >
          {(a) => <AIAnalysis ai={a} data={detail.data} advisory={advisory.data} />}
        </SectionState>
      </div>

      <div className="space-y-6">
        <SectionHeader index="09">Policy intelligence</SectionHeader>
        <div id="policy-intelligence" className="scroll-mt-24 space-y-6">
          <SectionState state={advisory} skeletonRows={6} loadingLabel="Loading advisory…">
            {(a) => (
              <div className="flex flex-col gap-6">
                <AdvisoryCard advisory={a} />
                <div className="grid gap-6 lg:grid-cols-2">
                  <PolicyRetrievalCard advisory={a} />
                  <DecisionTraceCard advisory={a} />
                </div>
              </div>
            )}
          </SectionState>
          <div className="pt-4 border-t border-[#e4e0d4]">
            <PolicyConsole />
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <SectionHeader index="10">Event timeline</SectionHeader>
        <EscalationHistory station={station} title="Station event timeline" />
      </div>

      <div className="space-y-6">
        <SectionHeader index="11">Advanced engine data</SectionHeader>
        <div className="grid gap-4">
          <Disclosure summary="Data source transparency">
            {data ? (
              <DataSourceTransparency data={data} config={config.data} />
            ) : (
              <span className="text-[#64748b] text-[13px]">No station payload yet.</span>
            )}
          </Disclosure>

          <Disclosure summary="Regulatory context and thresholds">
            {data ? (
              <RegulatoryContext data={data} config={config.data} />
            ) : (
              <span className="text-[#64748b] text-[13px]">No station payload yet.</span>
            )}
          </Disclosure>

          <Disclosure summary="Pathway window aggregates">
            {data ? (
              <WindowAggregates data={data} />
            ) : (
              <span className="text-[#64748b] text-[13px]">No station payload yet.</span>
            )}
          </Disclosure>

          <Disclosure summary="Methodology and validation">
            <MethodologyCard
              pollutantsAvailable={data?.pollutants_available ?? 0}
              highThreshold={config.data?.high_aqi_threshold ?? 300}
              persistenceThreshold={config.data?.persistence_threshold ?? 3}
              windowDuration={config.data?.window_duration_minutes ?? 3}
              windowHop={config.data?.window_hop_minutes ?? 1}
            />
          </Disclosure>
        </div>
      </div>

      {config.error ? (
        <div className="pt-6 border-t border-[#e4e0d4]">
          <ErrorState error={config.error} onRetry={config.refresh} compact />
        </div>
      ) : null}

      <BackLink />
    </div>
  );
}

function BackLink() {
  return (
    <div className="pt-12 text-center">
      <Link
        href="/"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white hover:bg-[#faf9f4] border border-[#e4e0d4] text-[#17231c] text-sm font-semibold transition-colors shadow-xs"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to National Overview
      </Link>
    </div>
  );
}
