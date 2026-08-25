"use client";

/**
 * Ventilation outlook — the PS 26082 view.
 *
 * WHAT THIS SHOWS AND WHY IT IS THE RIGHT THING TO SHOW
 *   Five winters of Delhi NCR data established that whether a pollution
 *   episode locks in cannot be diagnosed from the state at its onset
 *   (AUC 0.514) but is determined by the ventilation over the following 48
 *   hours (AUC 0.736). So the operationally useful display is not another AQI
 *   line — it is how much longer the atmosphere can still clear itself, and
 *   therefore how much time is left to act.
 *
 *   The headline is a countdown, not a severity gauge. Everything else on the
 *   page exists to justify that number.
 */

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  Gauge,
  Wind,
  Timer,
  FlaskConical,
  Radio,
  Satellite,
  ListFilter,
  MapPin,
} from "lucide-react";

import { api } from "@/lib/api";
import { usePolling } from "@/hooks/usePolling";
import { Panel, Pill, KeyValue, Note } from "@/components/ui/Card";
import { ErrorState, LoadingState } from "@/components/ui/States";
import type {
  ObservedComposite,
  VentilationAssessment,
  VentilationForecast,
  VentilationState,
} from "@/types";

/** Lead-time states carry colour; they are not severity bands. */
const STATE_STYLE: Record<VentilationState, { color: string; label: string }> = {
  clear: { color: "var(--aree-green)", label: "Clear" },
  watch: { color: "var(--aree-cyan)", label: "Watch" },
  approaching: { color: "var(--aree-amber)", label: "Approaching" },
  imminent: { color: "var(--aree-orange)", label: "Imminent" },
  collapsed: { color: "var(--aree-red)", label: "Collapsed" },
  unknown: { color: "var(--aree-muted)", label: "Unknown" },
};

const PRIORITY_COLOR: Record<string, string> = {
  LOW: "var(--aree-green)",
  MEDIUM: "var(--aree-amber)",
  HIGH: "var(--aree-orange)",
  CRITICAL: "var(--aree-red)",
};

/**
 * Render a UTC instant in IST.
 *
 * Every operational decision here is taken in India, and the page previously
 * showed UTC only. "Collapse onset 09:00" is 14:30 local - a five and a half
 * hour error in the one number the page exists to communicate. UTC is kept
 * alongside because the model runs on it.
 */
function istLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * What this forecast covers, and where.
 *
 * The page previously opened straight into a countdown with no statement of
 * scope, next to a panel citing 78 ground stations. A reader could only
 * conclude the countdown was per-station, or belonged to whichever station
 * the rest of the app had selected. Neither is true: ventilation is computed
 * once, at a single point, for the whole airshed.
 *
 * Saying so is not a caveat, it is the definition of the number above it.
 */
function ScopeBanner({ forecast }: { forecast: VentilationForecast }) {
  const { lat, lon } = forecast.location;
  return (
    <div
      className="border-aree-border bg-aree-card flex flex-wrap items-start justify-between gap-4 rounded-xl border p-4"
      style={{ borderLeft: "3px solid var(--aree-forest)" }}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <MapPin className="text-aree-forest h-4 w-4 shrink-0" aria-hidden />
          <span className="text-aree-text text-[15px] font-bold">
            Delhi NCR airshed
          </span>
          <Pill color="var(--aree-dim)">
            {lat.toFixed(2)}&deg;N, {lon.toFixed(2)}&deg;E
          </Pill>
        </div>
        <p className="text-aree-muted mt-2 max-w-2xl text-[12px] leading-relaxed">
          <strong className="text-aree-body">
            One outlook for the whole region — not per station.
          </strong>{" "}
          Ventilation is boundary-layer depth &times; wind speed, which varies
          over roughly 100 km. Computing it per monitor would imply a spatial
          detail the weather model does not have.
        </p>
      </div>

      <div className="text-right">
        <p className="aree-eyebrow text-aree-dim">Forecast issued</p>
        <p className="text-aree-body aree-num mt-1 text-[13px] font-bold">
          {istLabel(forecast.generated_at)} IST
        </p>
        <p className="text-aree-dim mt-0.5 text-[11px]">
          covers the next {forecast.horizon_hours} h
        </p>
      </div>
    </div>
  );
}

function hourLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${String(
    d.getUTCHours(),
  ).padStart(2, "0")}h`;
}

/**
 * Where the two halves of a decision come from.
 *
 * This panel exists because the global status strip reports the Pathway
 * engine, which this view does not use. Seeing "0 / 0 stations reporting"
 * above a confident countdown reads as fabricated, when in fact the forecast
 * needs no stations and the observation side has hundreds. Stating both
 * sources explicitly is the fix.
 */
function DataSources({
  forecast,
  observed,
}: {
  forecast: VentilationForecast;
  observed: ObservedComposite | null;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="border-aree-border bg-aree-card rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Satellite className="text-aree-cyan h-3.5 w-3.5" aria-hidden />
          <p className="aree-eyebrow text-aree-dim">Forecast input</p>
        </div>
        <p className="text-aree-body mt-2 text-[13px] font-semibold">
          Numerical weather model
        </p>
        <p className="text-aree-muted mt-1 text-[11.5px] leading-relaxed">
          Boundary layer height × wind speed, {forecast.horizon_hours} h ahead.
          Uses <strong>no ground stations</strong> — this is why the outlook
          works while the streaming engine is offline.
        </p>
      </div>

      <div className="border-aree-border bg-aree-card rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Radio className="text-aree-teal h-3.5 w-3.5" aria-hidden />
          <p className="aree-eyebrow text-aree-dim">Observation input</p>
        </div>
        {observed?.available ? (
          <>
            <p className="text-aree-body mt-2 text-[13px] font-semibold tabular-nums">
              {observed.pm25_ugm3} µg/m³{" "}
              <span className="text-aree-dim font-normal">
                across {observed.n_stations} stations
              </span>
            </p>
            <p className="text-aree-muted mt-1 text-[11.5px] leading-relaxed">
              Median concentration across the CPCB network, via data.gov.in,
              {" "}
              {observed.data_age_minutes} min old.
            </p>
            <p className="text-aree-dim mt-1.5 text-[11px] leading-relaxed">
              A different feed from the station list in the sidebar. That one is
              CAQM, which publishes hourly; this one is the only source that
              carries PM2.5 in µg/m³, which the episode threshold is calibrated
              in — so it is used here despite lagging further behind.
            </p>
          </>
        ) : (
          <p className="text-aree-muted mt-2 text-[11.5px] leading-relaxed">
            {observed?.reason ?? "Ground network unavailable."}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Every monitor behind the composite.
 *
 * A median with no visible constituents is not evidence. An operator seeing
 * one high station can tell it apart from an airshed-wide episode, and a
 * regulator reviewing an escalation needs the station names that appear in
 * GRAP orders. The reading age is shown per station because CPCB publishes
 * hourly and a two-hour-old value is normal, not a fault.
 */
function StationTable({ observed }: { observed: ObservedComposite | null }) {
  const [expanded, setExpanded] = useState(false);

  if (!observed?.available || !observed.stations?.length) {
    return (
      <Panel
        title="Reporting stations"
        icon={<ListFilter className="h-3.5 w-3.5" />}
        accent="var(--aree-teal)"
      >
        <p className="text-aree-dim text-[12px]">
          {observed?.reason ?? "No station readings available."}
        </p>
      </Panel>
    );
  }

  const all = observed.stations;
  const rows = expanded ? all : all.slice(0, 12);
  const median = observed.pm25_ugm3 ?? 0;

  return (
    <Panel
      title={`Reporting stations — ${observed.n_stations} fresh of ${observed.n_active_locations} active`}
      icon={<ListFilter className="h-3.5 w-3.5" />}
      accent="var(--aree-teal)"
      right={
        <Pill color="var(--aree-dim)">
          median {median} µg/m³ · {observed.min}–{observed.max}
        </Pill>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse">
          <thead>
            <tr className="border-aree-border border-b">
              <th className="aree-eyebrow text-aree-dim py-2 text-left">
                Station
              </th>
              <th className="aree-eyebrow text-aree-dim py-2 text-right">
                PM2.5
              </th>
              <th className="aree-eyebrow text-aree-dim w-[35%] py-2 pl-4 text-left">
                vs median
              </th>
              <th className="aree-eyebrow text-aree-dim py-2 text-right">Age</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((st) => {
              // Bar is scaled to the network maximum, so the visual ranking is
              // the actual ranking rather than a clipped one.
              const pct = observed.max
                ? Math.max(2, (st.pm25_ugm3 / observed.max) * 100)
                : 0;
              const above = st.pm25_ugm3 > median;
              return (
                <tr
                  key={st.location_id}
                  className="border-aree-border/50 border-b last:border-0"
                >
                  <td className="text-aree-body py-1.5 pr-3 text-[12px]">
                    {st.station}
                  </td>
                  <td className="text-aree-body py-1.5 text-right text-[12px] font-semibold tabular-nums">
                    {st.pm25_ugm3.toFixed(1)}
                  </td>
                  <td className="py-1.5 pl-4">
                    <div className="bg-aree-bg-soft h-1.5 w-full overflow-hidden rounded-full">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${pct}%`,
                          background: above
                            ? "var(--aree-orange)"
                            : "var(--aree-teal)",
                        }}
                      />
                    </div>
                  </td>
                  <td className="text-aree-dim py-1.5 text-right text-[11px] tabular-nums">
                    {st.age_minutes}m
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {all.length > 12 ? (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-aree-muted hover:text-aree-body mt-3 text-[11.5px] font-semibold"
        >
          {expanded
            ? "Show fewer"
            : `Show all ${all.length} stations`}
        </button>
      ) : null}

      <Note>
        {observed.n_stale_discarded} readings older than the freshness window
        were discarded before the median was taken.
        {observed.degraded
          ? ` Serving cached values: ${observed.degraded_reason}.`
          : ""}
      </Note>
    </Panel>
  );
}

/**
 * The countdown. Rendered as the largest thing on the page because it is the
 * only number an operator has to act on.
 */
function WindowHero({ forecast }: { forecast: VentilationForecast }) {
  const style = STATE_STYLE[forecast.state] ?? STATE_STYLE.unknown;
  const hours = forecast.intervention_window_hours;

  return (
    <div
      className="border-aree-border bg-aree-card-raised rounded-xl border p-6"
      style={{ borderLeft: `3px solid ${style.color}` }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="aree-eyebrow text-aree-dim">Intervention window</p>
          {hours == null ? (
            <>
              <p
                className="mt-1 text-[42px] leading-none font-bold"
                style={{ color: style.color }}
              >
                Open
              </p>
              <p className="text-aree-muted mt-2 max-w-xl text-[12.5px]">
                No sustained ventilation collapse in the next{" "}
                {forecast.horizon_hours} hours. The atmosphere is expected to
                keep clearing.
              </p>
            </>
          ) : (
            <>
              <p
                className="mt-1 text-[42px] leading-none font-bold tabular-nums"
                style={{ color: style.color }}
              >
                {hours.toFixed(1)}
                <span className="ml-2 text-[18px] font-semibold">hours</span>
              </p>
              <p className="text-aree-muted mt-2 max-w-xl text-[12.5px]">
                Time remaining before ventilation is forecast to collapse. After
                that point interventions act on air that is no longer clearing
                itself, so measures taken later do less.
              </p>
            </>
          )}
        </div>
        <Pill color={style.color} filled>
          {style.label}
        </Pill>
      </div>

      {forecast.collapse ? (
        <div className="border-aree-border mt-5 grid gap-3 border-t pt-4 sm:grid-cols-3">
          <KeyValue
            label="Collapse onset"
            value={
              <>
                {istLabel(forecast.collapse.onset)} IST
                <span className="text-aree-dim ml-2 text-[11px] font-normal">
                  ({forecast.collapse.onset.replace("T", " ").slice(11, 16)} UTC)
                </span>
              </>
            }
          />
          <KeyValue
            label="Sustained hours below"
            value={`${forecast.collapse.sustained_hours_below_threshold} h`}
          />
          <KeyValue
            label="Minimum ventilation"
            value={`${forecast.collapse.min_ventilation_m2_s} m²/s`}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The 72-hour outlook with the decision threshold drawn on it. */
function VentilationChart({ forecast }: { forecast: VentilationForecast }) {
  const threshold = forecast.operating_point.threshold_m2_s;

  const data = useMemo(
    () =>
      forecast.series.map((p) => ({
        t: hourLabel(p.time),
        iso: p.time,
        ventilation: p.ventilation_m2_s,
        blh: p.blh_m,
        wind: p.wind_ms,
      })),
    [forecast.series],
  );

  // Shade the forecast collapse so the eye lands on it without reading axes.
  const collapseFrom = forecast.collapse
    ? hourLabel(forecast.collapse.onset)
    : null;
  const collapseTo = data.length ? data[data.length - 1].t : null;

  return (
    <div className="h-[320px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <defs>
            <linearGradient id="ventFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--aree-cyan)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--aree-cyan)" stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid
            strokeDasharray="2 4"
            stroke="var(--aree-border)"
            vertical={false}
          />
          <XAxis
            dataKey="t"
            tick={{ fill: "var(--aree-dim)", fontSize: 10 }}
            stroke="var(--aree-border)"
            interval={Math.max(0, Math.floor(data.length / 8) - 1)}
          />
          <YAxis
            tick={{ fill: "var(--aree-dim)", fontSize: 10 }}
            stroke="var(--aree-border)"
            width={54}
            label={{
              value: "m²/s",
              angle: -90,
              position: "insideLeft",
              fill: "var(--aree-dim)",
              fontSize: 10,
            }}
          />

          {collapseFrom && collapseTo ? (
            <ReferenceArea
              x1={collapseFrom}
              x2={collapseTo}
              fill="var(--aree-red)"
              fillOpacity={0.07}
            />
          ) : null}

          <ReferenceLine
            y={threshold}
            stroke="var(--aree-red)"
            strokeDasharray="5 4"
            label={{
              value: `threshold ${threshold} m²/s`,
              position: "insideTopRight",
              fill: "var(--aree-red)",
              fontSize: 10,
            }}
          />

          <Tooltip
            contentStyle={{
              background: "var(--aree-card-raised)",
              border: "1px solid var(--aree-border-strong)",
              borderRadius: 8,
              fontSize: 11.5,
            }}
            labelStyle={{ color: "var(--aree-muted)" }}
            formatter={(value, name) => {
              // Recharts types the value as ValueType | undefined, so narrow
              // rather than assert - an undefined slipping through would
              // render "NaN m²/s" on the one panel an operator acts on.
              const n = typeof value === "number" ? value : Number(value);
              if (name === "ventilation")
                return [
                  Number.isFinite(n) ? `${n.toFixed(0)} m²/s` : "—",
                  "Ventilation",
                ];
              return [String(value ?? "—"), String(name ?? "")];
            }}
          />

          <Area
            type="monotone"
            dataKey="ventilation"
            stroke="var(--aree-cyan)"
            strokeWidth={1.8}
            fill="url(#ventFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * The decision basis. Shown, not hidden, because a regulatory system should be
 * able to answer "on what grounds" without anyone reading source code.
 */
function OperatingPointPanel({ forecast }: { forecast: VentilationForecast }) {
  const op = forecast.operating_point;
  return (
    <Panel
      title="Decision basis"
      icon={<Gauge className="h-3.5 w-3.5" />}
      accent="var(--aree-blue)"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <KeyValue label="Operating point" value={op.mode} />
        <KeyValue label="Threshold" value={`${op.threshold_m2_s} m²/s`} />
        <KeyValue
          label="Hit rate"
          value={op.hit_rate != null ? op.hit_rate.toFixed(2) : "—"}
        />
        <KeyValue
          label="False-alarm rate"
          value={
            op.false_alarm_rate != null ? op.false_alarm_rate.toFixed(2) : "—"
          }
        />
        <KeyValue
          label="AUC (training)"
          value={op.auc_training != null ? op.auc_training.toFixed(3) : "—"}
        />
        <KeyValue
          label="Training episodes"
          value={op.n_train_episodes ?? "—"}
        />
      </div>
      {op.caveat ? <Note>{op.caveat}</Note> : null}
    </Panel>
  );
}

/**
 * Assessment probe.
 *
 * Lets a reviewer vary the observed PM2.5 and watch the decision boundary
 * move. Included deliberately: the trigger is a conjunction, and the most
 * convincing demonstration of that is showing it NOT firing.
 */
function AssessmentProbe() {
  const [useLive, setUseLive] = useState(true);
  const [pm25, setPm25] = useState(168);
  const [result, setResult] = useState<VentilationAssessment | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Passing null asks the backend for the live network composite. The
      // response records which path was taken, so a manually supplied value
      // can never be displayed as though it were measured.
      setResult(
        await api.ventilationAssessment(useLive ? null : pm25, {
          station: "Delhi NCR",
        }),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Escalation assessment"
      icon={<FlaskConical className="h-3.5 w-3.5" />}
      accent="var(--aree-amber)"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex cursor-pointer items-center gap-2 pb-1.5">
          <input
            type="checkbox"
            checked={useLive}
            onChange={(e) => setUseLive(e.target.checked)}
            className="accent-[var(--aree-teal)]"
          />
          <span className="text-aree-body text-[12px]">
            Use live network
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="aree-eyebrow text-aree-dim">
            {useLive ? "Overridden by live feed" : "Observed PM2.5"}
          </span>
          <input
            type="number"
            value={pm25}
            min={0}
            max={1000}
            disabled={useLive}
            onChange={(e) => setPm25(Number(e.target.value))}
            className="border-aree-border bg-aree-bg-soft text-aree-body w-32 rounded-md border px-2 py-1.5 text-[13px] tabular-nums disabled:opacity-40"
          />
        </label>
        <button
          onClick={run}
          disabled={busy}
          className="border-aree-border bg-aree-card-raised text-aree-body hover:border-aree-border-strong rounded-md border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
        >
          {busy ? "Assessing…" : "Assess"}
        </button>
        <span className="text-aree-dim pb-1.5 text-[11px]">
          {useLive
            ? "reads the CPCB/DPCC composite"
            : "µg/m³ — try 168, then 40"}
        </span>
      </div>

      {err ? <Note>{err}</Note> : null}

      {result ? (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Pill
              color={
                result.triggered ? PRIORITY_COLOR[result.priority] : "var(--aree-green)"
              }
              filled
            >
              {result.triggered ? `${result.priority} — case opened` : "No case"}
            </Pill>
            <Pill color="var(--aree-muted)">{result.grap_stage_observed}</Pill>
            {result.observation_provenance ? (
              <Pill
                color={
                  result.observation_provenance.input_source === "live"
                    ? "var(--aree-teal)"
                    : "var(--aree-amber)"
                }
                title={result.observation_provenance.source}
              >
                {result.observation_provenance.input_source === "live"
                  ? `live · ${result.observation_provenance.n_stations} stations · ${result.observation_provenance.data_age_minutes} min old`
                  : "manual input — not measured"}
              </Pill>
            ) : null}
          </div>

          <ul className="mt-3 space-y-1.5">
            {result.reasons.map((r) => (
              <li
                key={r}
                className="text-aree-muted flex gap-2 text-[12px] leading-relaxed"
              >
                <span className="text-aree-dim">—</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>

          {result.case ? (
            <div className="border-aree-border mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2">
              <KeyValue
                label="Responsible authority"
                value={result.case.responsible_authority}
              />
              <KeyValue label="Status" value={result.case.status} />
              <KeyValue
                label="Deadline (UTC)"
                value={
                  result.case.deadline
                    ? result.case.deadline.replace("T", " ").slice(0, 16)
                    : "—"
                }
              />
              <KeyValue label="Basis" value={result.case.basis} />
              <div className="sm:col-span-2">
                <p className="aree-eyebrow text-aree-dim mb-1.5">
                  Recommended measures
                </p>
                <ul className="space-y-1">
                  {result.case.recommended_measures.map((m) => (
                    <li key={m} className="text-aree-muted text-[12px]">
                      • {m}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          <Note>{result.confidence_note}</Note>
        </div>
      ) : null}
    </Panel>
  );
}

export default function VentilationOutlook() {
  // 5 minutes: the underlying meteorological model does not update faster, so
  // polling harder would only add load without adding information.
  const forecast = usePolling<VentilationForecast>(
    (signal) => api.ventilationForecast(undefined, signal),
    { intervalMs: 300_000 },
  );
  const current = usePolling((signal) => api.ventilationCurrent(signal), {
    intervalMs: 300_000,
  });
  // Ground network polls faster than the forecast: CPCB publishes hourly, and
  // station dropouts are the thing an operator most needs to see promptly.
  const observed = usePolling<ObservedComposite>(
    (signal) => api.ventilationStations(signal),
    { intervalMs: 120_000 },
  );

  if (forecast.initialLoading) return <LoadingState label="Loading ventilation outlook…" />;
  if (forecast.error)
    return <ErrorState error={forecast.error} onRetry={forecast.refresh} />;
  if (!forecast.data) return <LoadingState />;

  const f = forecast.data;
  const c = current.data;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="aree-page-title">Ventilation outlook</h1>
        <p className="text-aree-dim mt-1 max-w-3xl text-[12px]">
          Whether a pollution episode locks in cannot be told from today&apos;s
          air — it is decided by how well the atmosphere clears itself over the
          next 48 hours. This forecasts that, and turns it into the time left
          to act.
        </p>
      </div>

      <ScopeBanner forecast={f} />

      <DataSources forecast={f} observed={observed.data} />

      <WindowHero forecast={f} />

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Panel
          title={`Ventilation coefficient — next ${f.horizon_hours} h`}
          icon={<Wind className="h-3.5 w-3.5" />}
          accent="var(--aree-cyan)"
          right={
            <Pill color="var(--aree-dim)">
              {f.summary.hours_below_threshold} h below threshold
            </Pill>
          }
        >
          <VentilationChart forecast={f} />
          <div className="border-aree-border mt-4 grid gap-3 border-t pt-4 sm:grid-cols-3">
            <KeyValue
              label="Minimum"
              value={`${f.summary.min_ventilation_m2_s} m²/s`}
            />
            <KeyValue
              label="Mean"
              value={`${f.summary.mean_ventilation_m2_s} m²/s`}
            />
            <KeyValue
              label="Maximum"
              value={`${f.summary.max_ventilation_m2_s} m²/s`}
            />
          </div>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel
            title="Observed now"
            icon={<Timer className="h-3.5 w-3.5" />}
            accent="var(--aree-teal)"
          >
            {c?.available ? (
              <div className="grid gap-3">
                <KeyValue
                  label="Ventilation"
                  value={`${c.latest.ventilation_m2_s} m²/s`}
                />
                <KeyValue label="Boundary layer" value={`${c.latest.blh_m} m`} />
                <KeyValue label="Wind" value={`${c.latest.wind_ms} m/s`} />
                <KeyValue
                  label="Data age"
                  value={`${c.latest.data_age_minutes} min`}
                />
                <KeyValue
                  label="Hours below threshold (24 h)"
                  value={c.hours_below_threshold_24h}
                />
              </div>
            ) : (
              <p className="text-aree-dim text-[12px]">
                No recent meteorological analysis.
              </p>
            )}
          </Panel>

          <OperatingPointPanel forecast={f} />
        </div>
      </div>

      <StationTable observed={observed.data} />

      <AssessmentProbe />

      <div className="text-aree-dim flex items-start gap-2 text-[11px] leading-relaxed">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <p>
          Advisory only. Legal authority for GRAP invocation rests with CAQM and
          the state pollution control boards; this view recommends and records,
          it does not issue orders.
        </p>
      </div>
    </div>
  );
}
