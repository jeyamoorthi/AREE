"use client";

/**
 * Station selection. Reads the shared station list — no poll of its own — so
 * the options always match the map, the palette and the report centre.
 */

import { ChevronDown } from "lucide-react";

import { useStations } from "@/components/providers/LiveDataProvider";
import { freshness } from "@/lib/freshness";
import { feedLabel, stationLabel } from "@/lib/station";
import { aqiColor } from "@/lib/theme";
import { ErrorState } from "./ui/States";

export interface StationSelectorProps {
  value: string | null;
  onChange: (station: string | null) => void;
  label?: string;
  /** Compact form for headers: no label, no summary line. */
  compact?: boolean;
  id?: string;
}

export default function StationSelector({
  value,
  onChange,
  label = "Monitoring sensor node",
  compact = false,
  id = "station-select",
}: StationSelectorProps) {
  const state = useStations();
  const stations = state.data?.stations ?? [];
  const selected = stations.find((s) => s.station === value);

  const select = (
    <div className="relative shadow-[var(--aree-shadow-sm)]">
      <select
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={state.initialLoading || stations.length === 0}
        aria-label={compact ? "Switch monitoring station" : undefined}
        className={`w-full appearance-none rounded-[var(--aree-radius-md)] border border-aree-border bg-aree-surface-1 text-aree-body outline-none transition-all focus:border-aree-accent focus:ring-1 focus:ring-aree-accent/30 disabled:opacity-60 ${
          compact ? "py-1.5 pl-3 pr-9 text-[12.5px]" : "py-2.5 pl-3.5 pr-10 text-sm"
        }`}
      >
        <option value="">
          {state.initialLoading
            ? "Loading stations…"
            : stations.length === 0
              ? "No stations available"
              : compact
                ? "Switch station…"
                : "— Select a monitoring node —"}
        </option>
        {stations.map((s) => {
          const look = freshness(s.freshness_status);
          return (
            <option key={s.station} value={s.station}>
              {look.marker} {stationLabel(s.station)}
              {s.has_data
                ? ` — AQI ${s.aqi} (${s.cpcb_band})` +
                  (s.freshness_status === "current" ? "" : ` · ${look.label.toLowerCase()}`)
                : s.feed_status === "no_aqi"
                  ? " — feed reports no AQI"
                  : s.feed_status === "error"
                    ? " — feed error"
                    : " — awaiting data"}
            </option>
          );
        })}
      </select>
      <ChevronDown
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-aree-muted ${
          compact ? "right-2.5 h-3.5 w-3.5" : "right-3.5 h-4 w-4"
        }`}
        aria-hidden
      />
    </div>
  );

  if (compact) return select;

  return (
    <div className="flex flex-col gap-2.5">
      <label htmlFor={id} className="aree-eyebrow">
        {label}
      </label>

      {select}

      {state.error && !state.data ? (
        <ErrorState error={state.error} onRetry={state.refresh} compact />
      ) : null}

      {state.data ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-aree-dim">
          <span>
            {state.data.active} active / {state.data.total} available
            {state.data.aging > 0 ? ` · ${state.data.aging} aging` : ""}
            {state.data.stale > 0 ? ` · ${state.data.stale} stale` : ""}
            {state.data.unavailable > 0 ? ` · ${state.data.unavailable} unavailable` : ""}
          </span>
          {selected && !selected.has_data && selected.feed_error ? (
            <>
              <span aria-hidden>|</span>
              <span className="text-aree-yellow">{selected.feed_error}</span>
            </>
          ) : null}
          {selected?.has_data ? (
            <>
              <span aria-hidden>|</span>
              <span>
                Selected{" "}
                <span
                  style={{ color: aqiColor(selected.aqi) }}
                  className="aree-num font-semibold"
                >
                  AQI {selected.aqi}
                </span>{" "}
                · {selected.grap_stage} · feed {feedLabel(selected.feed_id)}
              </span>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
