"use client";

/**
 * Persistence analysis.
 *
 * The engine decides escalation on consecutive high windows; this shows how
 * far along that count is, what remains, and where the trend is heading.
 * Raw engine values stay available under the advanced disclosure.
 */

import { MoveRight, TrendingDown, TrendingUp } from "lucide-react";

import { Disclosure, KeyValue, Panel, ProgressBar, Stat } from "@/components/ui/Card";
import { orDash } from "@/lib/theme";
import type { EngineConfig, StationDetail } from "@/types";

export default function PersistenceCard({
  data,
  config,
}: {
  data: StationDetail;
  config: EngineConfig | null;
}) {
  const persistenceThreshold = config?.persistence_threshold ?? 3;
  const highThreshold = config?.high_aqi_threshold ?? 300;
  const consecutive = data.consecutive_windows ?? 0;
  const remaining = data.remaining_windows ?? persistenceThreshold;
  const aqi = data.aqi ?? 0;
  const projected = data.projected_trigger_time ?? null;

  const percent = Math.min(
    100,
    Math.round((consecutive / Math.max(persistenceThreshold, 1)) * 100),
  );
  const progressColor =
    percent >= 100 ? "var(--aree-red)" : percent >= 50 ? "var(--aree-orange)" : "var(--aree-green)";

  const direction = data.forecast?.direction ?? null;
  const TrendIcon =
    direction === "rising" ? TrendingUp : direction === "falling" ? TrendingDown : MoveRight;
  const trendLabel =
    direction === "rising"
      ? consecutive > 0
        ? "Sustained rise"
        : "Rising"
      : direction === "falling"
        ? "Falling"
        : direction === "stable"
          ? "Stable"
          : "Not available";
  const trendColour =
    direction === "rising"
      ? "var(--aree-red)"
      : direction === "falling"
        ? "var(--aree-green)"
        : "var(--aree-muted)";

  const triggered = consecutive >= persistenceThreshold;
  const watch = aqi >= highThreshold && consecutive > 0 && !triggered;

  const banner = triggered
    ? {
        cls: "aree-escalation-glow",
        color: "var(--aree-red)",
        title: "Escalation triggered",
        detail: `${consecutive} consecutive windows at AQI ≥ ${highThreshold}. Immediate regulatory activation required.`,
      }
    : watch
      ? {
          cls: "",
          color: "var(--aree-orange)",
          title: "Escalation watch",
          detail: `${consecutive} of ${persistenceThreshold} windows recorded · ${remaining} remaining${
            projected ? ` · projected trigger ${projected}` : ""
          }`,
        }
      : {
          cls: "",
          color: "var(--aree-green)",
          title: "Normal operations",
          detail: `No sustained readings at or above AQI ${highThreshold}.`,
        };

  return (
    <>
      <div
        className={`rounded-xl border-2 px-5 py-4 ${banner.cls}`}
        style={{
          borderColor: banner.color,
          background: `color-mix(in srgb, ${banner.color} 8%, transparent)`,
        }}
        role={triggered ? "alert" : "status"}
      >
        <div
          className="text-[15px] font-bold tracking-[0.14em] uppercase"
          style={{ color: banner.color }}
        >
          {banner.title}
        </div>
        <div className="text-aree-body mt-1.5 text-[13px]">{banner.detail}</div>
      </div>

      <Panel title="Persistence" accent={progressColor} padding="p-5" className="mt-4">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="aree-eyebrow text-[10px]">Toward escalation threshold</span>
              <span
                className="aree-num text-2xl leading-none font-bold"
                style={{ color: progressColor }}
              >
                {percent}%
              </span>
            </div>
            <ProgressBar
              percent={percent}
              color={progressColor}
              height={12}
              label="Persistence toward escalation threshold"
            />
            <div className="text-aree-dim mt-2 text-[11px]">
              {consecutive} of {persistenceThreshold} consecutive qualifying windows
              {remaining > 0 ? ` · ${remaining} remaining` : " · threshold met"}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-5">
            <Stat
              label="Window"
              value={`${consecutive} / ${persistenceThreshold}`}
              color={progressColor}
            />
            <Stat
              label="Trend"
              value={
                <span className="flex items-center gap-1.5">
                  <TrendIcon className="h-4 w-4" aria-hidden />
                  <span className="text-[13px]">{trendLabel}</span>
                </span>
              }
              color={trendColour}
              mono={false}
              sub={
                data.forecast?.rate_per_min !== undefined && data.forecast !== null
                  ? `${data.forecast?.rate_per_min} AQI/min`
                  : undefined
              }
            />
          </div>
        </div>
      </Panel>

      <Disclosure summary="Advanced engine data" className="mt-3">
        <div className="grid gap-x-8 sm:grid-cols-2">
          <KeyValue label="Consecutive windows" value={consecutive} />
          <KeyValue label="Remaining windows" value={remaining} />
          <KeyValue
            label="Projected trigger"
            value={orDash(projected, "no projection")}
            color={projected === "ACTIVE NOW" ? "var(--aree-red)" : undefined}
          />
          <KeyValue label="Last data update" value={`${orDash(data.api_time)} UTC`} />
          <KeyValue
            label="Governance rule"
            value={
              data.governance_rule ||
              `AQI ≥ ${highThreshold} · ${persistenceThreshold} consecutive windows · ${
                config?.window_duration_minutes ?? "?"
              } min sliding · ${config?.window_hop_minutes ?? "?"} min hop · hysteresis ${
                config?.hysteresis_confirmations ?? "?"
              } confirmations`
            }
            mono={false}
          />
          <KeyValue
            label="Rate of change (5-min window)"
            value={
              data.aqi_rate_of_change !== null && data.aqi_rate_of_change !== undefined
                ? `${data.aqi_rate_of_change} AQI/min`
                : "Not available"
            }
          />
        </div>
      </Disclosure>
    </>
  );
}
