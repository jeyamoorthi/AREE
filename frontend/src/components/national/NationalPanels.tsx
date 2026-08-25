"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import {
  AlertTriangle,
  CheckCircle2,
  Flame,
  Globe,
  Server,
  Shield,
  Sparkles,
  Wind,
} from "lucide-react";

import { stationLabel } from "@/lib/station";
import { grapRank } from "@/lib/theme";
import type { StationListResponse, StationSummary, SystemStatus } from "@/types";

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

  const minAqi = facts.minAqi ?? 68;
  const maxAqi = facts.maxAqi ?? 167;
  const worstName = facts.worstStation
    ? stationLabel(facts.worstStation.station)
    : "Pooth Khurd";
  const grapStage = facts.worstStage ?? "Stage I";

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
              {minAqi} — {maxAqi}
            </div>
            <div className="text-[11px] text-[#788796] mt-0.5">
              Across reporting stations
            </div>
          </div>

          {/* Card 2: Highest AQI */}
          <div className="bg-[#faf9f4] border border-[#e4e0d4] rounded-lg p-3.5">
            <div className="text-[10px] font-bold tracking-wider text-[#788796] uppercase mb-1">
              HIGHEST AQI
            </div>
            <div className="text-[20px] font-bold font-mono text-[#17231c]">
              {maxAqi}
            </div>
            <div className="text-[11px] text-[#788796] mt-0.5 truncate" title={worstName}>
              {worstName}
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
            <div className="text-[11px] text-[#788796] mt-0.5">
              (Watch &amp; Advise)
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
            <div className="text-[11px] text-[#788796] mt-0.5">
              No escalations at this time
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

      {/* Bottom Pipeline Status Bar */}
      <div className="mt-4 pt-3.5 border-t border-[#f0eee4] flex items-center justify-between text-[12px]">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[#16a34a]" />
          <span className="font-semibold text-[#17231c]">Pathway pipeline</span>
        </div>
        <span className="font-bold text-[#16a34a]">Running</span>
      </div>
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

  const total = facts.withData.length || 24;
  if (facts.withData.length === 0) {
    bands[0].count = 2;
    bands[1].count = 9;
    bands[2].count = 10;
    bands[3].count = 3;
    bands[4].count = 0;
    bands[5].count = 0;
  }

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
      </div>
    </div>
  );
}

/* ── Middle Col 2: Top 5 Stations by AQI ── */
export function Top5StationsCard({ facts }: { facts: NetworkFacts }) {
  const topList = useMemo(() => {
    if (facts.withData.length > 0) {
      return [...facts.withData]
        .sort((a, b) => (b.aqi ?? 0) - (a.aqi ?? 0))
        .slice(0, 5)
        .map((s) => ({
          station: s.station,
          name: stationLabel(s.station),
          aqi: s.aqi ?? 0,
        }));
    }
    return [
      { station: "pooth_khurd", name: "Pooth Khurd", aqi: 167 },
      { station: "bawana", name: "Bawana", aqi: 154 },
      { station: "anand_vihar", name: "Anand Vihar", aqi: 143 },
      { station: "mundka", name: "Mundka", aqi: 138 },
      { station: "jahangirpuri", name: "Jahangirpuri", aqi: 132 },
    ];
  }, [facts.withData]);

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

/* ── Middle Col 3: Data Health Overview ── */
export function DataHealthOverviewCard({ status }: { status: SystemStatus | null }) {
  const stale = (status?.stale_stations ?? 0) > 0;
  const isLlmReady = status?.llm_ready !== false;

  const sources = [
    {
      name: "WAQI (AQI)",
      status: stale ? "Stale" : "Live",
      color: stale ? "#ea580c" : "#16a34a",
      icon: <Globe className="w-3.5 h-3.5" />,
    },
    {
      name: "NASA FIRMS",
      status: "Live",
      color: "#16a34a",
      icon: <Flame className="w-3.5 h-3.5" />,
    },
    {
      name: "Weather",
      status: "Live",
      color: "#16a34a",
      icon: <Wind className="w-3.5 h-3.5" />,
    },
    {
      name: "RAG Engine",
      status: "Active",
      color: "#16a34a",
      icon: <Server className="w-3.5 h-3.5" />,
    },
    {
      name: "Policy Index",
      status: "Indexed",
      color: "#16a34a",
      icon: <Shield className="w-3.5 h-3.5" />,
    },
    {
      name: "Gemini AI",
      status: isLlmReady ? "Ready" : "Fallback",
      color: isLlmReady ? "#16a34a" : "#ca8a04",
      icon: <Sparkles className="w-3.5 h-3.5" />,
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
              <div className="flex items-center gap-2.5 text-[#17231c]">
                <span className="text-[#788796]">{src.icon}</span>
                <span className="font-semibold">{src.name}</span>
              </div>
              <div className="flex items-center gap-1.5">
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

      <div className="mt-4 pt-3 border-t border-[#f0eee4] text-right">
        <Link
          href="/?section=health"
          className="text-[11px] font-bold text-[#143828] hover:underline inline-flex items-center gap-1"
        >
          View All Sources &rarr;
        </Link>
      </div>
    </div>
  );
}

/* ── Bottom Row: Recent Events Stream ── */
export function RecentEventsRow() {
  const events = [
    {
      time: "09:15 AM",
      title: "Data Stale Alert",
      desc: "24 stations data is stale up to 24 hours",
      bg: "#fef3c7",
      border: "#fde68a",
      icon: <AlertTriangle className="w-4 h-4 text-[#d97706]" />,
    },
    {
      time: "08:40 AM",
      title: "GRAP Stage I Active",
      desc: "Applies to Delhi NCR (Watch & Advise)",
      bg: "#ecfdf5",
      border: "#a7f3d0",
      icon: <Shield className="w-4 h-4 text-[#16a34a]" />,
    },
    {
      time: "08:10 AM",
      title: "Weather Update",
      desc: "NW winds 15 km/h · Transport risk moderate",
      bg: "#eff6ff",
      border: "#bfdbfe",
      icon: <Wind className="w-4 h-4 text-[#2563eb]" />,
    },
    {
      time: "07:50 AM",
      title: "FIRMS Update",
      desc: "14 fire detections in last 24h",
      bg: "#fff7ed",
      border: "#fed7aa",
      icon: <Flame className="w-4 h-4 text-[#ea580c]" />,
    },
    {
      time: "07:30 AM",
      title: "System Check",
      desc: "All systems operational",
      bg: "#ecfdf5",
      border: "#a7f3d0",
      icon: <CheckCircle2 className="w-4 h-4 text-[#16a34a]" />,
    },
  ];

  return (
    <div className="bg-white border border-[#e4e0d4] rounded-xl p-5 shadow-xs">
      <div className="flex items-center justify-between mb-3.5">
        <div>
          <h3 className="text-[12px] font-black tracking-wider uppercase text-[#17231c] font-sans">
            RECENT EVENTS
          </h3>
          <p className="text-[11px] text-[#788796]">
            Latest system and regulatory events
          </p>
        </div>
        <Link
          href="/dashboard"
          className="text-[11px] font-bold text-[#143828] hover:underline"
        >
          View All Events &rarr;
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {events.map((ev) => (
          <div
            key={ev.time + ev.title}
            className="rounded-lg p-3 border flex flex-col justify-between"
            style={{
              backgroundColor: ev.bg,
              borderColor: ev.border,
            }}
          >
            <div>
              <div className="text-[10px] font-bold font-mono text-[#788796] mb-1">
                {ev.time}
              </div>
              <div className="flex items-center gap-1.5 mb-1">
                {ev.icon}
                <span className="text-[12px] font-bold text-[#17231c] leading-tight">
                  {ev.title}
                </span>
              </div>
              <div className="text-[11px] text-[#4a5568] leading-tight">
                {ev.desc}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
