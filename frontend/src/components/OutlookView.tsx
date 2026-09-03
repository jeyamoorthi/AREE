"use client";

/* ==========================================================================
   AREE — Atmospheric Outlook (the decision screen)

   The page is an argument, and it is made in this order:

       1  WHAT IS HAPPENING?            observation + status + where
       2  WHAT HAPPENS NEXT?            72 h central + upper-tail
       3  WHY?                          wind -> boundary layer -> ventilation
       4  WHEN DOES RISK CROSS?         crossing, lead, sustained duration
       5  WHAT SHOULD THE AUTHORITY DO? measures, priority, approval

   That sequence is the product. A dashboard answers 1. AREE exists because 2-5
   are answerable, so they get equal room and appear in the order an officer
   asks them, not in the order the data happens to arrive.

   PRESENTATION ONLY. The headline, the causal chain, the milestones, the
   exposure ranking, the status name and the recommendation are all COMPOSED BY
   THE BACKEND and rendered verbatim. Nothing here compares a value against a
   threshold or decides what "deteriorating" means — if it did, the interface
   and the validated engine could describe the same atmosphere differently.

   ONE STATUS -> ONE UI STATE. Every coloured element on this page takes its
   tone from `risk.status_tone`. No card re-derives a state from forecast_risk
   or from a PM2.5 comparison; that is how EPISODE_UNDERWAY used to render as
   "Low" while an episode was under way.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Eye,
  Flame,
  History,
  Info,
  Radio,
  ShieldCheck,
  TrendingDown,
  Wind,
} from "lucide-react";

import SpatialOutlookMapLoader from "@/components/SpatialOutlookMapLoader";
import CaseAuthorisation from "@/components/CaseAuthorisation";

import { usePublishOutlookMode } from "@/components/providers/OutlookModeProvider";
import { useSyncPresetToUrl } from "@/hooks/useSyncPresetToUrl";
import { api, errorMessage } from "@/lib/api";
import { CPCB_PM25_BANDS } from "@/lib/cpcb";
import type { MechanismLink, OutlookResponse } from "@/types";

const PRESETS: { label: string; at?: string }[] = [
  { label: "Live" },
  { label: "02 Nov 2024 · 06:00", at: "2024-11-02T06:00:00Z" },
  { label: "14 Nov 2024 · 00:00", at: "2024-11-14T00:00:00Z" },
  { label: "16 Nov 2024 · 00:00", at: "2024-11-16T00:00:00Z" },
];

/* Indian operators read IST. UTC stays in the payload and in provenance so the
   record is unambiguous; the screen speaks local time. */
function ist(iso: string, withDate = true): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
  if (!withDate) return `${time} IST`;
  const day = d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
  return `${day}, ${time} IST`;
}

function utc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const C = {
  ink: "#1a1a17",
  body: "#44403a",
  muted: "#7d776c",
  dim: "#a8a196",
  line: "#e8e3d7",
  paper: "#ffffff",
  wash: "#faf8f2",
  amber: "#f0e6c8",
  amberBg: "#fdf8ec",
  amberInk: "#8a6d1f",
  green: "#d9e7d9",
  greenBg: "#f3f8f2",
  greenInk: "#2f6b3f",
  red: "#c2410c",
  redInk: "#b91c1c",
  orange: "#ea8c4f",
  orangeInk: "#b3511c",
  orangeBg: "#fdf4ec",
  violet: "#4338ca",
};

/* ── the four states, in one place ────────────────────────────────────────
   The backend names the tone; this file is the only place that decides what
   each tone looks like, so a card cannot invent its own interpretation.

   Ordering note: an episode ALREADY under way reads hotter than a warning
   about one that has not started, because the first is certain harm now and
   the second is forecast. The predictive case earns its prominence from the
   lead-time chip and the headline instead of from a louder colour — which
   also keeps the page from shouting on a signal that spends most of its time
   in a warning state.                                                       */
const STATUS_STYLE: Record<
  string,
  { ink: string; bg: string; border: string; dot: string }
> = {
  critical: { ink: C.redInk, bg: "#fdf2f0", border: "#f0d5cd", dot: "#b91c1c" },
  elevated: { ink: C.orangeInk, bg: C.orangeBg, border: "#f3ddc6", dot: "#ea580c" },
  warning: { ink: C.amberInk, bg: C.amberBg, border: C.amber, dot: "#ca8a04" },
  calm: { ink: C.greenInk, bg: C.greenBg, border: C.green, dot: "#16a34a" },
};

function styleFor(tone: string | undefined) {
  return STATUS_STYLE[tone ?? "calm"] ?? STATUS_STYLE.calm;
}

/* ── small building blocks ────────────────────────────────────────────── */

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

/**
 * A section of the argument.
 *
 * The numbers are not decoration: this is a fixed sequence an officer walks in
 * order, and each step depends on the one above it. That is the only thing on
 * this page numbered, precisely because it is the only thing that is a sequence.
 */
function SectionHead({
  n,
  question,
  hint,
}: {
  n: string;
  question: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pt-2">
      <span
        className="font-mono text-[10.5px] font-bold tabular-nums"
        style={{ color: C.dim }}
      >
        {n}
      </span>
      <h2
        className="text-[12.5px] font-bold uppercase tracking-[0.09em]"
        style={{ color: C.ink }}
      >
        {question}
      </h2>
      {hint ? (
        <span className="text-[11px]" style={{ color: C.muted }}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** One headline number with a supporting line. */
function Stat({
  label,
  value,
  unit,
  tone,
  caption,
  sub,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: string;
  caption?: string;
  sub?: string;
}) {
  return (
    <Card>
      <Eyebrow>{label}</Eyebrow>
      <p
        className="mt-2 text-[27px] font-bold leading-none tracking-tight"
        style={{ color: tone ?? C.ink }}
      >
        {value}
        {unit && (
          <span className="ml-1 text-[12px] font-semibold" style={{ color: C.muted }}>
            {unit}
          </span>
        )}
      </p>
      {caption && (
        <p
          className="mt-1.5 text-[12px] font-semibold"
          style={{ color: tone ?? C.body }}
        >
          {caption}
        </p>
      )}
      {sub && (
        <p className="mt-1 text-[10.5px] leading-snug" style={{ color: C.dim }}>
          {sub}
        </p>
      )}
    </Card>
  );
}

/**
 * One link of the causal chain, shown as from → to with its direction.
 *
 * `tone` comes from the page status. Previously the direction text was always
 * red, so a MONITOR day at 44 µg/m³ rendered "Deteriorating" in alarm colour
 * beside "Conditions are stable" — the boundary layer collapses every winter
 * night, so that read as an alarm every night and trained the reader to ignore it.
 */
function MechanismCell({ link, tone }: { link: MechanismLink; tone: string }) {
  if (!link.available) return null;
  const falling = link.direction === "falling";
  const word =
    link.label === "Wind"
      ? "Weakening"
      : link.label === "Boundary layer"
        ? "Shrinking"
        : "Deteriorating";
  const ink = falling ? styleFor(tone).ink : C.muted;
  return (
    <div className="flex items-start gap-2">
      <TrendingDown className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: ink }} />
      <div className="min-w-0">
        <Eyebrow>{link.label}</Eyebrow>
        <p className="mt-1 text-[13px] font-bold tabular-nums" style={{ color: C.ink }}>
          {link.now} → {link.low}
          <span className="ml-1 text-[10px] font-medium" style={{ color: C.muted }}>
            {link.unit}
          </span>
        </p>
        <p className="text-[10.5px] font-semibold" style={{ color: ink }}>
          {falling ? word : "Steady"}
        </p>
      </div>
    </div>
  );
}

/* ── page ─────────────────────────────────────────────────────────────── */

export default function OutlookView() {
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

  // Tell the shell which moment this page is describing, so the header and sidebar stop
  // showing a green LIVE pill above a reconstruction of November 2024.
  usePublishOutlookMode(data?.mode, data?.as_of);

  const chart = useMemo(
    () =>
      (data?.forecast.series ?? []).map((p) => ({
        label: ist(p.valid_at),
        short: ist(p.valid_at).replace(", ", " "),
        central: p.central,
        upper: p.upper,
      })),
    [data],
  );

  /* Y-DOMAIN.
     Recharts' auto domain fitted the data and left the 250 threshold line and
     the band annotation outside the plotting region, which clipped the label
     to "ation window". The axis now covers every mark the chart draws —
     observation, both forecast lines, and the threshold — plus headroom. */
  const yMax = useMemo(() => {
    if (!data) return 300;
    const values = [
      ...data.forecast.series.map((p) => p.upper),
      ...data.forecast.series.map((p) => p.central),
      data.observation.value,
      data.risk.threshold_ugm3,
    ].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (values.length === 0) return 300;
    return Math.ceil((Math.max(...values) * 1.15) / 50) * 50;
  }, [data]);

  /* The shaded accumulation band comes from the backend's timeline: it spans
     the forecast collapse to the forecast recovery. The UI does not decide
     where the bad window is. It carries no on-chart label — the label was what
     clipped, and the WHEN section below states the same window in words. */
  /* The X axis is keyed on `short` ("02 Nov 17:30 IST"), not `label`
     ("02 Nov, 17:30 IST"). Building the band bounds with ist() produced the comma
     form, which matches no category, so Recharts collapsed the shaded window against
     the left edge instead of spanning the collapse. Both bounds are now taken from the
     same field the axis uses. */
  const short = (iso: string) => ist(iso).replace(", ", " ");

  const band = useMemo(() => {
    if (!data) return null;
    const start = data.timeline.find((m) => m.kind === "collapse");
    const end = data.timeline.find((m) => m.kind === "recovery");
    if (!start) return null;
    return {
      from: short(start.at),
      to: end ? short(end.at) : chart[chart.length - 1]?.short,
    };
  }, [data, chart]);

  const crossingLabel = useMemo(() => {
    if (!data?.risk.first_crossing) return null;
    return ist(data.risk.first_crossing);
  }, [data]);

  const crossingX = useMemo(() => {
    if (!data?.risk.first_crossing) return null;
    return short(data.risk.first_crossing);
  }, [data]);

  /* Collapse timing and the remaining window, taken from the ventilation
     forecast so they are present whenever a collapse is forecast — regardless
     of whether the escalation conjunction has fired. */
  const collapseInfo = data?.atmosphere.ventilation_forecast.collapse ?? null;
  const windowHours =
    data?.atmosphere.ventilation_forecast.intervention_window_hours ?? null;

  const rec = data?.decision.recommendation;
  const tone = data?.risk.status_tone ?? "calm";
  const S = styleFor(tone);

  const exposure = data?.exposure;
  const hasField = exposure?.kind === "network";

  /* "77 reporting stations · median 43 · range 11–121". Every figure is read off the
     points the backend supplied for THIS hour; the range is not a separate field, it
     is the min and max of the same array the map draws. */
  const networkSummary = useMemo(() => {
    const points = exposure?.points ?? [];
    if (!hasField || points.length === 0) return null;
    const values = points.map((p) => p.pm25).filter((v) => Number.isFinite(v));
    if (values.length === 0) return null;
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const median = exposure?.median_pm25;
    return [
      `${points.length} reporting station${points.length === 1 ? "" : "s"}`,
      median !== undefined ? `median ${median.toFixed(0)} µg/m³` : null,
      `range ${lo.toFixed(0)}–${hi.toFixed(0)}`,
    ]
      .filter(Boolean)
      .join(" · ");
  }, [exposure, hasField]);

  return (
    <div className="space-y-3" style={{ color: C.body }}>
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-bold tracking-tight" style={{ color: C.ink }}>
            Atmospheric Outlook
          </h1>
          <p className="mt-0.5 text-[11.5px]" style={{ color: C.muted }}>
            What the atmosphere is doing now, what it will do next, and what that
            means for air quality.
            <br />
            Every value is computed by the AREE backend.
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
                  ? { background: C.ink, borderColor: C.ink, color: "#fff" }
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
          <p className="py-8 text-center text-[12.5px]" style={{ color: C.muted }}>
            Loading outlook…
          </p>
        </Card>
      )}

      {error && !loading && (
        <div
          className="rounded-lg border p-4"
          style={{ background: "#fdf2f0", borderColor: "#f0d5cd" }}
        >
          <p className="text-[12.5px] font-bold" style={{ color: C.redInk }}>
            Outlook unavailable
          </p>
          <p className="mt-1 text-[12px]" style={{ color: C.body }}>
            {error}
          </p>
        </div>
      )}

      {data && !loading && (
        <>
          {/* ══ HERO ═══════════════════════════════════════════════════════
              Above the numbered argument, because it is the one thing that has to
              survive being read from across a room: what state we are in, in one
              sentence, with the mode and the moment it describes. */}
          <div
            className="rounded-lg border p-4 sm:p-5"
            style={{ background: S.bg, borderColor: S.border }}
          >
            {/* PROVENANCE, FIRST. The mode and the as_of sit above the headline, not
                in a footnote: a reader must not be able to absorb the sentence before
                learning whether it describes now or a reconstruction of 2024. */}
            <div
              className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-b pb-2.5"
              style={{ borderColor: S.border }}
            >
              <span className="flex items-center gap-1.5">
                {data.mode === "replay" ? (
                  <History className="h-3.5 w-3.5" style={{ color: C.violet }} />
                ) : (
                  <Radio className="h-3.5 w-3.5" style={{ color: C.greenInk }} />
                )}
                <span
                  className="text-[10px] font-bold uppercase tracking-[0.12em]"
                  style={{ color: data.mode === "replay" ? C.violet : C.greenInk }}
                >
                  {data.mode}
                </span>
              </span>
              <span
                className="font-mono text-[11px] font-semibold"
                style={{ color: C.body }}
              >
                {utc(data.as_of)}
              </span>
              <span className="text-[10.5px]" style={{ color: C.muted }}>
                {data.mode === "replay"
                  ? "Reconstructed from data available at this moment"
                  : data.provenance.note}
              </span>
            </div>

            <div className="flex gap-3">
              <span
                className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: S.dot }}
                aria-hidden
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="text-[11px] font-bold uppercase tracking-[0.1em]"
                    style={{ color: S.ink }}
                  >
                    {data.risk.status_label}
                  </span>
                  {data.risk.lead_hours !== null &&
                  data.risk.status === "PREDICTIVE_WARNING" ? (
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
                      style={{ background: S.border, color: S.ink }}
                    >
                      {data.risk.lead_hours.toFixed(0)} H LEAD
                    </span>
                  ) : null}
                </div>
                <p
                  className="mt-1.5 text-[20px] font-bold leading-tight tracking-tight"
                  style={{ color: C.ink }}
                >
                  {data.narrative.headline}
                </p>
                <p
                  className="mt-1.5 max-w-[80ch] text-[13px] leading-snug"
                  style={{ color: C.body }}
                >
                  {data.narrative.detail}
                </p>
                {/* The crossing, stated in the same breath as the warning —
                    composed from risk fields, not invented. */}
                {crossingLabel ? (
                  <p
                    className="mt-2 text-[12.5px] font-semibold"
                    style={{ color: S.ink }}
                  >
                    Upper-tail crosses {data.risk.threshold_ugm3.toFixed(0)} µg/m³ at{" "}
                    {crossingLabel}
                    {data.risk.sustained_hours
                      ? ` · sustained ${data.risk.sustained_hours} h`
                      : ""}
                  </p>
                ) : null}
              </div>
            </div>

            {/* THE FIFTH ANSWER, ABOVE THE FOLD.
                An officer's five questions are what / next / why / when / what do I do.
                The first four were answerable from this banner; the recommendation sat
                a full screen further down, so the one question that ends in an action
                was the one that needed scrolling. This is the call and its state — the
                measures themselves stay in section 05, where there is room for them. */}
            {rec ? (
              <div
                className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t pt-2.5"
                style={{ borderColor: S.border }}
              >
                <span className="flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" style={{ color: S.ink }} />
                  <span
                    className="text-[12px] font-bold uppercase tracking-wide"
                    style={{ color: S.ink }}
                  >
                    {rec.call}
                  </span>
                </span>
                {data.decision.triggered ? (
                  <span className="text-[11.5px]" style={{ color: C.body }}>
                    <b>{data.decision.priority}</b> priority ·{" "}
                    {data.decision.recommended_measures.length} measures ·{" "}
                    <b>
                      {(data.decision.case_status ?? data.decision.approval_state)
                        .replace(/_/g, " ")
                        .toLowerCase()}
                    </b>
                  </span>
                ) : (
                  <span className="text-[11.5px]" style={{ color: C.body }}>
                    {rec.next_step}
                  </span>
                )}
                <a
                  href="#authority"
                  className="ml-auto text-[11.5px] font-semibold"
                  style={{ color: S.ink }}
                >
                  Review case ↓
                </a>
              </div>
            ) : null}
          </div>

          {/* ══ 1 · WHAT IS HAPPENING ══════════════════════════════════════ */}
          <SectionHead
            n="01"
            question="What is happening?"
            hint="Observed now, and where it is worst"
          />

          <div className="grid gap-3 lg:grid-cols-[0.72fr_1.35fr_1fr]">
            <Card>
              <Eyebrow>Observed PM2.5</Eyebrow>
              <p
                className="mt-2 text-[34px] font-bold leading-none tabular-nums"
                style={{ color: C.ink }}
              >
                {data.observation.value.toFixed(0)}
                <span
                  className="ml-1 text-[12px] font-semibold"
                  style={{ color: C.muted }}
                >
                  µg/m³
                </span>
              </p>
              <p
                className="mt-1.5 text-[14px] font-bold uppercase tracking-wide"
                style={{ color: S.ink }}
              >
                {data.observation.band}
              </p>
              <div
                className="mt-3 space-y-1 border-t pt-2.5"
                style={{ borderColor: C.line }}
              >
                <Eyebrow>Target</Eyebrow>
                <p
                  className="text-[12px] font-bold leading-snug"
                  style={{ color: C.ink }}
                >
                  {data.observation.n_stations !== null
                    ? `${data.observation.n_stations} ${
                        data.observation.n_stations === 1 ? "monitor" : "stations"
                      }`
                    : "count not recorded"}
                </p>
                <p className="text-[10.5px] leading-snug" style={{ color: C.dim }}>
                  {data.observation.target_label}
                </p>
                <p className="text-[10.5px]" style={{ color: C.dim }}>
                  {ist(data.observation.observed_at)}
                </p>
              </div>
            </Card>
            <Card>
              <div className="flex items-baseline justify-between gap-3">
                <Eyebrow>Spatial outlook</Eyebrow>
                <span className="text-[10px]" style={{ color: C.dim }}>
                  Observed field — not a spatial forecast
                </span>
              </div>
              {/* The header states which of the two shapes this is. It used to say
                  "Latest observed hour" unconditionally, which is false for a
                  historical composite that has no station-level hour at all. */}
              <p className="mt-1 text-[11px] font-semibold" style={{ color: C.body }}>
                {hasField && exposure?.observed_at
                  ? ist(exposure.observed_at)
                  : ist(data.as_of)}
              </p>
              <p className="text-[10.5px]" style={{ color: C.dim }}>
                {hasField
                  ? `Network observation · ${exposure?.n_stations} stations`
                  : `Historical composite · ${exposure?.n_monitors ?? "?"} ${
                      exposure?.n_monitors === 1 ? "monitor" : "monitors"
                    }`}
              </p>

              <div className="mt-2">
                {hasField ? (
                  <SpatialOutlookMapLoader
                    stations={exposure?.points ?? exposure?.worst ?? []}
                    observedAt={exposure?.observed_at}
                    ageHours={exposure?.age_hours}
                    // Taller than the old 260: the NCR box is roughly square, and a
                    // short wide card wastes most of the fit on empty longitude.
                    height={300}
                  />
                ) : (
                  /* No fabricated historical points. The absence is the finding:
                     it is why the multi-station capture exists. */
                  <div
                    className="flex h-[260px] flex-col items-center justify-center rounded-lg border px-6 text-center"
                    style={{ background: C.wash, borderColor: C.line }}
                  >
                    <Info className="h-5 w-5" style={{ color: C.dim }} aria-hidden />
                    <p
                      className="mt-2 text-[12px] font-bold"
                      style={{ color: C.body }}
                    >
                      No station-level spatial field for this timestamp
                    </p>
                    <p
                      className="mt-1 max-w-[46ch] text-[11px] leading-snug"
                      style={{ color: C.muted }}
                    >
                      {exposure?.reason ??
                        "The target for this hour is an NCR composite."}
                    </p>
                  </div>
                )}
              </div>

              {hasField ? (
                <div className="mt-2 border-t pt-2" style={{ borderColor: C.line }}>
                  {/* The legend carries the CPCB numeric ranges, so a reader can check
                      a symbol's colour against the national standard rather than
                      trusting it. The bands themselves come from the backend. */}
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {CPCB_PM25_BANDS.map((b) => (
                      <span
                        key={b.band}
                        className="text-[9.5px]"
                        style={{ color: C.muted }}
                        title={`${b.band}: ${b.from}–${b.to ?? "∞"} µg/m³`}
                      >
                        <span
                          className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                          style={{ background: b.colour }}
                        />
                        {b.band}{" "}
                        <span style={{ color: C.dim }}>
                          {b.to === null ? `${b.from}+` : `${b.from}–${b.to}`}
                        </span>
                      </span>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[9.5px]" style={{ color: C.dim }}>
                    Colour = CPCB band · symbol area ∝ concentration. Symbol size is a
                    reading, not a modelled extent.
                  </p>
                  {/* What the network as a whole is reading at this hour. */}
                  {networkSummary ? (
                    <p
                      className="mt-1 text-[10.5px] font-semibold"
                      style={{ color: C.body }}
                    >
                      {networkSummary}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </Card>

            <Card>
              <Eyebrow>Top areas at risk</Eyebrow>
              {hasField ? (
                <>
                  <p className="mt-0.5 text-[10px]" style={{ color: C.dim }}>
                    PM2.5 µg/m³ · {exposure?.n_stations} stations ·{" "}
                    {exposure?.observed_at ? ist(exposure.observed_at) : "—"}
                  </p>
                  <ol className="mt-2 space-y-0.5">
                    {(exposure?.worst ?? []).map((s, i) => (
                      <li
                        key={s.station}
                        className="flex items-center justify-between border-b py-1.5 last:border-0"
                        style={{ borderColor: "#f2efe6" }}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className="w-3 text-[10px] tabular-nums"
                            style={{ color: C.dim }}
                          >
                            {i + 1}
                          </span>
                          <span
                            className="truncate text-[11.5px] font-semibold"
                            style={{ color: C.ink }}
                          >
                            {s.place}
                          </span>
                        </span>
                        <span
                          className="text-[12px] font-bold tabular-nums"
                          style={{ color: s.pm25 > 100 ? "#c0392b" : C.body }}
                        >
                          {s.pm25.toFixed(0)}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {exposure?.median_pm25 !== undefined && (
                    <p className="mt-2 text-[10px]" style={{ color: C.dim }}>
                      Network median {exposure.median_pm25.toFixed(0)} · spread{" "}
                      {exposure.spread_pm25}
                    </p>
                  )}
                </>
              ) : (
                /* "0 stations" over a blank card reads as a broken system. It is
                   not broken — the ranking is undefined for a single-monitor
                   target, and saying which is more informative than a number. */
                <div className="mt-2">
                  <p
                    className="text-[11px] font-bold uppercase tracking-[0.08em]"
                    style={{ color: C.orangeInk }}
                  >
                    Station-level data unavailable
                  </p>
                  <p className="mt-2 text-[11.5px] leading-relaxed" style={{ color: C.body }}>
                    This replay target is a historical{" "}
                    {exposure?.n_monitors === 1 ? "single-monitor" : "multi-monitor"}{" "}
                    composite. A spatial ranking exists only where station-level
                    observations do.
                  </p>
                  <div
                    className="mt-3 rounded-md border p-3"
                    style={{ background: C.wash, borderColor: C.line }}
                  >
                    <Eyebrow>Target for this hour</Eyebrow>
                    <p
                      className="mt-1 text-[16px] font-bold tabular-nums"
                      style={{ color: C.ink }}
                    >
                      {(exposure?.composite_pm25 ?? data.observation.value).toFixed(0)}
                      <span
                        className="ml-1 text-[10px] font-semibold"
                        style={{ color: C.muted }}
                      >
                        µg/m³
                      </span>
                    </p>
                    <p className="mt-1 text-[10.5px]" style={{ color: C.dim }}>
                      {exposure?.n_monitors ?? data.observation.n_stations ?? "?"} monitor
                      · {data.observation.source}
                    </p>
                  </div>
                  <p className="mt-2 text-[10.5px] leading-snug" style={{ color: C.dim }}>
                    Station-level capture began Sept 2026 — which is why AREE now
                    records the whole network hourly.
                  </p>
                </div>
              )}
            </Card>
          </div>

          {/* ══ 2 · WHAT HAPPENS NEXT ══════════════════════════════════════ */}
          <SectionHead
            n="02"
            question="What happens next?"
            hint={`${data.forecast.horizon_hours}-hour PM2.5 forecast`}
          />

          <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span className="text-[10px]" style={{ color: C.muted }}>
                  <span
                    className="mr-1 inline-block h-[2px] w-3 align-middle"
                    style={{ background: C.ink }}
                  />
                  Median forecast (L1)
                </span>
                <span className="text-[10px]" style={{ color: C.muted }}>
                  <span
                    className="mr-1 inline-block h-2 w-3 rounded-sm align-middle"
                    style={{ background: "#f8d2b4" }}
                  />
                  Upper-tail risk (q90) — not a prediction
                </span>
                <span className="text-[10px]" style={{ color: C.muted }}>
                  <span
                    className="mr-1 inline-block h-[2px] w-3 align-middle"
                    style={{ background: C.redInk }}
                  />
                  Severe threshold
                </span>
                {band ? (
                  <span className="text-[10px]" style={{ color: C.muted }}>
                    <span
                      className="mr-1 inline-block h-2 w-3 rounded-sm align-middle"
                      style={{ background: "#f3c9b0" }}
                    />
                    High accumulation window
                  </span>
                ) : null}
              </div>
              <span className="text-[10px]" style={{ color: C.dim }}>
                µg/m³ · {Object.values(data.provenance.models).join(" · ")}
              </span>
            </div>

            <div className="mt-2 h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={chart}
                  margin={{ top: 10, right: 12, bottom: 0, left: -14 }}
                >
                  <CartesianGrid stroke="#f2efe6" vertical={false} />
                  <XAxis
                    dataKey="short"
                    tick={{ fontSize: 9, fill: C.dim }}
                    interval={Math.max(3, Math.floor(chart.length / 8))}
                    tickLine={false}
                    axisLine={{ stroke: C.line }}
                  />
                  <YAxis
                    domain={[0, yMax]}
                    tick={{ fontSize: 9, fill: C.dim }}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 11,
                      borderRadius: 6,
                      border: `1px solid ${C.line}`,
                    }}
                  />
                  {band && (
                    <ReferenceArea
                      x1={band.from}
                      x2={band.to}
                      fill="#f3c9b0"
                      fillOpacity={0.25}
                    />
                  )}
                  <Area
                    dataKey="upper"
                    name="Upper-tail risk (q90)"
                    stroke={C.orange}
                    fill="#fbe4d0"
                    fillOpacity={0.85}
                    strokeWidth={1.2}
                    isAnimationActive={false}
                  />
                  <Line
                    dataKey="central"
                    name="Median forecast (L1)"
                    stroke={C.ink}
                    strokeWidth={1.8}
                    dot={false}
                    isAnimationActive={false}
                  />
                  {/* Threshold label sits INSIDE the plotting region, and the axis
                      above guarantees there is room for it. */}
                  <ReferenceLine
                    y={data.risk.threshold_ugm3}
                    stroke={C.redInk}
                    strokeDasharray="4 3"
                    label={{
                      value: `Severe ${data.risk.threshold_ugm3.toFixed(0)}`,
                      position: "insideTopLeft",
                      fontSize: 9.5,
                      fill: C.redInk,
                    }}
                  />
                  {crossingLabel && (
                    <ReferenceLine
                      x={crossingX ?? undefined}
                      stroke={S.dot}
                      strokeDasharray="3 3"
                      label={{
                        value: "crossing",
                        position: "insideTop",
                        fontSize: 9.5,
                        fill: S.ink,
                      }}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div
              className="mt-2 flex flex-wrap gap-x-6 gap-y-1 border-t pt-2"
              style={{ borderColor: C.line }}
            >
              <span className="text-[10.5px]" style={{ color: C.muted }}>
                Peak median{" "}
                <b style={{ color: C.ink }}>
                  {data.forecast.summary.central_max.toFixed(0)}
                </b>{" "}
                µg/m³
              </span>
              <span className="text-[10.5px]" style={{ color: C.muted }}>
                Peak upper-tail{" "}
                <b style={{ color: S.ink }}>
                  {data.forecast.summary.upper_max.toFixed(0)}
                </b>{" "}
                µg/m³
              </span>
              <span className="text-[10.5px]" style={{ color: C.dim }}>
                Rule: q90 ≥ {data.provenance.warning_rule.threshold_ugm3.toFixed(0)} µg/m³
                for ≥ {data.provenance.warning_rule.min_sustained_hours} h ·{" "}
                {data.provenance.warning_rule.validated_by}
              </span>
            </div>
          </Card>

          {/* ══ 3 · WHY ════════════════════════════════════════════════════ */}
          <SectionHead
            n="03"
            question="Why?"
            hint="Meteorology drives dispersion, dispersion drives accumulation"
          />

          <Card>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {data.mechanism.links.map((l) => (
                <MechanismCell key={l.label} link={l} tone={tone} />
              ))}
              <div className="flex items-start gap-2">
                <Flame className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: C.muted }} />
                <div className="min-w-0">
                  <Eyebrow>Plume influence</Eyebrow>
                  <p
                    className="mt-1 text-[13px] font-bold tabular-nums"
                    style={{ color: C.ink }}
                  >
                    {data.plume.available && data.plume.influence !== null
                      ? data.plume.influence.toFixed(1)
                      : "None"}
                  </p>
                  <p className="text-[10.5px] font-semibold" style={{ color: C.muted }}>
                    {data.plume.available
                      ? `${data.plume.detections_24h} detections · FRP ${data.plume.total_frp_24h}`
                      : "No fire record for this hour"}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Wind className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: S.ink }} />
                <div className="min-w-0">
                  <Eyebrow>Dispersion</Eyebrow>
                  <p className="mt-1 text-[13px] font-bold" style={{ color: C.ink }}>
                    {data.mechanism.dispersion.verdict
                      .replace(/^\w/, (c) => c.toUpperCase())}
                  </p>
                  <p className="text-[10.5px] font-semibold" style={{ color: S.ink }}>
                    vs {data.mechanism.dispersion.threshold_m2_s?.toFixed(0)} m²/s
                  </p>
                </div>
              </div>
            </div>
            <p
              className="mt-3 border-t pt-2 text-[11.5px] leading-relaxed"
              style={{ borderColor: C.line, color: C.body }}
            >
              {data.mechanism.consequence}. Full dispersion diagnostic on the{" "}
              <a href="/ventilation" style={{ color: C.violet }}>
                Ventilation Outlook
              </a>
              .
            </p>
          </Card>

          {/* ══ 4 · WHEN DOES RISK CROSS ═══════════════════════════════════ */}
          <SectionHead
            n="04"
            question="When does risk cross?"
            hint="Forecast milestones, and how long is left to act"
          />

          <div className="grid gap-3 xl:grid-cols-[1fr_1.6fr]">
            <div className="grid grid-cols-2 gap-3 self-start">
              <Stat
                label="Severe expected"
                value={crossingLabel ? ist(data.risk.first_crossing!, false) : "None"}
                tone={crossingLabel ? S.ink : C.ink}
                caption={
                  data.risk.lead_hours !== null
                    ? `in ${data.risk.lead_hours.toFixed(0)} h`
                    : "no crossing forecast"
                }
                sub={
                  crossingLabel
                    ? `${ist(data.risk.first_crossing!)} · q90 ${data.risk.upper_at_crossing?.toFixed(0)} µg/m³`
                    : `Upper tail stays below ${data.risk.threshold_ugm3.toFixed(0)} µg/m³`
                }
              />
              <Stat
                label="Intervention window"
                value={
                  windowHours !== null
                    ? windowHours.toFixed(windowHours < 10 ? 1 : 0)
                    : "None"
                }
                unit={windowHours !== null ? "h" : undefined}
                tone={windowHours !== null && windowHours <= 0 ? C.redInk : C.ink}
                caption={
                  windowHours === null
                    ? "No ventilation collapse forecast"
                    : windowHours <= 0
                      ? "Collapse has begun"
                      : "Before the atmosphere stops clearing"
                }
                sub={
                  collapseInfo
                    ? `Collapse ${ist(collapseInfo.onset)} · ${collapseInfo.sustained_hours_below_threshold} h sustained`
                    : "Ventilation stays above the operating threshold"
                }
              />
            </div>

            <Card>
              <Eyebrow>Forecast milestones</Eyebrow>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[540px]">
                  <thead>
                    <tr style={{ color: C.dim }}>
                      <th className="pb-1.5 text-left text-[9.5px] font-semibold uppercase tracking-wide">
                        When
                      </th>
                      <th className="pb-1.5 text-left text-[9.5px] font-semibold uppercase tracking-wide">
                        Atmospheric state
                      </th>
                      <th className="pb-1.5 text-left text-[9.5px] font-semibold uppercase tracking-wide">
                        Consequence
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.timeline.map((m) => {
                      const dot =
                        m.kind === "now"
                          ? "#7fa86b"
                          : m.kind === "collapse"
                            ? "#e07a3f"
                            : m.kind === "recovery"
                              ? "#7fa86b"
                              : "#c0392b";
                      return (
                        <tr
                          key={m.kind + m.at}
                          className="border-t"
                          style={{ borderColor: "#f2efe6" }}
                        >
                          <td
                            className="whitespace-nowrap py-1.5 pr-3 text-[11.5px] font-semibold"
                            style={{ color: C.ink }}
                          >
                            <span
                              className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                              style={{ background: dot }}
                            />
                            {m.kind === "now" ? "Now" : ist(m.at)}
                            {m.kind !== "now" && (
                              <span
                                className="ml-1.5 text-[10px] font-normal"
                                style={{ color: C.dim }}
                              >
                                +{m.hours_from_now.toFixed(0)} h
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 pr-3 text-[11.5px]" style={{ color: C.body }}>
                            {m.state}
                          </td>
                          <td className="py-1.5 text-[11.5px]" style={{ color: C.muted }}>
                            {m.consequence}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          {/* ══ 5 · WHAT SHOULD THE AUTHORITY DO ═══════════════════════════ */}
          <div id="authority" className="scroll-mt-20" />
          <SectionHead
            n="05"
            question="What should the authority do?"
            hint="Advisory — legal authority rests with CAQM and the state boards"
          />

          {rec && (
            <div
              className="rounded-lg border p-4"
              style={{ background: S.bg, borderColor: S.border }}
            >
              <div className="grid gap-4 lg:grid-cols-[1.3fr_2fr]">
                <div className="flex gap-3">
                  <ShieldCheck
                    className="mt-0.5 h-4 w-4 shrink-0"
                    style={{ color: S.ink }}
                  />
                  <div>
                    <Eyebrow>Recommended response</Eyebrow>
                    <p className="mt-1 text-[15px] font-bold" style={{ color: S.ink }}>
                      {rec.call}
                    </p>
                    <p
                      className="mt-1 text-[11.5px] leading-snug"
                      style={{ color: C.body }}
                    >
                      {rec.because}
                    </p>
                    <p className="mt-2 text-[10.5px]" style={{ color: C.dim }}>
                      GRAP stage from observed AQI:{" "}
                      <b style={{ color: C.body }}>
                        {data.decision.grap_stage_observed}
                      </b>{" "}
                      · priority {data.decision.priority}
                    </p>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    [Eye, "Monitor", rec.next_step],
                    [
                      ClipboardCheck,
                      "Prepare",
                      data.decision.recommended_measures.length
                        ? `${data.decision.recommended_measures.length} measures ready for approval`
                        : "No measures pending",
                    ],
                    [Clock, "Review", data.decision.approval_state.replace(/_/g, " ")],
                  ].map(([Icon, title, text]) => {
                    const I = Icon as typeof Eye;
                    return (
                      <div key={title as string} className="flex gap-2">
                        <I
                          className="mt-0.5 h-3.5 w-3.5 shrink-0"
                          style={{ color: C.muted }}
                        />
                        <div>
                          <p className="text-[11.5px] font-bold" style={{ color: C.ink }}>
                            {title as string}
                          </p>
                          <p
                            className="text-[10.5px] leading-snug"
                            style={{ color: C.muted }}
                          >
                            {text as string}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {data.decision.recommended_measures.length > 0 && (
                <ul
                  className="mt-3 grid gap-1.5 border-t pt-3 sm:grid-cols-2"
                  style={{ borderColor: S.border }}
                >
                  {data.decision.recommended_measures.map((m) => (
                    <li
                      key={m}
                      className="flex gap-2 text-[11.5px]"
                      style={{ color: C.body }}
                    >
                      <CheckCircle2
                        className="mt-0.5 h-3 w-3 shrink-0"
                        style={{ color: S.ink }}
                      />
                      {m}
                    </li>
                  ))}
                </ul>
              )}

              {/* The decision itself. Everything above is a recommendation; this is
                  where a person accepts or refuses it, and the outcome is persisted. */}
              <CaseAuthorisation
                decision={data.decision}
                risk={data.risk}
                asOf={data.as_of}
                tone={S}
                onDecided={() => void load(PRESETS[preset].at)}
              />

              {data.decision.reasons.length > 0 && (
                <div className="mt-3 border-t pt-3" style={{ borderColor: S.border }}>
                  <Eyebrow>Why this case exists</Eyebrow>
                  <ul className="mt-1.5 grid gap-1">
                    {data.decision.reasons.map((r) => (
                      <li
                        key={r}
                        className="flex gap-2 text-[11px] leading-snug"
                        style={{ color: C.body }}
                      >
                        <AlertTriangle
                          className="mt-0.5 h-3 w-3 shrink-0"
                          style={{ color: C.muted }}
                        />
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* ── provenance: mode, sources, models ── */}
          <div
            className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border px-4 py-2.5"
            style={{ background: C.wash, borderColor: C.line }}
          >
            <span className="flex items-center gap-1.5">
              {data.mode === "replay" ? (
                <History className="h-3.5 w-3.5" style={{ color: C.violet }} />
              ) : (
                <Radio className="h-3.5 w-3.5" style={{ color: C.greenInk }} />
              )}
              <span
                className="text-[10px] font-bold uppercase tracking-wide"
                style={{ color: data.mode === "replay" ? C.violet : C.greenInk }}
              >
                {data.mode}
              </span>
            </span>
            <span className="text-[10.5px]" style={{ color: C.muted }}>
              {data.provenance.note}
            </span>
            <span className="text-[10.5px]" style={{ color: C.dim }}>
              obs: {data.provenance.target_source} · met:{" "}
              {data.provenance.feature_source} · models:{" "}
              {Object.values(data.provenance.models).join(", ")}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
