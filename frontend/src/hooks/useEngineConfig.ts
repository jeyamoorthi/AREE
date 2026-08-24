"use client";

// Engine thresholds change only on a backend restart, so they poll slowly.

import { usePolling } from "./usePolling";
import { api } from "@/lib/api";
import type { EngineConfig } from "@/types";

export function useEngineConfig() {
  return usePolling<EngineConfig>((signal) => api.systemConfig(signal), {
    intervalMs: 60000,
  });
}
