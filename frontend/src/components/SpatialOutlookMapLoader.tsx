"use client";

// Leaflet needs the DOM, so the map is client-only. Same pattern as
// StationMapLoader — one place that knows about SSR, not every caller.

import dynamic from "next/dynamic";

import type { SpatialStation } from "./SpatialOutlookMap";

const SpatialOutlookMap = dynamic(() => import("./SpatialOutlookMap"), {
  ssr: false,
  loading: () => (
    <div
      className="flex items-center justify-center rounded-lg"
      style={{ height: 260, background: "#faf8f2", color: "#a8a196", fontSize: 12 }}
    >
      Loading map…
    </div>
  ),
});

export type { SpatialStation };

export default function SpatialOutlookMapLoader(props: {
  stations: SpatialStation[];
  height?: number;
  labelCount?: number;
  /** The hour every reading on the map describes. */
  observedAt?: string;
  /** How far before as_of that hour sits — drives the ageing cue. */
  ageHours?: number;
}) {
  return <SpatialOutlookMap {...props} />;
}
