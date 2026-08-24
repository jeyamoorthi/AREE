"use client";

/**
 * Escalation event timeline.
 *
 * Used nationally (every recorded GRAP transition) and per station. Events are
 * only ever those the state machine actually recorded — when there are none,
 * the component says so plainly instead of inventing a plausible history.
 */

import Link from "next/link";
import { History, TrendingUp, AlertTriangle, ArrowRight } from "lucide-react";

import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";
import { stationLabel } from "@/lib/station";
import { aqiColor, grapColor, orDash } from "@/lib/theme";
import type { EscalationsResponse } from "@/types";
import { Panel, Pill, TimelineEvent } from "./ui/Card";
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
            icon={<History className="h-4 w-4" />}
            accent="var(--aree-red)"
            padding="p-6"
            right={
              <span className="text-aree-dim text-[12px] font-medium bg-aree-surface-2 px-2.5 py-1 rounded-full border border-aree-border">
                {data.total} recorded
              </span>
            }
          >
            <div className="relative">
              {/* Continuous vertical line for the timeline */}
              <div className="absolute top-4 bottom-4 left-4 w-0.5 bg-aree-border rounded-full" aria-hidden />
              
              <div className="flex flex-col gap-1 relative">
                {events.map((event, index) => {
                  const isLast = index === events.length - 1;
                  
                  return (
                    <TimelineEvent
                      key={`${event.timestamp}-${event.city}-${index}`}
                      icon={<TrendingUp className="h-4 w-4" />}
                      iconColor={grapColor(event.to_stage)}
                      timestamp={orDash(event.timestamp)}
                      isLast={isLast}
                    >
                      <div className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          {station ? null : (
                            <Link
                              href={`/stations/${encodeURIComponent(event.city ?? "")}`}
                              className="text-aree-text hover:text-aree-accent text-[14px] font-bold transition-colors"
                            >
                              {stationLabel(event.city)}
                            </Link>
                          )}
                        </div>
                        
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-aree-muted text-[13px] font-medium bg-aree-surface-2 px-2 py-0.5 rounded">
                            {orDash(event.from_stage, "—")}
                          </span>
                          <ArrowRight className="text-aree-faint h-3.5 w-3.5" aria-hidden />
                          <Pill color={grapColor(event.to_stage)} filled>
                            {orDash(event.to_stage)}
                          </Pill>
                          
                          {event.aqi !== null && event.aqi !== undefined ? (
                            <div className="ml-2 flex items-center gap-1.5 border-l border-aree-border pl-3">
                              <span className="text-aree-muted text-[12px] uppercase tracking-wider font-semibold">
                                AQI
                              </span>
                              <span
                                className="aree-num font-bold text-[14px]"
                                style={{ color: aqiColor(event.aqi) }}
                              >
                                {event.aqi}
                              </span>
                              {event.band ? (
                                <span className="text-aree-dim text-[12px] bg-aree-surface-2 px-1.5 py-0.5 rounded border border-aree-border/50">
                                  {event.band}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                        
                        {event.trigger ? (
                          <div className="text-aree-dim mt-1 text-[13px] leading-relaxed flex items-start gap-1.5 bg-aree-surface-1 p-2 rounded-md border border-aree-border/50">
                            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                            <span>{event.trigger}</span>
                          </div>
                        ) : null}
                      </div>
                    </TimelineEvent>
                  );
                })}
              </div>
            </div>

            {data.total > limit ? (
              <div className="text-aree-dim border-aree-border mt-4 border-t pt-4 text-center text-[12px] font-medium">
                Showing {limit} most recent of {data.total} events
              </div>
            ) : null}
          </Panel>
        );
      }}
    </SectionState>
  );
}
