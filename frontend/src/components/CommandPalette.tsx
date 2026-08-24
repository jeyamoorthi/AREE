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
        icon: <MapPin className="h-3.5 w-3.5" />,
        run: go("/"),
      },
      {
        id: "nav-command",
        group: "Navigate",
        label: "Open Command Center",
        icon: <LayoutDashboard className="h-3.5 w-3.5" />,
        run: go("/dashboard"),
      },
      {
        id: "nav-reports",
        group: "Navigate",
        label: "Generate Report",
        hint: "Report centre",
        icon: <FileText className="h-3.5 w-3.5" />,
        run: go("/reports"),
      },
      {
        id: "nav-policy",
        group: "Navigate",
        label: "Open Policy Console",
        hint: "Command Center → Policy Intelligence",
        icon: <FileText className="h-3.5 w-3.5" />,
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
        icon: <Radio className="h-3.5 w-3.5" />,
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
      icon: <FileText className="h-3.5 w-3.5" />,
      run: go("/dashboard#policy-intelligence"),
    }));

    const eventItems: Item[] = (escalations.data?.events ?? []).slice(0, 20).map((e, i) => ({
      id: `event-${i}-${e.timestamp ?? ""}`,
      group: "Escalation events",
      label: `${e.city ? stationLabel(e.city) : "Unknown station"} → ${e.to_stage ?? "—"}`,
      hint: [e.timestamp, e.aqi !== null ? `AQI ${e.aqi}` : null]
        .filter(Boolean)
        .join(" · "),
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
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
      className="fixed inset-0 z-[1000] flex items-start justify-center bg-black/65 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="border-aree-border-strong bg-aree-card aree-rise w-full max-w-xl overflow-hidden rounded-2xl border shadow-[0_24px_70px_rgba(0,0,0,0.65)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="border-aree-border flex items-center gap-3 border-b px-4 py-3">
          <Search className="text-aree-muted h-4 w-4 shrink-0" aria-hidden />
          <input
            /* The palette is a modal opened by an explicit shortcut, so focus
               belongs in its input the moment it mounts. */
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
            placeholder="Search station, policy, event…"
            aria-label="Search station, policy, event"
            className="text-aree-body placeholder:text-aree-faint w-full bg-transparent text-sm outline-none"
          />
          <kbd className="border-aree-border text-aree-faint rounded border px-1.5 py-0.5 font-mono text-[10px]">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="text-aree-muted px-4 py-6 text-center text-[13px]">
              No matches{stationsState.initialLoading ? " — loading station network…" : ""}
            </div>
          ) : (
            Object.entries(groups).map(([group, groupItems]) => (
              <div key={group} className="mb-1">
                <div className="aree-eyebrow px-4 py-1.5 text-[9.5px]">{group}</div>
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
                      className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${
                        isActive ? "bg-aree-accent/10" : "hover:bg-aree-border/40"
                      }`}
                    >
                      <span
                        className={isActive ? "text-aree-accent" : "text-aree-faint"}
                        aria-hidden
                      >
                        {item.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate text-[13px] ${
                            isActive ? "text-aree-text font-semibold" : "text-aree-body"
                          }`}
                        >
                          {item.label}
                        </span>
                        {item.hint ? (
                          <span className="text-aree-dim block truncate text-[11px]">
                            {item.hint}
                          </span>
                        ) : null}
                      </span>
                      {item.badge ? (
                        <span
                          className="aree-num shrink-0 text-[11px] font-bold"
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

        <div className="border-aree-border text-aree-faint flex items-center gap-4 border-t px-4 py-2 text-[10px]">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
