"use client";

// Leaflet requires the DOM, so the map is loaded client-side only.

import dynamic from "next/dynamic";

import { SkeletonMap } from "@/components/ui/States";
import type { MapStation } from "./StationMap";

/* The same default StationMap uses. Repeated rather than imported: importing
   anything from StationMap here would pull Leaflet into the server bundle. */
const DEFAULT_HEIGHT = "clamp(280px, 46vh, 480px)";

/* `loading` receives no props, so it cannot know the caller's height. It fills a
   wrapper that does — which keeps the skeleton the same box as the map it stands
   in for on every page, instead of the 480px default under a 440px home map. */
const StationMap = dynamic(() => import("./StationMap"), {
  ssr: false,
  loading: () => <SkeletonMap height="100%" />,
});

export type { MapStation };

export default function StationMapLoader(props: {
  stations: MapStation[];
  height?: number | string;
  selected?: string | null;
  onSelect?: (station: string) => void;
}) {
  const height = props.height ?? DEFAULT_HEIGHT;
  return (
    <div style={{ height }}>
      <StationMap {...props} height="100%" />
    </div>
  );
}

/**
 * Shared legend. Freshness is a first-class dimension of the map, so it is
 * always explained rather than left to colour alone.
 */
export function MapLegend({ className = "" }: { className?: string }) {
  const items = [
    { marker: "●", label: "Current", detail: "0–90 min", color: "var(--aree-accent)" },
    { marker: "◐", label: "Aging", detail: "90–120 min", color: "var(--aree-yellow)" },
    { marker: "⚠", label: "Stale", detail: "over 120 min", color: "var(--aree-orange)" },
    { marker: "×", label: "Unavailable", detail: "no usable AQI", color: "var(--aree-faint)" },
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
