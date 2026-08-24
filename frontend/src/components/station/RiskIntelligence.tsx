"use client";

/**
 * Explainability and recommended action.
 *
 * Both panels are strictly derivative: every reason is a string the risk
 * engine emitted (`eri_factors`, `cause_factors`, `decision_trace.reason`) and
 * every recommendation is a line the policy/advisory engine produced. Nothing
 * is paraphrased into a new claim and nothing is invented to fill space.
 */

import { Check, ClipboardList, HelpCircle } from "lucide-react";

import { Panel, Pill, ProgressBar } from "@/components/ui/Card";
import { confidenceColor, eriColor, orDash } from "@/lib/theme";
import type { AdvisoryResponse, HealthImpactResponse, StationDetail } from "@/types";

/** "Why this risk?" — engine-emitted contributing factors only. */
export function RiskExplain({
  data,
  advisory,
}: {
  data: StationDetail;
  advisory: AdvisoryResponse | null;
}) {
  const eriFactors = data.eri_factors ?? [];
  const causeFactors = data.cause_factors ?? [];
  const reason =
    typeof advisory?.decision_trace?.reason === "string"
      ? advisory.decision_trace.reason
      : null;

  const confidence = data.confidence_score ?? null;
  const causeConfidence = data.cause_confidence ?? null;

  const rows: { text: string; source: string }[] = [
    ...eriFactors.map((f) => ({ text: f, source: "Escalation readiness index" })),
    ...causeFactors.map((f) => ({ text: f, source: "Causal attribution" })),
    ...(reason ? [{ text: reason, source: "Decision trace" }] : []),
  ];

  return (
    <Panel
      title="Why this risk?"
      icon={<HelpCircle className="h-3.5 w-3.5" />}
      accent={eriColor(data.eri_score)}
      padding="p-5"
      right={
        data.eri_category ? (
          <Pill color={eriColor(data.eri_score)}>
            {data.eri_category} · ERI {data.eri_score ?? 0}
          </Pill>
        ) : null
      }
    >
      {rows.length === 0 ? (
        <div className="rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-4 text-[13px] leading-relaxed text-aree-muted shadow-[var(--aree-shadow-sm)]">
          The engine reports no contributing risk factors for this station at the current
          reading. Nothing is inferred beyond that.
        </div>
      ) : (
        <ul className="space-y-2.5 rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-4 shadow-[var(--aree-shadow-sm)]">
          {rows.map((row, index) => (
            <li key={`${row.source}-${index}`} className="flex items-start gap-3">
              <Check
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-aree-green"
                aria-hidden
              />
              <span className="min-w-0">
                <span className="text-[13px] leading-relaxed text-aree-body">
                  {row.text}
                </span>
                <span className="ml-2 text-[10px] uppercase tracking-[0.08em] text-aree-faint">
                  {row.source}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {confidence !== null || causeConfidence !== null ? (
        <div className="mt-5 grid gap-5 border-t border-aree-border pt-4 sm:grid-cols-2">
          {confidence !== null ? (
            <div className="rounded-[var(--aree-radius-sm)] border border-aree-border bg-aree-surface-2 p-3">
              <div className="flex items-baseline justify-between">
                <span className="aree-eyebrow text-[10.5px]">Signal confidence</span>
                <span
                  className="aree-num text-lg font-bold"
                  style={{ color: confidenceColor(confidence) }}
                >
                  {confidence}%
                </span>
              </div>
              <div className="mt-1">
                <ProgressBar
                  percent={confidence}
                  color={confidenceColor(confidence)}
                  label="Signal confidence"
                />
              </div>
              <div className="mt-2 text-[10.5px] text-aree-dim">
                AQI · satellite · wind agreement
              </div>
            </div>
          ) : null}

          {causeConfidence !== null ? (
            <div className="rounded-[var(--aree-radius-sm)] border border-aree-border bg-aree-surface-2 p-3">
              <div className="flex items-baseline justify-between">
                <span className="aree-eyebrow text-[10.5px]">Cause confidence</span>
                <span
                  className="aree-num text-lg font-bold"
                  style={{ color: confidenceColor(causeConfidence * 100) }}
                >
                  {Math.round(causeConfidence * 100)}%
                </span>
              </div>
              <div className="mt-1">
                <ProgressBar
                  percent={causeConfidence * 100}
                  color={confidenceColor(causeConfidence * 100)}
                  label="Cause confidence"
                />
              </div>
              <div className="mt-2 text-[10.5px] text-aree-dim">
                Attributed cause: {orDash(data.pollution_cause?.replace(/_/g, " "))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

/** Pull the action list out of the advisory the policy engine generated. */
function advisoryActions(advisory: AdvisoryResponse | null): {
  title: string;
  items: string[];
} | null {
  if (!advisory) return null;
  const section = advisory.sections.find((s) =>
    ["MANDATORY ACTIONS", "PREPARED PROTOCOL"].includes(s.title.toUpperCase()),
  );
  if (!section) return null;
  const items = section.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.replace(/^-\s*/, ""))
    .filter(Boolean);
  return items.length > 0 ? { title: section.title, items } : null;
}

/**
 * Recommended action.
 *
 * Two sources, both engine-owned: the advisory's action block (policy-grounded)
 * and the deterministic pre-emptive public-health advisory. If neither exists,
 * that is stated rather than filled in.
 */
export function RecommendedAction({
  advisory,
  health,
}: {
  advisory: AdvisoryResponse | null;
  health: HealthImpactResponse | null;
}) {
  const actions = advisoryActions(advisory);
  const preemptive = health?.preemptive_advisory ?? [];
  const hasAny = Boolean(actions) || preemptive.length > 0;

  return (
    <Panel
      title="Recommended action"
      icon={<ClipboardList className="h-3.5 w-3.5" />}
      accent="var(--aree-blue)"
      padding="p-5"
      right={
        actions ? (
          <Pill color="var(--aree-blue)">{actions.title.toLowerCase()}</Pill>
        ) : null
      }
    >
      {!hasAny ? (
        <div className="rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-4 text-[13px] leading-relaxed text-aree-muted shadow-[var(--aree-shadow-sm)]">
          No action has been issued by the policy engine for the current state.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {actions ? (
            <div className="rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-5 shadow-[var(--aree-shadow-sm)]">
              <ol className="space-y-3">
                {actions.items.map((item, index) => (
                  <li key={item} className="flex items-start gap-3">
                    <span
                      className="aree-num flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-aree-blue/10 text-[10.5px] font-bold text-aree-blue"
                      aria-hidden
                    >
                      {index + 1}
                    </span>
                    <span className="text-[13px] leading-relaxed text-aree-body">
                      {item}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {preemptive.length > 0 ? (
            <div
              className="rounded-[var(--aree-radius-md)] border p-4 shadow-[var(--aree-shadow-sm)]"
              style={{
                borderColor: "color-mix(in srgb, var(--aree-red) 35%, transparent)",
                background: "color-mix(in srgb, var(--aree-red) 5%, transparent)",
              }}
            >
              <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.12em] text-aree-red">
                ⚠ Pre-emptive public health advisory
              </div>
              <ul className="space-y-2">
                {preemptive.map((item) => (
                  <li key={item} className="text-[13px] leading-relaxed text-aree-amber">
                    ▸ {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      <p className="mt-5 border-t border-aree-border pt-4 text-[11.5px] leading-relaxed text-aree-dim">
        Actions are produced by the deterministic advisory and policy-retrieval engines
        from the current GRAP stage. They are not generated by the language model.
      </p>
    </Panel>
  );
}
