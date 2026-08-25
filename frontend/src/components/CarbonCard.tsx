"use client";

/**
 * Compute footprint of the decision engine.
 *
 * The national overview already receives this block inside /api/dashboard, so
 * it passes it down; anywhere else the card polls /api/carbon itself. Passing
 * `null` means "the parent is still loading" — it never triggers a second poll.
 */

import { Leaf } from "lucide-react";

import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";
import type { CarbonResponse } from "@/types";
import { Note, Panel, Stat } from "./ui/Card";
import { ErrorState, SkeletonCard } from "./ui/States";

export default function CarbonCard({ carbon }: { carbon?: CarbonResponse | null }) {
  const selfManaged = carbon === undefined;
  const state = usePolling<CarbonResponse>((signal) => api.carbon(signal), {
    intervalMs: 15000,
    enabled: selfManaged,
  });

  const data = selfManaged ? state.data : carbon;

  if (selfManaged && state.error && !state.data) {
    return <ErrorState error={state.error} onRetry={state.refresh} compact />;
  }
  if (!data) return <SkeletonCard rows={2} label="Loading compute footprint…" />;

  return (
    <Panel
      title="Carbon intensity"
      icon={<Leaf className="h-3.5 w-3.5 text-aree-accent" />}
      accent="var(--aree-green)"
      padding="p-5"
    >
      <div className="grid gap-6 rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-5 shadow-[var(--aree-shadow-sm)] sm:grid-cols-3">
        <Stat
          label="Total emissions"
          value={data.total_gco2}
          sub="gCO₂eq"
          color="#86efac"
        />
        <Stat
          label="Decisions processed"
          value={data.decision_count.toLocaleString()}
          sub="closed sliding windows"
          color="#86efac"
        />
        <Stat
          label="Per decision"
          value={data.per_decision_gco2}
          sub="gCO₂eq"
          color="#86efac"
        />
      </div>
      <div className="mt-5">
        <Note>{data.model_note}</Note>
      </div>
    </Panel>
  );
}
