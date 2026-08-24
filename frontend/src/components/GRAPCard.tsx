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
      padding="p-5"
      right={
        <Pill color={modeColor(mode)} filled={mode === "TRIGGERED"}>
          {modeLabel(mode)}
        </Pill>
      }
    >
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
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
    <Panel title="GRAP status" accent={color} padding="p-5">
      {stages.length === 0 ? (
        <div className="text-aree-muted text-[13px]">
          Stage definitions are not available from the engine configuration.
        </div>
      ) : (
        <ol className="flex flex-col gap-0">
          {stages.map((stage) => {
            const rank = grapRank(stage.stage);
            const isCurrent = rank === currentRank;
            const reached = rank <= currentRank && currentRank > 0;
            const stageColor = grapColor(stage.stage);
            return (
              <li key={stage.stage} className="flex items-start gap-3">
                <div className="flex flex-col items-center self-stretch">
                  <span
                    className={`mt-1.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-2 ${
                      isCurrent ? "aree-live-dot" : ""
                    }`}
                    style={{
                      borderColor: reached ? stageColor : "var(--aree-border-strong)",
                      background: isCurrent ? stageColor : "transparent",
                    }}
                    aria-hidden
                  />
                  <span
                    className="w-px flex-1"
                    style={{
                      background: reached ? stageColor : "var(--aree-border)",
                      opacity: reached ? 0.5 : 1,
                    }}
                    aria-hidden
                  />
                </div>
                <div className="min-w-0 flex-1 pb-4">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span
                      className="text-[13px] font-bold"
                      style={{
                        color: isCurrent
                          ? stageColor
                          : reached
                            ? "var(--aree-body)"
                            : "var(--aree-dim)",
                      }}
                    >
                      {stage.stage}
                    </span>
                    <span className="aree-num text-aree-faint text-[11px]">
                      AQI {stage.low}–{stage.high}
                    </span>
                    {isCurrent ? (
                      <Pill color={stageColor} filled>
                        current
                      </Pill>
                    ) : null}
                  </div>
                  <div className="text-aree-dim mt-1 text-[11px] leading-relaxed">
                    {stage.description}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="border-aree-border mt-2 grid gap-x-8 border-t pt-3 sm:grid-cols-2">
        <KeyValue
          label="Current stage"
          value={orDash(data.grap_stage, "Not available")}
          color={color}
        />
        <KeyValue label="Raw stage (pre-hysteresis)" value={orDash(data.grap_raw_stage)} />
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
                } confirmations`
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
    <div className="grid gap-x-8 sm:grid-cols-2">
      <KeyValue
        label="Engine mode"
        value={orDash(data.engine_mode)}
        color={modeColor(data.engine_mode)}
      />
      <KeyValue label="Data type" value="Real-time short window (not 24h composite)" mono={false} />
      <KeyValue label="Last API poll" value={`${orDash(data.api_time)} UTC`} />
      <KeyValue
        label="High-AQI threshold"
        value={config ? `≥ ${config.high_aqi_threshold}` : "Not available"}
      />
      <KeyValue
        label="Sliding window"
        value={
          config
            ? `${config.window_duration_minutes} min duration · ${config.window_hop_minutes} min hop`
            : "Not available"
        }
      />
      <KeyValue label="Governance rule" value={orDash(data.governance_rule)} mono={false} />
    </div>
  );
}
