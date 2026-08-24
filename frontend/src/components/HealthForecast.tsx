"use client";

/**
 * Public health impact forecast (VPPE).
 *
 * Deterministic risk multipliers computed in the engine. Advisory only — it
 * never affects GRAP escalation logic, and the panel says so.
 */

import { HeartPulse } from "lucide-react";

import { KeyValue, Note, Panel, Pill, Stat } from "@/components/ui/Card";
import { aqiColor, grapColor, riskLevelColor, urgencyColor } from "@/lib/theme";
import type { HealthImpactResponse } from "@/types";
import { EmptyState } from "./ui/States";

export default function HealthForecast({ health }: { health: HealthImpactResponse }) {
  if (!health.available) {
    return (
      <EmptyState>
        Collecting data — the vulnerable-population projection activates after three
        sliding windows have closed.
      </EmptyState>
    );
  }

  const proj30 = health.projected_30min ?? null;

  return (
    <Panel
      title="Public health impact forecast"
      icon={<HeartPulse className="h-3.5 w-3.5 text-aree-accent" />}
      accent={urgencyColor(health.mitigation_urgency)}
      padding="p-5"
      right={
        <Pill color={urgencyColor(health.mitigation_urgency)}>
          {health.mitigation_urgency ?? "LOW"} urgency
        </Pill>
      }
    >
      <div className="grid gap-6 sm:grid-cols-3">
        <Stat
          label="30-min projected AQI"
          value={proj30 ?? "—"}
          color={aqiColor(proj30)}
          size="lg"
          sub={
            <span style={{ color: grapColor(health.predicted_grap_30min) }}>
              GRAP {health.predicted_grap_30min ?? "—"}
            </span>
          }
        />
        <Stat
          label="Exposure score (30 min)"
          value={health.exposure_score_30min ?? "—"}
          color={aqiColor(proj30)}
          size="lg"
          sub="deterministic: AQI × 0.6"
        />
        <Stat
          label="Peak vulnerability level"
          value={health.vulnerability_max ?? "Not available"}
          color={riskLevelColor(health.vulnerability_max)}
          mono={false}
          size="sm"
          sub="highest level across the groups below"
        />
      </div>

      <div className="aree-eyebrow mt-6 mb-3">Vulnerable population risk</div>
      <div className="grid gap-px overflow-hidden rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-border shadow-[var(--aree-shadow-sm)] sm:grid-cols-2 lg:grid-cols-4">
        {health.groups.map((group) => {
          const color = riskLevelColor(group.level);
          return (
            <div key={group.group} className="bg-aree-surface-1 px-4 py-3">
              <div className="text-[11.5px] font-medium text-aree-muted">{group.label}</div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="aree-num text-xl font-bold" style={{ color }}>
                  {group.score}
                </span>
                <span
                  className="text-[10px] font-bold tracking-[0.08em] uppercase"
                  style={{ color }}
                >
                  {group.level}
                </span>
              </div>
              <div className="text-[10.5px] text-aree-dim mt-1">
                multiplier × {group.multiplier}
              </div>
            </div>
          );
        })}
      </div>

      {health.preemptive_advisory.length > 0 ? (
        <div
          className="mt-5 rounded-[var(--aree-radius-sm)] border px-4 py-3 shadow-[var(--aree-shadow-sm)]"
          style={{
            borderColor: "color-mix(in srgb, var(--aree-red) 45%, transparent)",
            background: "color-mix(in srgb, var(--aree-red) 5%, transparent)",
          }}
          role="alert"
        >
          <div className="mb-2 text-[11px] font-bold tracking-[0.12em] uppercase text-aree-red">
            ⚠ Pre-emptive public health advisory
          </div>
          {health.preemptive_advisory.map((item) => (
            <div key={item} className="text-[13px] leading-relaxed text-aree-amber">
              ▸ {item}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-5 text-center text-[12.5px] font-semibold text-aree-green">
          ✔ No pre-emptive advisory required at the current trajectory
        </div>
      )}

      <div className="mt-6 grid gap-x-8 border-t border-aree-border pt-4 sm:grid-cols-2">
        <KeyValue label="Impact radius" value={`${health.impact_radius_km} km`} />
        <KeyValue
          label="Est. population in radius"
          value={health.est_population.toLocaleString()}
        />
      </div>

      <div className="mt-3">
        <Note>
          Deterministic multipliers, no ML. Advisory only — does not affect GRAP
          escalation logic. Population figure is a configured constant, not census data.
        </Note>
      </div>
    </Panel>
  );
}
