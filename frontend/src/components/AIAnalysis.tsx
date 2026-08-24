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

import { Panel, Pill } from "@/components/ui/Card";
import { llmValueColor } from "@/lib/theme";
import type { AdvisoryResponse, AIResponse, StationDetail } from "@/types";

function Factor({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="aree-eyebrow mb-1 text-[10px]">{label}</div>
      <div
        className="truncate text-[13px] font-bold tracking-[0.04em] uppercase"
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
      detail: data?.feed_id ? `WAQI feed @${data.feed_id}` : "WAQI feed",
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
    <Panel
      title="AI risk interpretation"
      icon={<Sparkles className="h-3.5 w-3.5" />}
      accent="var(--aree-teal)"
      padding="p-0"
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
      <div className="border-aree-border text-aree-dim border-b px-5 py-2 text-[11px]">
        Interpretation layer. Escalation decisions are made by the deterministic engine
        above, never by this model.
      </div>

      {usingFallback ? (
        <div
          className="border-b px-5 py-3"
          style={{
            borderColor: "var(--aree-border)",
            background: "color-mix(in srgb, #eab308 7%, transparent)",
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

      <div className="p-5">
        <div className="aree-eyebrow mb-2">Current assessment</div>
        <p className="text-aree-body text-[13.5px] leading-[1.85] whitespace-pre-wrap">
          {ai.summary || "Awaiting the first interpretation for this station."}
        </p>
      </div>

      <div className="border-aree-border grid gap-5 border-t px-5 py-4 sm:grid-cols-4">
        <Factor label="Risk trajectory" value={ai.risk_trajectory} />
        <Factor label="Escalation likelihood" value={ai.regulatory_escalation_likelihood} />
        <Factor label="Public health risk" value={ai.public_health_risk} />
        <div className="min-w-0">
          <div className="aree-eyebrow mb-1 text-[10px]">Anomaly</div>
          <div
            className="text-[13px] font-bold tracking-[0.04em] uppercase"
            style={{ color: ai.anomaly_flag ? "var(--aree-red)" : "var(--aree-green)" }}
          >
            {ai.anomaly_flag ? "Detected" : "None"}
          </div>
        </div>
      </div>

      <div className="border-aree-border border-t px-5 py-4">
        <div className="aree-eyebrow mb-2.5">Sources used</div>
        <div className="flex flex-wrap gap-2">
          {sources.map((source) => (
            <span
              key={source.name}
              title={source.detail}
              className="border-aree-border flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px]"
              style={{
                color: source.available ? "var(--aree-body)" : "var(--aree-faint)",
              }}
            >
              <span
                aria-hidden
                style={{
                  color: source.available ? "var(--aree-green)" : "var(--aree-faint)",
                }}
              >
                {source.available ? "●" : "×"}
              </span>
              {source.name}
              <span className="text-aree-faint">
                {source.available ? "" : " · not available"}
              </span>
            </span>
          ))}
        </div>
      </div>

      <div className="border-aree-border text-aree-dim flex flex-wrap gap-x-5 gap-y-1 border-t px-5 py-2.5 text-[10px]">
        <span>Model {ai.model ?? "N/A"}</span>
        <span>Temperature {ai.temperature}</span>
        <span>Mode {ai.mode}</span>
        <span>10 s cooldown per station</span>
      </div>
    </Panel>
  );
}
