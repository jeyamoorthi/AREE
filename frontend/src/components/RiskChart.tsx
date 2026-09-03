"use client";

/**
 * Risk composition — the deterministic contributions the engine reports,
 * on one 0–100 scale so they can be compared at a glance.
 */

import {
  Bar,
  BarChart,
  Cell,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Panel } from "@/components/ui/Card";
import { COLORS, eriColor } from "@/lib/theme";
import type { StationDetail } from "@/types";

export default function RiskChart({ data }: { data: StationDetail }) {
  const rows = [
    { name: "ERI", value: data.eri_score ?? 0, color: eriColor(data.eri_score) },
    {
      name: "Transport",
      value: data.transport_score ?? 0,
      color: (data.transport_score ?? 0) > 50 ? COLORS.red : COLORS.yellow,
    },
    // Only charted when present: a missing metric plotted as 0 is indistinguishable
    // from a metric that was genuinely measured at 0.
    ...(data.confidence_score !== null && data.confidence_score !== undefined
      ? [{ name: "Confidence", value: data.confidence_score, color: COLORS.accent }]
      : []),
    {
      name: "Cause conf.",
      value: Math.round((data.cause_confidence ?? 0) * 100),
      color: COLORS.blue,
    },
    {
      name: "Transport prob.",
      value: Math.round((data.transport_probability ?? 0) * 100),
      color: COLORS.orange,
    },
  ];

  return (
    <Panel title="Risk composition (0–100)" padding="p-5">
      <div className="h-56 w-full rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-2 shadow-[var(--aree-shadow-sm)]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 18, right: 12, bottom: 4, left: -18 }}>
            <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="name"
              stroke={COLORS.dim}
              tick={{ fill: COLORS.muted, fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: COLORS.border }}
              interval={0}
            />
            <YAxis
              domain={[0, 100]}
              stroke={COLORS.dim}
              tick={{ fill: COLORS.muted, fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: COLORS.border }}
            />
            <Tooltip
              cursor={{ fill: "rgba(148,163,184,0.08)" }}
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
            <Bar dataKey="value" name="Score" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              <LabelList dataKey="value" position="top" fill={COLORS.muted} fontSize={10} />
              {rows.map((row) => (
                <Cell key={row.name} fill={row.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 px-1 text-[11px] text-aree-dim">
        Advisory only — the escalation decision uses AQI and persistence, never these
        composite scores.
      </div>
    </Panel>
  );
}
