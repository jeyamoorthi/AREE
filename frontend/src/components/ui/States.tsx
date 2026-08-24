"use client";

import { AlertTriangle, Loader2, RefreshCw, SatelliteDish, WifiOff } from "lucide-react";
import type { ReactNode } from "react";

import { ApiError, NetworkError } from "@/lib/api";
import { Card } from "./Card";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <Card className="flex items-center justify-center gap-3 py-10 text-center">
      <Loader2 className="h-5 w-5 animate-spin" style={{ color: "var(--aree-accent)" }} aria-hidden />
      <span className="text-aree-muted text-[13px]">{label}</span>
    </Card>
  );
}

export function EmptyState({
  children,
  icon,
}: {
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <Card className="py-8 text-center">
      {icon ? (
        <div className="text-aree-faint mb-3 flex justify-center" aria-hidden>
          {icon}
        </div>
      ) : null}
      <div className="text-aree-muted mx-auto max-w-md text-[13px] leading-relaxed">
        {children}
      </div>
    </Card>
  );
}

export function SkeletonBar({
  width = "100%",
  height = 12,
  className = "",
}: {
  width?: string;
  height?: number;
  className?: string;
}) {
  return (
    <div
      className={`aree-skeleton ${className}`}
      style={{ width, height, borderRadius: "var(--aree-radius-sm)" }}
      aria-hidden
    />
  );
}

export function SkeletonCard({
  rows = 3,
  label,
}: {
  rows?: number;
  label?: string;
}) {
  return (
    <Card>
      <div role="status" aria-live="polite" className="space-y-3">
        {label ? (
          <div className="text-aree-dim mb-3 flex items-center gap-2 text-[11px] tracking-[0.1em] uppercase">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {label}
          </div>
        ) : null}
        {Array.from({ length: rows }).map((_, i) => (
          <SkeletonBar key={i} width={`${90 - i * 13}%`} height={12} />
        ))}
      </div>
    </Card>
  );
}

export function SkeletonMap({ height = 460 }: { height?: number }) {
  return (
    <div
      className="border-aree-border bg-aree-surface-1 flex flex-col items-center justify-center gap-3 border"
      style={{ height, borderRadius: "var(--aree-radius-lg)" }}
      role="status"
      aria-live="polite"
    >
      <SatelliteDish className="text-aree-faint h-6 w-6 animate-pulse" aria-hidden />
      <span className="text-aree-muted text-[13px]">Loading station network…</span>
    </div>
  );
}

export function AnalysisSkeleton({
  steps = ["AQI", "Persistence", "Weather", "Policy"],
}: {
  steps?: string[];
}) {
  return (
    <Card>
      <div role="status" aria-live="polite">
        <div className="text-aree-muted mb-4 flex items-center gap-2 text-[11px] font-bold tracking-[0.12em] uppercase">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Analyzing environmental conditions…
        </div>
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-2">
          {steps.map((step, i) => (
            <li key={step} className="flex items-center gap-2">
              <span
                className="border-aree-border text-aree-muted border px-2.5 py-1 text-[11px] font-semibold"
                style={{
                  animation: `aree-blink 1.6s ease-in-out ${i * 0.25}s infinite`,
                  borderRadius: "var(--aree-radius-sm)",
                }}
              >
                {step}
              </span>
              {i < steps.length - 1 ? (
                <span className="text-aree-faint text-xs" aria-hidden>
                  →
                </span>
              ) : null}
            </li>
          ))}
        </ol>
        <div className="mt-4 space-y-2.5">
          <SkeletonBar width="92%" />
          <SkeletonBar width="78%" />
          <SkeletonBar width="60%" />
        </div>
      </div>
    </Card>
  );
}

export interface ErrorStateProps {
  error: Error;
  onRetry?: () => void;
  compact?: boolean;
}

export function ErrorState({ error, onRetry, compact = false }: ErrorStateProps) {
  const isNetwork = error instanceof NetworkError;
  const apiError = error instanceof ApiError ? error : null;
  const warming = apiError?.isWarmingUp ?? false;
  const feedDown = apiError?.isFeedUnavailable ?? false;

  const accent = warming
    ? "#eab308"
    : feedDown
      ? "#8a9bb4"
      : isNetwork
        ? "#ef4444"
        : "#f97316";

  const title = warming
    ? "AWAITING TELEMETRY"
    : feedDown
      ? apiError?.body?.error === "feed_error"
        ? "× FEED ERROR"
        : "× FEED UNAVAILABLE"
      : isNetwork
        ? "⚠ BACKEND OFFLINE"
        : (apiError?.body?.error?.replace(/_/g, " ").toUpperCase() ?? "REQUEST FAILED");

  const lead = warming
    ? null
    : feedDown
      ? "No usable AQI is available from this feed."
      : isNetwork
        ? "AREE intelligence engine is unavailable."
        : null;

  const Icon = warming ? Loader2 : isNetwork ? WifiOff : AlertTriangle;
  const showRetry = Boolean(onRetry) && !feedDown;

  return (
    <div
      className={compact ? "px-4 py-3" : "px-5 py-4"}
      style={{
        borderRadius: "var(--aree-radius-md)",
        border: `1px solid color-mix(in srgb, ${accent} 45%, transparent)`,
        background: `color-mix(in srgb, ${accent} 6%, transparent)`,
      }}
      role={warming ? "status" : "alert"}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${warming ? "animate-spin" : ""}`}
          style={{ color: accent }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div
            className="text-[13px] font-bold tracking-[0.08em]"
            style={{ color: accent }}
          >
            {title}
          </div>
          {lead ? (
            <div className="text-aree-body mt-1 text-[13px]">{lead}</div>
          ) : null}
          <div className="text-aree-muted mt-1 text-xs break-words">{error.message}</div>
          {apiError?.hint ? (
            <div className="text-aree-dim mt-1 text-xs">{apiError.hint}</div>
          ) : null}
        </div>
        {showRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="border-aree-border-strong text-aree-body hover:text-aree-accent flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold transition-colors"
            style={{
              border: "1px solid var(--aree-border-strong)",
              borderRadius: "var(--aree-radius-sm)",
            }}
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function SectionState<T>({
  state,
  children,
  emptyMessage,
  skeletonRows,
  skeleton,
  loadingLabel,
}: {
  state: {
    data: T | null;
    error: Error | null;
    initialLoading: boolean;
    refresh: () => void;
  };
  children: (data: T) => ReactNode;
  emptyMessage?: string;
  skeletonRows?: number;
  skeleton?: ReactNode;
  loadingLabel?: string;
}) {
  if (state.initialLoading) {
    return <>{skeleton ?? <SkeletonCard rows={skeletonRows} label={loadingLabel} />}</>;
  }

  if (state.error && !state.data) {
    return <ErrorState error={state.error} onRetry={state.refresh} />;
  }

  if (!state.data) {
    return <EmptyState>{emptyMessage ?? "No data available yet."}</EmptyState>;
  }

  return (
    <>
      {state.error ? (
        <div className="mb-3">
          <ErrorState error={state.error} onRetry={state.refresh} compact />
        </div>
      ) : null}
      {children(state.data)}
    </>
  );
}
