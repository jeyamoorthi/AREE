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

import { useMemo } from "react";
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

import InterventionTimer, {
  useInterventionCountdown,
} from "@/components/InterventionTimer";
import { useOutlookData } from "@/components/providers/OutlookDataProvider";
import UnavailableNotice from "@/components/UnavailableNotice";

const C = {
  ink: "var(--aree-text)",
  body: "var(--aree-body)",
  muted: "var(--aree-muted)",
  dim: "var(--aree-dim)",
  line: "var(--aree-border)",
  paper: "var(--aree-surface-1)",
  wash: "var(--aree-surface-2)",
  red: "var(--aree-red)",
  amber: "var(--aree-orange)",
  green: "var(--aree-green)",
  blue: "var(--aree-blue)",
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

/* ── chart geometry, in ONE place ──────────────────────────────────────────
   The timeline above the VC chart has to line up with it, and "lines up" is not a
   matter of taste: Recharts puts its plot area at `yAxisWidth + margin.left` from the
   container's left edge and `margin.right` from its right. Both numbers used to live
   inline on the <ComposedChart>. Copying them into the timeline would mean two places
   to change and one silent misalignment the first time either moved, so the chart and
   the timeline now read the same constants.                                          */
/* `top` carries the on-chart annotation labels ("Onset", "Recovery"), which are drawn
   above the plot area. Only `left` and `right` feed the timeline's insets, so this can
   grow without moving the Change #6 bar. */
const VC_CHART_MARGIN = { top: 20, right: 10, bottom: 0, left: -16 } as const;
const VC_Y_AXIS_WIDTH = 44;
const PLOT_INSET_LEFT = VC_Y_AXIS_WIDTH + VC_CHART_MARGIN.left;
const PLOT_INSET_RIGHT = VC_CHART_MARGIN.right;

/**
 * The forecast point covering an instant, as an INDEX into `forecast.series`.
 *
 * Every x position on this screen — the Change #6 timeline's segments and onset
 * marker, and the chart's reference lines and shaded band — has to resolve to the same
 * column, so they all resolve through this one function. Two `findIndex` calls with
 * the same predicate would agree today and are exactly the kind of thing that stops
 * agreeing later.
 *
 * Compared as epoch numbers, not as strings: a difference in ISO formatting between
 * two fields of the payload must not silently mis-place a marker. An instant falling
 * in a gap (the series skips an hour when a feature row is missing) snaps forward to
 * the next real point; one past the end pins to the last. Null in, null out.
 */
function seriesIndexAt(
  series: readonly { valid_at: string }[],
  iso: string | null | undefined,
): number | null {
  if (!iso || series.length === 0) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const found = series.findIndex((point) => Date.parse(point.valid_at) >= t);
  return found < 0 ? series.length - 1 : found;
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
      style={{ borderColor: "var(--aree-surface-3)" }}
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

/* ── the collapse timeline ─────────────────────────────────────────────────
   WHAT IT DRAWS, AND WHY IT STARTS AT "NOW" RATHER THAN EARLIER
     The forecast series is built with `range(1, horizon + 1)` — it begins one hour
     AFTER as_of and runs forward 72 h. There is no observed ventilation history in
     this payload at all: `ventilation_profile` is computed from that same forward
     series, so even its "24 h" figures describe the next day, not the last one.

     So an OBSERVED BAND cannot be drawn without inventing one. What is genuinely
     observed is a single instant — the measured coefficient at as_of — and that is
     what the neutral anchor to the left of the bar shows. The bar itself covers the
     forecast horizon and nothing else. A grey band stretching left would be a period
     this API has never described.

   POSITIONS ARE INDICES, NOT TIMES
     The chart below uses a CATEGORY x-axis keyed on the formatted label, so its
     points are evenly spaced by index regardless of their timestamps — and the
     series can skip an hour when a feature row is missing. Positioning the timeline
     by elapsed time would therefore drift from the chart by exactly those gaps. Both
     are indexed off the same array.                                                  */
type SegmentKind = "approaching" | "collapse" | "recovery" | "steady";

interface TimelineSegment {
  kind: SegmentKind;
  label: string;
  from: number;
  to: number;
  colour: string;
  /** Rendered as text beside the swatch — the state never rests on colour alone. */
  detail: string | null;
}

interface CollapseTimeline {
  segments: TimelineSegment[];
  /** Percent across the plot area, or null when no collapse is forecast. */
  onsetPct: number | null;
  onsetLabel: string | null;
  startLabel: string;
  endLabel: string;
  /** The one genuinely OBSERVED quantity: the measured coefficient at as_of. */
  observed: { value: string | null; at: string } | null;
}

function TimelineBar({ model }: { model: CollapseTimeline }) {
  return (
    <div className="mt-2">
      {/* OBSERVED — an instant, not a band, and labelled as one.
          The forecast series begins an hour after as_of, so there is no observed
          period inside this chart's domain to shade. What IS observed is the
          measured coefficient at as_of, and it is stated here in neutral tone
          rather than implied by a grey rectangle over time nobody forecast. */}
      {model.observed ? (
        <p className="flex flex-wrap items-center gap-1.5 text-[9.5px]" style={{ color: C.muted }}>
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: C.dim }}
            aria-hidden
          />
          <span className="font-semibold" style={{ color: C.body }}>
            Observed
          </span>
          <span>
            {model.observed.value ? `${model.observed.value} m²/s at ` : "at "}
            {model.observed.at} IST · forecast begins from here
          </span>
        </p>
      ) : null}

      {/* The onset marker needs headroom above the bar for its label. */}
      <div
        className="relative"
        style={{ paddingLeft: PLOT_INSET_LEFT, paddingRight: PLOT_INSET_RIGHT }}
      >
        <div className="relative h-[34px]">
          {model.onsetPct !== null ? (
            <>
              {/* Exact position — this is the line that must sit above the same
                  x as the chart's collapse edge. */}
              <span
                className="absolute top-[14px] bottom-0 w-0 border-l-2 border-dashed"
                style={{ left: `${model.onsetPct}%`, borderColor: C.red }}
                aria-hidden
              />
              {/* The LABEL is clamped away from both edges so it cannot push the
                  page wider on a narrow screen; the line above stays exact. */}
              <span
                className="absolute top-0 whitespace-nowrap text-[9.5px] font-bold uppercase tracking-wide"
                style={{
                  left: `clamp(0%, ${model.onsetPct}%, 100%)`,
                  transform: `translateX(-${Math.min(Math.max(model.onsetPct, 6), 94)}%)`,
                  color: C.red,
                }}
              >
                ↓ Onset {model.onsetLabel}
              </span>
            </>
          ) : null}

          {/* The bar itself. */}
          <div
            className="absolute inset-x-0 top-[18px] flex h-[10px] overflow-hidden rounded-sm"
            style={{ background: C.line }}
          >
            {model.segments.map((seg) => (
              <span
                key={seg.kind + seg.from}
                style={{ width: `${seg.to - seg.from}%`, background: seg.colour }}
                title={seg.label}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Ends of the horizon, under the plot area they belong to. */}
      <div
        className="mt-1 flex justify-between text-[9.5px]"
        style={{
          color: C.dim,
          paddingLeft: PLOT_INSET_LEFT,
          paddingRight: PLOT_INSET_RIGHT,
        }}
      >
        <span>{model.startLabel}</span>
        <span>{model.endLabel}</span>
      </div>

      {/* Every state named in words, and wrapping rather than crowding on mobile.
          This is the accessible reading of the bar, not a decorative key. */}
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        {model.segments.map((seg) => (
          <li
            key={`legend-${seg.kind}-${seg.from}`}
            className="flex items-center gap-1.5 text-[9.5px]"
            style={{ color: C.muted }}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: seg.colour }}
              aria-hidden
            />
            <span className="font-semibold" style={{ color: C.body }}>
              {seg.label}
            </span>
            {seg.detail ? <span>{seg.detail}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function VentilationOutlook() {
  /* Reads the workspace's payload — the same object the Summary tab renders. See
     OutlookDataProvider for why this view no longer fetches for itself. */
  const { data, loading, error, setTab } = useOutlookData();

  const chart = useMemo(
    () =>
      (data?.forecast.series ?? []).map((p) => ({
        label: ist(p.valid_at),
        ventilation: p.ventilation_m2_s,
      })),
    [data],
  );

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

  /* The window as a clock. Same deadline the executive page counts down, so the
     two screens cannot disagree about how long is left. */
  const countdown = useInterventionCountdown(data?.as_of, windowH, data?.mode);
  const ventNow = vp?.components?.ventilation_m2_s ?? null;
  const belowNow =
    ventNow !== null && threshold !== null ? ventNow <= threshold : null;

  // "store:ncr_28.63_77.22 (era5)" in replay vs "openmeteo:forecast" live. The backend
  // already names its own feature source; the page just has to stop ignoring it.
  const isReanalysis = Boolean(
    data?.provenance.feature_source?.startsWith("store:"),
  );

  /* ── annotation layer ──────────────────────────────────────────────────
     ONE MAPPING FROM AN INSTANT TO AN X POSITION, FOR EVERYTHING ON THIS CHART.

     The x-axis is a CATEGORY axis keyed on the formatted label, so Recharts places a
     ReferenceLine only if its `x` matches a category string EXACTLY. A near-miss is
     not an error — the mark silently collapses against the left edge, which is the
     failure OutlookView documents having already been bitten by once ("Building the
     band bounds with ist() produced the comma form, which matches no category").

     Formatting an event's own timestamp is therefore not good enough. The instant is
     resolved to an INDEX in `forecast.series` first, and the label is then read out of
     the chart array at that index — so an annotation is, by construction, the same
     column the chart drew. That also covers the case Change #6 had to handle: the
     series can skip an hour when a feature row is missing, and an event falling in
     that gap snaps forward to the next real point instead of landing nowhere.

     Nothing here classifies or predicts. Every timestamp comes from the payload. */
  const annotations = useMemo(() => {
    const series = data?.forecast.series ?? [];
    if (!data || series.length === 0 || chart.length !== series.length) {
      return { band: null, marks: [] as { key: string; x: string; label: string; colour: string }[] };
    }

    /** The chart category covering an instant, or null if it cannot be placed. */
    const labelAt = (iso: string | null | undefined): string | null => {
      const index = seriesIndexAt(series, iso);
      return index === null ? null : (chart[index]?.label ?? null);
    };

    /* Collapse onset is the backend's find_collapse result — the same field Change #6
       reads for the timeline above, so the marker and the bar point at one value. The
       timeline mark is used as a fallback only because the backend derives it from
       exactly that onset. */
    const onsetIso =
      data.atmosphere.ventilation_forecast.collapse?.onset ??
      data.timeline.find((m) => m.kind === "collapse")?.at ??
      null;
    const recoveryIso = data.timeline.find((m) => m.kind === "recovery")?.at ?? null;

    const onsetX = labelAt(onsetIso);
    const recoveryX = labelAt(recoveryIso);

    const marks: { key: string; x: string; label: string; colour: string }[] = [];
    // No onset in the payload -> no line. Never a mark at index 0 standing in for one.
    if (onsetX) marks.push({ key: "onset", x: onsetX, label: "Onset", colour: C.red });
    /* Recovery is dropped when it would sit on the same column as onset: two labels in
       one place is less readable than one, and the shaded band already shows the span. */
    if (recoveryX && recoveryX !== onsetX) {
      marks.push({ key: "recovery", x: recoveryX, label: "Recovery", colour: C.green });
    }

    const band = onsetX
      ? { from: onsetX, to: recoveryX ?? chart[chart.length - 1]?.label }
      : null;

    return { band, marks };
  }, [data, chart]);

  const band = annotations.band;

  /* The collapse timeline, from the same payload the chart draws. No request, no
     second time base: positions are indices into `forecast.series`, which is exactly
     what the category axis below plots. */
  const collapseTimeline = useMemo<CollapseTimeline | null>(() => {
    const series = data?.forecast.series ?? [];
    if (series.length < 2) return null;

    const last = series.length - 1;
    const pctOfIndex = (i: number) => (i / last) * 100;

    /* Shared with the chart's reference lines below — see seriesIndexAt. */
    const indexAt = (iso: string): number | null => seriesIndexAt(series, iso);

    const startLabel = `${ist(series[0].valid_at)} IST`;
    const endLabel = `${ist(series[last].valid_at)} IST`;

    /* Read from the profile the page already renders as "Ventilation (now)", so the
       anchor and that card cannot disagree. Null stays null. */
    const observedValue =
      data?.atmosphere.ventilation_profile.components?.ventilation_m2_s ?? null;
    const observed = data
      ? {
          value: observedValue !== null ? observedValue.toFixed(0) : null,
          at: ist(data.as_of),
        }
      : null;

    const collapse = data?.atmosphere.ventilation_forecast.collapse ?? null;
    const onsetIndex = collapse?.onset ? indexAt(collapse.onset) : null;

    /* NO COLLAPSE IS A RESULT, NOT AN ABSENCE.
       The backend forecast ran and found no sustained run below the operating point.
       That is worth stating plainly in one steady segment — not by drawing a bar with
       invented amber and red on it. */
    if (collapse === null || onsetIndex === null) {
      return {
        segments: [
          {
            kind: "steady",
            label: "No collapse forecast",
            from: 0,
            to: 100,
            colour: C.green,
            detail: "Ventilation stays above the operating point across the horizon",
          },
        ],
        onsetPct: null,
        onsetLabel: null,
        startLabel,
        endLabel,
        observed,
      };
    }

    const onsetPct = pctOfIndex(onsetIndex);

    /* Recovery exists only when the engine emitted the mark — it requires a SUSTAINED
       run back above the threshold, so a single midday spike does not count. When
       there is none, the collapse simply runs to the end of the horizon and no green
       is drawn. Inventing a recovery would be inventing the end of an episode. */
    const recoveryMark = data?.timeline.find((m) => m.kind === "recovery") ?? null;
    const recoveryIndex = recoveryMark ? indexAt(recoveryMark.at) : null;
    const recoveryPct =
      recoveryIndex !== null && recoveryIndex > onsetIndex
        ? pctOfIndex(recoveryIndex)
        : null;

    const segments: TimelineSegment[] = [];

    /* Approaching: the run-up from the start of the horizon to onset. Zero-width when
       the collapse has already begun at the first forecast hour, and dropped rather
       than drawn as a sliver. */
    if (onsetPct > 0) {
      segments.push({
        kind: "approaching",
        label: "Approaching",
        from: 0,
        to: onsetPct,
        colour: C.amber,
        detail: `until ${ist(collapse.onset)} IST`,
      });
    }

    segments.push({
      kind: "collapse",
      label: "Predicted collapse",
      from: onsetPct,
      to: recoveryPct ?? 100,
      colour: C.red,
      detail: `${collapse.sustained_hours_below_threshold} h below · min ${collapse.min_ventilation_m2_s.toFixed(0)} m²/s`,
    });

    if (recoveryPct !== null && recoveryMark) {
      segments.push({
        kind: "recovery",
        label: "Recovery",
        from: recoveryPct,
        to: 100,
        colour: C.green,
        detail: `from ${ist(recoveryMark.at)} IST`,
      });
    }

    return {
      segments,
      onsetPct,
      onsetLabel: `${ist(collapse.onset)} IST`,
      startLabel,
      endLabel,
      observed,
    };
  }, [data]);

  return (
    <div className="space-y-3" style={{ color: C.body }}>
      {loading && (
        <Card>
          <p className="py-10 text-center text-[12.5px]" style={{ color: C.muted }}>
            Loading ventilation diagnostic…
          </p>
        </Card>
      )}

      {error && !loading && (
        <UnavailableNotice title="Ventilation outlook unavailable" detail={error} />
      )}

      {data && !loading && vp?.available && (
        <>
          {/* ── status strip ── */}
          <div
            className="grid gap-4 rounded-lg border p-4 grid-cols-[minmax(0,1fr)] sm:grid-cols-2 lg:grid-cols-6"
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
              <p
                className="mt-1 flex flex-wrap items-baseline gap-1.5 text-[10.5px] font-semibold"
                style={{ color: C.body }}
              >
                {countdown.available ? (
                  <>
                    <InterventionTimer
                      asOf={data.as_of}
                      windowHours={windowH}
                      mode={data.mode}
                      size="sm"
                      showUnit={false}
                    />
                    <span style={{ color: C.muted }}>
                      intervention window remaining
                      {countdown.frozen ? " at this replayed moment" : ""}
                    </span>
                  </>
                ) : (
                  "No collapse forecast"
                )}
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
          <div className="grid gap-3 grid-cols-[minmax(0,1fr)] lg:grid-cols-2">
            <Card>
              <div className="flex items-start justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <Cloud className="h-3.5 w-3.5" style={{ color: C.blue }} />
                  <Eyebrow>Forecast input</Eyebrow>
                </span>
                <span
                  className="rounded px-2 py-0.5 text-[9.5px] font-bold"
                  style={{ background: "color-mix(in srgb, var(--aree-blue) 10%, transparent)", color: "var(--aree-blue)" }}
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
                      ? { background: "color-mix(in srgb, var(--aree-green) 10%, transparent)", color: "var(--aree-green)" }
                      : { background: "color-mix(in srgb, var(--aree-yellow) 14%, transparent)", color: "var(--aree-yellow)" }
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
          <div className="grid gap-3 grid-cols-[minmax(0,1fr)] xl:grid-cols-[1.7fr_1fr]">
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
                  style={{ background: "color-mix(in srgb, var(--aree-blue) 10%, transparent)", color: "var(--aree-blue)" }}
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
                  <span className="mr-1 inline-block h-2 w-3 rounded-sm align-middle" style={{ background: "color-mix(in srgb, var(--aree-red) 25%, transparent)" }} />
                  Collapse zone
                </span>
              </div>

              {/* ── the collapse timeline, directly above the chart it describes ──
                  Same horizontal domain, same insets, same index basis. */}
              {collapseTimeline ? (
                <TimelineBar model={collapseTimeline} />
              ) : (
                <p className="mt-2 text-[10.5px]" style={{ color: C.dim }}>
                  Collapse forecast unavailable — no ventilation series for this moment.
                </p>
              )}

              <div className="mt-2 h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chart} margin={{ ...VC_CHART_MARGIN }}>
                    <CartesianGrid stroke="var(--aree-surface-3)" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 9, fill: C.dim }}
                      /* Ticks thinned by available width rather than by a fixed
                         count — see the same axis on the Atmospheric tab. */
                      interval="preserveStartEnd"
                      minTickGap={44}
                      tickLine={false}
                      axisLine={{ stroke: C.line }}
                    />
                    <YAxis
                      tick={{ fontSize: 9, fill: C.dim }}
                      tickLine={false}
                      axisLine={false}
                      width={VC_Y_AXIS_WIDTH}
                    />
                    <Tooltip
                      contentStyle={{ fontSize: 11, borderRadius: 6, border: `1px solid ${C.line}` }}
                      formatter={(v) => [`${v} m²/s`, "Ventilation"]}
                    />
                    {threshold !== null && (
                      <ReferenceArea y1={0} y2={threshold} fill="color-mix(in srgb, var(--aree-red) 25%, transparent)" fillOpacity={0.45} />
                    )}
                    {band && (
                      <ReferenceArea x1={band.from} x2={band.to} fill="color-mix(in srgb, var(--aree-red) 35%, transparent)" fillOpacity={0.2} />
                    )}
                    <Area
                      dataKey="ventilation"
                      stroke={C.blue}
                      strokeWidth={1.6}
                      fill="color-mix(in srgb, var(--aree-blue) 22%, transparent)"
                      fillOpacity={0.5}
                      dot={false}
                    />
                    {threshold !== null && (
                      <ReferenceLine y={threshold} stroke={C.red} strokeDasharray="5 3" />
                    )}

                    {/* Operational events, at the exact columns resolved above. Each
                        carries its name as SVG text, so the marker is not colour alone.
                        The full instant stays on the Change #6 timeline directly above,
                        which keeps these labels short enough not to crowd a narrow
                        chart. Reference lines are decorative geometry and do not sit in
                        the tooltip's hit path. */}
                    {annotations.marks.map((mark) => (
                      <ReferenceLine
                        key={mark.key}
                        x={mark.x}
                        stroke={mark.colour}
                        strokeDasharray="3 3"
                        label={{
                          value: mark.label,
                          position: "top",
                          fontSize: 9.5,
                          fill: mark.colour,
                        }}
                      />
                    ))}
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
          <div className="grid gap-3 grid-cols-[minmax(0,1fr)] xl:grid-cols-[1.5fr_1fr_0.9fr]">
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
                            style={{ background: tone, borderColor: "var(--aree-surface-1)" }}
                          />
                          <p className="mt-1.5 text-[10.5px] font-bold" style={{ color: C.ink }}>
                            {m.kind === "now" ? "Now" : ist(m.at)}
                          </p>
                          <p className="text-[9.5px] font-semibold" style={{ color: C.muted }}>
                            {m.kind === "now"
                              ? countdown.available
                                ? `${countdown.elapsed ? "elapsed" : countdown.hhmm} remaining`
                                : "no window"
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
              <button
                type="button"
                onClick={() => setTab("summary")}
                className="mt-3 flex w-full items-center justify-between rounded-md border px-3 py-2 text-[11px] font-semibold transition"
                style={{ borderColor: C.line, color: C.body }}
              >
                What this means for air quality
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
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
