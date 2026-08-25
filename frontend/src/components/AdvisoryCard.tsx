"use client";

/**
 * Regulatory advisory, decision trace and policy-retrieval provenance.
 *
 * The advisory text is produced by the Python RAG engine; this only renders
 * it, keeping the engine's own section structure intact so the document stays
 * auditable.
 */

import { FileText, ScrollText } from "lucide-react";

import { KeyValue, Panel, Pill, Stat } from "@/components/ui/Card";
import { modeColor, orDash } from "@/lib/theme";
import type { AdvisoryResponse } from "@/types";

export default function AdvisoryCard({ advisory }: { advisory: AdvisoryResponse }) {
  const sections = advisory.sections;

  return (
    <Panel
      title="Policy-grounded regulatory advisory"
      icon={<ScrollText className="h-3.5 w-3.5" />}
      accent="var(--aree-blue)"
      padding="p-0"
      right={
        advisory.rag_policy_file ? (
          <Pill color="var(--aree-blue)" title="Source document retrieved for this advisory">
            {advisory.rag_policy_file}
          </Pill>
        ) : null
      }
    >
      <div className="flex flex-col gap-3 p-4">
        {sections.length > 0 ? (
          sections.map((section) => (
            <div
              key={section.title}
              className="rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-4 shadow-[var(--aree-shadow-sm)]"
            >
              <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-aree-accent">
                {section.title}
              </div>
              <pre className="whitespace-pre-wrap font-mono text-[12.5px] leading-[1.75] text-aree-body">
                {section.body}
              </pre>
            </div>
          ))
        ) : (
          <div className="rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-4 shadow-[var(--aree-shadow-sm)]">
            <pre className="whitespace-pre-wrap font-mono text-[12.5px] leading-[1.75] text-aree-body">
              {advisory.advisory_text || "Advisory not generated yet."}
            </pre>
          </div>
        )}
      </div>
    </Panel>
  );
}

export function DecisionTraceCard({ advisory }: { advisory: AdvisoryResponse }) {
  const trace = advisory.decision_trace;
  if (!trace) return null;

  const escalationColor =
    trace.escalation === "TRIGGERED" ? "var(--aree-red)" : "var(--aree-green)";

  return (
    <Panel title="Decision trace" padding="p-5" accent="var(--aree-border-strong)">
      <div className="rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-4 shadow-[var(--aree-shadow-sm)]">
        <div className="grid gap-x-8 sm:grid-cols-2">
          <KeyValue label="Input AQI" value={String(trace.input_aqi ?? "—")} />
          <KeyValue label="Threshold" value={String(trace.threshold ?? "—")} />
          <KeyValue label="Persistence" value={orDash(trace.persistence)} />
          <KeyValue label="Hysteresis" value={orDash(trace.hysteresis)} />
          <KeyValue
            label="Engine mode"
            value={orDash(trace.engine_mode)}
            color={modeColor(trace.engine_mode)}
          />
          <KeyValue
            label="Escalation"
            value={orDash(trace.escalation)}
            color={escalationColor}
          />
          <KeyValue label="Reason" value={orDash(trace.reason)} mono={false} />
          {trace.stage ? <KeyValue label="Stage" value={trace.stage} /> : null}
        </div>
      </div>
    </Panel>
  );
}

export function PolicyRetrievalCard({ advisory }: { advisory: AdvisoryResponse }) {
  const score = advisory.rag_similarity_score ?? 0;
  const scoreColor =
    score > 0.5 ? "var(--aree-green)" : score > 0.3 ? "var(--aree-yellow)" : "var(--aree-orange)";

  return (
    <Panel
      title="Policy retrieval provenance"
      icon={<FileText className="h-3.5 w-3.5" />}
      accent="var(--aree-blue)"
      padding="p-5"
    >
      <div className="rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-4 shadow-[var(--aree-shadow-sm)]">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Index type"
            value={orDash(advisory.rag_index_type, "Not available")}
            color="var(--aree-blue)"
            mono={false}
            size="sm"
          />
          <Stat
            label="Source document"
            value={orDash(advisory.rag_policy_file, "None retrieved")}
            mono={false}
            size="sm"
            sub={advisory.rag_embed_model ?? undefined}
          />
          <Stat label="Similarity" value={score} color={scoreColor} />
          <Stat
            label="Documents indexed"
            value={advisory.rag_docs_indexed ?? 0}
            sub={
              advisory.rag_last_updated ? `synced ${advisory.rag_last_updated}` : undefined
            }
          />
        </div>
      </div>
    </Panel>
  );
}

export function MethodologyCard({
  pollutantsAvailable,
  highThreshold,
  persistenceThreshold,
  windowDuration,
  windowHop,
}: {
  pollutantsAvailable: number;
  highThreshold: number;
  persistenceThreshold: number;
  windowDuration: number;
  windowHop: number;
}) {
  return (
    <div className="space-y-3 rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-4 text-[12.5px] leading-[1.8] text-aree-muted shadow-[var(--aree-shadow-sm)]">
      <p>
        <span className="font-semibold text-aree-text">WAQI AQI</span> is used directly
        from the API payload for all escalation logic — the US EPA-standard AQI reported
        by the WAQI network. PM2.5 concentration is displayed for reference only. This
        station is currently reporting{" "}
        <span className="font-semibold text-aree-text">
          {pollutantsAvailable} of 6
        </span>{" "}
        pollutants.
      </p>
      <p>
        <span className="font-semibold text-aree-text">Escalation logic</span> triggers
        when AQI ≥ {highThreshold} is sustained across {persistenceThreshold} consecutive
        sliding windows ({windowDuration} min duration, {windowHop} min hop). Every
        decision is traceable to the WAQI payload timestamp and feed ID.
      </p>
    </div>
  );
}
