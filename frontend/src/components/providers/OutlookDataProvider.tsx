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
     No polling while things work. The outlook is fetched when the moment changes
     and when a decision is recorded — a 72-hour forecast does not move between
     renders, and a replay of November 2024 never moves at all.

   WHEN LIVE CANNOT ANSWER
     The backend sleeps and wakes with an empty store, so live can take a minute to
     answer or refuse (424) while it restores observations. Two things follow:

       * The last live outlook this browser saw stands in, labelled as stale — after
         SLOW_MS without an answer, or at once on a failure. See lib/outlookCache.
       * Live is retried every LIVE_RETRY_MS until it answers. The warm-up notice
         always promised "the page will load as soon as it completes", and nothing
         ever re-requested it: the page stayed on the notice until a manual reload.
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
import { ApiError, api, errorMessage } from "@/lib/api";
import { readLiveOutlook, saveLiveOutlook } from "@/lib/outlookCache";
import type { OutlookResponse } from "@/types";

/** How long a live request may be silent before the cached outlook is shown. A warm
    backend answers well inside this, so a working page never flashes stale data. */
const SLOW_MS = 3000;

/** Retry cadence while live is unavailable or stale. A restore takes a minute or
    two; this catches its end within one tick without hammering a waking server. */
const LIVE_RETRY_MS = 15000;

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

/** Set while the workspace is showing a cached live outlook instead of a fresh one. */
export interface StaleOutlook {
  /** When this browser received the payload on screen, epoch ms. */
  savedAt: number;
  /** Why live is not on screen: still waiting, or the error it answered with. */
  reason: string;
  /** True once live has actually failed, rather than merely being slow. */
  failed: boolean;
}

/**
 * What kind of failure `error` is.
 *
 * "no_data" is the backend's 424 forecast_unavailable: the observation store holds
 * nothing for that moment, and retrying cannot change it. Everything else — the
 * network, a timeout, a 5xx — is "transient" and worth another attempt.
 */
export type OutlookErrorKind = "no_data" | "transient";

function errorKindOf(err: unknown): OutlookErrorKind {
  return err instanceof ApiError &&
    (err.status === 424 || err.body?.error === "forecast_unavailable")
    ? "no_data"
    : "transient";
}

export interface OutlookDataState {
  data: OutlookResponse | null;
  loading: boolean;
  /** True while `data` is being refetched in the background (after a decision). */
  refreshing: boolean;
  error: string | null;
  errorKind: OutlookErrorKind | null;
  /** Non-null when `data` is the last cached live outlook, not a fresh answer. */
  stale: StaleOutlook | null;
  /** Index into OUTLOOK_PRESETS. */
  preset: number;
  setPreset: (index: number) => void;
  /** Refetch the current moment, showing the loading state (e.g. a Retry button). */
  reload: () => void;
  /**
   * Refetch the current moment behind the payload already on screen — used after a
   * case decision is recorded, so the page neither blanks nor loses its scroll.
   */
  refresh: () => void;
  tab: OutlookTab;
  setTab: (tab: OutlookTab) => void;
  /** A `?at=` in the URL that matches no preset; the page is showing live instead. */
  unknownAt: string | null;
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
  const [preset, setPresetState] = useState(0);
  const [tab, setTab] = useState<OutlookTab>("summary");
  const [data, setData] = useState<OutlookResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<OutlookErrorKind | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState<StaleOutlook | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped by reload() to re-run the fetch effect for the same preset.
  const [generation, setGeneration] = useState(0);
  // The request (preset + generation) that has finished, either way. A retry waits
  // for it: a cold start can take longer than LIVE_RETRY_MS, and a retry fired over a
  // request still in flight would cancel the one about to succeed.
  const [settled, setSettled] = useState<string | null>(null);
  const requestKey = `${preset}:${generation}`;

  /* The loading state is entered where the change is made, not inside the effect
     that reacts to it: setting state synchronously in an effect body costs an
     extra render on every preset switch. */
  const setPreset = useCallback((index: number) => {
    setPresetState(index);
    setLoading(true);
    setError(null);
    setErrorKind(null);
    setStale(null);
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    setErrorKind(null);
    setGeneration((g) => g + 1);
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setGeneration((g) => g + 1);
  }, []);

  /* `cancelled` also stops a slow response for a preset the reader has already
     left from overwriting the one they switched to. */
  useEffect(() => {
    let cancelled = false;
    const live = OUTLOOK_PRESETS[preset].at === undefined;

    /* Stand the cached outlook in, if there is one. Returns whether it did. */
    const showCached = (reason: string, failed: boolean): boolean => {
      const cached = live ? readLiveOutlook() : null;
      if (!cached) return false;
      setData(cached.payload);
      setError(null);
      setErrorKind(null);
      setStale({ savedAt: cached.savedAt, reason, failed });
      setLoading(false);
      return true;
    };

    /* Only on a live request that is taking cold-start long. A retry behind a stale
       banner already has the cached outlook on screen. */
    const slow = live
      ? window.setTimeout(() => {
          if (!cancelled && stale === null) {
            showCached("Waiting for the live backend to respond.", false);
          }
        }, SLOW_MS)
      : undefined;

    api
      .outlook(OUTLOOK_PRESETS[preset].at)
      .then(
        (next) => {
          if (cancelled) return;
          setData(next);
          setError(null);
          setErrorKind(null);
          setStale(null);
          if (live) saveLiveOutlook(next);
        },
        (err) => {
          if (cancelled) return;
          const message = errorMessage(err);
          if (!showCached(message, true)) {
            setData(null);
            setStale(null);
            setError(message);
            setErrorKind(errorKindOf(err));
          }
        },
      )
      .finally(() => {
        window.clearTimeout(slow);
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
          setSettled(`${preset}:${generation}`);
        }
      });
    return () => {
      cancelled = true;
      window.clearTimeout(slow);
    };
    // `stale` is read, not reacted to: a change in it must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, generation]);

  /* Keep asking live until it answers. Only for live, and only once the current
     request has settled. Replay failures are permanent (there are no observations
     for that date), so retrying them would only repeat the refusal. */
  const retrying =
    preset === 0 && settled === requestKey && (error !== null || stale !== null);
  useEffect(() => {
    if (!retrying) return;
    const timer = window.setTimeout(() => setGeneration((g) => g + 1), LIVE_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [retrying]);

  const unknownAt = useSyncPresetToUrl(OUTLOOK_PRESETS, preset, setPreset);
  useSyncTabToUrl(tab, setTab);

  /* Announced once for the workspace rather than once per view. The header and
     sidebar must not show a green LIVE pill above a reconstruction of 2024, and
     that is true on both tabs. */
  usePublishOutlookMode(data?.mode, data?.as_of);

  const value = useMemo<OutlookDataState>(
    () => ({
      data,
      loading,
      refreshing,
      error,
      errorKind,
      stale,
      preset,
      setPreset,
      reload,
      refresh,
      tab,
      setTab,
      unknownAt,
    }),
    [
      data,
      loading,
      refreshing,
      error,
      errorKind,
      stale,
      preset,
      setPreset,
      reload,
      refresh,
      tab,
      unknownAt,
    ],
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
