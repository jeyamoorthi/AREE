"use client";

/**
 * Which moment the page in front of the user is describing.
 *
 * WHY THIS EXISTS
 *   The header and sidebar show a live indicator driven by /api/system/status - it
 *   answers "is the engine up", which is a question about the SERVER. The Atmospheric and Ventilation Outlooks can be showing a reconstruction of
 *   02 November 2024 while that indicator sits on a green "LIVE" pill, so the chrome
 *   contradicted the page: the provenance banner said REPLAY at the bottom and the
 *   header said LIVE at the top.
 *
 *   "Replay is not a fake live demo" is one of the project's load-bearing claims, and it
 *   cannot be made by a screen that labels a replay LIVE. So the pages that have a mode
 *   publish it here, and the chrome prefers it over engine liveness.
 *
 * SCOPE
 *   Only the two outlook pages set a mode. Everything else clears it, so the pill falls
 *   back to reporting the engine - which is the right answer on the National Overview,
 *   where there is no as_of at all.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type OutlookMode = "live" | "replay";

export interface OutlookModeState {
  /** null when the current page has no as_of of its own. */
  mode: OutlookMode | null;
  /** The instant being described, ISO-8601, as the backend resolved it. */
  asOf: string | null;
  publish: (mode: OutlookMode | null, asOf: string | null) => void;
}

const Ctx = createContext<OutlookModeState | null>(null);

export function OutlookModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<OutlookMode | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);

  const publish = useCallback((next: OutlookMode | null, at: string | null) => {
    setMode(next);
    setAsOf(at);
  }, []);

  const value = useMemo<OutlookModeState>(
    () => ({ mode, asOf, publish }),
    [mode, asOf, publish],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read the current page mode. Safe outside the provider (returns nulls). */
export function useOutlookMode(): OutlookModeState {
  return (
    useContext(Ctx) ?? {
      mode: null,
      asOf: null,
      publish: () => undefined,
    }
  );
}

/**
 * Declare the mode of the page that renders this hook, and clear it on unmount.
 *
 * Clearing matters: without it, navigating from a 2024 replay to the National Overview
 * would leave the header claiming REPLAY on a page that is showing live stations.
 */
export function usePublishOutlookMode(
  mode: OutlookMode | null | undefined,
  asOf: string | null | undefined,
): void {
  const { publish } = useOutlookMode();

  useEffect(() => {
    publish(mode ?? null, asOf ?? null);
    return () => publish(null, null);
  }, [publish, mode, asOf]);
}
