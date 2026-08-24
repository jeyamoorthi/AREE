"use client";

/**
 * Cross-station ranking. Every group and ordering is computed by the backend
 * from live engine state; this only renders it.
 */

import Link from "next/link";

import { Panel } from "@/components/ui/Card";
import { stationLabel } from "@/lib/station";
import { aqiColor, eriColor } from "@/lib/theme";
import type { RankedEntry, RankingGroup } from "@/types";

function valueColor(groupKey: string, entry: RankedEntry): string {
  if (groupKey === "aqi") return aqiColor(entry.aqi);
  if (groupKey === "eri") return eriColor(entry.eri_score);
  return "var(--aree-body)";
}

export function RankingList({
  title,
  entries,
  groupKey,
  highlight,
}: {
  title: string;
  entries: RankedEntry[];
  groupKey: string;
  highlight?: string | null;
}) {
  return (
    <Panel title={title} padding="p-0">
      {entries.length === 0 ? (
        <div className="px-4 py-4 text-[12.5px] text-aree-muted">No data yet</div>
      ) : (
        <ol className="divide-y divide-aree-border">
          {entries.map((entry) => {
            const isSelected = highlight === entry.station;
            return (
              <li
                key={entry.station}
                className={`flex items-center justify-between gap-3 px-4 py-2.5 transition-colors ${
                  isSelected ? "bg-aree-surface-2" : "hover:bg-aree-surface-1"
                }`}
              >
                <Link
                  href={`/stations/${encodeURIComponent(entry.station)}`}
                  className={`flex min-w-0 items-baseline gap-2 text-[12.5px] transition-colors hover:underline ${
                    isSelected
                      ? "font-bold text-aree-text"
                      : "text-aree-body hover:text-aree-accent"
                  }`}
                  title={entry.station}
                >
                  <span className="aree-num shrink-0 text-[10px] text-aree-faint">
                    {String(entry.rank).padStart(2, "0")}
                  </span>
                  <span className="truncate">{stationLabel(entry.station)}</span>
                </Link>
                <span
                  className="aree-num shrink-0 text-[13.5px] font-bold"
                  style={{ color: valueColor(groupKey, entry) }}
                >
                  {entry.value ?? "—"}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

export default function RankingTable({
  rankings,
  highlight,
}: {
  rankings: RankingGroup[];
  highlight?: string | null;
}) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
      {rankings.map((group) => (
        <RankingList
          key={group.key}
          title={group.label}
          entries={group.entries}
          groupKey={group.key}
          highlight={highlight}
        />
      ))}
    </div>
  );
}
