"use client";

// Phase 17 — WebSocket event channel.
// REST polling stays the data path; this only tells the UI when something
// changed so it can refresh immediately. If the socket never connects the
// dashboard keeps working on polling alone.

import { useCallback, useEffect, useRef, useState } from "react";

import { API_URL } from "@/lib/api";
import type { LiveEvent } from "@/types";

export type LiveStatus = "connecting" | "open" | "closed";

function wsUrl(): string {
  // Same-origin when API_URL is empty (the deployment shape that puts the API behind
  // this app's own /api rewrite). "".replace(/^http/,...) leaves an empty string, and
  // "/ws/live" is not a URL a WebSocket constructor accepts — so the origin has to
  // come from the page. Also picks wss automatically when the page is served over
  // TLS, which a shared tunnel always is.
  if (!API_URL) {
    if (typeof window === "undefined") return "";
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${window.location.host}/ws/live`;
  }
  const base = API_URL.replace(/^http/, "ws");
  return `${base}/ws/live`;
}

export interface LiveChannel {
  status: LiveStatus;
  lastEvent: LiveEvent | null;
  /** Increments on every event that should trigger a data refresh. */
  revision: number;
}

export function useLiveChannel(station?: string | null): LiveChannel {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [lastEvent, setLastEvent] = useState<LiveEvent | null>(null);
  const [revision, setRevision] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | null>(null);
  const attemptsRef = useRef(0);

  const handleMessage = useCallback((event: MessageEvent<string>) => {
    let parsed: LiveEvent;
    try {
      parsed = JSON.parse(event.data) as LiveEvent;
    } catch {
      return;
    }
    setLastEvent(parsed);
    if (
      parsed.type === "station_update" ||
      parsed.type === "escalation" ||
      parsed.type === "snapshot"
    ) {
      setRevision((r) => r + 1);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let disposed = false;

    const clearRetry = () => {
      if (retryRef.current !== null) {
        window.clearTimeout(retryRef.current);
        retryRef.current = null;
      }
    };

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");

      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl());
      } catch {
        scheduleRetry();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        attemptsRef.current = 0;
        setStatus("open");
        socket.send(JSON.stringify({ action: "subscribe", station: station ?? null }));
      };

      socket.onmessage = handleMessage;

      socket.onerror = () => {
        // onclose always follows; retry is scheduled there.
      };

      socket.onclose = () => {
        if (disposed) return;
        setStatus("closed");
        scheduleRetry();
      };
    };

    const scheduleRetry = () => {
      if (disposed) return;
      clearRetry();
      attemptsRef.current += 1;
      // Back off to at most 30s so a down backend is not hammered.
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attemptsRef.current, 5));
      retryRef.current = window.setTimeout(connect, delay);
    };

    connect();

    return () => {
      disposed = true;
      clearRetry();
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close();
        }
      }
    };
  }, [station, handleMessage]);

  return { status, lastEvent, revision };
}
