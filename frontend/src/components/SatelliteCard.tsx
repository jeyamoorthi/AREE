"use client";

/**
 * Satellite transport intelligence.
 *
 * Fire counts and alignment come from NASA FIRMS through the engine; wind from
 * the weather stream. The transport verdict is the engine's label, rendered
 * here with its supporting evidence rather than restated as a new conclusion.
 */

import { Flame, Satellite, Wind } from "lucide-react";

import { Disclosure, KeyValue, Panel, Pill, ProgressBar, Stat } from "@/components/ui/Card";
import { confidenceColor, orDash, transportLabel } from "@/lib/theme";
import type { StationDetail } from "@/types";

/** Compass rose label for a meteorological wind direction in degrees. */
function compass(deg: number): string {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return points[Math.round(deg / 22.5) % 16];
}

export default function SatelliteCard({ data }: { data: StationDetail }) {
  const fireCount = data.fire_count ?? 0;
  const transportScore = data.transport_score ?? 0;
  const windSpeed = data.wind_speed;
  const windDir = data.wind_direction;
  const label = transportLabel(data.transport_label);

  const fireColor =
    fireCount > 5 ? "var(--aree-red)" : fireCount > 0 ? "var(--aree-yellow)" : "var(--aree-green)";
  const scoreColor =
    transportScore > 50
      ? "var(--aree-red)"
      : transportScore > 20
        ? "var(--aree-yellow)"
        : "var(--aree-green)";

  const firmsStatus = data.firms_status ?? "awaiting";
  const statusColor =
    firmsStatus === "ok"
      ? "var(--aree-green)"
      : firmsStatus === "awaiting"
        ? "var(--aree-yellow)"
        : "var(--aree-red)";

  // Wind is reported as the direction it blows FROM; transport runs the other way.
  const windFlow =
    windDir !== null && windDir !== undefined
      ? `${compass(windDir)} → ${compass((windDir + 180) % 360)}`
      : null;

  return (
    <>
      <Panel
        title="Satellite transport intelligence"
        icon={<Satellite className="h-3.5 w-3.5" />}
        accent={scoreColor}
        padding="p-5"
        right={
          <Pill color={statusColor}>
            FIRMS {firmsStatus === "ok" ? "live" : firmsStatus}
          </Pill>
        }
      >
        <div className="grid gap-6 rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-5 shadow-[var(--aree-shadow-sm)] sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Fire detections"
            value={fireCount}
            color={fireColor}
            size="lg"
            sub={`${data.high_conf_fires ?? 0} high confidence`}
          />
          <Stat
            label="Wind"
            value={
              windSpeed !== null && windSpeed !== undefined
                ? `${windSpeed.toFixed(1)} m/s`
                : "Not available"
            }
            color={windSpeed ? "var(--aree-body)" : "var(--aree-dim)"}
            size={windSpeed ? "md" : "sm"}
            sub={
              windFlow ? (
                <span className="flex items-center gap-1.5">
                  <Wind className="h-3 w-3" aria-hidden />
                  {windFlow} · {Math.round(windDir as number)}°
                </span>
              ) : (
                "No wind telemetry from the source feed"
              )
            }
          />
          <Stat
            label="Transport"
            value={label.text}
            color={label.color}
            mono={false}
            size="sm"
            sub={`${data.aligned_fires ?? 0} aligned detections`}
          />
          <div className="min-w-0">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="aree-eyebrow text-[10.5px]">Transport score</span>
              <span className="aree-num text-[13px] font-bold" style={{ color: scoreColor }}>
                {transportScore}/100
              </span>
            </div>
            <ProgressBar percent={transportScore} color={scoreColor} label="Transport score" />
            <div className="mt-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="aree-eyebrow text-[10.5px]">Confidence</span>
                <span
                  className="aree-num text-[13px] font-bold"
                  style={{ color: confidenceColor(data.confidence_score) }}
                >
                  {data.confidence_score ?? 0}%
                </span>
              </div>
              <ProgressBar
                percent={data.confidence_score ?? 0}
                color={confidenceColor(data.confidence_score)}
                label="Signal confidence"
              />
            </div>
          </div>
        </div>

        {data.pollution_cause ? (
          <div className="mt-5 border-t border-aree-border pt-4">
            <div className="aree-eyebrow mb-2 flex items-center gap-2">
              <Flame className="h-3.5 w-3.5 text-aree-orange" aria-hidden />
              Causal attribution (Pathway DAG)
            </div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-[15px] font-bold text-aree-text">
                {data.pollution_cause.replace(/_/g, " ")}
              </span>
              <span className="text-[11px] text-aree-muted">
                confidence {((data.cause_confidence ?? 0) * 100).toFixed(0)}%
              </span>
              {data.transport_probability !== undefined ? (
                <span className="text-[11px] text-aree-muted">
                  · transport probability{" "}
                  {((data.transport_probability ?? 0) * 100).toFixed(0)}%
                </span>
              ) : null}
            </div>
            {data.cause_factors && data.cause_factors.length > 0 ? (
              <ul className="mt-2.5 space-y-1">
                {data.cause_factors.map((factor) => (
                  <li key={factor} className="text-[12px] leading-relaxed text-aree-body">
                    ▸ {factor}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {data.firms_error ? (
          <div className="mt-5 rounded-[var(--aree-radius-sm)] border border-[#7f1d1d] p-4 shadow-[var(--aree-shadow-sm)]" style={{ background: "color-mix(in srgb, var(--aree-red) 6%, transparent)" }}>
            <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-aree-red">
              ⚠ Satellite verification temporarily unavailable
            </span>
            <span className="ml-3 text-[11.5px] text-aree-muted">{data.firms_error}</span>
          </div>
        ) : null}
      </Panel>

      <Disclosure summary="Satellite engine data" className="mt-4">
        <div className="grid gap-x-8 sm:grid-cols-2">
          <KeyValue label="FIRMS status" value={orDash(data.firms_status)} color={statusColor} />
          <KeyValue label="Dataset" value={orDash(data.firms_dataset)} />
          <KeyValue label="Last NASA sync" value={`${orDash(data.firms_sync)} UTC`} />
          <KeyValue label="Bounding box" value={orDash(data.fire_bbox)} />
          <KeyValue
            label="Fire centroid"
            value={
              data.fire_centroid
                ? `${data.fire_centroid[0]}, ${data.fire_centroid[1]}`
                : "none detected"
            }
          />
          <KeyValue
            label="Plume distance"
            value={
              data.plume_distance_km !== undefined && data.plume_distance_km !== null
                ? `${data.plume_distance_km} km`
                : "Not available"
            }
          />
          <KeyValue
            label="Wind alignment"
            value={
              data.wind_alignment_deg !== undefined && data.wind_alignment_deg !== null
                ? `${data.wind_alignment_deg}°`
                : "Not available"
            }
          />
          <KeyValue label="Transport label" value={orDash(data.transport_label)} />
        </div>
      </Disclosure>
    </>
  );
}
