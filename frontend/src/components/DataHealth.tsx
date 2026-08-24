"use client";

/**
 * Source health.
 * Every row is a real subsystem state read from the API.
 */

import { Panel, DataHealthItem } from "@/components/ui/Card";
import { useStations, useSystemStatus } from "@/components/providers/LiveDataProvider";
import type { AdvisoryResponse, AIResponse, StationDetail } from "@/types";

export type HealthLevel = "ok" | "warn" | "bad" | "unknown";

export interface SourceRow {
  name: string;
  level: HealthLevel;
  status: string;
  detail?: string | null;
}

export function SourceHealthGrid({ rows }: { rows: SourceRow[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((row) => (
        <DataHealthItem
          key={row.name}
          label={row.name}
          status={row.status}
          level={row.level}
          detail={row.detail ?? undefined}
        />
      ))}
    </div>
  );
}

/** Network-wide source health for the national overview. */
export function NationalDataHealth() {
  const { data: status } = useSystemStatus();
  const { data: stations } = useStations();

  const stale = status?.stale_stations ?? 0;
  const aging = status?.aging_stations ?? 0;
  const unavailable = status?.unavailable_stations ?? 0;
  const feedErrors = stations
    ? stations.stations.filter((s) => s.feed_status === "error").length
    : 0;

  const rows: SourceRow[] = [
    {
      name: "WAQI",
      level: !status ? "unknown" : stale > 0 ? "bad" : aging > 0 ? "warn" : "ok",
      status: !status ? "Unknown" : stale > 0 ? "Stale" : aging > 0 ? "Aging" : "Live",
      detail: status
        ? `${status.current_stations} current · ${aging} aging · ${stale} stale · ${unavailable} unavailable`
        : "System status unavailable",
    },
    {
      name: "Pathway",
      level: status?.pipeline === "running" ? "ok" : "unknown",
      status: status?.pipeline?.toUpperCase() ?? "UNKNOWN",
      detail: status
        ? `${status.decisions_processed.toLocaleString()} decisions processed`
        : null,
    },
    {
      name: "Station feeds",
      level: feedErrors > 0 ? "bad" : unavailable > 0 ? "warn" : "ok",
      status: feedErrors > 0 ? "Errors" : unavailable > 0 ? "Partial" : "Nominal",
      detail: stations
        ? `${stations.active} of ${stations.total} publishing an AQI`
        : "Station list unavailable",
    },
    {
      name: "RAG",
      level: status?.rag_status === "active" ? "ok" : status?.rag_status ? "warn" : "unknown",
      status: status?.rag_status?.toUpperCase() ?? "UNKNOWN",
      detail:
        status?.rag_docs_indexed !== null && status?.rag_docs_indexed !== undefined
          ? `${status.rag_docs_indexed} documents indexed`
          : "Index state not reported",
    },
    {
      name: "Policy index",
      level:
        status?.rag_docs_indexed && status.rag_docs_indexed > 0
          ? "ok"
          : status
            ? "warn"
            : "unknown",
      status:
        status?.rag_docs_indexed && status.rag_docs_indexed > 0 ? "Indexed" : "Empty",
      detail: "Live document store served by the Python RAG pipeline",
    },
    {
      name: "Gemini",
      level: status?.llm_ready === true ? "ok" : status?.llm_ready === false ? "warn" : "unknown",
      status:
        status?.llm_ready === true
          ? "Ready"
          : status?.llm_ready === false
            ? "Fallback"
            : "Unknown",
      detail: status?.llm_ready === false ? status.llm_error : status?.llm_model,
    },
  ];

  return (
    <Panel title="Data health pipeline" padding="p-6">
      <SourceHealthGrid rows={rows} />
      <div className="mt-5 rounded-lg bg-[#faf9f4] border border-[#e4e0d4] p-3 flex items-center gap-3">
        <div className="h-2 w-2 rounded-full bg-[#16a34a] animate-pulse" />
        <p className="text-[#64748b] text-[12px] leading-relaxed">
          Freshness policy: current (0–90m) · aging (90–120m) · stale (&gt;120m).
        </p>
      </div>
    </Panel>
  );
}

/** Per-station source health for the command center. */
export function StationDataHealth({
  detail,
  ai,
  advisory,
}: {
  detail: StationDetail;
  ai: AIResponse | null;
  advisory: AdvisoryResponse | null;
}) {
  const fresh = detail.freshness_status;
  const firmsStatus = detail.firms_status ?? null;
  const windAvailable = detail.wind_speed !== null && detail.wind_speed !== undefined;
  const usingFallback = Boolean(ai?.model && ai.model.startsWith("deterministic"));

  const rows: SourceRow[] = [
    {
      name: "WAQI",
      level:
        fresh === "current" ? "ok" : fresh === "aging" ? "warn" : fresh === "stale" ? "bad" : "unknown",
      status:
        fresh === "current"
          ? "Current"
          : fresh === "aging"
            ? "Aging"
            : fresh === "stale"
              ? "Stale"
              : "Unavailable",
      detail: detail.waqi_timestamp_local ?? detail.waqi_timestamp ?? null,
    },
    {
      name: "FIRMS",
      level: firmsStatus === "ok" ? "ok" : firmsStatus === "awaiting" ? "warn" : firmsStatus ? "bad" : "unknown",
      status: firmsStatus ? firmsStatus.toUpperCase() : "UNKNOWN",
      detail: detail.firms_error ?? detail.firms_dataset ?? null,
    },
    {
      name: "Weather",
      level: windAvailable ? "ok" : "unknown",
      status: windAvailable ? "Live" : "Not available",
      detail: windAvailable
        ? `Wind ${detail.wind_speed?.toFixed(1)} m/s${detail.wind_label ? ` · ${detail.wind_label}` : ""}`
        : "No wind telemetry from the source feed",
    },
    {
      name: "RAG",
      level: advisory?.rag_index_type ? "ok" : "unknown",
      status: advisory?.rag_index_type ? "Active" : "Unknown",
      detail: advisory?.rag_index_type ?? null,
    },
    {
      name: "Policy",
      level: advisory?.rag_docs_indexed ? "ok" : "warn",
      status: advisory?.rag_docs_indexed ? "Indexed" : "Empty",
      detail: advisory?.rag_policy_file ?? null,
    },
    {
      name: "Gemini",
      level: ai ? (usingFallback ? "warn" : "ok") : "unknown",
      status: ai ? (usingFallback ? "Fallback" : "Ready") : "Unknown",
      detail: ai ? (ai.error ?? ai.model) : null,
    },
  ];

  return <SourceHealthGrid rows={rows} />;
}
