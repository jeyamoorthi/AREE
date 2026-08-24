"use client";

/**
 * Command center station header.
 *
 * The first line is identity only — name and feed. Coordinates, source and
 * live-channel state sit on a quieter second line, and everything else moves
 * into the advanced disclosure at the bottom of the page.
 */

import { useRouter } from "next/navigation";

import StationSelector from "@/components/StationSelector";
import { useStations } from "@/components/providers/LiveDataProvider";
import { Pill } from "@/components/ui/Card";
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
      ? { color: "var(--aree-green)", label: "WebSocket connected" }
      : liveStatus === "connecting"
        ? { color: "var(--aree-yellow)", label: "WebSocket connecting" }
        : { color: "var(--aree-dim)", label: "Polling only" };

  return (
    <div className="border-aree-border bg-aree-card mb-5 rounded-xl border px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-aree-text truncate text-2xl leading-tight font-black tracking-[0.06em] uppercase">
              {stationLabel(station)}
            </h1>
            {feedLabel(feedId) ? (
              <span className="aree-num text-aree-accent text-[13px] font-semibold">
                {feedLabel(feedId)}
              </span>
            ) : null}
          </div>

          <div className="text-aree-dim mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px]">
            {lat !== null ? (
              <span className="aree-num">
                {lat.toFixed(6)}° N{lon !== null ? ` · ${lon.toFixed(6)}° E` : ""}
              </span>
            ) : (
              <span>Coordinates not available</span>
            )}
            {city ? <span>{city}</span> : null}
            <span className="text-aree-muted font-semibold">WAQI</span>
            <span className="flex items-center gap-1.5">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  liveStatus === "open" ? "aree-live-dot" : ""
                }`}
                style={{ background: channel.color }}
                aria-hidden
              />
              {channel.label}
            </span>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2.5">
          <div className="flex flex-wrap justify-end gap-2">
            {data || summary ? (
              <Pill
                color={look.color}
                filled={(data?.freshness_status ?? summary?.freshness_status) === "stale"}
              >
                {look.marker} {look.badge}
              </Pill>
            ) : null}
            {data?.engine_mode ? (
              <Pill
                color={modeColor(data.engine_mode)}
                filled={data.engine_mode === "TRIGGERED"}
              >
                {modeLabel(data.engine_mode)}
              </Pill>
            ) : null}
            {data?.grap_stage ? <Pill>GRAP {orDash(data.grap_stage)}</Pill> : null}
          </div>
          <div className="w-full min-w-[220px]">
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
