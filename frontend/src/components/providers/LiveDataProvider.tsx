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
import type { StationListResponse, SystemStatus } from "@/types";

const SYSTEM_POLL_MS = 5000;
const STATIONS_POLL_MS = 15000;

const SystemStatusContext = createContext<PollingState<SystemStatus> | null>(null);
const StationsContext = createContext<PollingState<StationListResponse> | null>(null);

export function LiveDataProvider({ children }: { children: ReactNode }) {
  const systemStatus = usePolling<SystemStatus>((signal) => api.systemStatus(signal), {
    intervalMs: SYSTEM_POLL_MS,
  });
  const stations = usePolling<StationListResponse>((signal) => api.stations(signal), {
    intervalMs: STATIONS_POLL_MS,
  });

  return (
    <SystemStatusContext.Provider value={systemStatus}>
      <StationsContext.Provider value={stations}>{children}</StationsContext.Provider>
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
