"use client";

/**
 * Command center station header.
 *
 * The first line is identity only — name and feed. Coordinates, source and
 * live-channel state sit on a quieter second line, and everything else moves
 * into the advanced disclosure at the bottom of the page.
 */

import { useRouter } from "next/navigation";
import { MapPin, Radio, Activity } from "lucide-react";

import StationSelector from "@/components/StationSelector";
import { useStations } from "@/components/providers/LiveDataProvider";
import { Pill, StatusBadge } from "@/components/ui/Card";
import { freshness } from "@/lib/freshness";
import { feedLabel, stationLabel } from "@/lib/station";
import { modeColor, modeLabel, orDash } from "@/lib/theme";
import type { LiveStatus } from "@/hooks/useLiveChannel";
import type { StationDetail } from "@/types";

export default function StationHeader({
  station,
  data,
  liveStatus,
}: {
  station: string;
  data: StationDetail | null;
  liveStatus: LiveStatus;
}) {
  const router = useRouter();

  // With an unavailable feed there is no station payload at all, so identity
  // falls back to the network list — which still knows where the node is.
  const stations = useStations();
  const summary = stations.data?.stations.find((s) => s.station === station);

  const lat = data?.lat ?? summary?.lat ?? null;
  const lon = data?.lon ?? summary?.lon ?? null;
  const city = data?.city ?? summary?.city ?? null;
  const feedId = data?.feed_id ?? summary?.feed_id ?? null;

  const look = freshness(data?.freshness_status ?? summary?.freshness_status);

  const channel =
    liveStatus === "open"
      ? { color: "var(--aree-green)", label: "WebSocket connected", pulse: true }
      : liveStatus === "connecting"
        ? { color: "var(--aree-yellow)", label: "WebSocket connecting", pulse: true }
        : { color: "var(--aree-dim)", label: "Polling only", pulse: false };

  return (
    <div className="bg-aree-surface-1 border-aree-border mb-6 rounded-2xl border shadow-sm px-6 py-5 lg:px-8 lg:py-6 overflow-hidden relative">
      {/* Decorative subtle background elements */}
      <div className="absolute top-0 right-0 w-64 h-64 bg-aree-accent/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3 pointer-events-none" />
      
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-1">
            <h1 className="text-aree-text truncate text-3xl leading-tight font-black tracking-[0.04em] uppercase drop-shadow-sm">
              {stationLabel(station)}
            </h1>
            {feedLabel(feedId) ? (
              <span className="bg-aree-surface-2 border border-aree-border/50 aree-num text-aree-accent text-[13px] font-bold px-2.5 py-1 rounded-md shadow-sm">
                ID: {feedLabel(feedId)}
              </span>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] font-medium">
            <div className="flex items-center gap-1.5 text-aree-dim bg-aree-surface-2 px-2.5 py-1 rounded-full border border-aree-border/50">
              <MapPin className="h-3.5 w-3.5" />
              {lat !== null ? (
                <span className="aree-num">
                  {lat.toFixed(6)}° N{lon !== null ? ` · ${lon.toFixed(6)}° E` : ""}
                </span>
              ) : (
                <span>Coordinates not available</span>
              )}
              {city ? <span className="ml-1 pl-2 border-l border-aree-border/50">{city}</span> : null}
            </div>
            
            <div className="flex items-center gap-2 bg-aree-surface-2 px-2.5 py-1 rounded-full border border-aree-border/50 text-aree-dim">
              <Radio className="h-3.5 w-3.5" />
              <span className="text-aree-muted font-bold">WAQI Source</span>
            </div>

            <div className="flex items-center gap-2 bg-aree-surface-2 px-2.5 py-1 rounded-full border border-aree-border/50 text-aree-dim">
              <Activity className="h-3.5 w-3.5" />
              <span className="flex items-center gap-1.5">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    channel.pulse ? "animate-pulse shadow-[0_0_8px_currentColor]" : ""
                  }`}
                  style={{ background: channel.color, color: channel.color }}
                  aria-hidden
                />
                {channel.label}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-start lg:items-end gap-4 shrink-0">
          <div className="flex flex-wrap items-center justify-end gap-2.5">
            {data || summary ? (
              <StatusBadge
                color={look.color}
                pulse={(data?.freshness_status ?? summary?.freshness_status) === "current"}
              >
                {look.marker} {look.badge}
              </StatusBadge>
            ) : null}
            
            {data?.engine_mode ? (
              <Pill
                color={modeColor(data.engine_mode)}
                filled={data.engine_mode === "TRIGGERED"}
              >
                {modeLabel(data.engine_mode)}
              </Pill>
            ) : null}
            
            {data?.grap_stage ? (
              <div className="bg-aree-surface-2 border border-aree-border font-bold text-[12px] px-3 py-1 rounded-full shadow-sm flex items-center gap-1.5">
                <span className="text-aree-dim text-[10px] uppercase">GRAP</span>
                <span>{orDash(data.grap_stage)}</span>
              </div>
            ) : null}
          </div>
          
          <div className="w-full sm:w-[260px] lg:w-[300px]">
            <StationSelector
              id="station-switcher"
              compact
              value={station}
              onChange={(next) =>
                router.push(next ? `/stations/${encodeURIComponent(next)}` : "/dashboard")
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
