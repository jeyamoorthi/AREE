"use client";

/**
 * Feed-condition surfaces for one station: the stale/aging banners, the
 * ingestion error banner, the pollutant grid and the raw transparency block.
 *
 * Every value is served by the backend. The frontend only formats a duration
 * for reading; it never recomputes an age, shifts a timezone, or softens a
 * freshness classification.
 */

import { AlertTriangle } from "lucide-react";

import { formatDuration, formatUtcIso } from "@/lib/duration";
import { freshness } from "@/lib/freshness";
import { KeyValue, Panel, Stat } from "@/components/ui/Card";
import { aqiColor, orDash } from "@/lib/theme";
import type { EngineConfig, StationDetail } from "@/types";

// WAQI publishes per-pollutant AQI sub-indices in `iaqi`, not concentrations,
// so no mass unit is shown — labelling these µg/m³ would misstate the source.
const POLLUTANTS: { name: string; key: keyof StationDetail; waqiKey: string }[] = [
  { name: "PM2.5", key: "raw_pm25", waqiKey: "pm25" },
  { name: "PM10", key: "raw_pm10", waqiKey: "pm10" },
  { name: "NO₂", key: "raw_no2", waqiKey: "no2" },
  { name: "SO₂", key: "raw_so2", waqiKey: "so2" },
  { name: "O₃", key: "raw_o3", waqiKey: "o3" },
  { name: "CO", key: "raw_co", waqiKey: "co" },
];

/**
 * The stale banner is a core AREE feature: when the upstream feed is frozen,
 * the age of the reading is the most important number on the screen and is
 * rendered as such. It is never hidden, softened or auto-dismissed.
 */
export function StaleDataBanner({ data }: { data: StationDetail; config?: EngineConfig | null }) {
  const status = data.freshness_status;

  // Aging is informational: the feed is older than expected but still plausible
  // for an hourly upstream source. It must not read as an alarm.
  if (status === "aging") {
    const look = freshness("aging");
    const age = formatDuration(data.stale_seconds);
    return (
      <div
        className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-3"
        style={{
          borderColor: "color-mix(in srgb, #eab308 45%, transparent)",
          background: "color-mix(in srgb, #eab308 6%, transparent)",
        }}
        role="status"
      >
        <span className="text-[13px] font-bold" style={{ color: look.color }}>
          {look.marker} {look.badge}
        </span>
        <span className="aree-num text-aree-body text-xs">WAQI reading {age} ago</span>
        <span className="text-aree-dim text-xs">
          Older than expected, still within the window for an hourly feed.
        </span>
      </div>
    );
  }

  if (status !== "stale") return null;

  const age = formatDuration(data.stale_seconds);
  const localReading = data.waqi_timestamp_local ?? data.waqi_timestamp ?? null;
  const utcReading = data.waqi_timestamp_utc ?? null;
  const lastSync = formatUtcIso(data.feed_last_sync);

  return (
    <div
      className="mb-5 overflow-hidden rounded-xl border-2"
      style={{
        borderColor: "#f97316",
        background:
          "linear-gradient(180deg, color-mix(in srgb, #f97316 11%, transparent), color-mix(in srgb, #f97316 4%, transparent))",
      }}
      role="alert"
    >
      <div className="flex items-center gap-2 border-b border-[color-mix(in_srgb,#f97316_35%,transparent)] px-5 py-2.5">
        <AlertTriangle className="text-aree-orange h-4 w-4 shrink-0" aria-hidden />
        <span className="text-aree-orange text-[13px] font-bold tracking-[0.12em] uppercase">
          Upstream data stale
        </span>
      </div>

      <div className="px-5 py-6 text-center">
        <div className="aree-hero-num text-aree-orange text-[clamp(2rem,1.2rem+3.5vw,3.25rem)]">
          {age ?? "—"}
        </div>
        <div className="text-aree-orange/80 mt-1.5 text-[11px] font-bold tracking-[0.28em] uppercase">
          Behind
        </div>
      </div>

      <div className="grid gap-px bg-[color-mix(in_srgb,#f97316_25%,transparent)] sm:grid-cols-3">
        <div className="bg-aree-bg/40 px-5 py-3">
          <div className="aree-eyebrow text-[9.5px]">Last reading</div>
          <div className="aree-num text-aree-body mt-1 text-[12px] font-semibold">
            {localReading ?? "Not available"}
          </div>
          {utcReading ? (
            <div className="aree-num text-aree-dim text-[11px]">{utcReading}</div>
          ) : null}
        </div>
        <div className="bg-aree-bg/40 px-5 py-3">
          <div className="aree-eyebrow text-[9.5px]">WAQI sync</div>
          <div className="aree-num text-aree-body mt-1 text-[12px] font-semibold">
            {lastSync ?? "Not reported"}
          </div>
        </div>
        <div className="bg-aree-bg/40 px-5 py-3">
          <div className="aree-eyebrow text-[9.5px]">Last published AQI</div>
          <div
            className="aree-num mt-1 text-[12px] font-bold"
            style={{ color: aqiColor(data.aqi) }}
          >
            {data.aqi ?? "Not available"}
          </div>
        </div>
      </div>

      <p className="text-aree-body border-t border-[color-mix(in_srgb,#f97316_30%,transparent)] px-5 py-3 text-[12px] leading-relaxed">
        <span className="text-aree-orange font-bold">⚠</span> Regulatory decisions use the
        last published value and should not be treated as current conditions.
      </p>
    </div>
  );
}

export function IngestionErrorBanner({ data }: { data: StationDetail }) {
  if (data.ingestion_status !== "error" || !data.ingestion_error) return null;
  return (
    <div className="mb-4 rounded-xl border border-[#7f1d1d] bg-[rgba(239,68,68,0.06)] px-4 py-3">
      <span className="text-aree-red text-[11px] font-bold tracking-[0.1em] uppercase">
        × WAQI feed temporarily unavailable
      </span>
      <span className="text-aree-muted ml-2 text-[11px]">{data.ingestion_error}</span>
    </div>
  );
}

/** Compact pollutant readings. Missing pollutants are stated, not hidden. */
export function PollutantGrid({ data }: { data: StationDetail }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-[var(--aree-border)] sm:grid-cols-3 lg:grid-cols-6">
      {POLLUTANTS.map(({ name, key, waqiKey }) => {
        const value = data[key] as number | null | undefined;
        const available = value !== null && value !== undefined;
        const dominant = data.dominant_pollutant?.toLowerCase() === waqiKey;
        return (
          <div
            key={name}
            className="bg-aree-card px-4 py-3.5"
            title={
              available
                ? `${name}: WAQI sub-index ${value}`
                : `${name} not reported by this feed`
            }
          >
            <div className="flex items-center gap-1.5">
              <span className="aree-eyebrow text-[10px]">{name}</span>
              {dominant ? (
                <span
                  className="text-aree-accent text-[9px] font-bold tracking-[0.1em] uppercase"
                  title="Dominant pollutant reported by WAQI"
                >
                  dom
                </span>
              ) : null}
            </div>
            <div
              className={`aree-num aree-tabular mt-1.5 text-xl leading-none font-bold ${
                available ? "text-aree-text" : "text-aree-faint"
              }`}
            >
              {available ? value : "—"}
            </div>
            <div className="text-aree-dim mt-1.5 text-[10px]">
              {available ? "WAQI sub-index" : "not reported"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Raw feed values, shown inside the advanced disclosure. */
export function DataSourceTransparency({
  data,
  config,
}: {
  data: StationDetail;
  config: EngineConfig | null;
}) {
  const threshold = config?.stale_data_threshold_seconds ?? 1200;
  const stale = data.stale_seconds;
  const freshnessText =
    stale !== null && stale !== undefined ? `${Math.round(stale)} s ago` : "Not available";
  const freshnessColor =
    stale === null || stale === undefined
      ? "var(--aree-dim)"
      : stale > threshold
        ? "var(--aree-orange)"
        : "var(--aree-green)";

  return (
    <div className="grid gap-x-8 gap-y-0 sm:grid-cols-2">
      <KeyValue label="WAQI feed ID" value={orDash(data.feed_id)} />
      <KeyValue
        label="WAQI AQI (raw)"
        value={orDash(data.waqi_aqi)}
        color={aqiColor(data.waqi_aqi ?? null)}
      />
      <KeyValue
        label="WAQI timestamp (local)"
        value={orDash(data.waqi_timestamp_local ?? data.waqi_timestamp)}
      />
      <KeyValue label="WAQI timestamp (UTC)" value={orDash(data.waqi_timestamp_utc)} />
      <KeyValue label="WAQI debug.sync" value={orDash(formatUtcIso(data.feed_last_sync))} />
      <KeyValue label="Station name (API)" value={orDash(data.station_name_api)} mono={false} />
      <KeyValue label="Reading age" value={freshnessText} color={freshnessColor} />
      <KeyValue label="Last API poll" value={`${orDash(data.api_time)} UTC`} />
      <KeyValue label="Ingestion status" value={orDash(data.ingestion_status)} />
      <KeyValue label="Ingestion error" value={orDash(data.ingestion_error, "none")} />
    </div>
  );
}

/** Small AQI aggregate row from the Pathway windows. */
export function WindowAggregates({ data }: { data: StationDetail }) {
  const windows = [
    { label: "5-min avg", value: data.avg_aqi_5min },
    { label: "15-min avg", value: data.avg_aqi_15min },
    { label: "5-min max", value: data.max_aqi_5min },
    { label: "15-min max", value: data.max_aqi_15min },
  ].filter((w) => w.value !== null && w.value !== undefined);

  if (windows.length === 0) return null;

  return (
    <Panel title="Pathway window aggregates" padding="p-5">
      <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
        {windows.map((w) => (
          <Stat
            key={w.label}
            label={w.label}
            value={typeof w.value === "number" ? w.value.toFixed(1) : "—"}
            size="sm"
          />
        ))}
      </div>
      {data.aqi_rate_of_change !== null && data.aqi_rate_of_change !== undefined ? (
        <div className="text-aree-dim mt-4 text-[11px]">
          5-min window rate of change: {data.aqi_rate_of_change} AQI/min
        </div>
      ) : null}
    </Panel>
  );
}
