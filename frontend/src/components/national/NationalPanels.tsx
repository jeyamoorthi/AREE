"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Flame, Globe, Server, Shield, Sparkles } from "lucide-react";

import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";
import { istDateTime } from "@/lib/clock";
import { newestFirst } from "@/lib/escalation";
import { stationLabel } from "@/lib/station";
import { freshness } from "@/lib/freshness";
import { AQI_BANDS, aqiColor, grapColor, grapRank } from "@/lib/theme";
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

/* ── Top Right: NCR Summary (6 Metric Cards + engine status) ── */
export function NationalSummaryPanel({
  facts,
  status,
  stations,
  loading = false,
}: {
  facts: NetworkFacts;
  status: SystemStatus | null;
  stations: StationListResponse | null;
  /**
   * True until the first /api/stations response. Every verdict card holds a dash
   * until then: "Within limits" and "No escalations" before anything has been
   * read would be an all-clear the page has not earned.
   */
  loading?: boolean;
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
  const stageInForce = grapRank(facts.worstStage) > 0;
  // "Stage II (Very Poor)" -> "Stage II": the band is already on the GRAP card.
  const stageShort = /Stage\s+[IV]+/i.exec(grapStage)?.[0] ?? grapStage;

  /* One verdict, consistent with the GRAP card beside it. "Within limits" is kept
     for the case that actually is: no station triggered AND no stage in force. A
     stage in force (including one held by hysteresis) is named as such, so the
     summary never reads green next to "Stage II". */
  const regulatory = loading
    ? { label: "—", caption: "Awaiting first station response", color: "var(--aree-dim)" }
    : facts.triggered > 0
      ? { label: "Triggered", caption: "Active escalation", color: "var(--aree-red)" }
      : stageInForce
        ? {
            label: `GRAP ${stageShort} in force`,
            caption: "No station triggered",
            color: grapColor(grapStage),
          }
        : {
            label: "Within limits",
            caption: "No stage in force · no escalation",
            color: "var(--aree-green)",
          };
  const dash = (value: number) => (loading ? "—" : value);

  return (
    <div className="bg-aree-card border border-aree-border rounded-xl p-5 shadow-xs flex flex-col justify-between h-full">
      <div>
        <h2 className="text-[12px] font-black tracking-wider uppercase text-aree-text font-sans mb-4">
          NCR SUMMARY
        </h2>

        {/* 2 columns x 3 rows grid of metrics */}
        <div className="grid grid-cols-2 gap-3.5">
          {/* Card 1: AQI Range */}
          <div className="bg-aree-surface-2 border border-aree-border rounded-lg p-3.5">
            <div className="text-[10px] font-bold tracking-wider text-aree-dim uppercase mb-1">
              AQI RANGE
            </div>
            <div className="text-[20px] font-bold font-mono text-aree-text">
              {hasData ? `${minAqi} — ${maxAqi}` : "—"}
            </div>
            <div className="text-[11px] text-aree-dim mt-0.5">
              {hasData
                ? `Across ${facts.withData.length} reporting stations`
                : "No station is reporting yet"}
            </div>
          </div>

          {/* Card 2: Highest AQI */}
          <div className="bg-aree-surface-2 border border-aree-border rounded-lg p-3.5">
            <div className="text-[10px] font-bold tracking-wider text-aree-dim uppercase mb-1">
              HIGHEST AQI
            </div>
            <div className="text-[20px] font-bold font-mono text-aree-text">
              {hasData ? maxAqi : "—"}
            </div>
            <div
              className="text-[11px] text-aree-dim mt-0.5 truncate"
              title={worstName ?? undefined}
            >
              {worstName ?? "Awaiting telemetry"}
            </div>
          </div>

          {/* Card 3: Regulatory State */}
          <div className="bg-aree-surface-2 border border-aree-border rounded-lg p-3.5">
            <div className="text-[10px] font-bold tracking-wider text-aree-dim uppercase mb-1">
              REGULATORY STATE
            </div>
            <div
              className="text-[17px] font-extrabold leading-tight"
              style={{ color: regulatory.color }}
            >
              {regulatory.label}
            </div>
            <div className="text-[11px] text-aree-dim mt-0.5">
              {regulatory.caption}
            </div>
          </div>

          {/* Card 4: GRAP Status */}
          <div className="bg-aree-surface-2 border border-aree-border rounded-lg p-3.5">
            <div className="text-[10px] font-bold tracking-wider text-aree-dim uppercase mb-1">
              GRAP STATUS
            </div>
            <div className="text-[18px] font-bold text-aree-text">
              {loading ? "—" : grapStage}
            </div>
            {/* "(Watch & Advise)" was hardcoded and describes Stage I regardless of the
                stage shown. The distinction that matters more: AREE COMPUTES a stage
                per station (with hysteresis); only CAQM INVOKES one. This is the
                highest of those per-station stages, not a function of the peak AQI. */}
            <div className="text-[11px] text-aree-dim mt-0.5">
              Highest GRAP stage in force across stations · not a CAQM invocation
            </div>
          </div>

          {/* Card 5: Active Escalations */}
          <div className="bg-aree-surface-2 border border-aree-border rounded-lg p-3.5">
            <div className="text-[10px] font-bold tracking-wider text-aree-dim uppercase mb-1">
              ACTIVE ESCALATIONS
            </div>
            <div className="text-[20px] font-bold font-mono text-aree-text">
              {dash(facts.triggered)}
            </div>
            {/* The caption used to read "No escalations at this time" even when the
                count beside it was non-zero. */}
            <div className="text-[11px] text-aree-dim mt-0.5">
              {loading
                ? "Awaiting first station response"
                : facts.triggered > 0
                ? `${facts.triggered} station${facts.triggered === 1 ? "" : "s"} in a triggered state`
                : "No escalations at this time"}
            </div>
          </div>

          {/* Card 6: Data Freshness Breakdown */}
          <div className="bg-aree-surface-2 border border-aree-border rounded-lg p-3.5">
            <div className="text-[10px] font-bold tracking-wider text-aree-dim uppercase mb-1.5">
              DATA FRESHNESS
            </div>
            <div className="space-y-1 text-[11px] font-semibold">
              <div className="flex items-center gap-1.5 text-aree-text">
                <span className="h-2 w-2 rounded-full bg-aree-green" />
                <span>{dash(current)} Current</span>
              </div>
              <div className="flex items-center gap-1.5 text-aree-text">
                <span className="h-2 w-2 rounded-full bg-aree-yellow" />
                <span>{dash(aging)} Aging</span>
              </div>
              <div className="flex items-center gap-1.5 text-aree-text">
                <span className="h-2 w-2 rounded-full bg-aree-orange" />
                <span>{dash(stale)} Stale</span>
              </div>
              <div className="flex items-center gap-1.5 text-aree-text">
                <span className="text-[10px] text-aree-dim">⊗</span>
                <span>{dash(unavailable)} Unavailable</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Engine status. This read "Pathway pipeline - Running" as two literal strings,
          on a machine where Pathway had never started and the direct engine was doing
          the work. Both halves now come from /api/system/status. */}
      <div className="mt-4 pt-3.5 border-t border-aree-border flex items-center justify-between text-[12px]">
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{
              background: status?.engine_loaded ? "var(--aree-green)" : "var(--aree-red)",
            }}
          />
          <span className="font-semibold text-aree-text">
            {status?.mode === "streaming"
              ? "Pathway streaming engine"
              : status?.mode === "direct"
                ? "Direct engine"
                : "Engine"}
          </span>
        </div>
        <span
          className="font-bold"
          style={{ color: status?.engine_loaded ? "var(--aree-green)" : "var(--aree-red)" }}
        >
          {status ? (status.engine_loaded ? "Running" : "Engine offline") : "—"}
        </span>
      </div>
      {status?.degraded ? (
        <p className="mt-1.5 text-[10.5px] text-aree-dim leading-snug">
          Direct mode: GRAP state machine, causal attribution and the forecast layer are
          unchanged. Event-time windowing and policy retrieval are unavailable.
        </p>
      ) : null}
    </div>
  );
}

/* ── Middle Col 1: AQI Distribution Donut Chart ── */
export function AQIDistributionDonut({ facts }: { facts: NetworkFacts }) {
  // From the shared CPCB table, so the donut, the map legend and every marker
  // agree on each band's colour.
  const bands = AQI_BANDS.map((b) => ({
    label: `${b.label} (${b.range})`,
    count: 0,
    color: b.color,
  }));

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
    <div className="bg-aree-card border border-aree-border rounded-xl p-5 shadow-xs flex flex-col justify-between">
      <div>
        <h3 className="text-[12px] font-black tracking-wider uppercase text-aree-text font-sans">
          AQI DISTRIBUTION
        </h3>
        <p className="text-[11px] text-aree-dim mt-0.5 mb-4">
          Distribution of stations by AQI category
        </p>

        {total === 0 ? (
          <p className="py-10 text-center text-[12px] text-aree-dim">
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
                {/* Recharts' default tooltip is a white box with black text — right
                    in the light theme, glaring in the dark one. Painted from tokens. */}
                <Tooltip
                  contentStyle={{
                    background: "var(--aree-surface-1)",
                    border: "1px solid var(--aree-border)",
                    borderRadius: 8,
                    boxShadow: "var(--aree-shadow-md)",
                    fontSize: 11,
                  }}
                  labelStyle={{ color: "var(--aree-text)" }}
                  itemStyle={{ color: "var(--aree-body)" }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-[19px] font-extrabold font-mono text-aree-text leading-none">
                {total}
              </span>
              <span className="text-[9px] text-aree-dim font-bold uppercase mt-0.5">
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
                  /* `justify-between` alone leaves NO gap once the band name fills
                     the row, which on a phone read as "Satisfactory (51–100)48". */
                  className="flex items-start justify-between gap-2 text-aree-body"
                >
                  {/* The band name WRAPS rather than truncating. This column is a
                      third of a card, and "Satisfactory (51–100)" does not fit it on
                      any screen — truncating turns the legend into "Satisfactory
                      (51–…", which is precisely the half a reader needs to check a
                      colour against the CPCB scale. Two lines cost nothing here. */}
                  <div className="flex min-w-0 items-start gap-1.5">
                    <span
                      className="mt-1 h-2 w-2 shrink-0 rounded-full"
                      style={{ background: b.color }}
                    />
                    <span className="leading-tight">{b.label}</span>
                  </div>
                  <span className="font-semibold text-aree-text shrink-0 font-mono">
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
  const [showAll, setShowAll] = useState(false);
  const total = facts.withData.length;
  const ranked = useMemo(
    () =>
      [...facts.withData]
        .sort((a, b) => (b.aqi ?? 0) - (a.aqi ?? 0))
        .map((s) => ({
          station: s.station,
          name: stationLabel(s.station),
          aqi: s.aqi ?? 0,
          // Already on the summary; the row simply used to drop it, so a nine-hour-old
          // reading sat in the top five looking exactly like a live one.
          freshness_status: s.freshness_status,
        })),
    [facts.withData],
  );
  const topList = showAll ? ranked : ranked.slice(0, 5);

  return (
    <div className="bg-aree-card border border-aree-border rounded-xl p-5 shadow-xs flex flex-col justify-between">
      <div>
        <h3 className="text-[12px] font-black tracking-wider uppercase text-aree-text font-sans">
          {showAll ? "STATIONS BY AQI" : "TOP 5 STATIONS BY AQI"}
        </h3>
        <p className="text-[11px] text-aree-dim mt-0.5 mb-3">
          {showAll ? `All ${total} reporting stations, highest first` : "Highest current AQI"}
        </p>

        <div
          id="aree-station-ranking"
          className={`space-y-2.5 ${showAll ? "max-h-[420px] overflow-y-auto pr-1" : ""}`}
        >
          {topList.length === 0 ? (
            <p className="py-8 text-center text-[12px] text-aree-dim">
              No station has reported yet.
            </p>
          ) : null}
          {topList.map((st, i) => {
            const look = freshness(st.freshness_status);
            const provisional = st.freshness_status !== "current";
            return (
              <div
                key={st.station}
                className="flex items-center justify-between text-[12px] py-1 border-b border-aree-border last:border-b-0"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-bold text-aree-dim text-[11px] min-w-3 shrink-0">
                    {i + 1}
                  </span>
                  {/* The LINK keeps full contrast — a stale station must stay as easy
                      to read and to click as any other. The caveat rides on a marker
                      and a word beside it, not on faded text. */}
                  <Link
                    href={`/stations/${encodeURIComponent(st.station)}`}
                    className="font-semibold text-aree-text hover:text-aree-forest transition-colors truncate"
                  >
                    {st.name}
                  </Link>
                  {provisional ? (
                    <span
                      className="shrink-0 text-[10px] font-bold uppercase tracking-wide"
                      style={{ color: look.color }}
                      title={`Reading is ${look.label.toLowerCase()}`}
                    >
                      {look.marker} {look.label}
                    </span>
                  ) : null}
                </div>
                {/* Only the VALUE is dimmed. It is the number that would otherwise be
                    read as equivalent to a live one; the identity is not in doubt. */}
                <span
                  className="font-bold font-mono shrink-0"
                  style={{
                    color: aqiColor(st.aqi),
                    ...(provisional ? { opacity: 0.55 } : null),
                  }}
                >
                  {st.aqi}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Expands in place. This linked to /dashboard, which has no station list —
          the full ranking belongs here, beside the five it extends. */}
      {total > 5 ? (
        <div className="mt-4 pt-3 border-t border-aree-border text-right">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            aria-controls="aree-station-ranking"
            className="text-[11px] font-bold text-aree-forest hover:underline inline-flex items-center gap-1 cursor-pointer"
          >
            {showAll ? "Show top 5" : `Show all ${total} stations`}
          </button>
        </div>
      ) : null}
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
/** "unavailable" -> "Unavailable": a raw backend enum is not a label. */
function sentenceCase(value: string | null | undefined): string | null {
  if (!value) return null;
  const words = value.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

export function DataHealthOverviewCard({ status }: { status: SystemStatus | null }) {
  const stale = status?.stale_stations ?? 0;
  const aging = status?.aging_stations ?? 0;
  const unavailable = status?.unavailable_stations ?? 0;

  const unknown = { label: "Unknown", color: "var(--aree-dim)" };

  const networkState = !status
    ? unknown
    : stale > 0
      ? { label: `${stale} stale`, color: "var(--aree-orange)" }
      : aging > 0
        ? { label: `${aging} aging`, color: "var(--aree-yellow)" }
        : { label: "Current", color: "var(--aree-green)" };

  const engineState = !status
    ? unknown
    : !status.engine_loaded
      ? { label: "Engine offline", color: "var(--aree-red)" }
      : status.mode === "streaming"
        ? { label: "Streaming", color: "var(--aree-green)" }
        : { label: "Direct", color: "var(--aree-yellow)" };

  const ragState = !status
    ? unknown
    : status.rag_status === "active"
      ? { label: "Active", color: "var(--aree-green)" }
      : { label: sentenceCase(status.rag_status) ?? "Unavailable", color: "var(--aree-yellow)" };

  const docs = status?.rag_docs_indexed ?? null;
  const policyState =
    docs === null
      ? unknown
      : docs > 0
        ? { label: `${docs} on disk`, color: "var(--aree-green)" }
        : { label: "Empty", color: "var(--aree-yellow)" };

  const llmState = !status
    ? unknown
    : status.llm_ready === true
      ? { label: "Ready", color: "var(--aree-green)" }
      : status.llm_ready === false
        ? { label: "Fallback", color: "var(--aree-yellow)" }
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
      color: unavailable > 0 ? "var(--aree-yellow)" : "var(--aree-green)",
      icon: <Flame className="w-3.5 h-3.5" />,
    },
  ];

  return (
    <div className="bg-aree-card border border-aree-border rounded-xl p-5 shadow-xs flex flex-col justify-between">
      <div>
        <h3 className="text-[12px] font-black tracking-wider uppercase text-aree-text font-sans">
          DATA HEALTH OVERVIEW
        </h3>
        <p className="text-[11px] text-aree-dim mt-0.5 mb-3">
          Health of key data sources
        </p>

        <div className="space-y-2">
          {sources.map((src) => (
            <div
              key={src.name}
              className="flex items-center justify-between text-[12px] py-1 border-b border-aree-border last:border-b-0"
            >
              <div className="flex items-center gap-2.5 text-aree-text min-w-0">
                <span className="text-aree-dim shrink-0">{src.icon}</span>
                <span className="font-semibold truncate">{src.name}</span>
                {src.sub ? (
                  <span className="text-[10.5px] text-aree-dim truncate shrink">
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
      <div className="mt-4 pt-3 border-t border-aree-border">
        <p className="text-[10.5px] text-aree-dim leading-snug">
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

  const events = useMemo(
    () => newestFirst(state.data?.events ?? []).slice(0, 5),
    [state.data],
  );

  return (
    <div className="bg-aree-card border border-aree-border rounded-xl p-5 shadow-xs">
      <div className="flex items-center justify-between mb-3.5">
        <div>
          <h3 className="text-[12px] font-black tracking-wider uppercase text-aree-text font-sans">
            RECENT EVENTS
          </h3>
          <p className="text-[11px] text-aree-dim">
            GRAP stage transitions recorded by the state machine
          </p>
        </div>
        {state.data && state.data.total > events.length ? (
          <span className="text-[11px] text-aree-dim">
            {events.length} of {state.data.total}
          </span>
        ) : null}
      </div>

      {state.initialLoading ? (
        <p className="py-6 text-center text-[12px] text-aree-dim">Loading events…</p>
      ) : state.error && !state.data ? (
        <p className="py-6 text-center text-[12px] text-aree-dim">
          Event log unavailable — {state.error.message}
        </p>
      ) : events.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-aree-dim">
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
                className="rounded-lg p-3 border flex flex-col justify-between bg-aree-surface-2"
                style={{ borderColor: "var(--aree-border)" }}
              >
                <div className="text-[10px] font-bold font-mono text-aree-dim mb-1">
                  {istDateTime(ev.timestamp) ?? ev.timestamp ?? "—"}
                </div>
                <div className="flex items-center gap-1.5 mb-1">
                  <Shield className="w-4 h-4 shrink-0" style={{ color: colour }} />
                  <span className="text-[12px] font-bold text-aree-text leading-tight truncate">
                    {stationLabel(ev.city ?? ev.station ?? "—")}
                  </span>
                </div>
                <div className="text-[11px] text-aree-body leading-tight">
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
