"use client";

/**
 * Command Center. Station-centric: pick a node and the whole page becomes that
 * station. The choice is reflected in ?station= so the view is shareable and
 * survives a reload.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback } from "react";
import { Radio } from "lucide-react";

import PolicyConsole from "@/components/PolicyConsole";
import StationDashboard from "@/components/StationDashboard";
import StationSelector from "@/components/StationSelector";
import { Panel, SectionHeader } from "@/components/ui/Card";
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
    <>
      <div className="mb-4">
        <h1 className="aree-page-title">Command Center</h1>
        <p className="text-aree-dim mt-1 text-[12px]">
          Select a monitoring node to open its full regulatory intelligence view.
        </p>
      </div>

      <Panel
        title="Monitoring control"
        icon={<Radio className="h-3.5 w-3.5" />}
        accent="var(--aree-accent)"
        padding="p-5"
      >
        <StationSelector value={station} onChange={handleChange} />
        <p className="text-aree-dim mt-4 text-[11.5px] leading-relaxed">
          No node is selected, so no regulatory state is shown. Press{" "}
          <kbd className="border-aree-border text-aree-muted rounded border px-1.5 py-0.5 font-mono text-[10px]">
            Ctrl K
          </kbd>{" "}
          to search stations, policies and events from anywhere.
        </p>
      </Panel>

      {/* Policy intelligence is network-wide, so it stays available even with
          no station selected. */}
      <SectionHeader index="01">Policy intelligence</SectionHeader>
      <div id="policy-intelligence" className="scroll-mt-24">
        <PolicyConsole />
      </div>
    </>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading command center…" />}>
      <DashboardContent />
    </Suspense>
  );
}
