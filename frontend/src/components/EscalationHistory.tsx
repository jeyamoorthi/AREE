"use client";

/**
 * Escalation event timeline.
 *
 * Used nationally (every recorded GRAP transition) and per station. Events are
 * only ever those the state machine actually recorded — when there are none,
 * the component says so plainly instead of inventing a plausible history.
 */

import Link from "next/link";
import { History } from "lucide-react";

import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";
import { stationLabel } from "@/lib/station";
import { aqiColor, grapColor, orDash } from "@/lib/theme";
import type { EscalationsResponse } from "@/types";
import { Panel, Pill } from "./ui/Card";
import { EmptyState, SectionState } from "./ui/States";

export default function EscalationHistory({
  station,
  limit = 8,
  title = "Escalation timeline",
}: {
  station?: string;
  limit?: number;
  title?: string;
}) {
  const state = usePolling<EscalationsResponse>(
    (signal) => api.escalations(station, signal),
    { intervalMs: 15000, deps: [station] },
  );

  return (
    <SectionState state={state} skeletonRows={3} loadingLabel="Loading event history…">
      {(data) => {
        if (data.events.length === 0) {
          return (
            <EmptyState icon={<History className="h-5 w-5" />}>
              No escalation events recorded{station ? " for this station" : ""}. The
              timeline fills in when the state machine records a GRAP transition.
            </EmptyState>
          );
        }

        const events = data.events.slice(0, limit);

        return (
          <Panel
            title={title}
            icon={<History className="h-3.5 w-3.5" />}
            accent="var(--aree-red)"
            padding="p-5"
            right={
              <span className="text-aree-dim text-[11px]">
                {data.total} recorded
              </span>
            }
          >
            <ol className="relative">
              {/* Continuous rail behind the markers. */}
              <span
                className="bg-aree-border absolute top-1 bottom-1 left-[5px] w-px"
                aria-hidden
              />
              {events.map((event, index) => (
                <li
                  key={`${event.timestamp}-${event.city}-${index}`}
                  className="relative flex gap-4 pb-5 pl-6 last:pb-0"
                >
                  <span
                    className="absolute top-1.5 left-0 h-[11px] w-[11px] rounded-full border-2"
                    style={{
                      borderColor: grapColor(event.to_stage),
                      background: "var(--aree-bg)",
                    }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="aree-num text-aree-dim text-[11px]">
                        {orDash(event.timestamp)}
                      </span>
                      {station ? null : (
                        <Link
                          href={`/stations/${encodeURIComponent(event.city ?? "")}`}
                          className="text-aree-text hover:text-aree-accent text-[13px] font-bold transition-colors"
                        >
                          {stationLabel(event.city)}
                        </Link>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-aree-muted text-[12px]">
                        {orDash(event.from_stage, "—")}
                      </span>
                      <span className="text-aree-faint text-[12px]" aria-hidden>
                        →
                      </span>
                      <Pill color={grapColor(event.to_stage)} filled>
                        {orDash(event.to_stage)}
                      </Pill>
                      {event.aqi !== null && event.aqi !== undefined ? (
                        <span className="text-aree-muted text-[12px]">
                          AQI{" "}
                          <span
                            className="aree-num font-bold"
                            style={{ color: aqiColor(event.aqi) }}
                          >
                            {event.aqi}
                          </span>
                          {event.band ? ` · ${event.band}` : ""}
                        </span>
                      ) : null}
                    </div>
                    {event.trigger ? (
                      <div className="text-aree-dim mt-1.5 text-[11px] leading-relaxed">
                        {event.trigger}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>

            {data.total > limit ? (
              <div className="text-aree-dim border-aree-border mt-2 border-t pt-3 text-center text-[11px]">
                Showing the {limit} most recent of {data.total} recorded events
              </div>
            ) : null}
          </Panel>
        );
      }}
    </SectionState>
  );
}
