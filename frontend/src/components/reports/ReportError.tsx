"use client";

/**
 * A report failure, stated as something an authority can act on.
 *
 * Three things are always present, because each of them was missing at some point
 * and each absence cost the operator a guess: WHAT failed in plain words, WHEN it
 * failed, and — where retrying could possibly help — a control to try again. Where
 * retrying cannot help, no Retry button is offered rather than one that reliably
 * reproduces the same failure.
 */

import { AlertTriangle, RefreshCw } from "lucide-react";

import { istDateTime } from "@/lib/clock";
import { reportErrorPresentation } from "@/lib/reportErrors";

export default function ReportError({
  error,
  occurredAt,
  onRetry,
}: {
  error: Error;
  /** ISO instant recorded when the failure was caught. */
  occurredAt: string | null;
  onRetry?: () => void;
}) {
  const view = reportErrorPresentation(error);
  const at = occurredAt ? istDateTime(occurredAt) : null;

  return (
    <div
      role="alert"
      className="rounded-[var(--aree-radius-md)] px-4 py-3.5"
      style={{
        border: "1px solid color-mix(in srgb, var(--aree-red) 45%, transparent)",
        background: "color-mix(in srgb, var(--aree-red) 6%, transparent)",
      }}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0"
          style={{ color: "var(--aree-red)" }}
          aria-hidden
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span
              className="text-[13px] font-bold tracking-[0.04em]"
              style={{ color: "var(--aree-red)" }}
            >
              {view.title}
            </span>
            {/* The status is shown, not hidden behind a generic phrase: it is the
                one token a support conversation can actually be about. */}
            {view.status !== undefined ? (
              <span className="aree-num text-[11px] font-semibold text-aree-dim">
                HTTP {view.status}
              </span>
            ) : null}
          </div>

          <p className="mt-1 text-[12.5px] leading-relaxed text-aree-body">
            {view.message}
          </p>

          {/* The backend's own words, kept but subordinated. They are for the person
              who will paste them into a ticket, not for the person deciding what to
              do next. */}
          {view.detail && view.detail !== view.message ? (
            <p className="mt-1 text-[11px] break-words text-aree-muted">{view.detail}</p>
          ) : null}

          {at ? (
            <p className="aree-num mt-1.5 text-[11px] text-aree-faint">Failed at {at}</p>
          ) : null}
        </div>

        {view.retryable && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="flex shrink-0 items-center gap-1.5 rounded-[var(--aree-radius-sm)] border border-aree-border-strong px-2.5 py-1.5 text-xs font-semibold text-aree-body transition-colors hover:text-aree-accent"
            aria-label="Try generating the report again"
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}
