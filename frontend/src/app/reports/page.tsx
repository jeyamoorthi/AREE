"use client";

/**
 * Report centre.
 * Generate a report for a station and download the PDF.
 */

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { FileText, Database } from "lucide-react";

import ReportDownload from "@/components/ReportDownload";
import StationSelector from "@/components/StationSelector";
import DecisionSnapshot from "@/components/reports/DecisionSnapshot";
import ReportHistory from "@/components/reports/ReportHistory";
import StationIntelligencePreview from "@/components/reports/StationIntelligencePreview";
import { useStations } from "@/components/providers/LiveDataProvider";
import { KeyValue, IntelligencePanel, StatusBadge, SectionHeader, Stat } from "@/components/ui/Card";
import { EmptyState, ErrorState, SkeletonBar, SkeletonCard } from "@/components/ui/States";
import { istDateTime } from "@/lib/clock";
import { usePolling } from "@/hooks/usePolling";
import { usePrintSubject } from "@/hooks/usePrintSubject";
import { api } from "@/lib/api";
import { freshness } from "@/lib/freshness";
import { appendReportRecord, newReportId } from "@/lib/reportHistory";
import { stationLabel } from "@/lib/station";
import { aqiColor, bandColor, grapColor, modeColor, modeLabel, orDash } from "@/lib/theme";
import type { ReportMetaResponse, StationDetail } from "@/types";

const REPORT_META_POLL_MS = 30000;
const REPORT_META_TIMEOUT_MS = 10000;

/* The station payload is polled ONCE for this whole screen and handed to every panel
   that needs it — the intelligence preview and the report preview both describe the
   same station at the same instant, and two independent polls of the same endpoint
   would eventually put two different AQIs on one page. Same reasoning, and the same
   cadence, as the report metadata beside it. */
const STATION_POLL_MS = 30000;
const STATION_TIMEOUT_MS = 10000;

export default function ReportsPage() {
  const stationsState = useStations();
  const [selected, setSelected] = useState<string | null>(null);

  /* Deadline, not just an interval. The operator has selected a station and is
     waiting for one specific answer; without it a request that never returns leaves
     a spinner that has no end condition. Ten seconds is well inside the thirty-second
     poll, so a slow answer and the next attempt cannot collide. */
  const meta = usePolling<ReportMetaResponse>(
    (signal) => api.reportMeta(selected as string, signal),
    {
      intervalMs: REPORT_META_POLL_MS,
      timeoutMs: REPORT_META_TIMEOUT_MS,
      enabled: Boolean(selected),
      deps: [selected],
    },
  );

  // Names the printed page after whatever station is currently selected.
  usePrintSubject(selected ? stationLabel(selected) : null);

  const stationDetail = usePolling<StationDetail>(
    (signal) => api.station(selected as string, signal),
    {
      intervalMs: STATION_POLL_MS,
      timeoutMs: STATION_TIMEOUT_MS,
      enabled: Boolean(selected),
      deps: [selected],
    },
  );

  const reportable = useMemo(
    () => (stationsState.data?.stations ?? []).filter((s) => s.has_data),
    [stationsState.data],
  );

  /* Written ONCE, at the moment the download succeeds, from the values that were on
     screen at that moment. It is a snapshot and is never refreshed afterwards — see
     lib/reportHistory for why that is the opposite of how lib/recents behaves. */
  const recordDownload = useCallback(() => {
    if (!selected) return;
    appendReportRecord({
      id: newReportId(),
      station: selected,
      generatedAt: new Date().toISOString(),
      aqi: stationDetail.data?.aqi ?? meta.data?.aqi ?? null,
      riskCategory: stationDetail.data?.eri_category ?? null,
      eriScore: stationDetail.data?.eri_score ?? null,
      grapStage: stationDetail.data?.grap_stage ?? meta.data?.grap_stage ?? null,
      reportType: "Regulatory intelligence brief · 4 pages · PDF",
    });
  }, [selected, meta.data, stationDetail.data]);

  return (
    <div className="max-w-[1400px] mx-auto space-y-8 pb-12">
      <div className="mb-8">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-aree-text mb-2">Report Centre</h1>
        <p className="text-sm text-aree-muted max-w-2xl leading-relaxed">
          Four-page municipal escalation brief: decision snapshot, technical escalation
          detail, policy grounding and system transparency.
        </p>
      </div>

      <div className="space-y-6">
        <SectionHeader index="01">Generate report</SectionHeader>
        <div className="grid gap-6 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(320px,1.1fr)]">
          <IntelligencePanel title="Report parameters" variant="default">
            <div className="flex flex-col gap-6 p-4 sm:p-6">
              <StationSelector
                id="report-station"
                value={selected}
                onChange={setSelected}
                label="Station"
              />

              {/* Directly under the selector, and before anything about the report
                  itself: the conditions are what make a station worth a brief, so
                  they are read first and the format is read second. */}
              {selected ? (
                <section aria-label="Station intelligence" className="space-y-3">
                  <h3 className="aree-eyebrow">Station intelligence</h3>
                  <StationIntelligencePreview station={selected} state={stationDetail} />
                </section>
              ) : null}

              {/* Between the conditions and the button that files a document about
                  them. The panel above says what the station is reading; this says
                  what the engine has concluded, which is what the brief carries. */}
              {selected ? (
                <section
                  aria-label="Decision snapshot"
                  className="space-y-3 rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-2 p-4"
                >
                  <h3 className="aree-eyebrow">Decision snapshot</h3>
                  <DecisionSnapshot state={stationDetail} />
                </section>
              ) : null}

              <div className="bg-aree-surface-2 border border-aree-border rounded-lg p-4">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-aree-dim mb-3 block">
                  Report type
                </span>
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded bg-aree-forest/10 flex items-center justify-center shrink-0">
                    <FileText className="text-aree-forest h-4 w-4" aria-hidden />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-aree-text">Regulatory intelligence brief</div>
                    <div className="text-xs text-aree-muted">4 pages · PDF</div>
                  </div>
                </div>
                <p className="text-xs text-aree-dim mt-4 leading-relaxed border-t border-aree-border pt-3">
                  The engine publishes one report format.
                </p>
              </div>

              {selected ? (
                <ReportDownload
                  station={selected}
                  label="Generate Report"
                  onDownloaded={recordDownload}
                  freshnessStatus={stationDetail.data?.freshness_status ?? null}
                  staleSeconds={stationDetail.data?.stale_seconds ?? null}
                />
              ) : (
                <button
                  type="button"
                  disabled
                  className="w-full bg-aree-surface-2 border border-aree-border text-aree-dim cursor-not-allowed rounded-lg px-4 py-3 text-sm font-medium transition-colors"
                >
                  Select a station to generate
                </button>
              )}
            </div>
          </IntelligencePanel>

          <IntelligencePanel title="Report preview" variant="default">
            <div className="p-4 sm:p-6 h-full flex flex-col">
              {!selected ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center py-12">
                  <Database className="h-8 w-8 text-aree-dim mb-3" aria-hidden />
                  <div className="text-sm text-aree-muted">Select a station to see what its report will contain.</div>
                </div>
              ) : meta.initialLoading ? (
                /* A skeleton shaped like the answer, not a spinner. The operator can
                   see a title, two figures and a detail block are coming, which is
                   most of what "is this worth waiting for" asks. */
                <div className="space-y-6" role="status" aria-live="polite">
                  <span className="sr-only">Loading report metadata</span>
                  <div className="border-b border-aree-border pb-4">
                    <SkeletonBar width="55%" height={20} />
                    <div className="mt-2.5">
                      <SkeletonBar width="30%" height={14} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <SkeletonBar height={54} />
                    <SkeletonBar height={54} />
                  </div>
                  <div className="rounded-lg border border-aree-border p-4 space-y-3">
                    <SkeletonBar width="90%" />
                    <SkeletonBar width="75%" />
                    <SkeletonBar width="60%" />
                  </div>
                </div>
              ) : meta.error && !meta.data ? (
                <ErrorState
                  error={meta.error}
                  onRetry={meta.refresh}
                  occurredAt={meta.errorAt?.toISOString() ?? null}
                  compact
                />
              ) : !meta.data ? (
                <EmptyState icon={<Database className="h-5 w-5" />}>
                  The engine has no report metadata for {stationLabel(selected)} yet.
                  This is normal for a station that has not closed a window since the
                  engine started — pick another station, or try again in a few minutes.
                </EmptyState>
              ) : (
                <div className="space-y-6">
                  <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-aree-border">
                    <div>
                      <div className="text-lg font-bold text-aree-text mb-2">
                        {stationLabel(meta.data.station)}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge
                          color={modeColor(meta.data.engine_mode)}
                          pulse={meta.data.engine_mode === "TRIGGERED"}
                          variant={meta.data.engine_mode === "TRIGGERED" ? "solid" : "outline"}
                        >
                          {modeLabel(meta.data.engine_mode)}
                        </StatusBadge>

                        {/* Freshness travels WITH the report, not merely beside the
                            station. The brief carries a reading, and how old that
                            reading is qualifies every conclusion drawn from it — so
                            it is stated where the report is described, in the same
                            presentation the rest of the application uses. */}
                        {stationDetail.data?.has_data ? (
                          <StatusBadge
                            color={freshness(stationDetail.data.freshness_status).color}
                            variant={
                              stationDetail.data.freshness_status === "stale"
                                ? "solid"
                                : "outline"
                            }
                          >
                            {freshness(stationDetail.data.freshness_status).badge}
                          </StatusBadge>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <Stat
                      label="AQI"
                      value={meta.data.aqi ?? "—"}
                      color={aqiColor(meta.data.aqi)}
                      /* The band NAME, from the engine's own classification on the
                         station payload. It is never derived from the number beside
                         it: a second classifier would eventually disagree with the
                         one the brief itself was written from. */
                      sub={
                        stationDetail.data?.cpcb_band ? (
                          <span style={{ color: bandColor(stationDetail.data.cpcb_band) }}>
                            {stationDetail.data.cpcb_band}
                          </span>
                        ) : undefined
                      }
                    />
                    <Stat
                      label="GRAP stage"
                      value={orDash(meta.data.grap_stage)}
                      color={grapColor(meta.data.grap_stage)}
                      mono={false}
                      size="sm"
                    />
                  </div>
                  
                  <div className="bg-aree-surface-2 p-4 rounded-lg border border-aree-border grid gap-3">
                    <KeyValue label="Generated for" value={meta.data.generated_for} />
                    {/* The instant the report's reading describes, zone-labelled by
                        the backend. Without it the brief is undated evidence. */}
                    <KeyValue
                      label="Reading timestamp"
                      value={
                        stationDetail.data?.waqi_timestamp_local ??
                        istDateTime(stationDetail.data?.waqi_timestamp ?? null) ??
                        "Not reported"
                      }
                    />
                    <KeyValue label="Filename" value={meta.data.filename} />
                    <KeyValue
                      label="Availability"
                      value={meta.data.available ? "Ready for generation" : "Not available"}
                      color={meta.data.available ? "var(--aree-green)" : "var(--aree-yellow)"}
                    />
                  </div>
                </div>
              )}
            </div>
          </IntelligencePanel>
        </div>
      </div>

      <div className="space-y-6">
        <SectionHeader index="02">Report history</SectionHeader>
        <ReportHistory />
      </div>

      <div className="space-y-6">
        <SectionHeader index="03">Stations available for reporting</SectionHeader>
        {stationsState.initialLoading ? (
          /* Three skeletons in the same grid the real cards land in, so the page does
             not reflow the moment they arrive. */
          <div
            className="grid gap-4 grid-cols-[minmax(0,1fr)] md:grid-cols-2 xl:grid-cols-3"
            role="status"
            aria-live="polite"
          >
            <span className="sr-only">Loading station network</span>
            {[0, 1, 2].map((i) => (
              <SkeletonCard key={i} rows={4} />
            ))}
          </div>
        ) : stationsState.error && !stationsState.data ? (
          <ErrorState
            error={stationsState.error}
            onRetry={stationsState.refresh}
            occurredAt={stationsState.errorAt?.toISOString() ?? null}
          />
        ) : reportable.length === 0 ? (
          <EmptyState icon={<Database className="h-5 w-5" />}>
            No station has produced a closed window yet, so there is nothing to report
            on. The engine needs one complete window per station before a brief can be
            generated — this resolves itself a few minutes after the engine starts.
          </EmptyState>
        ) : (
          <div className="grid gap-4 grid-cols-[minmax(0,1fr)] md:grid-cols-2 xl:grid-cols-3">
            {reportable.map((station) => {
              const look = freshness(station.freshness_status);
              return (
                <IntelligencePanel
                  key={station.station}
                  title={stationLabel(station.station)}
                  headerAction={
                    <StatusBadge color={look.color} variant={station.freshness_status === "stale" ? "solid" : "outline"}>
                      {look.marker} {look.label}
                    </StatusBadge>
                  }
                >
                  <div className="p-4 space-y-4">
                    <div className="grid grid-cols-3 gap-3">
                      <Stat label="AQI" value={station.aqi ?? "—"} color={aqiColor(station.aqi)} size="sm" />
                      <Stat
                        label="GRAP"
                        value={orDash(station.grap_stage)}
                        color={grapColor(station.grap_stage)}
                        mono={false}
                        size="sm"
                      />
                      <Stat label="ERI" value={station.eri_score ?? 0} size="sm" />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-4 border-t border-aree-border">
                      <button
                        type="button"
                        onClick={() => setSelected(station.station)}
                        className="bg-aree-surface-2 hover:bg-aree-border border border-aree-border text-aree-text px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                      >
                        Select
                      </button>
                      <ReportDownload
                        station={station.station}
                        variant="ghost"
                        label="PDF"
                      />
                      <Link
                        href={`/stations/${encodeURIComponent(station.station)}`}
                        className="ml-auto text-xs text-aree-muted hover:text-aree-forest transition-colors flex items-center gap-1"
                      >
                        View Details &rarr;
                      </Link>
                    </div>
                  </div>
                </IntelligencePanel>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
