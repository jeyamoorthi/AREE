"use client";

/**
 * Subscribe to the locally-stored report history.
 *
 * See lib/reportHistory for what is stored and the standing note that this is a
 * browser-local stand-in for durable storage the backend does not have yet. The
 * subscription also listens for `storage` events, so other tabs stay in step.
 */

import { useSyncExternalStore } from "react";

import {
  getReportHistorySnapshot,
  getReportHistoryServerSnapshot,
  subscribeReportHistory,
  type ReportRecord,
} from "@/lib/reportHistory";

export function useReportHistory(): ReportRecord[] {
  return useSyncExternalStore(
    subscribeReportHistory,
    getReportHistorySnapshot,
    getReportHistoryServerSnapshot,
  );
}
