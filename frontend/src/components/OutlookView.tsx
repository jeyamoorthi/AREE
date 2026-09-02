"use client";

/* ==========================================================================
   AREE — Atmospheric Outlook
   The one screen that shows the whole chain:
   observation -> forecast -> cause -> early warning -> action -> approval.

   PRESENTATION ONLY. Every number, threshold, status and recommendation in
   here was decided by the backend. This file must never compute a risk level,
   compare a value against a threshold, or choose a GRAP stage - if it did, the
   UI and the validated engine could disagree, and the screen would stop being
   evidence of what the system actually does.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Flame,
  History,
  Radio,
  Wind,
} from "lucide-react";

import { api, errorMessage } from "@/lib/api";
import type { OutlookResponse, OutlookStatus } from "@/types";

/* The demo anchor. 16 Nov 2024 is the episode Experiment D scored: peak
   1000 ug/m3, and the upper tail anticipated it ~68 h before onset. */
const PRESETS: { label: string; at?: string }[] = [
  { label: "Live" },
  { label: "02 Nov 2024 · 06:00", at: "2024-11-02T06:00:00Z" },
  { label: "14 Nov 2024 · 00:00", at: "2024-11-14T00:00:00Z" },
  { label: "16 Nov 2024 · 00:00", at: "2024-11-16T00:00:00Z" },
];

/* Status is the primary state. The map is exhaustive over OutlookStatus so a
   new backend status cannot silently fall through to a friendly default. */
const STATUS_STYLE: Record<
  OutlookStatus,
  { label: string; tone: string; ring: string; icon: typeof AlertTriangle }
> = {
  SEVERE_EPISODE_UNDERWAY: {
    label: "Severe episode under way",
    tone: "#b91c1c",
    ring: "#fee2e2",
    icon: AlertTriangle,
  },
  PREDICTIVE_WARNING: {
    label: "Predictive warning",
    tone: "#c2410c",
    ring: "#ffedd5",
    icon: Clock,
  },
  EPISODE_UNDERWAY: {
    label: "Episode under way",
    tone: "#a16207",
    ring: "#fef3c7",
    icon: AlertTriangle,
  },
  MONITOR: {
    label: "Monitoring",
    tone: "#15803d",
    ring: "#dcfce7",
    icon: CheckCircle2,
  },
};

function hhmm(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function Arrow({ direction }: { direction?: string }) {
  if (direction === "falling") return <span className="text-[#b91c1c]">↓</span>;
  if (direction === "rising") return <span className="text-[#15803d]">↑</span>;
  return <span className="text-[#78716c]">→</span>;
}

/* ── one atmospheric quantity, with where it starts and how low it gets ── */
function TrendRow({
  label,
  trend,
  unit,
}: {
  label: string;
  trend: { available: boolean; now?: number; min?: number; direction?: string };
  unit: string;
}) {
  if (!trend.available) {
    return (
      <div className="flex items-baseline justify-between py-2">
        <span className="text-[12.5px] text-[#57534e]">{label}</span>
        <span className="text-[12px] text-[#a8a29e]">unavailable</span>
      </div>
    );
  }
  return (
    <div className="flex items-baseline justify-between border-b border-[#f0ede4] py-2 last:border-0">
      <span className="text-[12.5px] text-[#57534e]">
        {label} <Arrow direction={trend.direction} />
      </span>
      <span className="tabular-nums text-[13px] font-semibold text-[#1c1917]">
        {trend.now?.toLocaleString()} → {trend.min?.toLocaleString()}
        <span className="ml-1 text-[11px] font-normal text-[#78716c]">{unit}</span>
      </span>
    </div>
  );
}

export default function OutlookView() {
  const [preset, setPreset] = useState(1); // the replay anchor, for the demo
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

  const chart = useMemo(() => {
    if (!data) return [];
    return data.forecast.series.map((p) => ({
      t: p.valid_at,
      label: hhmm(p.valid_at),
      central: p.central,
      upper: p.upper,
      ventilation: p.ventilation_m2_s,
    }));
  }, [data]);

  const style = data ? STATUS_STYLE[data.risk.status] : null;
  const StatusIcon = style?.icon ?? Clock;

  return (
    <div className="space-y-4">
      {/* ── header: what this is, and WHEN it is ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-bold text-[#1c1917]">
            Atmospheric Outlook
          </h1>
          <p className="mt-1 max-w-3xl text-[12px] text-[#78716c]">
            One screen: what the air is doing now, what the atmosphere will do
            next, why, and what response that implies. Every value is computed
            by the AREE backend.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p, i) => (
            <button
              key={p.label}
              onClick={() => setPreset(i)}
              className={`rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition ${
                preset === i
                  ? "border-[#1c1917] bg-[#1c1917] text-white"
                  : "border-[#e4e0d4] bg-white text-[#57534e] hover:border-[#a8a29e]"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── replay banner. Deliberately loud, never a tooltip. ── */}
      {data && (
        <div
          className={`flex items-center gap-2.5 rounded-xl border px-4 py-2.5 ${
            data.mode === "replay"
              ? "border-[#c7d2fe] bg-[#eef2ff]"
              : "border-[#bbf7d0] bg-[#f0fdf4]"
          }`}
        >
          {data.mode === "replay" ? (
            <History className="h-4 w-4 shrink-0 text-[#4338ca]" />
          ) : (
            <Radio className="h-4 w-4 shrink-0 text-[#15803d]" />
          )}
          <span className="text-[12.5px] font-semibold uppercase tracking-wide text-[#1c1917]">
            {data.mode}
          </span>
          <span className="text-[12.5px] text-[#44403c]">
            {data.provenance.note}
          </span>
        </div>
      )}

      {loading && (
        <div className="rounded-xl border border-[#e4e0d4] bg-white p-10 text-center text-[13px] text-[#78716c]">
          Loading outlook…
        </div>
      )}

      {error && !loading && (
        <div className="rounded-xl border border-[#fecaca] bg-[#fef2f2] p-5">
          <p className="text-[13px] font-semibold text-[#b91c1c]">
            Outlook unavailable
          </p>
          <p className="mt-1 text-[12.5px] text-[#7f1d1d]">{error}</p>
        </div>
      )}

      {data && !loading && style && (
        <>
          {/* ── the headline: observation beside the primary state ── */}
          <div className="grid gap-4 md:grid-cols-[260px_1fr]">
            <div className="rounded-xl border border-[#e4e0d4] bg-white p-5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#78716c]">
                Observed PM2.5
              </p>
              <p className="mt-2 tabular-nums text-[34px] font-bold leading-none text-[#1c1917]">
                {data.observation.value.toFixed(0)}
                <span className="ml-1.5 text-[13px] font-medium text-[#78716c]">
                  µg/m³
                </span>
              </p>
              <p className="mt-1.5 text-[13px] font-semibold text-[#44403c]">
                {data.observation.band}
              </p>
              <p className="mt-2 text-[11px] text-[#a8a29e]">
                source: {data.observation.source}
              </p>
            </div>

            <div
              className="rounded-xl border p-5"
              style={{ borderColor: style.ring, background: style.ring }}
            >
              <div className="flex items-center gap-2">
                <StatusIcon className="h-5 w-5" style={{ color: style.tone }} />
                <p
                  className="text-[15px] font-bold uppercase tracking-wide"
                  style={{ color: style.tone }}
                >
                  {style.label}
                </p>
              </div>

              {data.risk.forecast_risk && data.risk.lead_hours !== null && (
                <p className="mt-2 text-[22px] font-bold leading-tight text-[#1c1917]">
                  Severe episode likely within{" "}
                  {Math.round(data.risk.lead_hours)} hours
                </p>
              )}
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#44403c]">
                {data.risk.status_detail}
              </p>

              {data.risk.first_crossing && (
                <p className="mt-2 text-[12px] text-[#57534e]">
                  Upper-tail risk crosses{" "}
                  <strong>{data.risk.threshold_ugm3.toFixed(0)} µg/m³</strong> at{" "}
                  <strong>{hhmm(data.risk.first_crossing)} UTC</strong>, held for{" "}
                  {data.risk.sustained_hours} h · signal{" "}
                  <code className="text-[11px]">{data.risk.trigger_source}</code>
                </p>
              )}
            </div>
          </div>

          {/* ── the chart, and the atmosphere that explains it ── */}
          <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
            <div className="rounded-xl border border-[#e4e0d4] bg-white p-5">
              <div className="flex items-baseline justify-between">
                <p className="text-[13px] font-bold text-[#1c1917]">
                  {data.forecast.horizon_hours}-hour PM2.5 outlook
                </p>
                <p className="text-[11px] text-[#78716c]">µg/m³</p>
              </div>

              <div className="mt-3 h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chart}>
                    <CartesianGrid stroke="#f0ede4" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10, fill: "#a8a29e" }}
                      interval={11}
                      tickLine={false}
                      axisLine={{ stroke: "#e4e0d4" }}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: "#a8a29e" }}
                      tickLine={false}
                      axisLine={false}
                      width={38}
                    />
                    <Tooltip
                      contentStyle={{
                        fontSize: 12,
                        borderRadius: 8,
                        border: "1px solid #e4e0d4",
                      }}
                    />
                    {/* Upper tail drawn as a band, never as a second forecast
                        line - it is a risk envelope, not a prediction. */}
                    <Area
                      dataKey="upper"
                      name="Upper-tail risk (q90)"
                      stroke="#f97316"
                      fill="#fed7aa"
                      fillOpacity={0.5}
                      strokeWidth={1}
                    />
                    <Line
                      dataKey="central"
                      name="Central forecast"
                      stroke="#1c1917"
                      strokeWidth={2}
                      dot={false}
                    />
                    <ReferenceLine
                      y={data.risk.threshold_ugm3}
                      stroke="#b91c1c"
                      strokeDasharray="4 4"
                      label={{
                        value: `Severe ${data.risk.threshold_ugm3.toFixed(0)}`,
                        fontSize: 10,
                        fill: "#b91c1c",
                        position: "right",
                      }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-[#f0ede4] pt-3">
                <span className="text-[11.5px] text-[#57534e]">
                  <span className="mr-1.5 inline-block h-[2px] w-4 align-middle bg-[#1c1917]" />
                  {data.forecast.labels.central}
                </span>
                <span className="text-[11.5px] text-[#57534e]">
                  <span className="mr-1.5 inline-block h-2.5 w-4 rounded-sm align-middle bg-[#fed7aa]" />
                  {data.forecast.labels.upper}
                </span>
              </div>
            </div>

            <div className="rounded-xl border border-[#e4e0d4] bg-white p-5">
              <div className="flex items-center gap-2">
                <Wind className="h-4 w-4 text-[#0e7490]" />
                <p className="text-[13px] font-bold text-[#1c1917]">
                  Atmospheric state
                </p>
              </div>
              <div className="mt-2">
                <TrendRow
                  label="Ventilation"
                  trend={data.atmosphere.ventilation}
                  unit="m²/s"
                />
                <TrendRow label="Boundary layer" trend={data.atmosphere.pblh} unit="m" />
                <TrendRow label="Wind" trend={data.atmosphere.wind} unit="m/s" />
              </div>

              {data.atmosphere.ventilation.hours_below_threshold !== null && (
                <p className="mt-3 rounded-lg bg-[#fafaf9] px-3 py-2 text-[11.5px] leading-relaxed text-[#57534e]">
                  <strong>
                    {data.atmosphere.ventilation.hours_below_threshold} of{" "}
                    {data.forecast.horizon_hours} h
                  </strong>{" "}
                  below the calibrated{" "}
                  {data.atmosphere.ventilation.threshold_m2_s?.toFixed(0)} m²/s
                  operating point.
                </p>
              )}

              {!data.atmosphere.inversion.available && (
                <p className="mt-2 text-[11px] leading-relaxed text-[#a8a29e]">
                  Inversion: {data.atmosphere.inversion.reason}
                </p>
              )}
            </div>
          </div>

          {/* ── why ── */}
          <div className="rounded-xl border border-[#e4e0d4] bg-white p-5">
            <p className="text-[13px] font-bold text-[#1c1917]">Why</p>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-[#f0ede4] bg-[#fafaf9] p-3.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#78716c]">
                  Ventilation collapse
                </p>
                {data.atmosphere.ventilation_forecast.collapse ? (
                  <>
                    <p className="mt-1.5 text-[15px] font-bold text-[#1c1917]">
                      {
                        data.atmosphere.ventilation_forecast.collapse
                          .sustained_hours_below_threshold
                      }{" "}
                      sustained hours
                    </p>
                    <p className="mt-1 text-[11.5px] text-[#57534e]">
                      from{" "}
                      {hhmm(data.atmosphere.ventilation_forecast.collapse.onset)}{" "}
                      UTC
                    </p>
                  </>
                ) : (
                  <p className="mt-1.5 text-[13px] text-[#78716c]">
                    none forecast
                  </p>
                )}
              </div>

              <div className="rounded-lg border border-[#f0ede4] bg-[#fafaf9] p-3.5">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#78716c]">
                  <Flame className="h-3 w-3 text-[#ea580c]" /> Plume influence
                </p>
                <p className="mt-1.5 text-[15px] font-bold text-[#1c1917]">
                  {data.plume.detections_24h.toLocaleString()} detections
                </p>
                <p className="mt-1 text-[11.5px] text-[#57534e]">
                  FRP {data.plume.total_frp_24h.toLocaleString()} · index{" "}
                  {data.plume.influence ?? "—"}
                </p>
              </div>

              <div className="rounded-lg border border-[#f0ede4] bg-[#fafaf9] p-3.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#78716c]">
                  Intervention window
                </p>
                <p className="mt-1.5 text-[15px] font-bold text-[#1c1917]">
                  {data.decision.intervention_window_hours ?? "—"} h
                </p>
                <p className="mt-1 text-[11.5px] text-[#57534e]">
                  before the atmosphere stops clearing
                </p>
              </div>
            </div>

            <ul className="mt-3 space-y-1.5">
              {data.decision.reasons.map((r) => (
                <li key={r} className="flex gap-2 text-[12px] text-[#44403c]">
                  <span className="text-[#a8a29e]">—</span>
                  {r}
                </li>
              ))}
            </ul>
          </div>

          {/* ── recommended response. Backend's words, backend's decision. ── */}
          <div className="rounded-xl border border-[#e4e0d4] bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] font-bold text-[#1c1917]">
                Recommended response
              </p>
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-[#1c1917] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-white">
                  {data.decision.priority}
                </span>
                <span className="rounded-md border border-[#e4e0d4] px-2.5 py-1 text-[11px] font-semibold text-[#57534e]">
                  {data.decision.approval_state.replace(/_/g, " ")}
                </span>
              </div>
            </div>

            <p className="mt-1.5 text-[12px] text-[#78716c]">
              {data.decision.priority_rationale} · GRAP (observed):{" "}
              {data.decision.grap_stage_observed} ·{" "}
              {data.decision.responsible_authority}
            </p>

            {data.decision.recommended_measures.length > 0 ? (
              <ul className="mt-3 space-y-1.5">
                {data.decision.recommended_measures.map((m) => (
                  <li
                    key={m}
                    className="rounded-lg border border-[#f0ede4] bg-[#fafaf9] px-3 py-2 text-[12.5px] text-[#292524]"
                  >
                    {m}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-[12.5px] text-[#78716c]">
                No case open — the validated conjunction has not fired.
              </p>
            )}

            <p className="mt-3 border-t border-[#f0ede4] pt-3 text-[11px] leading-relaxed text-[#78716c]">
              {data.decision.note}
            </p>
          </div>

          {/* ── provenance, in the open ── */}
          <div className="rounded-xl border border-[#e4e0d4] bg-[#fafaf9] p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#78716c]">
              Provenance
            </p>
            <div className="mt-2 grid gap-x-6 gap-y-1 text-[11.5px] text-[#57534e] sm:grid-cols-2">
              <span>observations: {data.provenance.target_source}</span>
              <span>meteorology: {data.provenance.feature_source}</span>
              <span>
                models: {Object.values(data.provenance.models).join(", ")}
              </span>
              <span>
                warning rule: ≥{" "}
                {data.provenance.warning_rule.threshold_ugm3.toFixed(0)} µg/m³ for{" "}
                {data.provenance.warning_rule.min_sustained_hours} h (
                {data.provenance.warning_rule.signal})
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-[#a8a29e]">
              {data.provenance.warning_rule.validated_by}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
