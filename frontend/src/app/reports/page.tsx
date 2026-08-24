"use client";

/**
 * Report centre.
 * Generate a report for a station and download the PDF.
 */

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { FileText, Loader2, History, Database } from "lucide-react";

import ReportDownload from "@/components/ReportDownload";
import StationSelector from "@/components/StationSelector";
import { useStations } from "@/components/providers/LiveDataProvider";
import { KeyValue, IntelligencePanel, StatusBadge, SectionHeader, Stat } from "@/components/ui/Card";
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
    <div className="max-w-[1400px] mx-auto space-y-8 pb-12">
      <div className="mb-8">
        <h1 className="text-3xl font-light tracking-tight text-[#17231c] mb-2">Report Centre</h1>
        <p className="text-sm text-[#64748b] max-w-2xl leading-relaxed">
          Four-page municipal escalation brief: decision snapshot, technical escalation
          detail, policy grounding and system transparency.
        </p>
      </div>

      <div className="space-y-6">
        <SectionHeader index="01">Generate report</SectionHeader>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,1.1fr)]">
          <IntelligencePanel title="Report parameters" variant="default">
            <div className="flex flex-col gap-6 p-6">
              <StationSelector
                id="report-station"
                value={selected}
                onChange={setSelected}
                label="Station"
              />

              <div className="bg-[#faf9f4] border border-[#e4e0d4] rounded-lg p-4">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[#788796] mb-3 block">
                  Report type
                </span>
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded bg-[#143828]/10 flex items-center justify-center shrink-0">
                    <FileText className="text-[#143828] h-4 w-4" aria-hidden />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-[#17231c]">Regulatory intelligence brief</div>
                    <div className="text-xs text-[#64748b]">4 pages · PDF</div>
                  </div>
                </div>
                <p className="text-xs text-[#788796] mt-4 leading-relaxed border-t border-[#e4e0d4] pt-3">
                  The engine publishes one report format.
                </p>
              </div>

              {selected ? (
                <ReportDownload
                  station={selected}
                  label="Generate Report"
                  onDownloaded={recordDownload}
                />
              ) : (
                <button
                  type="button"
                  disabled
                  className="w-full bg-[#faf9f4] border border-[#e4e0d4] text-[#788796] cursor-not-allowed rounded-lg px-4 py-3 text-sm font-medium transition-colors"
                >
                  Select a station to generate
                </button>
              )}
            </div>
          </IntelligencePanel>

          <IntelligencePanel title="Report preview" variant="default">
            <div className="p-6 h-full flex flex-col">
              {!selected ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center py-12">
                  <Database className="h-8 w-8 text-[#788796] mb-3" />
                  <div className="text-sm text-[#64748b]">Select a station to see what its report will contain.</div>
                </div>
              ) : meta.initialLoading ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center py-12">
                  <Loader2 className="h-6 w-6 text-[#143828] animate-spin mb-3" aria-hidden />
                  <div className="text-sm text-[#64748b]">Loading report metadata…</div>
                </div>
              ) : meta.error ? (
                <ErrorState error={meta.error} onRetry={meta.refresh} compact />
              ) : meta.data ? (
                <div className="space-y-6">
                  <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-[#e4e0d4]">
                    <div>
                      <div className="text-lg font-bold text-[#17231c] mb-2">
                        {stationLabel(meta.data.station)}
                      </div>
                      <StatusBadge
                        color={modeColor(meta.data.engine_mode)}
                        pulse={meta.data.engine_mode === "TRIGGERED"}
                        variant={meta.data.engine_mode === "TRIGGERED" ? "solid" : "outline"}
                      >
                        {modeLabel(meta.data.engine_mode)}
                      </StatusBadge>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <Stat label="AQI" value={meta.data.aqi ?? "—"} color={aqiColor(meta.data.aqi)} />
                    <Stat
                      label="GRAP stage"
                      value={orDash(meta.data.grap_stage)}
                      color={grapColor(meta.data.grap_stage)}
                      mono={false}
                      size="sm"
                    />
                  </div>
                  
                  <div className="bg-[#faf9f4] p-4 rounded-lg border border-[#e4e0d4] grid gap-3">
                    <KeyValue label="Generated for" value={meta.data.generated_for} />
                    <KeyValue label="Filename" value={meta.data.filename} />
                    <KeyValue
                      label="Availability"
                      value={meta.data.available ? "Ready for generation" : "Not available"}
                      color={meta.data.available ? "#16a34a" : "#ca8a04"}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </IntelligencePanel>
        </div>
      </div>

      <div className="space-y-6">
        <SectionHeader index="02">Report history</SectionHeader>
        {history.length === 0 ? (
          <EmptyState icon={<History className="h-5 w-5" />}>
            No report generated in this session yet.
          </EmptyState>
        ) : (
          <IntelligencePanel title="Generated in this session">
            <div className="divide-y divide-[#e4e0d4]">
              {history.map((entry) => (
                <div
                  key={`${entry.station}-${entry.generatedAt}`}
                  className="flex flex-wrap items-center justify-between gap-4 p-4 hover:bg-[#faf9f4] transition-colors"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/stations/${encodeURIComponent(entry.station)}`}
                      className="text-sm font-semibold text-[#17231c] hover:text-[#143828] transition-colors block mb-1"
                    >
                      {stationLabel(entry.station)}
                    </Link>
                    <div className="flex items-center gap-2 text-xs text-[#64748b]">
                      <span>{istDateTime(entry.generatedAt)}</span>
                      <span>&bull;</span>
                      <span style={{ color: aqiColor(entry.aqi) }}>AQI {entry.aqi ?? "—"}</span>
                      <span>&bull;</span>
                      <span style={{ color: grapColor(entry.grapStage) }}>{entry.grapStage ?? "—"}</span>
                    </div>
                  </div>
                  <ReportDownload
                    station={entry.station}
                    variant="ghost"
                    label="Download Again"
                  />
                </div>
              ))}
            </div>
          </IntelligencePanel>
        )}
      </div>

      <div className="space-y-6">
        <SectionHeader index="03">Stations available for reporting</SectionHeader>
        {stationsState.initialLoading ? (
          <SkeletonCard rows={4} label="Loading station network…" />
        ) : stationsState.error && !stationsState.data ? (
          <ErrorState error={stationsState.error} onRetry={stationsState.refresh} />
        ) : reportable.length === 0 ? (
          <EmptyState>
            No station has produced a closed window yet.
          </EmptyState>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
                    <div className="flex flex-wrap items-center gap-2 pt-4 border-t border-[#e4e0d4]">
                      <button
                        type="button"
                        onClick={() => setSelected(station.station)}
                        className="bg-[#faf9f4] hover:bg-[#f0eee4] border border-[#e4e0d4] text-[#17231c] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
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
                        className="ml-auto text-xs text-[#64748b] hover:text-[#143828] transition-colors flex items-center gap-1"
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
