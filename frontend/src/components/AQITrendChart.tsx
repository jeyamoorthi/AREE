"use client";

/**
 * AQI trend chart — the engine's actual sliding-window history plus its
 * linear-regression projection. Both series come from /api/forecast; the
 * chart never interpolates a value the engine did not emit.
 */

import { useMemo } from "react";
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

import { COLORS } from "@/lib/theme";
import type { ForecastResponse } from "@/types";

interface Point {
  label: string;
  observed: number | null;
  projected: number | null;
}

function clockLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(11, 19);
}

export default function AQITrendChart({
  forecast,
  highThreshold = 300,
  height = 260,
}: {
  forecast: ForecastResponse;
  highThreshold?: number;
  height?: number;
}) {
  const points = useMemo<Point[]>(() => {
    const history = forecast.history ?? [];
    const observed: Point[] = history.map((p) => ({
      label: clockLabel(p.timestamp),
      observed: p.aqi ?? null,
      projected: null,
    }));

    if (observed.length === 0) return [];

    // Anchor the projection line to the last observed reading so the two
    // series join instead of floating apart.
    const last = observed[observed.length - 1];
    last.projected = last.observed;

    if (forecast.projected_5min !== null && forecast.projected_5min !== undefined) {
      observed.push({ label: "+5m", observed: null, projected: forecast.projected_5min });
    }
    if (forecast.projected_30min !== null && forecast.projected_30min !== undefined) {
      observed.push({ label: "+30m", observed: null, projected: forecast.projected_30min });
    }
    return observed;
  }, [forecast]);

  if (points.length === 0) {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center text-[13px] text-aree-muted">
        Awaiting window history…
      </div>
    );
  }

  return (
    <div>
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 10, right: 14, bottom: 4, left: -14 }}>
            <defs>
              <linearGradient id="aree-observed-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.accent} stopOpacity={0.28} />
                <stop offset="100%" stopColor={COLORS.accent} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              stroke={COLORS.dim}
              tick={{ fill: COLORS.muted, fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: COLORS.border }}
              minTickGap={18}
            />
            <YAxis
              stroke={COLORS.dim}
              tick={{ fill: COLORS.muted, fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: COLORS.border }}
              domain={[0, "auto"]}
              width={46}
            />
            <Tooltip
              contentStyle={{
                background: "var(--aree-surface-2)",
                border: "1px solid var(--aree-border-strong)",
                borderRadius: "var(--aree-radius-md)",
                boxShadow: "var(--aree-shadow-sm)",
                fontSize: 12,
              }}
              labelStyle={{ color: "var(--aree-muted)" }}
              itemStyle={{ color: "var(--aree-text)", fontWeight: 500 }}
            />
            <ReferenceLine
              y={highThreshold}
              stroke={COLORS.red}
              strokeDasharray="4 4"
              label={{
                value: `Escalation threshold ${highThreshold}`,
                fill: COLORS.red,
                fontSize: 10,
                position: "insideTopRight",
              }}
            />
            <Area
              type="monotone"
              dataKey="observed"
              stroke="none"
              fill="url(#aree-observed-fill)"
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="observed"
              name="Observed AQI"
              stroke={COLORS.accent}
              strokeWidth={2}
              dot={{ r: 2.5, fill: "var(--aree-surface-1)", stroke: COLORS.accent, strokeWidth: 2 }}
              activeDot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="projected"
              name="Projected AQI"
              stroke={COLORS.orange}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={{ r: 2.5, fill: "var(--aree-surface-1)", stroke: COLORS.orange, strokeWidth: 2 }}
              connectNulls
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-aree-muted">
        <span className="flex items-center gap-2 rounded-full border border-aree-border bg-aree-surface-1 px-2.5 py-1 shadow-[var(--aree-shadow-sm)]">
          <span className="inline-block h-0.5 w-3" style={{ background: COLORS.accent }} />
          Observed (windows)
        </span>
        <span className="flex items-center gap-2 rounded-full border border-aree-border bg-aree-surface-1 px-2.5 py-1 shadow-[var(--aree-shadow-sm)]">
          <span
            className="inline-block h-0.5 w-3"
            style={{
              backgroundImage: `repeating-linear-gradient(90deg, ${COLORS.orange} 0 4px, transparent 4px 7px)`,
            }}
          />
          Linear projection
        </span>
      </div>
    </div>
  );
}
