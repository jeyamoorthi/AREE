"use client";

/**
 * Lightweight command palette (Ctrl/Cmd + K).
 *
 * No new dependency and no new backend search: it filters data the app has
 * already loaded — the shared station list — plus policy documents and
 * escalation events, which are only fetched while the palette is open.
 */

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  FileText,
  LayoutDashboard,
  MapPin,
  Radio,
  Search,
} from "lucide-react";

import { useStations } from "@/components/providers/LiveDataProvider";
import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";
import { freshness } from "@/lib/freshness";
import { feedLabel, stationLabel } from "@/lib/station";
import { aqiColor } from "@/lib/theme";
import type { EscalationsResponse, PolicyResponse } from "@/types";

type Item = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  badge?: { text: string; color: string };
  icon: React.ReactNode;
  run: () => void;
};

/**
 * Mounted only while open (see AppShell), so opening it resets its own state
 * naturally instead of through an effect.
 */
export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const stationsState = useStations();

  // Only fetched while the palette is open — the rest of the app never needs it.
  const policy = usePolling<PolicyResponse>((signal) => api.policy(signal), {
    intervalMs: 60000,
  });
  const escalations = usePolling<EscalationsResponse>(
    (signal) => api.escalations(undefined, signal),
    { intervalMs: 60000 },
  );

  const items = useMemo<Item[]>(() => {
    const go = (href: string) => () => {
      onClose();
      router.push(href);
    };

    const navigation: Item[] = [
      {
        id: "nav-overview",
        group: "Navigate",
        label: "Open National Overview",
        icon: <MapPin className="h-4 w-4" />,
        run: go("/"),
      },
      {
        id: "nav-command",
        group: "Navigate",
        label: "Open Command Center",
        icon: <LayoutDashboard className="h-4 w-4" />,
        run: go("/dashboard"),
      },
      {
        id: "nav-reports",
        group: "Navigate",
        label: "Generate Report",
        hint: "Report centre",
        icon: <FileText className="h-4 w-4" />,
        run: go("/reports"),
      },
      {
        id: "nav-policy",
        group: "Navigate",
        label: "Open Policy Console",
        hint: "Command Center → Policy Intelligence",
        icon: <FileText className="h-4 w-4" />,
        run: go("/dashboard#policy-intelligence"),
      },
    ];

    const stationItems: Item[] = (stationsState.data?.stations ?? []).map((s) => {
      const look = freshness(s.freshness_status);
      return {
        id: `station-${s.station}`,
        group: "Stations",
        label: stationLabel(s.station),
        hint: [feedLabel(s.feed_id), s.city].filter(Boolean).join(" · "),
        badge: s.has_data
          ? { text: `AQI ${s.aqi}`, color: aqiColor(s.aqi) }
          : { text: look.label, color: look.color },
        icon: <Radio className="h-4 w-4" />,
        run: () => {
          onClose();
          router.push(`/stations/${encodeURIComponent(s.station)}`);
        },
      };
    });

    const policyItems: Item[] = (policy.data?.policy_files ?? []).map((f) => ({
      id: `policy-${f.name}`,
      group: "Policy documents",
      label: f.name,
      hint: `${f.type.toUpperCase()} · ${f.size_kb} KB`,
      icon: <FileText className="h-4 w-4" />,
      run: go("/dashboard#policy-intelligence"),
    }));

    const eventItems: Item[] = (escalations.data?.events ?? []).slice(0, 20).map((e, i) => ({
      id: `event-${i}-${e.timestamp ?? ""}`,
      group: "Escalation events",
      label: `${e.city ? stationLabel(e.city) : "Unknown station"} → ${e.to_stage ?? "—"}`,
      hint: [e.timestamp, e.aqi !== null ? `AQI ${e.aqi}` : null]
        .filter(Boolean)
        .join(" · "),
      icon: <AlertTriangle className="h-4 w-4" />,
      run: e.city
        ? () => {
            onClose();
            router.push(`/stations/${encodeURIComponent(e.city as string)}`);
          }
        : go("/"),
    }));

    return [...navigation, ...stationItems, ...policyItems, ...eventItems];
  }, [stationsState.data, policy.data, escalations.data, router, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 24);
    return items
      .filter((item) =>
        `${item.label} ${item.hint ?? ""} ${item.group}`.toLowerCase().includes(q),
      )
      .slice(0, 24);
  }, [items, query]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const groups = filtered.reduce<Record<string, Item[]>>((acc, item) => {
    (acc[item.group] ??= []).push(item);
    return acc;
  }, {});

  let runningIndex = -1;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-start justify-center bg-black/70 px-4 pt-[15vh] backdrop-blur-md"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-aree-surface-2 w-full max-w-2xl overflow-hidden rounded-[var(--aree-radius-lg)] border border-aree-border shadow-[var(--aree-shadow-lg)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-aree-border bg-aree-surface-1">
          <Search className="text-aree-accent h-5 w-5 shrink-0" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                filtered[active]?.run();
              }
            }}
            placeholder="Search stations, policies, events…"
            aria-label="Search station, policy, event"
            className="text-white placeholder:text-gray-500 w-full bg-transparent text-base outline-none font-medium"
          />
          <kbd className="bg-aree-surface-3 border border-aree-border text-gray-400 rounded-[var(--aree-radius-sm)] px-2 py-1 font-mono text-[11px] hidden sm:block">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-2 bg-aree-surface-2">
          {filtered.length === 0 ? (
            <div className="text-gray-400 px-6 py-12 text-center text-sm">
              No results found{stationsState.initialLoading ? " — loading station network…" : ""}
            </div>
          ) : (
            Object.entries(groups).map(([group, groupItems]) => (
              <div key={group} className="mb-3 px-2">
                <div className="text-[10px] font-bold tracking-wider text-gray-500 uppercase px-4 py-2 mt-2">{group}</div>
                {groupItems.map((item) => {
                  runningIndex += 1;
                  const index = runningIndex;
                  const isActive = index === active;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-index={index}
                      onMouseEnter={() => setActive(index)}
                      onClick={item.run}
                      className={`flex w-full items-center gap-4 px-4 py-3 text-left rounded-[var(--aree-radius-md)] transition-colors ${
                        isActive ? "bg-aree-surface-3 border border-aree-border/50 shadow-sm" : "border border-transparent hover:bg-aree-surface-3/50"
                      }`}
                    >
                      <span
                        className={`flex items-center justify-center w-8 h-8 rounded-full shrink-0 ${isActive ? "bg-aree-accent/15 text-aree-accent" : "bg-aree-surface-4 text-gray-400"}`}
                        aria-hidden
                      >
                        {item.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate text-[14px] ${
                            isActive ? "text-white font-medium" : "text-gray-300"
                          }`}
                        >
                          {item.label}
                        </span>
                        {item.hint ? (
                          <span className="text-gray-500 block truncate text-[12px] mt-0.5">
                            {item.hint}
                          </span>
                        ) : null}
                      </span>
                      {item.badge ? (
                        <span
                          className="shrink-0 text-[12px] font-medium px-2 py-1 rounded bg-aree-surface-4"
                          style={{ color: item.badge.color }}
                        >
                          {item.badge.text}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="bg-aree-surface-1 border-t border-aree-border text-gray-500 flex flex-wrap items-center gap-6 px-5 py-3 text-[11px] font-medium">
          <span className="flex items-center gap-1.5"><kbd className="font-mono bg-aree-surface-3 px-1 rounded">↑</kbd><kbd className="font-mono bg-aree-surface-3 px-1 rounded">↓</kbd> navigate</span>
          <span className="flex items-center gap-1.5"><kbd className="font-mono bg-aree-surface-3 px-1 rounded">↵</kbd> open</span>
          <span className="flex items-center gap-1.5"><kbd className="font-mono bg-aree-surface-3 px-1 rounded">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
