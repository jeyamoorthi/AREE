"use client";

// Polling data hook with strict cleanup: every effect aborts its in-flight
// request and clears its interval, so navigating away never leaks a timer or
// writes state into an unmounted component.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, NetworkError } from "@/lib/api";

export const DEFAULT_POLL_MS = 5000;

export interface PollingState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** True until the first response for the current inputs has resolved. */
  initialLoading: boolean;
  lastUpdated: Date | null;
  refresh: () => void;
}

export function usePolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: {
    intervalMs?: number;
    enabled?: boolean;
    deps?: unknown[];
    /**
     * Bumping this refetches immediately without showing the initial-loading
     * state — used by the WebSocket channel to pull fresh data on an event.
     */
    refreshKey?: string | number;
  } = {},
): PollingState<T> {
  const { intervalMs = DEFAULT_POLL_MS, enabled = true, deps, refreshKey = 0 } = options;

  // Identity of the current inputs. Changing it restarts polling and puts the
  // consumer back into its initial-loading state.
  const depsKey = useMemo(() => JSON.stringify(deps ?? []), [deps]);

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [resolvedKey, setResolvedKey] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [nonce, setNonce] = useState(0);

  // Keep the latest fetcher without making it an effect dependency; assigning
  // in an effect (not during render) keeps refs off the render path.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let controller: AbortController | null = null;

    const run = async () => {
      controller?.abort();
      controller = new AbortController();
      setLoading(true);

      try {
        const result = await fetcherRef.current(controller.signal);
        if (cancelled) return;
        setData(result);
        setError(null);
        setLastUpdated(new Date());
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (err instanceof ApiError || err instanceof NetworkError) {
          setError(err);
        } else {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setResolvedKey(depsKey);
        }
      }
    };

    void run();
    const timer = window.setInterval(run, intervalMs);

    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [enabled, intervalMs, nonce, depsKey, refreshKey]);

  return {
    data,
    error,
    loading,
    initialLoading: enabled && resolvedKey !== depsKey,
    lastUpdated,
    refresh,
  };
}
