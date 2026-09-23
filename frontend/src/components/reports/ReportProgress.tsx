"use client";

/**
 * The five stages of building an escalation brief, shown while one is being built.
 *
 * WHY THE STAGES ARE SIMULATED, AND WHAT THAT COSTS
 *   ⚠ THE TIMINGS BELOW ARE SIMULATED. The report endpoint is a single request that
 *   returns the finished PDF; it emits no progress events, so nothing here is
 *   measuring the generator. The durations are an approximation of how long each
 *   phase takes in practice, and they exist so that a seven-second wait reads as work
 *   in progress rather than as a hung button.
 *
 *   REPLACE THIS WITH REAL EVENTS when the API can send them — server-sent events or
 *   a websocket frame per stage — and delete the timers. The component's shape does
 *   not need to change: it already takes the stage list as state rather than owning
 *   the clock, so a real feed can drive the same display.
 *
 *   The one thing the simulation is NOT allowed to do is outlive the truth. It never
 *   reports success on its own: only the request completing marks the stages
 *   complete, and if the request is still running when the last timer fires, the
 *   final stage stays active rather than claiming a document exists. That is why the
 *   timers advance the cursor but never finish the sequence.
 */

import { AlertCircle, Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type StageStatus = "pending" | "active" | "complete" | "failed";

export interface GenerationStage {
  id: string;
  label: string;
  /** What the stage is doing, in the operator's language rather than the code's. */
  detail: string;
  /** SIMULATED duration — see the file header. */
  simulatedMs: number;
}

export const GENERATION_STAGES: GenerationStage[] = [
  { id: "collect", label: "Collect", detail: "Gathering station data", simulatedMs: 1000 },
  {
    id: "validate",
    label: "Validate",
    detail: "Checking data completeness and freshness",
    simulatedMs: 1500,
  },
  {
    id: "analyse",
    label: "Analyse",
    detail: "Running risk and atmospheric assessment",
    simulatedMs: 2000,
  },
  { id: "evaluate", label: "Evaluate", detail: "Applying regulatory rules", simulatedMs: 1000 },
  { id: "generate", label: "Generate", detail: "Building the PDF document", simulatedMs: 2000 },
];

export interface GenerationProgress {
  /** -1 when idle. Otherwise the stage the sequence has reached. */
  cursor: number;
  /** True once the request has actually returned a document. */
  complete: boolean;
  /** The stage that was in progress when the request failed, or null. */
  failedAt: number | null;
  running: boolean;
  start: () => void;
  succeed: () => void;
  fail: () => void;
  reset: () => void;
}

/**
 * Drives the stage cursor.
 *
 * The timers are started from an event handler, never from an effect: they are a
 * side effect of the operator pressing a button, not of this component rendering,
 * and starting them on render would restart the sequence on every re-render.
 */
export function useGenerationProgress(): GenerationProgress {
  const [cursor, setCursor] = useState(-1);
  const [complete, setComplete] = useState(false);
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const [running, setRunning] = useState(false);

  const timers = useRef<number[]>([]);

  /* A plain mirror of `cursor`, so fail() can read where the sequence had got to
     without inspecting state from inside an updater. Every write to it sits beside
     the matching setCursor below, and nothing else moves the cursor, so the two
     cannot drift. */
  const cursorRef = useRef(-1);

  const clearTimers = useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
  }, []);

  // Only teardown. A component unmounting mid-generation must not leave five timers
  // writing into state that no longer has anywhere to go.
  useEffect(() => () => clearTimers(), [clearTimers]);

  const start = useCallback(() => {
    clearTimers();
    cursorRef.current = 0;
    setCursor(0);
    setComplete(false);
    setFailedAt(null);
    setRunning(true);

    /* Cumulative offsets, so each stage begins when the ones before it would have
       finished. The LAST stage is deliberately never scheduled past its own start:
       nothing advances beyond "Generate" until the request itself answers. */
    let elapsed = 0;
    for (let i = 0; i < GENERATION_STAGES.length - 1; i += 1) {
      elapsed += GENERATION_STAGES[i].simulatedMs;
      const next = i + 1;
      timers.current.push(
        window.setTimeout(() => {
          cursorRef.current = next;
          setCursor(next);
        }, elapsed),
      );
    }
  }, [clearTimers]);

  const succeed = useCallback(() => {
    clearTimers();
    cursorRef.current = GENERATION_STAGES.length;
    setCursor(GENERATION_STAGES.length);
    setComplete(true);
    setRunning(false);
  }, [clearTimers]);

  const fail = useCallback(() => {
    clearTimers();
    setRunning(false);
    // The stage that was in progress is the one that failed, as far as the operator
    // can tell — the request carries no stage of its own to blame, so the honest
    // report is "it stopped here", not a guess at which phase threw.
    setFailedAt(Math.max(0, cursorRef.current));
  }, [clearTimers]);

  const reset = useCallback(() => {
    clearTimers();
    cursorRef.current = -1;
    setCursor(-1);
    setComplete(false);
    setFailedAt(null);
    setRunning(false);
  }, [clearTimers]);

  return { cursor, complete, failedAt, running, start, succeed, fail, reset };
}

function statusOf(index: number, progress: GenerationProgress): StageStatus {
  if (progress.failedAt !== null) {
    if (index === progress.failedAt) return "failed";
    return index < progress.failedAt ? "complete" : "pending";
  }
  if (progress.complete) return "complete";
  if (index < progress.cursor) return "complete";
  if (index === progress.cursor) return "active";
  return "pending";
}

const TONE: Record<StageStatus, { color: string; border: string; background: string }> = {
  pending: {
    color: "var(--aree-faint)",
    border: "var(--aree-border)",
    background: "transparent",
  },
  active: {
    color: "var(--aree-accent)",
    border: "color-mix(in srgb, var(--aree-accent) 55%, transparent)",
    background: "color-mix(in srgb, var(--aree-accent) 10%, transparent)",
  },
  complete: {
    color: "var(--aree-green)",
    border: "color-mix(in srgb, var(--aree-green) 40%, transparent)",
    background: "color-mix(in srgb, var(--aree-green) 7%, transparent)",
  },
  failed: {
    color: "var(--aree-red)",
    border: "color-mix(in srgb, var(--aree-red) 55%, transparent)",
    background: "color-mix(in srgb, var(--aree-red) 10%, transparent)",
  },
};

/**
 * The stage list itself.
 *
 * Every transition is a plain CSS `transition` on colour, border and width — no
 * animation library, and nothing that keeps running once a stage settles. The
 * connector bar between stages fills as the sequence advances, which is what carries
 * the sense of progress when five short labels would otherwise just change colour.
 */
export default function ReportProgress({
  progress,
  stationLabel,
}: {
  progress: GenerationProgress;
  /** Named in the live announcement, so the update means something out of context. */
  stationLabel: string;
}) {
  if (progress.cursor < 0) return null;

  const active = GENERATION_STAGES[progress.cursor];
  const failed = progress.failedAt !== null ? GENERATION_STAGES[progress.failedAt] : null;

  return (
    <div
      className="rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-2 px-4 py-3.5"
      aria-label={`Report generation progress for ${stationLabel}`}
    >
      {/* One polite announcement per stage change, not one per frame: the visual
          list is decorative to a screen reader, and the sentence below is the whole
          message. */}
      <p className="sr-only" aria-live="polite">
        {failed
          ? `Report generation for ${stationLabel} failed during ${failed.label}: ${failed.detail}.`
          : progress.complete
            ? `Report for ${stationLabel} generated.`
            : active
              ? `${active.label}: ${active.detail}.`
              : ""}
      </p>

      <ol className="flex flex-wrap items-center gap-y-2">
        {GENERATION_STAGES.map((stage, index) => {
          const status = statusOf(index, progress);
          const tone = TONE[status];
          const last = index === GENERATION_STAGES.length - 1;

          return (
            <li key={stage.id} className="flex min-w-0 items-center">
              <span
                className="flex items-center gap-1.5 rounded-[var(--aree-radius-sm)] border px-2.5 py-1 text-[11px] font-bold tracking-[0.04em] transition-colors duration-300"
                style={{
                  color: tone.color,
                  borderColor: tone.border,
                  background: tone.background,
                }}
                title={stage.detail}
              >
                {status === "complete" ? (
                  <Check className="h-3 w-3 shrink-0" aria-hidden />
                ) : status === "failed" ? (
                  <AlertCircle className="h-3 w-3 shrink-0" aria-hidden />
                ) : status === "active" ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
                ) : (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: "currentColor" }}
                    aria-hidden
                  />
                )}
                {stage.label}
                {/* The status is carried as text as well as colour and icon, so the
                    list is readable without either. */}
                <span className="sr-only">
                  {status === "complete"
                    ? " complete"
                    : status === "failed"
                      ? " failed"
                      : status === "active"
                        ? " in progress"
                        : " not started"}
                </span>
              </span>

              {!last ? (
                <span
                  className="mx-1.5 h-px w-4 shrink-0 transition-colors duration-300 sm:w-6"
                  style={{
                    background:
                      status === "complete" ? "var(--aree-green)" : "var(--aree-border)",
                  }}
                  aria-hidden
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* The sentence under the row is what the operator actually reads; the chips
          above it are the shape of the process. */}
      <p className="mt-2.5 text-[11.5px] text-aree-muted">
        {failed
          ? `Stopped during ${failed.label} — ${failed.detail.toLowerCase()}.`
          : progress.complete
            ? "Report generated and downloaded."
            : active
              ? active.detail
              : ""}
      </p>
    </div>
  );
}
