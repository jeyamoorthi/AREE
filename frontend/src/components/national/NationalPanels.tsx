"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Flame, Globe, Server, Shield, Sparkles } from "lucide-react";

import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";
import { istDateTime } from "@/lib/clock";
import { stationLabel } from "@/lib/station";
import { grapColor, grapRank } from "@/lib/theme";
import type {
  EscalationsResponse,
  StationListResponse,
  StationSummary,
  SystemStatus,
} from "@/types";

export interface NetworkFacts {
  withData: StationSummary[];
  minAqi: number | null;
  maxAqi: number | null;
  worstStation: StationSummary | null;
  worstStage: string | null;
  triggered: number;
  watch: number;
  normal: number;
}

export function useNetworkFacts(data: StationListResponse | null): NetworkFacts {
  return useMemo(() => {
    const stations = data?.stations ?? [];
    const withData = stations.filter(
      (s) => s.has_data && s.aqi !== null && s.aqi !== undefined,
    );
    const values = withData.map((s) => s.aqi as number);
    const worstStation =
      withData.length > 0
        ? withData.reduce((worst, s) =>
            (s.aqi ?? -1) > (worst.aqi ?? -1) ? s : worst,
          )
        : null;
    const worstStage =
      withData.length > 0
        ? withData.reduce<string | null>(
            (worst, s) =>
              grapRank(s.grap_stage) > grapRank(worst) ? (s.grap_stage ?? null) : worst,
            null,
          )
        : null;

    return {
      withData,
      minAqi: values.length ? Math.min(...values) : null,
      maxAqi: values.length ? Math.max(...values) : null,
      worstStation,
      worstStage,
      triggered: stations.filter((s) => s.engine_mode === "TRIGGERED").length,
      watch: stations.filter((s) => s.engine_mode === "WATCH").length,
      normal: stations.filter((s) => s.engine_mode === "NORMAL").length,
    };
  }, [data]);
}

/* ── Top Right: National Summary (6 Metric Cards + Pathway status) ── */
export function NationalSummaryPanel({
  facts,
  status,
  stations,
}: {
  facts: NetworkFacts;
  status: SystemStatus | null;
  stations: StationListResponse | null;
}) {
  const stale = status?.stale_stations ?? stations?.stale ?? 0;
  const aging = status?.aging_stations ?? stations?.aging ?? 0;
  const unavailable = status?.unavailable_stations ?? stations?.unavailable ?? 0;
  const current = status?.current_stations ?? stations?.current ?? 0;

  // No placeholder values. These fell back to 68 / 167 / "Pooth Khurd" / "Stage I" when
  // the network had not reported, so an empty engine rendered a plausible-looking
  // summary of a network that was not there.
  const hasData = facts.withData.length > 0;
  const minAqi = facts.minAqi;
  const maxAqi = facts.maxAqi;
  const worstName = facts.worstStation
    ? stationLabel(facts.worstStation.station)
    : null;
  const grapStage = facts.worstStage ?? "None";

  return (
    <div className="bg-white border border-[#e4e0d4] rounded-xl p-5 shadow-xs flex flex-col justify-between h-full">
      <div>
        <h2 className="text-[12px] font-black tracking-wider uppercase text-[#17231c] font-sans mb-4">
          NATIONAL SUMMARY
        </h2>

        {/* 2 columns x 3 rows grid of metrics */}
        <div className="grid grid-cols-2 gap-3.5">
          {/* Card 1: AQI Range */}
          <div className="bg-[#faf9f4] border border-[#e4e0d4] rounded-lg p-3.5">
            <div className="text-[10px] font-bold tracking-wider text-[#788796] uppercase mb-1">
              AQI RANGE
            </div>
            <div className="text-[20px] font-bold font-mono text-[#17231c]">
              {hasData ? `${minAqi} — ${maxAqi}` : "—"}
            </div>
            <div className="text-[11px] text-[#788796] mt-0.5">
              {hasData
                ? `Across ${facts.withData.length} reporting stations`
                : "No station is reporting yet"}
            </div>
          </div>

          {/* Card 2: Highest AQI */}
          <div className="bg-[#faf9f4] border border-[#e4e0d4] rounded-lg p-3.5">
            <div className="text-[10px] font-bold tracking-wider text-[#788796] uppercase mb-1">
              HIGHEST AQI
            </div>
            <div className="text-[20px] font-bold font-mono text-[#17231c]">
              {hasData ? maxAqi : "—"}
            </div>
            <div
              className="text-[11px] text-[#788796] mt-0.5 truncate"
              title={worstName ?? undefined}
            >
              {worstName ?? "Awaiting telemetry"}
            </div>
          </div>

          {/* Card 3: Regulatory State */}
          <div className="bg-[#faf9f4] border border-[#e4e0d4] rounded-lg p-3.5">
            <div className="text-[10px] font-bold tracking-wider text-[#788796] uppercase mb-1">
              REGULATORY STATE
            </div>
            <div
              className={`text-[17px] font-extrabold ${
                facts.triggered > 0 ? "text-[#dc2626]" : "text-[#16a34a]"
              }`}
            >
              {facts.triggered > 0 ? "Triggered" : "Within Limits"}
            </div>
            <div className="text-[11px] text-[#788796] mt-0.5">
              {facts.triggered > 0
                ? "Active escalation"
                : "No immediate escalation"}
            </div>
          </div>

          {/* Card 4: GRAP Status */}
          <div className="bg-[#faf9f4] border border-[#e4e0d4] rounded-lg p-3.5">
            <div className="text-[10px] font-bold tracking-wider text-[#788796] uppercase mb-1">
              GRAP STATUS
            </div>
            <div className="text-[18px] font-bold text-[#17231c]">
              {grapStage}
            </div>
            {/* "(Watch & Advise)" was hardcoded and describes Stage I regardless of the
                stage shown. The distinction that matters more: AREE COMPUTES a stage
                from the highest observed AQI; only CAQM INVOKES one. */}
            <div className="text-[11px] text-[#788796] mt-0.5">
              Computed from highest station AQI · not a CAQM invocation
            </div>
          </div>

          {/* Card 5: Active Escalations */}
          <div className="bg-[#faf9f4] border border-[#e4e0d4] rounded-lg p-3.5">
            <div className="text-[10px] font-bold tracking-wider text-[#788796] uppercase mb-1">
              ACTIVE ESCALATIONS
            </div>
            <div className="text-[20px] font-bold font-mono text-[#17231c]">
              {facts.triggered}
            </div>
            {/* The caption used to read "No escalations at this time" even when the
                count beside it was non-zero. */}
            <div className="text-[11px] text-[#788796] mt-0.5">
              {facts.triggered > 0
                ? `${facts.triggered} station${facts.triggered === 1 ? "" : "s"} in a triggered state`
                : "No escalations at this time"}
            </div>
          </div>

          {/* Card 6: Data Freshness Breakdown */}
          <div className="bg-[#faf9f4] border border-[#e4e0d4] rounded-lg p-3.5">
            <div className="text-[10px] font-bold tracking-wider text-[#788796] uppercase mb-1.5">
              DATA FRESHNESS
            </div>
            <div className="space-y-1 text-[11px] font-semibold">
              <div className="flex items-center gap-1.5 text-[#17231c]">
                <span className="h-2 w-2 rounded-full bg-[#16a34a]" />
                <span>{current} Current</span>
              </div>
              <div className="flex items-center gap-1.5 text-[#17231c]">
                <span className="h-2 w-2 rounded-full bg-[#ca8a04]" />
                <span>{aging} Aging</span>
              </div>
              <div className="flex items-center gap-1.5 text-[#17231c]">
                <span className="h-2 w-2 rounded-full bg-[#ea580c]" />
                <span>{stale} Stale</span>
              </div>
              <div className="flex items-center gap-1.5 text-[#17231c]">
                <span className="text-[10px] text-[#788796]">⊗</span>
                <span>{unavailable} Unavailable</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Engine status. This read "Pathway pipeline - Running" as two literal strings,
          on a machine where Pathway had never started and the direct engine was doing
          the work. Both halves now come from /api/system/status. */}
      <div className="mt-4 pt-3.5 border-t border-[#f0eee4] flex items-center justify-between text-[12px]">
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{
              background: status?.engine_loaded ? "#16a34a" : "#dc2626",
            }}
          />
          <span className="font-semibold text-[#17231c]">
            {status?.mode === "streaming"
              ? "Pathway streaming engine"
              : status?.mode === "direct"
                ? "Direct engine"
                : "Engine"}
          </span>
        </div>
        <span
          className="font-bold"
          style={{ color: status?.engine_loaded ? "#16a34a" : "#dc2626" }}
        >
          {status ? (status.engine_loaded ? "Running" : "Offline") : "—"}
        </span>
      </div>
      {status?.degraded ? (
        <p className="mt-1.5 text-[10.5px] text-[#788796] leading-snug">
          Direct mode: GRAP state machine, causal attribution and the forecast layer are
          unchanged. Event-time windowing and policy retrieval are unavailable.
        </p>
      ) : null}
    </div>
  );
}

/* ── Middle Col 1: AQI Distribution Donut Chart ── */
export function AQIDistributionDonut({ facts }: { facts: NetworkFacts }) {
  const bands = [
    { label: "Good (0-50)", count: 0, color: "#16a34a" },
    { label: "Satisfactory (51-100)", count: 0, color: "#65a30d" },
    { label: "Moderate (101-200)", count: 0, color: "#ca8a04" },
    { label: "Poor (201-300)", count: 0, color: "#ea580c" },
    { label: "Very Poor (301-400)", count: 0, color: "#dc2626" },
    { label: "Severe (401+)", count: 0, color: "#991b1b" },
  ];

  for (const s of facts.withData) {
    const a = s.aqi ?? 0;
    if (a <= 50) bands[0].count++;
    else if (a <= 100) bands[1].count++;
    else if (a <= 200) bands[2].count++;
    else if (a <= 300) bands[3].count++;
    else if (a <= 400) bands[4].count++;
    else bands[5].count++;
  }

  // No synthetic distribution. This used to fill 2/9/10/3 across the bands and set the
  // denominator to 24 when no station had reported, so an empty engine drew a complete,
  // entirely invented donut.
  const total = facts.withData.length;
  const chartData = bands.filter((b) => b.count > 0);

  return (
    <div className="bg-white border border-[#e4e0d4] rounded-xl p-5 shadow-xs flex flex-col justify-between">
      <div>
        <h3 className="text-[12px] font-black tracking-wider uppercase text-[#17231c] font-sans">
          AQI DISTRIBUTION
        </h3>
        <p className="text-[11px] text-[#788796] mt-0.5 mb-4">
          Distribution of stations by AQI category
        </p>

        {total === 0 ? (
          <p className="py-10 text-center text-[12px] text-[#788796]">
            No station has reported yet — the distribution appears once the network is
            online.
          </p>
        ) : (
        <div className="flex flex-col sm:flex-row items-center gap-5">
          <div className="relative w-36 h-36 shrink-0 flex items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey="count"
                  nameKey="label"
                  cx="50%"
                  cy="50%"
                  innerRadius={38}
                  outerRadius={58}
                  paddingAngle={2}
                  stroke="none"
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-[19px] font-extrabold font-mono text-[#17231c] leading-none">
                {total}
              </span>
              <span className="text-[9px] text-[#788796] font-bold uppercase mt-0.5">
                Stations
              </span>
            </div>
          </div>

          <div className="flex-1 space-y-1.5 text-[11px]">
            {bands.map((b) => {
              const pct = Math.round((b.count / total) * 100);
              return (
                <div
                  key={b.label}
                  className="flex items-center justify-between text-[#2d3748]"
                >
                  <div className="flex items-center gap-1.5 truncate">
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ background: b.color }}
                    />
                    <span className="truncate">{b.label}</span>
                  </div>
                  <span className="font-semibold text-[#17231c] shrink-0 font-mono">
                    {b.count} ({pct}%)
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

/* ── Middle Col 2: Top 5 Stations by AQI ── */
export function Top5StationsCard({ facts }: { facts: NetworkFacts }) {
  // The fallback list (Pooth Khurd 167, Bawana 154, ...) rendered five named Delhi
  // stations with plausible AQI values that no feed had produced. Removed: an empty
  // network must look empty.
  const topList = useMemo(
    () =>
      [...facts.withData]
        .sort((a, b) => (b.aqi ?? 0) - (a.aqi ?? 0))
        .slice(0, 5)
        .map((s) => ({
          station: s.station,
          name: stationLabel(s.station),
          aqi: s.aqi ?? 0,
        })),
    [facts.withData],
  );

  return (
    <div className="bg-white border border-[#e4e0d4] rounded-xl p-5 shadow-xs flex flex-col justify-between">
      <div>
        <h3 className="text-[12px] font-black tracking-wider uppercase text-[#17231c] font-sans">
          TOP 5 STATIONS BY AQI
        </h3>
        <p className="text-[11px] text-[#788796] mt-0.5 mb-3">
          Highest current AQI
        </p>

        <div className="space-y-2.5">
          {topList.length === 0 ? (
            <p className="py-8 text-center text-[12px] text-[#788796]">
              No station has reported yet.
            </p>
          ) : null}
          {topList.map((st, i) => (
            <div
              key={st.station}
              className="flex items-center justify-between text-[12px] py-1 border-b border-[#f0eee4] last:border-b-0"
            >
              <div className="flex items-center gap-3">
                <span className="font-bold text-[#788796] text-[11px] w-3">
                  {i + 1}
                </span>
                <Link
                  href={`/stations/${encodeURIComponent(st.station)}`}
                  className="font-semibold text-[#17231c] hover:text-[#143828] transition-colors"
                >
                  {st.name}
                </Link>
              </div>
              <span className="font-bold font-mono text-[#ea580c]">
                {st.aqi}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-[#f0eee4] text-right">
        <Link
          href="/dashboard"
          className="text-[11px] font-bold text-[#143828] hover:underline inline-flex items-center gap-1"
        >
          View All Stations &rarr;
        </Link>
      </div>
    </div>
  );
}

/* ── Middle Col 3: Data Health Overview ──
   Every row here used to be a literal. "NASA FIRMS - Live", "Weather - Live",
   "RAG Engine - Active" and "Policy Index - Indexed" were printed as constants while
   the API reported rag_status "unavailable" and the satellite poller had never run.
   Two of them were not even reported by this endpoint, so there was nothing to be
   right or wrong about.

   Now: only subsystems /api/system/status actually reports, each with its real state.
   FIRMS and the meteorological feed are deliberately absent - they belong to the
   forecast layer and are reported on the Atmospheric Outlook, which knows about them. */
export function DataHealthOverviewCard({ status }: { status: SystemStatus | null }) {
  const stale = status?.stale_stations ?? 0;
  const aging = status?.aging_stations ?? 0;
  const unavailable = status?.unavailable_stations ?? 0;

  const unknown = { label: "Unknown", color: "#788796" };

  const networkState = !status
    ? unknown
    : stale > 0
      ? { label: `${stale} stale`, color: "#ea580c" }
      : aging > 0
        ? { label: `${aging} aging`, color: "#ca8a04" }
        : { label: "Current", color: "#16a34a" };

  const engineState = !status
    ? unknown
    : !status.engine_loaded
      ? { label: "Offline", color: "#dc2626" }
      : status.mode === "streaming"
        ? { label: "Streaming", color: "#16a34a" }
        : { label: "Direct", color: "#ca8a04" };

  const ragState = !status
    ? unknown
    : status.rag_status === "active"
      ? { label: "Active", color: "#16a34a" }
      : { label: status.rag_status ?? "Unavailable", color: "#ca8a04" };

  const docs = status?.rag_docs_indexed ?? null;
  const policyState =
    docs === null
      ? unknown
      : docs > 0
        ? { label: `${docs} on disk`, color: "#16a34a" }
        : { label: "Empty", color: "#ca8a04" };

  const llmState = !status
    ? unknown
    : status.llm_ready === true
      ? { label: "Ready", color: "#16a34a" }
      : status.llm_ready === false
        ? { label: "Fallback", color: "#ca8a04" }
        : unknown;

  const sources = [
    {
      name: "Station network",
      sub: status ? `${status.active_stations}/${status.known_stations} reporting` : null,
      status: networkState.label,
      color: networkState.color,
      icon: <Globe className="w-3.5 h-3.5" />,
    },
    {
      name: "Engine",
      sub: status?.pipeline ?? null,
      status: engineState.label,
      color: engineState.color,
      icon: <Server className="w-3.5 h-3.5" />,
    },
    {
      name: "Policy documents",
      sub: null,
      status: policyState.label,
      color: policyState.color,
      icon: <Shield className="w-3.5 h-3.5" />,
    },
    {
      name: "Policy retrieval",
      sub: status?.degraded ? "requires Pathway" : null,
      status: ragState.label,
      color: ragState.color,
      icon: <Server className="w-3.5 h-3.5" />,
    },
    {
      name: "LLM narrative",
      sub: status?.llm_model ?? null,
      status: llmState.label,
      color: llmState.color,
      icon: <Sparkles className="w-3.5 h-3.5" />,
    },
    {
      name: "Unavailable feeds",
      sub: "no usable AQI",
      status: status ? String(unavailable) : "—",
      color: unavailable > 0 ? "#ca8a04" : "#16a34a",
      icon: <Flame className="w-3.5 h-3.5" />,
    },
  ];

  return (
    <div className="bg-white border border-[#e4e0d4] rounded-xl p-5 shadow-xs flex flex-col justify-between">
      <div>
        <h3 className="text-[12px] font-black tracking-wider uppercase text-[#17231c] font-sans">
          DATA HEALTH OVERVIEW
        </h3>
        <p className="text-[11px] text-[#788796] mt-0.5 mb-3">
          Health of key data sources
        </p>

        <div className="space-y-2">
          {sources.map((src) => (
            <div
              key={src.name}
              className="flex items-center justify-between text-[12px] py-1 border-b border-[#f0eee4] last:border-b-0"
            >
              <div className="flex items-center gap-2.5 text-[#17231c] min-w-0">
                <span className="text-[#788796] shrink-0">{src.icon}</span>
                <span className="font-semibold truncate">{src.name}</span>
                {src.sub ? (
                  <span className="text-[10.5px] text-[#788796] truncate shrink">
                    {src.sub}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: src.color }}
                />
                <span
                  className="text-[11px] font-bold"
                  style={{ color: src.color }}
                >
                  {src.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* The old "View All Sources" link pointed at /?section=health, which no route
          reads - it reloaded this same page. */}
      <div className="mt-4 pt-3 border-t border-[#f0eee4]">
        <p className="text-[10.5px] text-[#788796] leading-snug">
          Freshness: current 0–90 min · aging 90–120 min · stale beyond 120 min. Satellite
          and meteorological feeds are reported on the Atmospheric Outlook.
        </p>
      </div>
    </div>
  );
}

/* ── Bottom Row: Recent Events Stream ──
   This was five hardcoded cards: a "09:15 AM Data Stale Alert" about 24 stations, a
   "FIRMS Update - 14 fire detections", a "System Check - All systems operational".
   None of them referred to anything that had happened; they rendered identically on an
   empty engine and on a live one, and a judge asking "what triggered the 09:15 alert?"
   had no answer.

   Now: real GRAP transitions from /api/escalations. When the state machine has recorded
   nothing, the row says so - an empty operations log is a fact, not a gap to fill. */
export function RecentEventsRow() {
  const state = usePolling<EscalationsResponse>(
    (signal) => api.escalations(undefined, signal),
    { intervalMs: 15000 },
  );

  const events = (state.data?.events ?? []).slice(0, 5);

  return (
    <div className="bg-white border border-[#e4e0d4] rounded-xl p-5 shadow-xs">
      <div className="flex items-center justify-between mb-3.5">
        <div>
          <h3 className="text-[12px] font-black tracking-wider uppercase text-[#17231c] font-sans">
            RECENT EVENTS
          </h3>
          <p className="text-[11px] text-[#788796]">
            GRAP stage transitions recorded by the state machine
          </p>
        </div>
        {state.data && state.data.total > events.length ? (
          <span className="text-[11px] text-[#788796]">
            {events.length} of {state.data.total}
          </span>
        ) : null}
      </div>

      {state.initialLoading ? (
        <p className="py-6 text-center text-[12px] text-[#788796]">Loading events…</p>
      ) : state.error && !state.data ? (
        <p className="py-6 text-center text-[12px] text-[#788796]">
          Event log unavailable — {state.error.message}
        </p>
      ) : events.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-[#788796]">
          No stage transition recorded in this session. Events appear here when a
          station&apos;s GRAP stage changes.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {events.map((ev, i) => {
            const colour = grapColor(ev.to_stage);
            return (
              <div
                key={`${ev.timestamp}-${ev.city ?? ev.station ?? i}`}
                className="rounded-lg p-3 border flex flex-col justify-between bg-[#faf9f4]"
                style={{ borderColor: "#e4e0d4" }}
              >
                <div className="text-[10px] font-bold font-mono text-[#788796] mb-1">
                  {istDateTime(ev.timestamp) ?? ev.timestamp ?? "—"}
                </div>
                <div className="flex items-center gap-1.5 mb-1">
                  <Shield className="w-4 h-4 shrink-0" style={{ color: colour }} />
                  <span className="text-[12px] font-bold text-[#17231c] leading-tight truncate">
                    {stationLabel(ev.city ?? ev.station ?? "—")}
                  </span>
                </div>
                <div className="text-[11px] text-[#4a5568] leading-tight">
                  {ev.from_stage ?? "—"} → <b style={{ color: colour }}>{ev.to_stage}</b>
                  {ev.aqi !== null && ev.aqi !== undefined ? ` · AQI ${ev.aqi}` : ""}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
