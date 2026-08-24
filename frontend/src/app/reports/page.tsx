"use client";

/**
 * Report centre.
 *
 * Generate a report for a station, inspect what the engine will put in it,
 * then download the PDF the Python report generator produces. Report history
 * is what this session has generated — AREE does not persist a report archive,
 * so none is implied.
 */

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { FileText, Loader2 } from "lucide-react";

import ReportDownload from "@/components/ReportDownload";
import StationSelector from "@/components/StationSelector";
import { useStations } from "@/components/providers/LiveDataProvider";
import { KeyValue, Panel, Pill, SectionHeader, Stat } from "@/components/ui/Card";
import { EmptyState, ErrorState, SkeletonCard } from "@/components/ui/States";
import { istDateTime } from "@/lib/clock";
import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";
import { freshness } from "@/lib/freshness";
import { stationLabel } from "@/lib/station";
import { aqiColor, grapColor, modeColor, modeLabel, orDash } from "@/lib/theme";
import type { ReportMetaResponse } from "@/types";

interface HistoryEntry {
  station: string;
  generatedAt: string;
  aqi: number | null;
  grapStage: string | null;
  filename: string;
}

export default function ReportsPage() {
  const stationsState = useStations();
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const meta = usePolling<ReportMetaResponse>(
    (signal) => api.reportMeta(selected as string, signal),
    { intervalMs: 30000, enabled: Boolean(selected), deps: [selected] },
  );

  const reportable = useMemo(
    () => (stationsState.data?.stations ?? []).filter((s) => s.has_data),
    [stationsState.data],
  );

  const recordDownload = useCallback(() => {
    if (!selected) return;
    const entry: HistoryEntry = {
      station: selected,
      generatedAt: new Date().toISOString(),
      aqi: meta.data?.aqi ?? null,
      grapStage: meta.data?.grap_stage ?? null,
      filename: meta.data?.filename ?? `${selected}.pdf`,
    };
    setHistory((prev) => [entry, ...prev.filter((h) => h.station !== selected)].slice(0, 8));
  }, [selected, meta.data]);

  return (
    <>
      <div className="mb-4">
        <h1 className="aree-page-title">Report Centre</h1>
        <p className="text-aree-dim mt-1 text-[12px]">
          Four-page municipal escalation brief: decision snapshot, technical escalation
          detail, policy grounding and system transparency. Every value is a deterministic
          output of live engine state — the report contains no generative narrative.
        </p>
      </div>

      <SectionHeader index="01">Generate report</SectionHeader>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,1.1fr)]">
        <Panel title="Report parameters" accent="var(--aree-accent)" padding="p-5">
          <div className="flex flex-col gap-5">
            <StationSelector
              id="report-station"
              value={selected}
              onChange={setSelected}
              label="Station"
            />

            <div>
              <span className="aree-eyebrow mb-2 block">Report type</span>
              <div className="border-aree-border bg-aree-bg-soft/50 flex items-center gap-3 rounded-lg border px-3 py-2.5">
                <FileText className="text-aree-accent h-4 w-4 shrink-0" aria-hidden />
                <span className="text-aree-body text-[13px] font-semibold">
                  Regulatory intelligence brief
                </span>
                <span className="text-aree-dim ml-auto text-[11px]">4 pages · PDF</span>
              </div>
              <p className="text-aree-dim mt-2 text-[11px]">
                The engine publishes one report format. No other type is offered because
                none exists.
              </p>
            </div>

            {selected ? (
              <ReportDownload
                station={selected}
                label="Generate report"
                onDownloaded={recordDownload}
              />
            ) : (
              <button
                type="button"
                disabled
                className="border-aree-border text-aree-faint cursor-not-allowed rounded-lg border px-4 py-2.5 text-[12.5px] font-semibold"
              >
                Select a station to generate
              </button>
            )}
          </div>
        </Panel>

        <Panel title="Report preview" padding="p-5">
          {!selected ? (
            <div className="text-aree-muted flex h-full min-h-[180px] items-center justify-center text-center text-[13px]">
              Select a station to see what its report will contain.
            </div>
          ) : meta.initialLoading ? (
            <div className="text-aree-muted flex items-center gap-2 text-[13px]">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading report metadata…
            </div>
          ) : meta.error ? (
            <ErrorState error={meta.error} onRetry={meta.refresh} compact />
          ) : meta.data ? (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <span className="text-aree-text text-[15px] font-bold">
                  {stationLabel(meta.data.station)}
                </span>
                <Pill
                  color={modeColor(meta.data.engine_mode)}
                  filled={meta.data.engine_mode === "TRIGGERED"}
                >
                  {modeLabel(meta.data.engine_mode)}
                </Pill>
              </div>
              <div className="grid grid-cols-2 gap-5">
                <Stat label="AQI" value={meta.data.aqi ?? "—"} color={aqiColor(meta.data.aqi)} />
                <Stat
                  label="GRAP stage"
                  value={orDash(meta.data.grap_stage)}
                  color={grapColor(meta.data.grap_stage)}
                  mono={false}
                  size="sm"
                />
              </div>
              <div className="mt-4 grid gap-x-8">
                <KeyValue label="Generated for" value={meta.data.generated_for} />
                <KeyValue label="Filename" value={meta.data.filename} />
                <KeyValue
                  label="Availability"
                  value={meta.data.available ? "ready" : "not available"}
                  color={
                    meta.data.available ? "var(--aree-green)" : "var(--aree-yellow)"
                  }
                />
              </div>
            </>
          ) : null}
        </Panel>
      </div>

      <SectionHeader index="02">Report history</SectionHeader>
      {history.length === 0 ? (
        <EmptyState icon={<FileText className="h-5 w-5" />}>
          No report generated in this session yet. AREE does not keep a server-side report
          archive — each report is rendered on request from current engine state.
        </EmptyState>
      ) : (
        <Panel title="Generated in this session" padding="p-4">
          {history.map((entry) => (
            <div
              key={`${entry.station}-${entry.generatedAt}`}
              className="border-aree-border/70 flex flex-wrap items-center justify-between gap-3 border-b py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <Link
                  href={`/stations/${encodeURIComponent(entry.station)}`}
                  className="text-aree-body hover:text-aree-accent text-[13px] font-semibold transition-colors"
                >
                  {stationLabel(entry.station)}
                </Link>
                <div className="text-aree-dim mt-0.5 text-[11px]">
                  {istDateTime(entry.generatedAt)} · AQI {entry.aqi ?? "—"} ·{" "}
                  {entry.grapStage ?? "—"}
                </div>
              </div>
              <ReportDownload
                station={entry.station}
                variant="ghost"
                label="Download again"
              />
            </div>
          ))}
        </Panel>
      )}

      <SectionHeader index="03">Stations available for reporting</SectionHeader>
      {stationsState.initialLoading ? (
        <SkeletonCard rows={4} label="Loading station network…" />
      ) : stationsState.error && !stationsState.data ? (
        <ErrorState error={stationsState.error} onRetry={stationsState.refresh} />
      ) : reportable.length === 0 ? (
        <EmptyState>
          No station has produced a closed window yet. Reports become available once the
          engine emits state.
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {reportable.map((station) => {
            const look = freshness(station.freshness_status);
            return (
              <Panel
                key={station.station}
                title={stationLabel(station.station)}
                accent={aqiColor(station.aqi)}
                padding="p-4"
                right={
                  <Pill color={look.color} filled={station.freshness_status === "stale"}>
                    {look.marker} {look.label}
                  </Pill>
                }
              >
                <div className="grid grid-cols-3 gap-4">
                  <Stat label="AQI" value={station.aqi ?? "—"} color={aqiColor(station.aqi)} />
                  <Stat
                    label="GRAP"
                    value={orDash(station.grap_stage)}
                    color={grapColor(station.grap_stage)}
                    mono={false}
                    size="sm"
                  />
                  <Stat label="ERI" value={station.eri_score ?? 0} size="sm" />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelected(station.station)}
                    className="border-aree-border text-aree-muted hover:border-aree-accent hover:text-aree-accent rounded-lg border px-3 py-2 text-[12px] font-semibold transition-colors"
                  >
                    Select
                  </button>
                  <ReportDownload
                    station={station.station}
                    variant="ghost"
                    label="Download PDF"
                  />
                  <Link
                    href={`/stations/${encodeURIComponent(station.station)}`}
                    className="text-aree-dim hover:text-aree-accent ml-auto text-[11px] transition-colors"
                  >
                    View station →
                  </Link>
                </div>
              </Panel>
            );
          })}
        </div>
      )}
    </>
  );
}
