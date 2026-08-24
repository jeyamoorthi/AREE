"use client";

/**
 * Command Center. Station-centric: pick a node and the whole page becomes that
 * station. The choice is reflected in ?station= so the view is shareable and
 * survives a reload.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback } from "react";
import { Crosshair } from "lucide-react";

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
        <h1 className="text-3xl font-light tracking-tight text-[#17231c] mb-2">Command Center</h1>
        <p className="text-sm text-[#64748b] max-w-2xl leading-relaxed">
          Select a monitoring node to open its full regulatory intelligence view.
        </p>
      </div>

      <IntelligencePanel
        title="Monitoring control"
        variant="default"
      >
        <div className="p-6">
          <div className="flex items-start gap-4 mb-6">
            <div className="w-10 h-10 rounded-full bg-[#143828]/10 flex items-center justify-center shrink-0">
              <Crosshair className="text-[#143828] w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-medium text-[#17231c]">Target Node</h3>
              <p className="text-sm text-[#64748b] mt-1">Select a specific environmental station to view its live telemetry and regulatory state.</p>
            </div>
          </div>
          
          <StationSelector value={station} onChange={handleChange} />
          
          <div className="mt-6 p-4 bg-[#faf9f4] border border-[#e4e0d4] rounded-lg flex items-center gap-3">
            <p className="text-xs text-[#64748b] leading-relaxed flex-1">
              No node is currently targeted. Press{" "}
              <kbd className="bg-white border border-[#e4e0d4] text-[#17231c] rounded px-1.5 py-0.5 font-mono text-[10px] mx-1">
                Ctrl K
              </kbd>{" "}
              to search the network for stations, active policies, and recent escalation events.
            </p>
          </div>
        </div>
      </IntelligencePanel>

      {/* Policy intelligence is network-wide, so it stays available even with
          no station selected. */}
      <div className="pt-4">
        <SectionHeader index="01">Policy intelligence</SectionHeader>
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
