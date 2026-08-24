"use client";

// Leaflet requires the DOM, so the map is loaded client-side only.

import dynamic from "next/dynamic";

import { SkeletonMap } from "@/components/ui/States";
import type { MapStation } from "./StationMap";

const StationMap = dynamic(() => import("./StationMap"), {
  ssr: false,
  loading: () => <SkeletonMap />,
});

export type { MapStation };

export default function StationMapLoader(props: {
  stations: MapStation[];
  height?: number;
  selected?: string | null;
  onSelect?: (station: string) => void;
}) {
  return <StationMap {...props} />;
}

/**
 * Shared legend. Freshness is a first-class dimension of the map, so it is
 * always explained rather than left to colour alone.
 */
export function MapLegend({ className = "" }: { className?: string }) {
  const items = [
    { marker: "●", label: "Current", detail: "0–90 min", color: "#22c55e" },
    { marker: "◐", label: "Aging", detail: "90–120 min", color: "#eab308" },
    { marker: "⚠", label: "Stale", detail: "over 120 min", color: "#f97316" },
    { marker: "×", label: "Unavailable", detail: "no usable AQI", color: "#94a3b8" },
  ];
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 p-3 shadow-[var(--aree-shadow-sm)] ${className}`}>
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5 text-[11px]">
          <span
            className="flex h-[18px] w-[18px] items-center justify-center rounded-full border text-[10px] font-bold leading-none shadow-[var(--aree-shadow-sm)]"
            style={{
              color: item.color,
              borderColor: item.color,
              background: `color-mix(in srgb, ${item.color} 12%, transparent)`,
            }}
            aria-hidden
          >
            {item.marker}
          </span>
          <span className="font-semibold text-aree-body">{item.label}</span>
          <span className="text-aree-dim">{item.detail}</span>
        </span>
      ))}
      <span className="ml-auto text-[11px] text-aree-dim">
        Marker colour follows the CPCB AQI band.
      </span>
    </div>
  );
}
