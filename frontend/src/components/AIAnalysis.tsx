"use client";

/**
 * AI risk interpretation.
 *
 * The Gemini call happens inside the Python engine; this only displays it —
 * and it is deliberately framed as interpretation, never as a decision. When
 * the engine falls back to deterministic analysis that is stated plainly
 * rather than hidden.
 */

import { Sparkles } from "lucide-react";

import { IntelligencePanel, Pill } from "@/components/ui/Card";
import { llmValueColor } from "@/lib/theme";
import type { AdvisoryResponse, AIResponse, StationDetail } from "@/types";

function Factor({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-aree-surface-2 border-aree-border min-w-0 rounded-lg border p-3 shadow-sm transition-colors hover:bg-aree-surface-3">
      <div className="text-aree-dim mb-1 text-[10px] font-semibold tracking-wider uppercase">{label}</div>
      <div
        className="truncate text-[14px] font-bold tracking-[0.02em]"
        style={{ color: llmValueColor(value) }}
      >
        {value}
      </div>
    </div>
  );
}

/** Which upstream sources actually contributed to this station's state. */
function sourceRows(
  data: StationDetail | null,
  advisory: AdvisoryResponse | null,
): { name: string; available: boolean; detail: string }[] {
  return [
    {
      name: "AQI",
      available: data?.aqi !== null && data?.aqi !== undefined,
      detail: data?.feed_id ? `station feed ${data.feed_id}` : "station feed",
    },
    {
      name: "Weather",
      available: data?.wind_speed !== null && data?.wind_speed !== undefined,
      detail: data?.wind_label ?? "wind telemetry",
    },
    {
      name: "Satellite",
      available: data?.firms_status === "ok",
      detail: data?.firms_dataset ?? "NASA FIRMS",
    },
    {
      name: "GRAP policy",
      available: Boolean(data?.grap_stage),
      detail: data?.grap_stage ?? "stage rules",
    },
    {
      name: "Policy documents",
      available: Boolean(advisory?.rag_docs_indexed),
      detail: advisory?.rag_policy_file ?? "indexed corpus",
    },
    {
      name: "RAG",
      available: Boolean(advisory?.rag_index_type),
      detail: advisory?.rag_index_type ?? "retrieval index",
    },
  ];
}

export default function AIAnalysis({
  ai,
  data,
  advisory,
}: {
  ai: AIResponse;
  data: StationDetail | null;
  advisory: AdvisoryResponse | null;
}) {
  const usingFallback = Boolean(ai.model && ai.model.startsWith("deterministic"));
  const sources = sourceRows(data, advisory);

  return (
    <IntelligencePanel
      title="AI risk interpretation"
      icon={<Sparkles className="h-4 w-4" />}
      right={
        <div className="flex flex-wrap items-center gap-2">
          <Pill color={usingFallback ? "var(--aree-yellow)" : "var(--aree-teal)"}>
            {usingFallback ? "Deterministic fallback" : (ai.model ?? "model")}
          </Pill>
          <Pill color={ai.cached ? "var(--aree-green)" : "var(--aree-muted)"}>
            {ai.cached ? "cached" : "fresh"}
          </Pill>
        </div>
      }
    >
      {/* Interpretation is never a decision — say so before the text is read. */}
      <div className="border-aree-border text-aree-dim border-b bg-aree-surface-2/50 px-5 py-2 text-[11px]">
        Interpretation layer. Escalation decisions are made by the deterministic engine
        above, never by this model.
      </div>

      {usingFallback ? (
        <div
          className="border-b px-5 py-3"
          style={{
            borderColor: "var(--aree-border)",
            background: "color-mix(in srgb, #eab308 10%, transparent)",
          }}
        >
          <span className="text-aree-yellow text-[11px] font-bold tracking-[0.1em] uppercase">
            ◐ Deterministic fallback active
          </span>
          <span className="text-aree-body ml-2 text-[12px]">
            {ai.error
              ? `Gemini unavailable — ${ai.error}`
              : "Gemini unavailable. The assessment below is computed deterministically from live engine values."}
          </span>
        </div>
      ) : null}

      <div className="p-6">
        <div className="text-aree-dim mb-3 text-xs font-semibold tracking-wider uppercase">Current assessment</div>
        <p className="text-aree-body text-[14px] leading-relaxed whitespace-pre-wrap">
          {ai.summary || "Awaiting the first interpretation for this station."}
        </p>
      </div>

      <div className="border-aree-border grid gap-4 border-t bg-aree-surface-1/50 px-6 py-5 sm:grid-cols-2 lg:grid-cols-4">
        <Factor label="Risk trajectory" value={ai.risk_trajectory} />
        <Factor label="Escalation likelihood" value={ai.regulatory_escalation_likelihood} />
        <Factor label="Public health risk" value={ai.public_health_risk} />
        <div className="bg-aree-surface-2 border-aree-border min-w-0 rounded-lg border p-3 shadow-sm transition-colors hover:bg-aree-surface-3">
          <div className="text-aree-dim mb-1 text-[10px] font-semibold tracking-wider uppercase">Anomaly</div>
          <div
            className="text-[14px] font-bold tracking-[0.02em]"
            style={{ color: ai.anomaly_flag ? "var(--aree-red)" : "var(--aree-green)" }}
          >
            {ai.anomaly_flag ? "Detected" : "None"}
          </div>
        </div>
      </div>

      <div className="border-aree-border border-t px-6 py-4">
        <div className="text-aree-dim mb-3 text-[10px] font-semibold tracking-wider uppercase">Sources used</div>
        <div className="flex flex-wrap gap-2.5">
          {sources.map((source) => (
            <div
              key={source.name}
              title={source.detail}
              className="bg-aree-surface-2 border-aree-border flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] shadow-sm"
              style={{
                color: source.available ? "var(--aree-body)" : "var(--aree-faint)",
              }}
            >
              <span
                aria-hidden
                className="flex h-2 w-2 rounded-full"
                style={{
                  background: source.available ? "var(--aree-green)" : "var(--aree-faint)",
                }}
              />
              <span className="font-medium">{source.name}</span>
              <span className="text-aree-faint text-[10px]">
                {source.available ? "" : "(unavailable)"}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="border-aree-border text-aree-dim flex flex-wrap gap-x-6 gap-y-2 border-t bg-aree-surface-2/30 px-6 py-3 text-[11px] font-medium">
        <span>Model: {ai.model ?? "N/A"}</span>
        <span>Temp: {ai.temperature}</span>
        <span>Mode: {ai.mode}</span>
        <span>Cooldown: 10s / station</span>
      </div>
    </IntelligencePanel>
  );
}
