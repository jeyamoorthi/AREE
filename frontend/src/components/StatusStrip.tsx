"use client";

/**
 * Global status strip — five compact blocks answering "is this system live,
 * how much of the network is reporting, is the data current, is anything
 * escalating, how much work has the engine done".
 *
 * Pathway pipeline state stays visible but secondary. Every value comes from
 * /api/system/status or /api/stations; nothing here is computed optimistically.
 */

import { RefreshCw } from "lucide-react";

import { useStations, useSystemStatus } from "@/components/providers/LiveDataProvider";
import { utcClock } from "@/lib/clock";
import { errorMessage } from "@/lib/api";
import { SkeletonBar } from "@/components/ui/States";

function Block({
  value,
  label,
  color,
  sub,
  title,
}: {
  value: React.ReactNode;
  label: string;
  color?: string;
  sub?: React.ReactNode;
  title?: string;
}) {
  return (
    <div
      className="border-aree-border flex min-w-0 flex-col justify-center gap-1 border-l px-4 py-3 first:border-l-0"
      title={title}
    >
      <div
        className="aree-num aree-tabular truncate text-[15px] leading-none font-bold"
        style={{ color: color ?? "var(--aree-text)" }}
      >
        {value}
      </div>
      <div className="aree-eyebrow truncate text-[9.5px]">{label}</div>
      {sub ? <div className="text-aree-dim truncate text-[10px]">{sub}</div> : null}
    </div>
  );
}

export default function StatusStrip() {
  const state = useSystemStatus();
  const stationsState = useStations();

  const status = state.data;
  const stations = stationsState.data;

  const offline = Boolean(state.error) && !status;
  const engineDown = Boolean(status && !status.engine_loaded);
  const healthy = Boolean(status?.engine_loaded);

  const accent = offline
    ? "var(--aree-red)"
    : engineDown
      ? "var(--aree-yellow)"
      : "var(--aree-green)";

  const streamLabel = offline ? "OFFLINE" : engineDown ? "DEGRADED" : "LIVE";
  const streamSub = offline
    ? "backend unreachable"
    : engineDown
      ? "engine not loaded"
      : "streaming";

  // Active escalation = a station the state machine currently holds in
  // TRIGGERED. `escalations_recorded` is the historical count and is shown
  // separately so the two are never confused.
  const triggered = stations
    ? stations.stations.filter((s) => s.engine_mode === "TRIGGERED").length
    : null;

  const stale = status?.stale_stations ?? 0;
  const aging = status?.aging_stations ?? 0;
  const unavailable = status?.unavailable_stations ?? 0;

  const freshness = !healthy
    ? { value: "—", color: "var(--aree-dim)", label: "DATA FRESHNESS", sub: undefined as string | undefined }
    : stale > 0
      ? {
          value: `⚠ ${stale} STALE`,
          color: "var(--aree-orange)",
          label: "DATA FRESHNESS",
          sub: unavailable > 0 ? `× ${unavailable} unavailable` : undefined,
        }
      : aging > 0
        ? {
            value: `◐ ${aging} AGING`,
            color: "var(--aree-yellow)",
            label: "DATA FRESHNESS",
            sub: unavailable > 0 ? `× ${unavailable} unavailable` : undefined,
          }
        : {
            value: "● ALL CURRENT",
            color: "var(--aree-green)",
            label: "DATA FRESHNESS",
            sub: unavailable > 0 ? `× ${unavailable} unavailable` : undefined,
          };

  if (state.initialLoading && !status) {
    return (
      <div className="border-aree-border bg-aree-card mb-5 rounded-xl border px-4 py-4">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonBar key={i} height={28} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-5">
      <div
        className="bg-aree-card overflow-hidden rounded-xl border shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
        style={{ borderColor: healthy ? "var(--aree-border)" : accent }}
        role="status"
        aria-live="polite"
      >
        <div className="grid grid-cols-2 divide-y divide-[var(--aree-border)] sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-5">
          <Block
            value={
              <span className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${healthy ? "aree-live-dot" : "aree-blink"}`}
                  style={{ background: accent }}
                  aria-hidden
                />
                {streamLabel}
              </span>
            }
            label={streamSub}
            color={accent}
          />
          <Block
            value={
              status ? `${status.active_stations} / ${status.known_stations}` : "—"
            }
            label="Stations reporting"
            color="var(--aree-accent)"
            title="Stations with a usable AQI, out of all configured monitoring nodes"
          />
          <Block
            value={freshness.value}
            label={freshness.label}
            color={freshness.color}
            sub={freshness.sub}
            title="current 0–90 min · aging 90–120 min · stale over 120 min · unavailable means no usable AQI"
          />
          <Block
            value={triggered === null ? "—" : triggered}
            label="Active escalations"
            color={triggered ? "var(--aree-red)" : "var(--aree-green)"}
            sub={
              status ? `${status.escalations_recorded.toLocaleString()} recorded` : undefined
            }
            title="Stations the state machine currently holds in TRIGGERED"
          />
          <Block
            value={status ? status.decisions_processed.toLocaleString() : "—"}
            label="Decisions processed"
            color="var(--aree-body)"
            title="Closed sliding windows evaluated by the engine"
          />
        </div>
      </div>

      {/* Secondary line: pipeline, degraded subsystems, refresh. */}
      <div className="text-aree-dim mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px]">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              background: status?.pipeline === "running" ? "var(--aree-green)" : "var(--aree-dim)",
            }}
            aria-hidden
          />
          Pathway pipeline {status?.pipeline ?? "unknown"}
        </span>

        {status?.rag_status ? (
          <span>
            RAG index {status.rag_status}
            {status.rag_docs_indexed !== null && status.rag_docs_indexed !== undefined
              ? ` · ${status.rag_docs_indexed} docs`
              : ""}
          </span>
        ) : null}

        {status?.llm_ready === false ? (
          <span className="text-aree-yellow" title={status.llm_error ?? undefined}>
            Gemini fallback active
          </span>
        ) : status?.llm_ready ? (
          /* Ready but with a recorded error still means degraded — say so. */
          <span
            className={status.llm_error ? "text-aree-yellow" : undefined}
            title={status.llm_error ?? undefined}
          >
            Gemini {status.llm_model ?? "ready"}
            {status.llm_error ? " · last call failed" : ""}
          </span>
        ) : null}

        {engineDown && status?.engine_error ? (
          <span className="text-aree-yellow">{status.engine_error}</span>
        ) : null}

        {offline && state.error ? (
          <span className="text-aree-red">{errorMessage(state.error)}</span>
        ) : null}

        <span className="ml-auto flex items-center gap-2">
          <span className="aree-num">
            {utcClock(status?.server_time ?? state.lastUpdated?.toISOString()) ?? "—"}
          </span>
          <button
            type="button"
            onClick={state.refresh}
            className="hover:text-aree-accent flex items-center gap-1 transition-colors"
            aria-label="Refresh system status"
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            refresh
          </button>
        </span>
      </div>
    </div>
  );
}
