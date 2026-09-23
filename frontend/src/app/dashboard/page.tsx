"use client";

/**
 * Command Center. Station-centric: pick a node and the whole page becomes that
 * station. The choice is reflected in ?station= so the view is shareable and
 * survives a reload.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback } from "react";
import { Crosshair } from "lucide-react";

import EscalationHistory from "@/components/EscalationHistory";
import PolicyConsole from "@/components/PolicyConsole";
import StationDashboard from "@/components/StationDashboard";
import StationSelector from "@/components/StationSelector";
import { IntelligencePanel, SectionHeader } from "@/components/ui/Card";
import { LoadingState } from "@/components/ui/States";

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const station = searchParams.get("station");

  const handleChange = useCallback(
    (next: string | null) => {
      router.replace(
        next ? `/dashboard?station=${encodeURIComponent(next)}` : "/dashboard",
      );
    },
    [router],
  );

  if (station) return <StationDashboard station={station} />;

  return (
    <div className="max-w-[1400px] mx-auto space-y-8 pb-12">
      <div className="mb-8">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-aree-text mb-2">Command Center</h1>
        <p className="text-sm text-aree-muted max-w-2xl leading-relaxed">
          Select a monitoring node to open its full regulatory intelligence view.
        </p>
      </div>

      <IntelligencePanel
        title="Monitoring control"
        variant="default"
      >
        <div className="p-4 sm:p-6">
          <div className="flex items-start gap-4 mb-6">
            <div className="w-10 h-10 rounded-full bg-aree-forest/10 flex items-center justify-center shrink-0">
              <Crosshair className="text-aree-forest w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-medium text-aree-text">Target Node</h3>
              <p className="text-sm text-aree-muted mt-1">Select a specific environmental station to view its live telemetry and regulatory state.</p>
            </div>
          </div>
          
          <StationSelector value={station} onChange={handleChange} />
          
          <div className="mt-6 p-4 bg-aree-surface-2 border border-aree-border rounded-lg flex items-center gap-3">
            <p className="text-xs text-aree-muted leading-relaxed flex-1">
              No node is currently targeted. Press{" "}
              <kbd className="bg-aree-surface-1 border border-aree-border text-aree-text rounded px-1.5 py-0.5 font-mono text-[10px] mx-1">
                Ctrl K
              </kbd>{" "}
              to search the network for stations, active policies, and recent escalation events.
            </p>
          </div>
        </div>
      </IntelligencePanel>

      {/* The audit trail, network-wide, and the only place the two halves of the
          decision chain are read against each other: what the engine escalated, and
          what the authority then did about it. It lives here rather than on a station
          page because a case is raised for the airshed, not for one monitor. */}
      <div className="pt-4">
        <SectionHeader index="01">Decision log</SectionHeader>
        <EscalationHistory
          title="Escalations and authority decisions"
          limit={10}
          showDecisions
        />
      </div>

      {/* Policy intelligence is network-wide, so it stays available even with
          no station selected. */}
      <div className="pt-4">
        <SectionHeader index="02">Policy intelligence</SectionHeader>
        <div id="policy-intelligence" className="scroll-mt-24">
          <PolicyConsole />
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading command center…" />}>
      <DashboardContent />
    </Suspense>
  );
}
