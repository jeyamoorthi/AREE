"use client";

/* ==========================================================================
   One outlook payload for the whole Outlook workspace.

   WHY THIS EXISTS
     Atmospheric Outlook and Ventilation Outlook were two routes, and each owned a
     complete copy of the same machinery: its own `useState<OutlookResponse>`, its
     own `api.outlook(at)` call, its own preset list, its own useSyncPresetToUrl and
     its own usePublishOutlookMode. That was tolerable while they were separate
     pages — a user could only be on one at a time.

     As two TABS of one workspace it stops being tolerable. Two independent fetches
     of the same endpoint would mean the Summary tab and the Diagnostics tab could
     be describing different moments: switch tabs across an hour boundary and the
     ventilation collapse on one tab would belong to a forecast the other never saw.
     The two views exist precisely to be read against each other, so they have to be
     reading the same payload.

   WHAT IT OWNS
     The moment (`preset` -> `as_of`), the payload, the request, the address bar and
     the page-mode announcement. The views own their rendering and nothing else.

   WHAT IT DOES NOT DO
     No polling. The outlook is fetched when the moment changes and when a decision
     is recorded, exactly as both pages did before — a 72-hour forecast does not
     move between renders, and a replay of November 2024 never moves at all.
   ========================================================================== */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { usePublishOutlookMode } from "@/components/providers/OutlookModeProvider";
import { useSyncPresetToUrl } from "@/hooks/useSyncPresetToUrl";
import { api, errorMessage } from "@/lib/api";
import type { OutlookResponse } from "@/types";

/**
 * The moments the workspace can describe.
 *
 * Merged from the two pages' own lists, which held the same three replay anchors and
 * disagreed only on the label of the live entry ("Live" vs "Live (anchored)"). One
 * selector now drives both tabs, so there is one list.
 */
export const OUTLOOK_PRESETS: readonly { label: string; at?: string }[] = [
  { label: "Live" },
  { label: "02 Nov 2024 · 06:00", at: "2024-11-02T06:00:00Z" },
  { label: "14 Nov 2024 · 00:00", at: "2024-11-14T00:00:00Z" },
  { label: "16 Nov 2024 · 00:00", at: "2024-11-16T00:00:00Z" },
];

export type OutlookTab = "summary" | "diagnostics";

export interface OutlookDataState {
  data: OutlookResponse | null;
  loading: boolean;
  error: string | null;
  /** Index into OUTLOOK_PRESETS. */
  preset: number;
  setPreset: (index: number) => void;
  /** Refetch the current moment — used after a case decision is recorded. */
  reload: () => void;
  tab: OutlookTab;
  setTab: (tab: OutlookTab) => void;
}

const Ctx = createContext<OutlookDataState | null>(null);

/**
 * Keep the active tab in the address bar.
 *
 * Same technique, and the same reasoning, as useSyncPresetToUrl: read location once
 * on mount and write with replaceState, so switching tabs is not a navigation and
 * the first client render still matches the server's. It also gives /ventilation
 * somewhere to redirect to — a bookmark of the old route lands on the view it named
 * rather than on the other one.
 */
function useSyncTabToUrl(tab: OutlookTab, setTab: (tab: OutlookTab) => void): void {
  // A ref, not state, and for the same reason useSyncPresetToUrl uses one: this guard
  // exists only to stop the first effect run from overwriting an incoming ?tab= with
  // the default. It must not itself cause a render.
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current) return;
    applied.current = true;
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (requested === "diagnostics" || requested === "summary") {
      setTab(requested);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!applied.current) return;
    const url = new URL(window.location.href);
    // "summary" is the default, so it stays out of the URL rather than decorating it.
    if (tab === "summary") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    if (url.toString() !== window.location.href) {
      window.history.replaceState(null, "", url.toString());
    }
  }, [tab]);
}

export function OutlookDataProvider({ children }: { children: ReactNode }) {
  const [preset, setPreset] = useState(0);
  const [tab, setTab] = useState<OutlookTab>("summary");
  const [data, setData] = useState<OutlookResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (at?: string) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.outlook(at));
    } catch (err) {
      setData(null);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(OUTLOOK_PRESETS[preset].at);
  }, [preset, load]);

  const reload = useCallback(() => {
    void load(OUTLOOK_PRESETS[preset].at);
  }, [load, preset]);

  useSyncPresetToUrl(OUTLOOK_PRESETS, preset, setPreset);
  useSyncTabToUrl(tab, setTab);

  /* Announced once for the workspace rather than once per view. The header and
     sidebar must not show a green LIVE pill above a reconstruction of 2024, and
     that is true on both tabs. */
  usePublishOutlookMode(data?.mode, data?.as_of);

  const value = useMemo<OutlookDataState>(
    () => ({ data, loading, error, preset, setPreset, reload, tab, setTab }),
    [data, loading, error, preset, reload, tab],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The shared outlook payload. Throws outside the workspace, deliberately. */
export function useOutlookData(): OutlookDataState {
  const value = useContext(Ctx);
  if (!value) {
    throw new Error("useOutlookData must be used inside <OutlookDataProvider>");
  }
  return value;
}
