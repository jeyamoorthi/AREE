"use client";

/**
 * What the engine currently knows about the station a report is about to be
 * generated for — shown BEFORE the operator presses generate.
 *
 * WHY THIS EXISTS
 *   The report centre used to ask an authority to commit to a station from a dropdown
 *   and a filename. Everything that makes one station worth a brief and another not —
 *   the reading, how old it is, whether the engine has escalated — was one navigation
 *   away, on a different screen. This panel puts the answer under the selector, so
 *   the decision to generate is made with the conditions in view rather than from the
 *   station's name.
 *
 * WHERE THE VALUES COME FROM
 *   One request, owned by the page: GET /api/stations/{station}, the same payload the
 *   command centre renders. Nothing here is recomputed — not the band, not the mode,
 *   not the age of the reading. A second opinion about any of them would eventually
 *   contradict the station page an officer opens next.
 *
 * WHAT IS DELIBERATELY NOT PRINTED
 *   A source line for the AQI itself. The engine reads the index from CAQM and the
 *   concentrations from CPCB, and only the second of those is named on the payload
 *   (`pollutant_source`). Printing "CPCB / CAQM" as a constant beside the index would
 *   be inventing provenance on the one panel whose job is provenance, so the AQI is
 *   attributed by its feed and its timestamp and nothing more.
 */

import { Database } from "lucide-react";

import { PollutantGrid } from "@/components/AQICard";
import { Stat } from "@/components/ui/Card";
import { EmptyState, ErrorState, SkeletonBar } from "@/components/ui/States";
import type { PollingState } from "@/hooks/usePolling";
import { istDateTime } from "@/lib/clock";
import { formatAgeBehind, formatDuration } from "@/lib/duration";
import { escalationSummary } from "@/lib/escalation";
import { freshness } from "@/lib/freshness";
import { feedLabel, stationLabel } from "@/lib/station";
import { aqiColor, bandColor, grapColor, modeColor, modeLabel, orDash } from "@/lib/theme";
import type { StationDetail } from "@/types";

/** The shape of the loaded panel, so selecting a station does not reflow the page. */
function PreviewSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <span className="sr-only">Loading station intelligence</span>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <SkeletonBar key={i} height={62} />
        ))}
      </div>
      <SkeletonBar height={86} />
      <SkeletonBar height={40} />
    </div>
  );
}

export default function StationIntelligencePreview({
  station,
  state,
}: {
  station: string;
  /** Owned by the reports page, so one fetch serves every panel on the screen. */
  state: PollingState<StationDetail>;
}) {
  if (state.initialLoading) return <PreviewSkeleton />;

  if (state.error && !state.data) {
    return (
      <ErrorState
        error={state.error}
        onRetry={state.refresh}
        occurredAt={state.errorAt?.toISOString() ?? null}
        compact
      />
    );
  }

  const data = state.data;

  /* has_data is the engine's own statement that it has never closed a window for
     this station. It is a different fact from "the reading is old", and conflating
     the two would tell an operator a feed is stale when in truth it has never
     reported at all. */
  if (!data || !data.has_data) {
    return (
      <EmptyState icon={<Database className="h-5 w-5" />}>
        No current data available for this station. {stationLabel(station)} has not
        produced a closed window yet, so a report generated now would have nothing to
        describe.
      </EmptyState>
    );
  }

  const look = freshness(data.freshness_status);
  const age =
    data.freshness_status === "stale"
      ? formatAgeBehind(data.stale_seconds)
      : (() => {
          const value = formatDuration(data.stale_seconds);
          return value === null ? null : `${value} ago`;
        })();

  /* The backend labels this instant with its own zone — "2026-08-21 21:00 IST" — so
     it is printed as sent. istDateTime is only the fallback for the raw UTC field,
     and it renders in the same zone. Nothing here shifts a timestamp. */
  const readingAt =
    data.waqi_timestamp_local ?? istDateTime(data.waqi_timestamp ?? null) ?? null;

  const escalation = escalationSummary(data);
  const feed = feedLabel(data.feed_id);
  const pollutantAge =
    data.pollutant_age_minutes === null || data.pollutant_age_minutes === undefined
      ? null
      : formatDuration(data.pollutant_age_minutes * 60);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Current AQI"
          value={data.aqi ?? "—"}
          color={aqiColor(data.aqi)}
          sub={
            data.cpcb_band ? (
              <span style={{ color: bandColor(data.cpcb_band) }}>{data.cpcb_band}</span>
            ) : undefined
          }
          title="Air quality index published by the engine for this station"
        />
        <Stat
          label="GRAP stage"
          value={orDash(data.grap_stage)}
          color={grapColor(data.grap_stage)}
          mono={false}
          size="sm"
          title="Graded Response Action Plan stage currently in force for this station"
        />
        <Stat
          label="Engine mode"
          value={data.engine_mode ? modeLabel(data.engine_mode) : "—"}
          color={data.engine_mode ? modeColor(data.engine_mode) : undefined}
          mono={false}
          size="sm"
          title="Where the escalation engine has placed this station"
        />
        <Stat
          label="Reading age"
          value={age ?? "—"}
          color={look.color}
          mono={false}
          size="sm"
          sub={look.badge}
          title="How far behind the published reading is"
        />
      </div>

      {/* The application's one pollutant display, with the national standards turned
          on: a brief is read away from this screen, by someone who cannot hover a
          cell to find out what the number should be. */}
      <PollutantGrid data={data} showStandards />

      <dl className="grid gap-x-6 gap-y-1.5 text-[11.5px] grid-cols-[minmax(0,1fr)] sm:grid-cols-2">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-aree-dim">Reading timestamp</dt>
          <dd className="aree-num font-semibold text-aree-body">
            {readingAt ?? "Not reported"}
          </dd>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-aree-dim">Station feed</dt>
          <dd className="aree-num font-semibold text-aree-body">
            {feed ?? "Not reported"}
            {data.station_name_api ? (
              <span className="ml-1.5 font-normal text-aree-muted">
                {data.station_name_api}
              </span>
            ) : null}
          </dd>
        </div>

        {/* Named only when the payload names it. The concentrations and the index
            come from different feeds; this attributes the concentrations, which is
            the only one of the two the engine actually publishes a source for. */}
        {data.pollutant_source ? (
          <div className="flex flex-wrap items-baseline gap-x-2 sm:col-span-2">
            <dt className="text-aree-dim">Concentrations from</dt>
            <dd className="font-semibold text-aree-body">
              {data.pollutant_source}
              {pollutantAge ? (
                <span className="ml-1.5 font-normal text-aree-muted">
                  · measured {pollutantAge} ago
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>

      {escalation.headline ? (
        <p className="text-[12.5px] leading-relaxed text-aree-body">
          <span className="font-bold" style={{ color: escalation.color }}>
            {escalation.headline}
          </span>
          {escalation.detail ? <> — {escalation.detail}</> : null}
        </p>
      ) : null}
    </div>
  );
}
