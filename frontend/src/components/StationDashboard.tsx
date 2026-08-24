"use client";

/**
 * Environmental Command Center for one station.
 *
 * The page is ordered by the operator's questions, not by subsystem:
 * what is the reading → is it current → why → what happens next → what does
 * the model think → what does policy require → what has already happened.
 * Engineering depth is preserved, but moved behind the advanced disclosure.
 */

import Link from "next/link";
import { useMemo } from "react";
import { ArrowLeft, MapPin } from "lucide-react";

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
import { Disclosure, Panel, SectionHeader } from "@/components/ui/Card";
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

  // Live channel: events pull fresh data early; polling remains the base path.
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

  // A dormant or failing upstream feed makes every section report the same
  // thing. Say it once instead of repeating one banner a dozen times.
  const feedDown =
    detail.error instanceof ApiError && detail.error.isFeedUnavailable
      ? detail.error
      : null;

  if (feedDown) {
    return (
      <div className="flex flex-col">
        <StationHeader station={station} data={data} liveStatus={live.status} />
        <ErrorState error={feedDown} />
        <Panel title="What this means" className="mt-4" padding="p-5">
          <p className="text-aree-muted text-[13px] leading-relaxed">
            This station publishes no usable AQI, so the engine computes no regulatory
            state for it and the intelligence sections are not shown. This is an upstream
            feed condition, not a staleness classification — the station is never counted
            as merely old. The engine keeps polling and this page recovers automatically
            if the feed starts publishing again.
          </p>
        </Panel>
        <BackLink />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <StationHeader station={station} data={data} liveStatus={live.status} />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <ReportDownload station={station} />
        <Link
          href="/reports"
          className="border-aree-border text-aree-muted hover:border-aree-border-strong hover:text-aree-body rounded-lg border px-4 py-2.5 text-[12.5px] font-semibold transition-colors"
        >
          Open report centre
        </Link>
      </div>

      {/* 01 — Air quality intelligence */}
      <SectionHeader index="01">Air quality intelligence</SectionHeader>
      <SectionState
        state={detail}
        skeletonRows={5}
        loadingLabel="Loading AQI…"
        skeleton={<SkeletonCard rows={5} label="Loading AQI…" />}
      >
        {(d) => (
          <>
            <StaleDataBanner data={d} config={config.data} />
            <IngestionErrorBanner data={d} />

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.85fr)_minmax(280px,1fr)]">
              <AQIHero data={d} />
              <Panel
                title="Station location"
                icon={<MapPin className="h-3.5 w-3.5" />}
                padding="p-3"
              >
                {mapStations.length > 0 ? (
                  <StationMapLoader
                    stations={mapStations}
                    selected={station}
                    height={244}
                  />
                ) : (
                  <div className="text-aree-muted flex h-[244px] items-center justify-center text-center text-[13px]">
                    No coordinates available for this station.
                  </div>
                )}
              </Panel>
            </div>

            <div className="mt-4">
              <PollutantGrid data={d} />
            </div>

            <Panel title="Source health" padding="p-4" className="mt-4">
              <StationDataHealth detail={d} ai={ai.data} advisory={advisory.data} />
            </Panel>
          </>
        )}
      </SectionState>

      {/* 02 — Live regulatory state */}
      <SectionHeader index="02">Live regulatory state</SectionHeader>
      <SectionState state={detail} skeletonRows={3} loadingLabel="Loading regulatory state…">
        {(d) => <LiveRegulatoryState data={d} config={config.data} />}
      </SectionState>

      {/* 03 — Regulatory risk */}
      <SectionHeader index="03">Regulatory risk</SectionHeader>
      <SectionState state={detail} skeletonRows={4} loadingLabel="Loading GRAP status…">
        {(d) => <GRAPTimeline data={d} config={config.data} />}
      </SectionState>

      {/* 04 — Persistence analysis */}
      <SectionHeader index="04">Persistence analysis</SectionHeader>
      <SectionState state={detail} skeletonRows={4} loadingLabel="Loading persistence engine…">
        {(d) => <PersistenceCard data={d} config={config.data} />}
      </SectionState>

      {/* 05 — Forecast intelligence */}
      <SectionHeader index="05">Forecast intelligence</SectionHeader>
      <SectionState state={forecast} skeletonRows={4} loadingLabel="Loading forecast…">
        {(f) => (
          <ForecastCard forecast={f} highThreshold={config.data?.high_aqi_threshold} />
        )}
      </SectionState>
      <div className="mt-4">
        <SectionState state={health} skeletonRows={3} loadingLabel="Loading health impact…">
          {(h) => <HealthForecast health={h} />}
        </SectionState>
      </div>

      {/* 06 — Satellite intelligence */}
      <SectionHeader index="06">Satellite intelligence</SectionHeader>
      <SectionState state={detail} skeletonRows={3} loadingLabel="Loading satellite intelligence…">
        {(d) => <SatelliteCard data={d} />}
      </SectionState>

      {/* 07 — Risk explainability */}
      <SectionHeader index="07">Risk explainability</SectionHeader>
      <SectionState state={detail} skeletonRows={4} loadingLabel="Loading risk factors…">
        {(d) => (
          <div className="grid gap-4 lg:grid-cols-2">
            <RiskExplain data={d} advisory={advisory.data} />
            <RecommendedAction advisory={advisory.data} health={health.data} />
          </div>
        )}
      </SectionState>
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <SectionState state={detail} skeletonRows={3}>
          {(d) => <RiskChart data={d} />}
        </SectionState>
        <SectionState state={overview} skeletonRows={3} loadingLabel="Loading comparison…">
          {(o) => (
            <Panel title="Cross-station comparison" padding="p-4">
              <RankingTable rankings={o.rankings} highlight={station} />
            </Panel>
          )}
        </SectionState>
      </div>

      {/* 08 — AI risk interpretation */}
      <SectionHeader index="08">AI risk interpretation</SectionHeader>
      <SectionState
        state={ai}
        skeleton={<AnalysisSkeleton />}
        emptyMessage="No interpretation available for this station yet."
      >
        {(a) => <AIAnalysis ai={a} data={detail.data} advisory={advisory.data} />}
      </SectionState>

      {/* 09 — Policy intelligence */}
      <SectionHeader index="09">Policy intelligence</SectionHeader>
      <div id="policy-intelligence" className="scroll-mt-24">
        <SectionState state={advisory} skeletonRows={6} loadingLabel="Loading advisory…">
          {(a) => (
            <div className="flex flex-col gap-4">
              <AdvisoryCard advisory={a} />
              <div className="grid gap-4 lg:grid-cols-2">
                <PolicyRetrievalCard advisory={a} />
                <DecisionTraceCard advisory={a} />
              </div>
            </div>
          )}
        </SectionState>
        <div className="mt-4">
          <PolicyConsole />
        </div>
      </div>

      {/* 10 — Event timeline */}
      <SectionHeader index="10">Event timeline</SectionHeader>
      <EscalationHistory station={station} title="Station event timeline" />

      {/* 11 — Advanced engine data */}
      <SectionHeader index="11">Advanced engine data</SectionHeader>
      <div className="flex flex-col gap-3">
        <Disclosure summary="Data source transparency">
          {data ? (
            <DataSourceTransparency data={data} config={config.data} />
          ) : (
            <span className="text-aree-muted text-[13px]">No station payload yet.</span>
          )}
        </Disclosure>

        <Disclosure summary="Regulatory context and thresholds">
          {data ? (
            <RegulatoryContext data={data} config={config.data} />
          ) : (
            <span className="text-aree-muted text-[13px]">No station payload yet.</span>
          )}
        </Disclosure>

        <Disclosure summary="Pathway window aggregates">
          {data ? (
            <WindowAggregates data={data} />
          ) : (
            <span className="text-aree-muted text-[13px]">No station payload yet.</span>
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

      {config.error ? (
        <div className="mt-6">
          <ErrorState error={config.error} onRetry={config.refresh} compact />
        </div>
      ) : null}

      <BackLink />
    </div>
  );
}

function BackLink() {
  return (
    <div className="mt-10 text-center">
      <Link
        href="/"
        className="text-aree-muted hover:text-aree-accent inline-flex items-center gap-2 text-[12px] transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back to national overview
      </Link>
    </div>
  );
}
