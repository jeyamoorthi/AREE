"use client";

/**
 * Forecast intelligence.
 *
 * Linear regression over closed sliding windows, computed in the engine. The
 * chart is the projection; the column beside it is the same projection stated
 * numerically. No confidence figure is shown because the engine does not emit
 * one — the number of contributing windows is shown instead.
 */

import { MoveRight, TrendingDown, TrendingUp } from "lucide-react";

import { Note, Panel, Pill, Stat } from "@/components/ui/Card";
import { aqiColor, grapColor, trendColor } from "@/lib/theme";
import type { ForecastResponse } from "@/types";
import AQITrendChart from "./AQITrendChart";
import { EmptyState } from "./ui/States";

export default function ForecastCard({
  forecast,
  highThreshold,
}: {
  forecast: ForecastResponse;
  highThreshold?: number;
}) {
  if (!forecast.available) {
    return (
      <EmptyState>
        Collecting data points — the projection activates once at least three sliding
        windows have closed for this station.
      </EmptyState>
    );
  }

  const direction = forecast.direction ?? "stable";
  const color = trendColor(direction);
  const TrendIcon =
    direction === "rising" ? TrendingUp : direction === "falling" ? TrendingDown : MoveRight;

  const eta = forecast.escalation_eta;

  return (
    <Panel
      title="AQI forecast"
      accent={color}
      padding="p-5"
      right={
        forecast.anomaly ? (
          <Pill color="var(--aree-red)" filled>
            ⚠ anomaly detected
          </Pill>
        ) : (
          <Pill color="var(--aree-muted)">{forecast.data_points} windows</Pill>
        )
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(200px,1fr)]">
        <div className="rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-4 shadow-[var(--aree-shadow-sm)]">
          <AQITrendChart forecast={forecast} highThreshold={highThreshold} />
        </div>

        <div className="flex flex-col gap-5">
          <Stat
            label="Trend"
            value={
              <span className="flex items-center gap-2">
                <TrendIcon className="h-4 w-4 text-aree-accent" aria-hidden />
                {direction.charAt(0).toUpperCase() + direction.slice(1)}
              </span>
            }
            color={color}
            mono={false}
            sub={`${forecast.rate_per_min ?? 0} AQI/min · slope ${forecast.slope ?? 0}`}
          />
          <Stat
            label="Projected +5 min"
            value={forecast.projected_5min ?? "—"}
            color={aqiColor(forecast.projected_5min)}
            sub={`GRAP ${forecast.predicted_grap ?? "—"}`}
          />
          <Stat
            label="Projected +30 min"
            value={forecast.projected_30min ?? "—"}
            color={aqiColor(forecast.projected_30min)}
            sub={
              <span style={{ color: grapColor(forecast.predicted_grap_30min) }}>
                GRAP {forecast.predicted_grap_30min ?? "—"}
              </span>
            }
          />
          <Stat
            label="Escalation ETA"
            value={eta ? `~${eta} min` : "None imminent"}
            color={eta && eta < 15 ? "var(--aree-red)" : "var(--aree-green)"}
            mono={Boolean(eta)}
            size="sm"
            sub={
              forecast.exposure_score_30min !== null &&
              forecast.exposure_score_30min !== undefined
                ? `30-min exposure score ${forecast.exposure_score_30min}`
                : undefined
            }
          />
        </div>
      </div>

      {forecast.anomaly ? (
        <div
          className="mt-4 rounded-[var(--aree-radius-sm)] border px-4 py-3 shadow-[var(--aree-shadow-sm)]"
          style={{
            borderColor: "color-mix(in srgb, var(--aree-red) 50%, transparent)",
            background: "color-mix(in srgb, var(--aree-red) 10%, transparent)",
          }}
          role="alert"
        >
          <span className="text-[12px] font-bold text-aree-red uppercase tracking-wider">⚠ ANOMALY DETECTED</span>
          <span className="ml-3 text-[12.5px] text-aree-body">
            Current AQI deviates significantly from the recent trend (z-score &gt; 2σ).
          </span>
        </div>
      ) : null}

      <div className="mt-4">
        <Note>
          Linear regression over the last {forecast.data_points} closed windows.
          Deterministic — no external model is called.
        </Note>
      </div>
    </Panel>
  );
}
