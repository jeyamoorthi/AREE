"use client";

// Polling data hook with strict cleanup: every effect aborts its in-flight
// request and clears its interval, so navigating away never leaks a timer or
// writes state into an unmounted component.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, NetworkError, TimeoutError } from "@/lib/api";

export const DEFAULT_POLL_MS = 5000;

export interface PollingState<T> {
  data: T | null;
  error: Error | null;
  /**
   * When `error` was recorded. Null whenever `error` is null.
   *
   * An error panel with no time on it is indistinguishable from one that has been
   * on screen since a problem that has already cleared, which is how an operator
   * ends up retrying something that already works.
   */
  errorAt: Date | null;
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
    /**
     * Abandon a request that has not answered within this many milliseconds and
     * surface a TimeoutError.
     *
     * Off by default, and deliberately so. Most consumers here poll on a short
     * interval against a local engine, where a slow response is followed by a
     * fresh attempt seconds later and a deadline would only produce noise. It is
     * opted into on the screens where the operator is WAITING for one specific
     * answer and needs to be told that nothing is coming, rather than watching a
     * spinner that has no end condition.
     */
    timeoutMs?: number;
  } = {},
): PollingState<T> {
  const {
    intervalMs = DEFAULT_POLL_MS,
    enabled = true,
    deps,
    refreshKey = 0,
    timeoutMs,
  } = options;

  // Identity of the current inputs. Changing it restarts polling and puts the
  // consumer back into its initial-loading state.
  const depsKey = useMemo(() => JSON.stringify(deps ?? []), [deps]);

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [errorAt, setErrorAt] = useState<Date | null>(null);
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
      const active = controller;
      setLoading(true);

      /* The deadline aborts the SAME controller the request is already using, so
         there is one cancellation path rather than two racing ones. `expired` is
         what tells the catch below which kind of abort it just caught: a cleanup
         and a deadline are indistinguishable from the AbortError alone, and one
         must be silent while the other must reach the screen. */
      let expired = false;
      const deadline =
        timeoutMs === undefined
          ? null
          : window.setTimeout(() => {
              expired = true;
              active.abort();
            }, timeoutMs);

      try {
        const result = await fetcherRef.current(active.signal);
        if (cancelled) return;
        setData(result);
        setError(null);
        setErrorAt(null);
        setLastUpdated(new Date());
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") {
          if (expired && timeoutMs !== undefined) {
            setError(new TimeoutError(timeoutMs));
            setErrorAt(new Date());
          }
          return;
        }
        if (err instanceof ApiError || err instanceof NetworkError) {
          setError(err);
        } else {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
        setErrorAt(new Date());
      } finally {
        if (deadline !== null) window.clearTimeout(deadline);
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
  }, [enabled, intervalMs, nonce, depsKey, refreshKey, timeoutMs]);

  return {
    data,
    error,
    errorAt,
    loading,
    initialLoading: enabled && resolvedKey !== depsKey,
    lastUpdated,
    refresh,
  };
}
