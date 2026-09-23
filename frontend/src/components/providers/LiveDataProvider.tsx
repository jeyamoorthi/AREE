"use client";

/**
 * One poll per shared dataset, for the whole application.
 *
 * The header, status strip, national map, station selector, command palette
 * and report centre all need the same two payloads. Fetching them here means
 * one request per interval instead of one per component, and every surface
 * renders exactly the same numbers at the same time.
 */

import { createContext, useContext, type ReactNode } from "react";

import { usePolling, type PollingState } from "@/hooks/usePolling";
import { api } from "@/lib/api";
import type { OutlookResponse, StationListResponse, SystemStatus } from "@/types";

const SYSTEM_POLL_MS = 5000;
const STATIONS_POLL_MS = 15000;

/**
 * How long the station network gets to answer before the request is abandoned.
 *
 * WHY THIS ONE POLL AND NOT THE OTHER TWO
 *   The station list is the dataset an operator WAITS on: the report centre, the
 *   selector and the map are all unusable until it lands, and without a deadline a
 *   request that never returns leaves a spinner with no end condition. System status
 *   polls every five seconds and would replace a slow answer with a fresh attempt
 *   long before any sensible deadline; putting one there would only manufacture
 *   errors for a subsystem that is merely busy.
 *
 * WHY TEN SECONDS AND NOT THE FIFTEEN OF THE INTERVAL
 *   It has to expire strictly INSIDE the polling period, or a slow response and the
 *   next scheduled attempt collide and the screen never settles. Ten leaves a clear
 *   five-second gap.
 */
const STATIONS_TIMEOUT_MS = 10000;

/* The LIVE outlook, for chrome that has to show the intervention window on every
   page — currently the critical-alert banner.
 *
 * WHY IT IS HERE AND NOT IN THE BANNER
 *   Same reason as the other two: one request per interval for the whole app rather
 *   than one per component. A second consumer of the window later gets it free.
 *
 * WHY SIXTY SECONDS
 *   The window it carries is published in hours and moves by the hour. Polling it at
 *   the station cadence would be fifteen times the traffic for a number that cannot
 *   have changed. The countdown itself ticks locally, once a minute, in
 *   InterventionTimer — the clock does not need the network to keep moving.
 *
 * WHY NO `at`
 *   Deliberately always live. This feeds application chrome that is on screen while
 *   the user is anywhere, including pages with no as_of at all; the outlook PAGES own
 *   their own replay-parameterised fetch and must not be driven from here.
 *
 * WHY IT IS GATED
 *   /api/aree/outlook is the most expensive endpoint in the application: it runs the
 *   forecast, the ventilation assessment and the case derivation for one moment. Its
 *   only consumer here is the alert banner, which renders nothing unless a station is
 *   TRIGGERED — so on an ordinary day this costs no requests at all, and it starts
 *   only when there is something for it to describe.
 */
const OUTLOOK_POLL_MS = 60000;

const SystemStatusContext = createContext<PollingState<SystemStatus> | null>(null);
const StationsContext = createContext<PollingState<StationListResponse> | null>(null);
const LiveOutlookContext = createContext<PollingState<OutlookResponse> | null>(null);

export function LiveDataProvider({ children }: { children: ReactNode }) {
  const systemStatus = usePolling<SystemStatus>((signal) => api.systemStatus(signal), {
    intervalMs: SYSTEM_POLL_MS,
  });
  const stations = usePolling<StationListResponse>((signal) => api.stations(signal), {
    intervalMs: STATIONS_POLL_MS,
    timeoutMs: STATIONS_TIMEOUT_MS,
  });
  const anyTriggered = (stations.data?.stations ?? []).some(
    (s) => s.engine_mode === "TRIGGERED",
  );
  const liveOutlook = usePolling<OutlookResponse>((signal) => api.outlook(undefined, signal), {
    intervalMs: OUTLOOK_POLL_MS,
    enabled: anyTriggered,
  });

  return (
    <SystemStatusContext.Provider value={systemStatus}>
      <StationsContext.Provider value={stations}>
        <LiveOutlookContext.Provider value={liveOutlook}>
          {children}
        </LiveOutlookContext.Provider>
      </StationsContext.Provider>
    </SystemStatusContext.Provider>
  );
}

export function useSystemStatus(): PollingState<SystemStatus> {
  const value = useContext(SystemStatusContext);
  if (!value) {
    throw new Error("useSystemStatus must be used inside <LiveDataProvider>");
  }
  return value;
}

export function useStations(): PollingState<StationListResponse> {
  const value = useContext(StationsContext);
  if (!value) {
    throw new Error("useStations must be used inside <LiveDataProvider>");
  }
  return value;
}

/**
 * The live AREE outlook, shared by application chrome.
 *
 * NOT for the outlook pages: they take an `as_of` and must keep their own fetch, or
 * a replay of November 2024 would be driven by a poll that is always live.
 */
export function useLiveOutlook(): PollingState<OutlookResponse> {
  const value = useContext(LiveOutlookContext);
  if (!value) {
    throw new Error("useLiveOutlook must be used inside <LiveDataProvider>");
  }
  return value;
}
