"use client";

/**
 * Regulatory state surfaces: the live state strip and the GRAP stage timeline.
 *
 * Stage boundaries come from /api/system/config, the current stage and every
 * transition detail from the station payload. Nothing here decides a stage.
 */

import { KeyValue, Panel, Pill, Stat } from "@/components/ui/Card";
import { aqiColor, eriColor, grapColor, grapRank, modeColor, modeLabel, orDash } from "@/lib/theme";
import type { EngineConfig, StationDetail } from "@/types";
import { CheckCircle2, Circle } from "lucide-react";

/** One-line answer to "how serious is it, right now". */
export function LiveRegulatoryState({
  data,
  config,
}: {
  data: StationDetail;
  config: EngineConfig | null;
}) {
  const persistenceThreshold = config?.persistence_threshold ?? null;
  const consecutive = data.consecutive_windows ?? 0;
  const mode = data.engine_mode ?? "NORMAL";

  const escalation =
    mode === "TRIGGERED" ? "Triggered" : mode === "WATCH" ? "Watch" : "None";

  return (
    <Panel
      title="Engine verdict"
      accent={modeColor(mode)}
      padding="p-6"
      right={
        <Pill color={modeColor(mode)} filled={mode === "TRIGGERED"}>
          {modeLabel(mode)}
        </Pill>
      }
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="AQI" value={data.aqi ?? "—"} color={aqiColor(data.aqi)} size="lg" />
        <Stat
          label="Risk"
          value={orDash(data.eri_category, "Not available")}
          color={eriColor(data.eri_score)}
          mono={false}
          size="sm"
          sub={data.eri_score !== undefined ? `ERI ${data.eri_score}` : undefined}
        />
        <Stat
          label="GRAP"
          value={orDash(data.grap_stage, "Not available")}
          color={grapColor(data.grap_stage)}
          mono={false}
          size="sm"
          sub={data.grap_description ?? undefined}
        />
        <Stat
          label="Persistence"
          value={
            persistenceThreshold
              ? `${consecutive} / ${persistenceThreshold}`
              : String(consecutive)
          }
          color={
            persistenceThreshold && consecutive >= persistenceThreshold
              ? "var(--aree-red)"
              : consecutive > 0
                ? "var(--aree-orange)"
                : "var(--aree-green)"
          }
          sub="windows"
        />
        <Stat
          label="Escalation"
          value={escalation}
          color={modeColor(mode)}
          mono={false}
          size="sm"
          sub={
            data.hysteresis_pending
              ? `pending ${data.hysteresis_pending}`
              : "state machine verdict"
          }
        />
      </div>
    </Panel>
  );
}

/** GRAP stages as a timeline, with the technical decision values below it. */
export function GRAPTimeline({
  data,
  config,
}: {
  data: StationDetail;
  config: EngineConfig | null;
}) {
  const stages = config?.grap_stages ?? [];
  const currentRank = grapRank(data.grap_stage);
  const color = grapColor(data.grap_stage);

  return (
    <Panel title="GRAP stage progression" accent={color} padding="p-6">
      {stages.length === 0 ? (
        <div className="text-aree-muted text-[14px] bg-aree-surface-2 p-4 rounded-lg">
          Stage definitions are not available from the engine configuration.
        </div>
      ) : (
        <div className="mb-8">
          {/* Horizontal Progress Bar */}
          <div className="flex w-full items-center mb-6 relative">
            {stages.map((stage, index) => {
              const rank = grapRank(stage.stage);
              const isCurrent = rank === currentRank;
              const reached = rank <= currentRank && currentRank > 0;
              const stageColor = grapColor(stage.stage);
              const isLast = index === stages.length - 1;

              return (
                <div key={stage.stage} className="flex-1 flex flex-col items-center relative">
                  {/* The Line connecting stages */}
                  {!isLast && (
                    <div 
                      className="absolute top-3 left-1/2 w-full h-1" 
                      style={{ 
                        background: (rank < currentRank && currentRank > 0) ? grapColor(stages[index+1].stage) : 'var(--aree-border)',
                        opacity: (rank < currentRank && currentRank > 0) ? 0.6 : 1
                      }}
                    />
                  )}
                  
                  {/* The Node */}
                  <div 
                    className={`relative z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 bg-aree-card shadow-sm`}
                    style={{ 
                      borderColor: reached ? stageColor : 'var(--aree-border-strong)',
                      boxShadow: isCurrent ? `0 0 0 4px color-mix(in srgb, ${stageColor} 20%, transparent)` : undefined,
                    }}
                  >
                    {reached ? (
                      <CheckCircle2 className="h-4 w-4" style={{ color: stageColor }} />
                    ) : (
                      <Circle className="h-3 w-3 text-aree-border-strong" fill="currentColor" />
                    )}
                  </div>
                  
                  <div className="mt-3 flex flex-col items-center text-center">
                    <span 
                      className={`text-[12px] font-bold ${isCurrent ? 'scale-110' : ''} transition-transform`}
                      style={{ color: isCurrent ? stageColor : reached ? 'var(--aree-body)' : 'var(--aree-dim)' }}
                    >
                      {stage.stage}
                    </span>
                    <span className="text-[10px] text-aree-faint mt-1 whitespace-nowrap">AQI {stage.low}{stage.high !== 9999 ? `-${stage.high}` : '+'}</span>
                  </div>
                </div>
              );
            })}
          </div>
          
          {/* Active Stage Description Box */}
          {currentRank > 0 && stages.find(s => grapRank(s.stage) === currentRank) ? (
            <div className="bg-aree-surface-2 border border-aree-border rounded-lg p-4 mt-2">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-bold text-[14px]" style={{ color }}>{data.grap_stage}</span>
                <Pill color={color} filled>Active</Pill>
              </div>
              <p className="text-[13px] text-aree-body leading-relaxed">
                {stages.find(s => grapRank(s.stage) === currentRank)?.description}
              </p>
            </div>
          ) : null}
        </div>
      )}

      <div className="border-aree-border mt-4 grid gap-x-8 gap-y-4 border-t pt-5 sm:grid-cols-2 lg:grid-cols-3 bg-aree-surface-1/50 rounded-b-xl -mx-6 -mb-6 px-6 pb-6">
        <KeyValue
          label="Current stage"
          value={orDash(data.grap_stage, "Not available")}
          color={color}
        />
        <KeyValue label="Raw stage" value={orDash(data.grap_raw_stage)} />
        <KeyValue label="Previous stage" value={orDash(data.previous_stage, "none")} />
        <KeyValue
          label="Transitioned this window"
          value={data.grap_transitioned ? "yes" : "no"}
          color={data.grap_transitioned ? "var(--aree-orange)" : undefined}
        />
        <KeyValue
          label="Hysteresis"
          value={
            data.hysteresis_pending
              ? `${data.hysteresis_pending} · ${data.hysteresis_count ?? 0}/${
                  config?.hysteresis_confirmations ?? "?"
                } confirms`
              : "stable"
          }
          color={data.hysteresis_pending ? "var(--aree-yellow)" : undefined}
        />
        <KeyValue
          label="Escalation threshold"
          value={
            config
              ? `AQI ≥ ${config.high_aqi_threshold} × ${config.persistence_threshold} windows`
              : "Not available"
          }
        />
      </div>
    </Panel>
  );
}

/** Regulatory framing values, kept for the advanced disclosure. */
export function RegulatoryContext({
  data,
  config,
}: {
  data: StationDetail;
  config: EngineConfig | null;
}) {
  return (
    <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3 bg-aree-surface-2 p-5 rounded-lg border border-aree-border">
      <KeyValue
        label="Engine mode"
        value={orDash(data.engine_mode)}
        color={modeColor(data.engine_mode)}
      />
      <KeyValue label="Data type" value="Real-time short window" mono={false} />
      <KeyValue label="Last API poll" value={`${orDash(data.api_time)} UTC`} />
      <KeyValue
        label="High-AQI threshold"
        value={config ? `≥ ${config.high_aqi_threshold}` : "Not available"}
      />
      <KeyValue
        label="Sliding window"
        value={
          config
            ? `${config.window_duration_minutes}m dur · ${config.window_hop_minutes}m hop`
            : "Not available"
        }
      />
      <KeyValue label="Governance rule" value={orDash(data.governance_rule)} mono={false} />
    </div>
  );
}
