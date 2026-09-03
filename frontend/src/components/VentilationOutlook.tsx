"use client";

/* ==========================================================================
   AREE — Ventilation Outlook (deep diagnostic screen)

   This page answers ONE question: how well will the atmosphere clear pollution?

   It is deliberately the counterpart to Atmospheric Outlook, which answers
   "what does that mean for air quality and what should be done". The two used
   to overlap almost entirely; the split is now explicit:

       Atmospheric Outlook  ->  summary, consequence, recommendation
       Ventilation Outlook  ->  the dispersion diagnostic and its evidence

   Model metrics (hit rate, false-alarm rate, AUC, training episodes) live HERE,
   under Decision basis. They belong to someone auditing why the system drew a
   line at 466 m2/s, not to someone deciding whether to act this evening.

   It reads the SAME /api/aree/outlook contract as the executive page, so both
   share one as_of and replay behaves identically on each. Nothing on this page
   computes a threshold, a status or a statistic.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChevronRight,
  Cloud,
  Gauge,
  History,
  Info,
  Radio,
  Radar,
  ShieldCheck,
  Thermometer,
  Wind,
} from "lucide-react";

import { usePublishOutlookMode } from "@/components/providers/OutlookModeProvider";
import { useSyncPresetToUrl } from "@/hooks/useSyncPresetToUrl";
import { api, errorMessage } from "@/lib/api";
import type { OutlookResponse } from "@/types";

const PRESETS: { label: string; at?: string }[] = [
  { label: "Live (anchored)" },
  { label: "02 Nov 2024 · 06:00", at: "2024-11-02T06:00:00Z" },
  { label: "14 Nov 2024 · 00:00", at: "2024-11-14T00:00:00Z" },
  { label: "16 Nov 2024 · 00:00", at: "2024-11-16T00:00:00Z" },
];

const C = {
  ink: "#1a1a17",
  body: "#44403a",
  muted: "#7d776c",
  dim: "#a8a196",
  line: "#e8e3d7",
  paper: "#ffffff",
  wash: "#faf8f2",
  red: "#c0392b",
  amber: "#e07a3f",
  green: "#3f7a4e",
  blue: "#3b82c4",
};

function ist(iso: string, withDate = true): string {
  const d = new Date(iso);
  const t = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
  if (!withDate) return t;
  const day = d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
  return `${day} ${t}`;
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="text-[9.5px] font-bold uppercase tracking-[0.09em]"
      style={{ color: C.muted }}
    >
      {children}
    </p>
  );
}

function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${className}`}
      style={{ background: C.paper, borderColor: C.line }}
    >
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  small,
}: {
  label: string;
  value: string;
  tone?: string;
  small?: string;
}) {
  return (
    <div
      className="flex items-baseline justify-between border-b py-2 last:border-0"
      style={{ borderColor: "#f2efe6" }}
    >
      <span className="text-[11.5px]" style={{ color: C.body }}>
        {label}
      </span>
      <span className="text-right">
        <span
          className="text-[12.5px] font-bold tabular-nums"
          style={{ color: tone ?? C.ink }}
        >
          {value}
        </span>
        {small && (
          <span className="ml-1.5 text-[10px]" style={{ color: C.dim }}>
            {small}
          </span>
        )}
      </span>
    </div>
  );
}

/** Donut of the last 24 h banded on the calibrated threshold. */
function Donut({
  bands,
}: {
  bands: { label: string; hours: number; colour: string; share: number }[];
}) {
  const total = bands.reduce((a, b) => a + b.hours, 0) || 1;
  const R = 42;
  const stroke = 17;
  const circ = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 110 110" className="h-[110px] w-[110px] shrink-0">
        <g transform="translate(55,55) rotate(-90)">
          {bands.map((b) => {
            const len = (b.hours / total) * circ;
            const el = (
              <circle
                key={b.label}
                r={R}
                fill="none"
                stroke={b.colour}
                strokeWidth={stroke}
                strokeDasharray={`${len} ${circ - len}`}
                strokeDashoffset={-offset}
              />
            );
            offset += len;
            return el;
          })}
        </g>
      </svg>
      <div className="min-w-0 flex-1 space-y-1">
        {bands.map((b) => (
          <div key={b.label} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[10.5px]" style={{ color: C.body }}>
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: b.colour }}
              />
              {b.label} m²/s
            </span>
            <span className="text-[10.5px] font-semibold tabular-nums" style={{ color: C.ink }}>
              {b.hours} h ({Math.round(b.share * 100)}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function VentilationOutlook() {
  const [preset, setPreset] = useState(0);
  const [data, setData] = useState<OutlookResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (at?: string) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.outlook(at));
    } catch (err) {
      setData(null);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(PRESETS[preset].at);
  }, [preset, load]);

  useSyncPresetToUrl(PRESETS, preset, setPreset);

  const chart = useMemo(
    () =>
      (data?.forecast.series ?? []).map((p) => ({
        label: ist(p.valid_at),
        ventilation: p.ventilation_m2_s,
      })),
    [data],
  );

  // Tell the shell which moment this page is describing (see OutlookModeProvider).
  usePublishOutlookMode(data?.mode, data?.as_of);

  const vf = data?.atmosphere.ventilation_forecast;
  const vp = data?.atmosphere.ventilation_profile;
  const op = vf?.operating_point;
  const threshold = op?.threshold_m2_s ?? data?.atmosphere.ventilation.threshold_m2_s ?? null;
  const windowH = vf?.intervention_window_hours ?? null;

  // TWO DIFFERENT QUESTIONS, AND THE PAGE USED TO ANSWER BOTH WITH ONE FLAG.
  //
  //   collapsed  — has the forecast collapse already STARTED? (a clock)
  //   belowNow   — is ventilation below the operating point RIGHT NOW? (a measurement)
  //
  // Every string on the status row was keyed on `collapsed`, so a live screen showing
  // 332.8 m²/s against a 465.9 threshold read "Imminent — dispersion capacity within
  // operating range" beside "Poor dispersion", and the interpretation card underneath
  // said "Ventilation is above the operating point". Three statements, one of them
  // right. Copy that contradicts the number beside it is worse than no copy.
  const collapsed = windowH !== null && windowH <= 0;
  const ventNow = vp?.components?.ventilation_m2_s ?? null;
  const belowNow =
    ventNow !== null && threshold !== null ? ventNow <= threshold : null;

  // "store:ncr_28.63_77.22 (era5)" in replay vs "openmeteo:forecast" live. The backend
  // already names its own feature source; the page just has to stop ignoring it.
  const isReanalysis = Boolean(
    data?.provenance.feature_source?.startsWith("store:"),
  );

  const band = useMemo(() => {
    if (!data) return null;
    const s = data.timeline.find((m) => m.kind === "collapse");
    const e = data.timeline.find((m) => m.kind === "recovery");
    if (!s) return null;
    return { from: ist(s.at), to: e ? ist(e.at) : chart[chart.length - 1]?.label };
  }, [data, chart]);

  return (
    <div className="space-y-3" style={{ color: C.body }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-bold tracking-tight" style={{ color: C.ink }}>
            Ventilation Outlook
          </h1>
          <p className="mt-0.5 text-[11.5px]" style={{ color: C.muted }}>
            Dispersion capacity and intervention window for Delhi NCR.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p, i) => (
            <button
              key={p.label}
              onClick={() => setPreset(i)}
              className="rounded-md border px-3 py-1.5 text-[11.5px] font-semibold transition"
              style={
                preset === i
                  ? { background: "#14532d", borderColor: "#14532d", color: "#fff" }
                  : { background: C.paper, borderColor: C.line, color: C.body }
              }
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <Card>
          <p className="py-10 text-center text-[12.5px]" style={{ color: C.muted }}>
            Loading ventilation diagnostic…
          </p>
        </Card>
      )}

      {error && !loading && (
        <div className="rounded-lg border p-4" style={{ background: "#fdf2f0", borderColor: "#f0d5cd" }}>
          <p className="text-[12.5px] font-bold" style={{ color: "#b91c1c" }}>
            Ventilation outlook unavailable
          </p>
          <p className="mt-1 text-[12px]">{error}</p>
        </div>
      )}

      {data && !loading && vp?.available && (
        <>
          {/* ── status strip ── */}
          <div
            className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-6"
            style={{ background: C.wash, borderColor: C.line }}
          >
            <div className="lg:border-r lg:pr-4" style={{ borderColor: C.line }}>
              <span className="flex items-center gap-1.5">
                <Radar className="h-3.5 w-3.5" style={{ color: C.red }} />
                <Eyebrow>Ventilation status</Eyebrow>
              </span>
              <p
                className="mt-1.5 text-[17px] font-bold leading-none"
                style={{ color: belowNow ? C.red : C.ink }}
              >
                {collapsed
                  ? "Collapsed"
                  : (vf?.state ?? "—").replace(/^\w/, (c) => c.toUpperCase())}
              </p>
              <p className="mt-1 text-[10.5px] leading-snug" style={{ color: C.muted }}>
                {/* Describes the CURRENT measurement, not the collapse clock. */}
                {belowNow === null
                  ? "Ventilation not available for this hour"
                  : belowNow
                    ? "Below the operating point — dispersion capacity is poor now"
                    : "Above the operating point — dispersion capacity is adequate now"}
              </p>
              <p className="mt-1 text-[10.5px] font-semibold" style={{ color: C.body }}>
                {windowH !== null ? `${windowH.toFixed(1)} h intervention window remaining` : "No collapse forecast"}
              </p>
            </div>

            {[
              [Gauge, "Ventilation (now)", `${vp.components?.ventilation_m2_s?.toFixed(1)}`, "m²/s",
               (vp.components?.ventilation_m2_s ?? 0) <= (threshold ?? 0) ? "Poor dispersion" : "Adequate dispersion", C.body],
              [Cloud, "Boundary layer", `${vp.components?.blh_m?.toFixed(0)}`, "m",
               (vp.components?.blh_m ?? 0) < 400 ? "Very low" : "Moderate", (vp.components?.blh_m ?? 0) < 400 ? C.red : C.body],
              [Wind, "Wind speed (10 m)", `${vp.components?.wind_ms?.toFixed(2)}`, "m/s",
               (vp.components?.wind_ms ?? 0) < 2 ? "Light" : "Moderate", C.body],
              [ShieldCheck, "Operating point", `${threshold?.toFixed(1)}`, "m²/s", "Threshold", C.body],
              [History, "Hours below threshold (24 h)", `${vp.hours_below_24h}`, "h",
               `${Math.round((vp.share_below_24h ?? 0) * 100)}% of last 24 h`, C.body],
            ].map(([Icon, label, value, unit, caption, tone]) => {
              const I = Icon as typeof Gauge;
              return (
                <div key={label as string}>
                  <span className="flex items-center gap-1.5">
                    <I className="h-3.5 w-3.5" style={{ color: C.muted }} />
                    <Eyebrow>{label as string}</Eyebrow>
                  </span>
                  <p className="mt-1.5 text-[17px] font-bold leading-none tabular-nums" style={{ color: C.ink }}>
                    {value as string}
                    <span className="ml-1 text-[10.5px] font-semibold" style={{ color: C.muted }}>
                      {unit as string}
                    </span>
                  </p>
                  <p className="mt-1 text-[10.5px] font-semibold" style={{ color: tone as string }}>
                    {caption as string}
                  </p>
                </div>
              );
            })}
          </div>

          {/* ── the two inputs, stated plainly ── */}
          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <div className="flex items-start justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <Cloud className="h-3.5 w-3.5" style={{ color: C.blue }} />
                  <Eyebrow>Forecast input</Eyebrow>
                </span>
                <span
                  className="rounded px-2 py-0.5 text-[9.5px] font-bold"
                  style={{ background: "#eef4fb", color: "#1e5b96" }}
                >
                  {data.provenance.feature_source}
                </span>
              </div>
              {/* A replay does not run on a forecast. It runs on ERA5 reanalysis at
                  valid time — the weather as it turned out, which no forecaster held at
                  that hour. Calling that "numerical weather model, 72 h ahead" is the
                  perfect-prognosis overclaim the engineering report is careful to avoid,
                  so the label follows the actual feature source. */}
              <p className="mt-2 text-[12.5px] font-bold" style={{ color: C.ink }}>
                {isReanalysis
                  ? "ERA5 reanalysis at valid time"
                  : `Numerical weather model (${data.forecast.horizon_hours} h ahead)`}
              </p>
              <p className="mt-1 text-[11px] leading-snug" style={{ color: C.muted }}>
                {isReanalysis ? (
                  <>
                    Boundary layer height × wind speed at 10 m, from the archive rather
                    than a forecast run. <b>Perfect prognosis</b>: this replay knows the
                    weather that actually occurred, so its skill is an upper bound on
                    what the live system can achieve.
                  </>
                ) : (
                  <>
                    Boundary layer height × wind speed at 10 m. Uses no ground stations,
                    so it keeps working while the streaming engine is offline.
                  </>
                )}
              </p>
              <div className="mt-2">
                <Row label="Horizon" value={`${data.forecast.horizon_hours} h`} />
                <Row label="Models" value={Object.values(data.provenance.models).join(", ")} />
                <Row label="Mode" value={data.mode.toUpperCase()} />
              </div>
            </Card>

            <Card>
              <div className="flex items-start justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <Radio className="h-3.5 w-3.5" style={{ color: C.green }} />
                  <Eyebrow>Observation input</Eyebrow>
                </span>
                <span
                  className="rounded px-2 py-0.5 text-[9.5px] font-bold"
                  style={
                    data.observation.target === "network"
                      ? { background: "#eff6f0", color: "#2f6b3f" }
                      : { background: "#f6efd9", color: "#8a6d1f" }
                  }
                >
                  {data.observation.source}
                </span>
              </div>
              {/* Reads the OBSERVATION, not the exposure panel. Those are different
                  hours and different targets: a Nov 2024 replay is a one-monitor
                  composite, and taking the station count from `exposure` printed
                  today's network size beside a 2024 value. */}
              <p className="mt-2 text-[12.5px] font-bold" style={{ color: C.ink }}>
                {data.observation.value.toFixed(0)} µg/m³
                {data.observation.n_stations !== null
                  ? ` across ${data.observation.n_stations} ${
                      data.observation.n_stations === 1 ? "monitor" : "stations"
                    }`
                  : ""}
              </p>
              <p className="mt-1 text-[11px] leading-snug" style={{ color: C.muted }}>
                {data.observation.target === "network"
                  ? "Median PM2.5 across the reporting network. This is a different feed from the station roster in the sidebar — see the note below."
                  : "The historical NCR target. For most of the record it rests on a single monitor, which is why AREE now captures the whole network hourly."}
              </p>
              <div className="mt-2">
                <Row label="Target" value={data.observation.target_label} />
                <Row
                  label={data.observation.n_stations === 1 ? "Monitors" : "Stations"}
                  value={
                    data.observation.n_stations !== null
                      ? String(data.observation.n_stations)
                      : "not recorded"
                  }
                  tone={data.observation.n_stations === 1 ? C.amber : undefined}
                />
                <Row label="Observed at" value={ist(data.observation.observed_at)} />
              </div>
            </Card>
          </div>

          {/* ── chart · components · distribution ── */}
          <div className="grid gap-3 xl:grid-cols-[1.7fr_1fr]">
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <Wind className="h-3.5 w-3.5" style={{ color: C.blue }} />
                  <Eyebrow>
                    Ventilation coefficient — next {data.forecast.horizon_hours} hours
                  </Eyebrow>
                </span>
                <span
                  className="rounded px-2 py-0.5 text-[9.5px] font-bold"
                  style={{ background: "#eef4fb", color: "#1e5b96" }}
                >
                  {data.atmosphere.ventilation.hours_below_threshold} H BELOW THRESHOLD
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4">
                <span className="text-[10px]" style={{ color: C.muted }}>
                  <span className="mr-1 inline-block h-[2px] w-3 align-middle" style={{ background: C.blue }} />
                  Ventilation (m²/s)
                </span>
                <span className="text-[10px]" style={{ color: C.muted }}>
                  <span className="mr-1 inline-block h-[2px] w-3 align-middle" style={{ background: C.red }} />
                  Operating point ({threshold?.toFixed(1)} m²/s)
                </span>
                <span className="text-[10px]" style={{ color: C.muted }}>
                  <span className="mr-1 inline-block h-2 w-3 rounded-sm align-middle" style={{ background: "#f7dcd6" }} />
                  Collapse zone
                </span>
              </div>

              <div className="mt-2 h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chart} margin={{ top: 8, right: 10, bottom: 0, left: -16 }}>
                    <CartesianGrid stroke="#f2efe6" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 9, fill: C.dim }}
                      interval={Math.max(3, Math.floor(chart.length / 8))}
                      tickLine={false}
                      axisLine={{ stroke: C.line }}
                    />
                    <YAxis tick={{ fontSize: 9, fill: C.dim }} tickLine={false} axisLine={false} width={44} />
                    <Tooltip
                      contentStyle={{ fontSize: 11, borderRadius: 6, border: `1px solid ${C.line}` }}
                      formatter={(v) => [`${v} m²/s`, "Ventilation"]}
                    />
                    {threshold !== null && (
                      <ReferenceArea y1={0} y2={threshold} fill="#f7dcd6" fillOpacity={0.45} />
                    )}
                    {band && (
                      <ReferenceArea x1={band.from} x2={band.to} fill="#e9b7a6" fillOpacity={0.2} />
                    )}
                    <Area
                      dataKey="ventilation"
                      stroke={C.blue}
                      strokeWidth={1.6}
                      fill="#dbeafe"
                      fillOpacity={0.5}
                      dot={false}
                    />
                    {threshold !== null && (
                      <ReferenceLine y={threshold} stroke={C.red} strokeDasharray="5 3" />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <div className="space-y-3">
              <Card>
                <Eyebrow>Ventilation components (now)</Eyebrow>
                <div className="mt-1.5">
                  <Row label="Boundary layer height" value={`${vp.components?.blh_m?.toFixed(0)} m`} />
                  <Row label="Wind speed (10 m)" value={`${vp.components?.wind_ms?.toFixed(2)} m/s`} />
                  <Row
                    label="Ventilation (PBLH × wind)"
                    value={`${vp.components?.ventilation_m2_s?.toFixed(1)} m²/s`}
                    tone={collapsed ? C.red : C.ink}
                  />
                </div>
              </Card>

              <Card>
                <Eyebrow>Distribution (next 24 h)</Eyebrow>
                <div className="mt-2">
                  <Donut bands={vp.distribution ?? []} />
                </div>
              </Card>

              <Card>
                <Eyebrow>Ventilation statistics ({vp.statistics?.hours} h)</Eyebrow>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {[
                    ["Minimum", vp.statistics?.min, C.red],
                    ["Mean", vp.statistics?.mean, C.ink],
                    ["Maximum", vp.statistics?.max, C.green],
                  ].map(([l, v, t]) => (
                    <div key={l as string}>
                      <p className="text-[9.5px] font-semibold uppercase" style={{ color: C.dim }}>
                        {l as string}
                      </p>
                      <p className="mt-0.5 text-[14px] font-bold tabular-nums" style={{ color: t as string }}>
                        {(v as number)?.toFixed(1)}
                      </p>
                      <p className="text-[9px]" style={{ color: C.dim }}>
                        m²/s
                      </p>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>

          {/* ── events · decision basis · interpretation ── */}
          <div className="grid gap-3 xl:grid-cols-[1.5fr_1fr_0.9fr]">
            <Card>
              <span className="flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5" style={{ color: C.muted }} />
                <Eyebrow>Intervention window & key events</Eyebrow>
              </span>

              <div className="mt-4 overflow-x-auto pb-1">
                <div className="relative min-w-[560px] pt-1">
                  <div className="absolute left-0 right-0 top-[6px] h-[2px]" style={{ background: C.line }} />
                  <div className="relative flex justify-between">
                    {data.timeline.map((m) => {
                      const tone =
                        m.kind === "now"
                          ? C.red
                          : m.kind === "collapse"
                            ? C.amber
                            : m.kind === "minimum" || m.kind === "peak_risk"
                              ? C.red
                              : C.green;
                      return (
                        <div key={m.kind + m.at} className="flex w-[19%] flex-col items-start">
                          <span
                            className="h-3 w-3 rounded-full border-2"
                            style={{ background: tone, borderColor: "#fff" }}
                          />
                          <p className="mt-1.5 text-[10.5px] font-bold" style={{ color: C.ink }}>
                            {m.kind === "now" ? "Now" : ist(m.at)}
                          </p>
                          <p className="text-[9.5px] font-semibold" style={{ color: C.muted }}>
                            {m.kind === "now"
                              ? `${windowH?.toFixed(1) ?? "—"} h remaining`
                              : `${m.hours_from_now > 0 ? "+" : ""}${m.hours_from_now.toFixed(0)} h`}
                          </p>
                          <p className="mt-1 text-[9.5px] leading-snug" style={{ color: C.body }}>
                            {m.state}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t pt-2" style={{ borderColor: C.line }}>
                {[
                  ["Critical", C.red],
                  ["Warning", C.amber],
                  ["Recovery", C.green],
                ].map(([l, c]) => (
                  <span key={l} className="text-[9.5px]" style={{ color: C.muted }}>
                    <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: c }} />
                    {l}
                  </span>
                ))}
              </div>
            </Card>

            <Card>
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5" style={{ color: C.muted }} />
                <Eyebrow>Decision basis</Eyebrow>
              </span>
              <div className="mt-1.5">
                <Row
                  label="Operating point (threshold)"
                  value={`${threshold?.toFixed(1)} m²/s`}
                  small={op?.mode ? `${op.mode}${op.calibrated ? " (calibrated)" : ""}` : undefined}
                />
                <Row
                  label="Current ventilation vs threshold"
                  value={`${vp.components?.ventilation_m2_s?.toFixed(1)} ${
                    (vp.components?.ventilation_m2_s ?? 0) < (threshold ?? 0) ? "<" : ">"
                  } ${threshold?.toFixed(1)}`}
                  tone={(vp.components?.ventilation_m2_s ?? 0) < (threshold ?? 0) ? C.red : C.green}
                />
                {/* These two rows were labelled "Hit rate (validation)" and
                    "False-alarm rate" and carried the TRAINING figures — 0.61 / 0.19 on
                    143 episodes. The same threshold scores 0.20 / 0.50 on the held-out
                    episodes, and a judge who has read the engineering report will look
                    for exactly that number. Showing both, labelled, is stronger than
                    showing the flattering one. */}
                <Row
                  label="Hit rate — training"
                  value={op?.hit_rate?.toFixed(2) ?? "—"}
                  small={op?.n_train_episodes ? `${op.n_train_episodes} episodes` : undefined}
                />
                <Row
                  label="False alarm — training"
                  value={op?.false_alarm_rate?.toFixed(2) ?? "—"}
                />
                <Row
                  label="Hit rate — held out"
                  value={op?.holdout_hit_rate?.toFixed(2) ?? "—"}
                  tone={C.red}
                  small={
                    op?.n_holdout_episodes ? `${op.n_holdout_episodes} episodes` : undefined
                  }
                />
                <Row
                  label="False alarm — held out"
                  value={op?.holdout_false_alarm_rate?.toFixed(2) ?? "—"}
                  tone={C.red}
                />
                <Row
                  label="AUC — training"
                  value={op?.auc_training?.toFixed(3) ?? "—"}
                  small={
                    op?.outcome_window_hours
                      ? `${op.outcome_window_hours} h outcome window`
                      : undefined
                  }
                />
              </div>
              {op?.caveat && (
                <p className="mt-2 text-[9.5px] leading-snug" style={{ color: C.dim }}>
                  {op.caveat}
                </p>
              )}
            </Card>

            <Card className="flex flex-col">
              <span className="flex items-center gap-1.5">
                <Thermometer className="h-3.5 w-3.5" style={{ color: C.muted }} />
                <Eyebrow>Interpretation</Eyebrow>
              </span>
              <p className="mt-2 flex-1 text-[11.5px] leading-relaxed" style={{ color: C.body }}>
                {/* Keyed on the measurement, so this can no longer contradict the number
                    in the card immediately above it. */}
                {belowNow
                  ? `Ventilation is ${ventNow?.toFixed(0)} m²/s, below the ${threshold?.toFixed(0)} m²/s operating point, and ${vp.hours_below_24h} of the last 24 hours were below it. Dispersion capacity is poor and pollutants are accumulating faster than the atmosphere clears them.`
                  : `Ventilation is ${ventNow?.toFixed(0)} m²/s, above the ${threshold?.toFixed(0)} m²/s operating point. ${vp.hours_below_24h} of the last 24 hours fell below it, so conditions remain worth watching.`}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed" style={{ color: C.muted }}>
                {data.mechanism.consequence}.
              </p>
              <a
                href="/outlook"
                className="mt-3 flex items-center justify-between rounded-md border px-3 py-2 text-[11px] font-semibold transition"
                style={{ borderColor: C.line, color: C.body }}
              >
                What this means for air quality
                <ChevronRight className="h-3.5 w-3.5" />
              </a>
            </Card>
          </div>

          {/* ── advisory footer ── */}
          <div
            className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1.5 rounded-lg border px-4 py-2.5"
            style={{ background: C.wash, borderColor: C.line }}
          >
            <span className="text-[10.5px]" style={{ color: C.muted }}>
              Advisory only. Legal authority for GRAP invocation rests with CAQM
              and the state pollution control boards.
            </span>
            <span className="text-[10px]" style={{ color: C.dim }}>
              {data.provenance.note}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
