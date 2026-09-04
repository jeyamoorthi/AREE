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
    // ERI is computed only on the Pathway path. Charting `?? 0` drew a solid
    // zero bar for a readiness index that had never been calculated.
    ...(data.eri_score !== null && data.eri_score !== undefined
      ? [{ name: "ERI", value: data.eri_score, color: eriColor(data.eri_score) }]
      : []),
    ...(data.transport_score !== null && data.transport_score !== undefined
      ? [{
          name: "Transport",
          value: data.transport_score,
          color: data.transport_score > 50 ? COLORS.red : COLORS.yellow,
        }]
      : []),
    // Only charted when present: a missing metric plotted as 0 is indistinguishable
    // from a metric that was genuinely measured at 0.
    ...(data.confidence_score !== null && data.confidence_score !== undefined
      ? [{ name: "Confidence", value: data.confidence_score, color: COLORS.accent }]
      : []),
    // Same rule as Confidence above, which it did not previously follow: a
    // metric the engine never computed was charted as a solid 0 bar, which is
    // indistinguishable from one that was measured at 0. Direct mode computes
    // neither of these, so in that mode the bars are simply absent.
    ...(data.cause_confidence !== null && data.cause_confidence !== undefined
      ? [{
          name: "Cause conf.",
          value: Math.round(data.cause_confidence * 100),
          color: COLORS.blue,
        }]
      : []),
    ...(data.transport_probability !== null && data.transport_probability !== undefined
      ? [{
          name: "Transport prob.",
          value: Math.round(data.transport_probability * 100),
          color: COLORS.orange,
        }]
      : []),
  ];

  // With every component metric guarded, direct mode can legitimately produce an
  // empty set. An empty axis reads as "all zero"; saying so reads as what it is.
  if (rows.length === 0) {
    return (
      <Panel title="Risk composition (0–100)" padding="p-5">
        <div className="rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-5 text-[12px] text-aree-dim shadow-[var(--aree-shadow-sm)]">
          None of the component metrics — escalation readiness, transport score,
          signal confidence, causal attribution — are computed by the engine in
          this mode, so there is nothing to compose. They are absent rather than
          zero.
        </div>
      </Panel>
    );
  }

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
