"use client";

/**
 * Lightweight command palette (Ctrl/Cmd + K).
 *
 * No new dependency and no new backend search: it filters data the app has
 * already loaded — the shared station list — plus policy documents and
 * escalation events, which are only fetched while the palette is open.
 *
 * COLOURS. This file used to be written for a dark surface it never had: the
 * search input was `text-white` on `bg-aree-surface-1`, which resolved to #ffffff
 * on #ffffff — an invisible field the operator was expected to type into — and the
 * result labels were `text-gray-300` on var(--aree-surface-2), around 1.4:1. Every foreground
 * here now comes from an `--aree-*` token, so the palette is legible on the surface
 * it is actually painted on.
 */

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Clock,
  FileText,
  LayoutDashboard,
  MapPin,
  Radio,
  RefreshCw,
  Search,
} from "lucide-react";

import {
  useStations,
  useSystemStatus,
} from "@/components/providers/LiveDataProvider";
import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";
import { freshness } from "@/lib/freshness";
import { rememberRecent, readRecents } from "@/lib/recents";
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
  /** Everything this item can be matched against, lower-cased once. */
  search: string;
  /** Recorded in the recents list when run. Absent = not worth remembering. */
  recent?: { kind: "station" | "nav"; id: string };
  run: () => void;
};

/* Sections appear in this order when they have results. Navigation first because a
   palette is opened to GO somewhere far more often than to look something up. */
const GROUP_ORDER = [
  "Recent",
  "Navigate",
  "Actions",
  "Stations",
  "Policy documents",
  "Escalation events",
];

/**
 * Mounted only while open (see AppShell), so opening it resets its own state
 * naturally instead of through an effect.
 */
export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const stationsState = useStations();
  const statusState = useSystemStatus();

  /* Read once per open. The palette is unmounted while closed, so this is not a
     subscription and cannot go stale within a session. Never read during render on
     the server — see lib/recents. */
  const [recents] = useState(() => readRecents());

  // Only fetched while the palette is open — the rest of the app never needs it.
  const policy = usePolling<PolicyResponse>((signal) => api.policy(signal), {
    intervalMs: 60000,
  });
  const escalations = usePolling<EscalationsResponse>(
    (signal) => api.escalations(undefined, signal),
    { intervalMs: 60000 },
  );

  const stationsRefresh = stationsState.refresh;
  const statusRefresh = statusState.refresh;

  const items = useMemo<Item[]>(() => {
    const go = (href: string) => () => {
      onClose();
      router.push(href);
    };

    /* The application's real sections. Atmospheric and Ventilation are no longer
       separate destinations — they are tabs of /outlook — so there is one entry. */
    const navigation: Item[] = [
      {
        id: "nav-/",
        group: "Navigate",
        label: "National Overview",
        hint: "Network map, distribution and recent events",
        icon: <MapPin className="h-4 w-4" />,
        search: "national overview dashboard map network home",
        recent: { kind: "nav", id: "/" },
        run: go("/"),
      },
      {
        id: "nav-/dashboard",
        group: "Navigate",
        label: "Command Center",
        hint: "Per-station regulatory intelligence",
        icon: <LayoutDashboard className="h-4 w-4" />,
        search: "command center station dashboard",
        recent: { kind: "nav", id: "/dashboard" },
        run: go("/dashboard"),
      },
      {
        id: "nav-/outlook",
        group: "Navigate",
        label: "Outlook",
        hint: "Summary and Diagnostics — forecast, cause and recommended response",
        icon: <Activity className="h-4 w-4" />,
        search:
          "outlook atmospheric ventilation summary diagnostics forecast dispersion",
        recent: { kind: "nav", id: "/outlook" },
        run: go("/outlook"),
      },
      {
        id: "nav-/reports",
        group: "Navigate",
        label: "Reports",
        hint: "Generate a municipal escalation brief",
        icon: <FileText className="h-4 w-4" />,
        search: "reports report centre pdf brief generate",
        recent: { kind: "nav", id: "/reports" },
        run: go("/reports"),
      },
      {
        id: "nav-policy",
        group: "Navigate",
        label: "Policy Console",
        hint: "Command Center → Policy Intelligence",
        icon: <FileText className="h-4 w-4" />,
        search: "policy console intelligence documents rag index",
        recent: { kind: "nav", id: "/dashboard#policy-intelligence" },
        run: go("/dashboard#policy-intelligence"),
      },
    ];

    /* ACTIONS — only what the application can genuinely already do.
       `refresh` is part of every PollingState; calling it refetches the shared
       datasets immediately instead of waiting out the interval. There is no
       replay action here on purpose: replay lives in the Outlook page's own
       provider, which this palette sits outside of, so a "toggle replay" command
       would be a control with nothing behind it. */
    const actions: Item[] = [
      {
        id: "action-refresh",
        group: "Actions",
        label: "Refresh live data",
        hint: "Refetch station network and system status now",
        icon: <RefreshCw className="h-4 w-4" />,
        search: "refresh reload refetch update live data stations status",
        run: () => {
          stationsRefresh();
          statusRefresh();
          onClose();
        },
      },
    ];

    const stationItems: Item[] = (stationsState.data?.stations ?? []).map((s) => {
      const look = freshness(s.freshness_status);
      const name = stationLabel(s.station);
      return {
        id: `station-${s.station}`,
        group: "Stations",
        label: name,
        hint: [feedLabel(s.feed_id), s.city, look.label].filter(Boolean).join(" · "),
        badge: s.has_data
          ? { text: `AQI ${s.aqi ?? "—"}`, color: aqiColor(s.aqi) }
          : { text: look.label, color: look.color },
        icon: <Radio className="h-4 w-4" />,
        search: `${name} ${s.station} ${s.city ?? ""} ${s.feed_id ?? ""} ${
          s.grap_stage ?? ""
        }`,
        recent: { kind: "station", id: s.station },
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
      search: `${f.name} ${f.type} policy document`,
      run: go("/dashboard#policy-intelligence"),
    }));

    const eventItems: Item[] = (escalations.data?.events ?? [])
      .slice(0, 20)
      .map((e, i) => {
        const where = e.city ?? e.station ?? null;
        return {
          id: `event-${i}-${e.timestamp ?? ""}`,
          group: "Escalation events",
          label: `${where ? stationLabel(where) : "Unknown station"} → ${e.to_stage ?? "—"}`,
          hint: [e.timestamp, e.aqi !== null ? `AQI ${e.aqi}` : null]
            .filter(Boolean)
            .join(" · "),
          icon: <AlertTriangle className="h-4 w-4" />,
          search: `${where ?? ""} ${e.to_stage ?? ""} ${e.from_stage ?? ""} escalation event`,
          run: where
            ? () => {
                onClose();
                router.push(`/stations/${encodeURIComponent(where)}`);
              }
            : go("/"),
        };
      });

    return [...navigation, ...actions, ...stationItems, ...policyItems, ...eventItems];
  }, [
    stationsState.data,
    policy.data,
    escalations.data,
    router,
    onClose,
    stationsRefresh,
    statusRefresh,
  ]);

  /* Recents are resolved against the live item list rather than rendered from what
     was stored. A station that has since left the network, or a route that no longer
     exists, simply does not come back — the palette never offers a destination it
     cannot reach or names a station from memory. */
  const recentItems = useMemo<Item[]>(() => {
    if (recents.length === 0) return [];
    return recents
      .map((entry) =>
        items.find((it) => it.recent?.kind === entry.kind && it.recent.id === entry.id),
      )
      .filter((it): it is Item => Boolean(it))
      .map((it) => ({ ...it, id: `recent-${it.id}`, group: "Recent" }));
  }, [recents, items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    // Nothing typed: lead with where the operator has actually been.
    if (!q) return [...recentItems, ...items].slice(0, 24);

    const matches = items.filter((item) =>
      `${item.label} ${item.hint ?? ""} ${item.group} ${item.search}`
        .toLowerCase()
        .includes(q),
    );

    /* Prefix hits first — typing "out" should surface Outlook above anything that
       merely contains the letters. Deterministic, and no fuzzy-search dependency. */
    const ranked = [
      ...matches.filter((m) => m.label.toLowerCase().startsWith(q)),
      ...matches.filter((m) => !m.label.toLowerCase().startsWith(q)),
    ];

    return ranked
      .slice()
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
      .slice(0, 24);
  }, [items, recentItems, query]);

  const activeItem = filtered[active];
  const activeOptionId = activeItem ? `${listId}-opt-${active}` : undefined;

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [active]);

  /** Run an item and record it, so the next open leads with it. */
  function activate(item: Item | undefined) {
    if (!item) return;
    if (item.recent) rememberRecent(item.recent);
    item.run();
  }

  /* Consecutive runs of the same group, keeping each item's flat index so the
     keyboard cursor and the rendered order cannot disagree. */
  const groups = useMemo(() => {
    const out: { group: string; entries: { item: Item; index: number }[] }[] = [];
    filtered.forEach((item, index) => {
      const tail = out[out.length - 1];
      if (tail && tail.group === item.group) tail.entries.push({ item, index });
      else out.push({ group: item.group, entries: [{ item, index }] });
    });
    return out;
  }, [filtered]);

  const emptyMessage = stationsState.initialLoading
    ? "Stations loading…"
    : "No matching commands or stations";

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-md"
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
        <div className="flex items-center gap-3 px-5 py-4 border-b border-aree-border bg-aree-surface-1 focus-within:border-aree-accent focus-within:ring-1 focus-within:ring-aree-accent/40">
          <Search className="text-aree-forest h-5 w-5 shrink-0" aria-hidden />
          {/* Combobox pattern: focus never leaves this input, and the highlighted
              result is announced through aria-activedescendant. That is also why the
              option buttons below are not tabbable — there is no focus to trap. */}
          <input
            autoFocus
            value={query}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
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
                activate(filtered[active]);
              }
            }}
            placeholder="Search stations, sections, policies, events…"
            aria-label="Search station, section, policy, event"
            className="text-aree-text placeholder:text-aree-dim w-full bg-transparent text-base outline-none font-medium"
          />
          <kbd className="bg-aree-surface-3 border border-aree-border text-aree-muted rounded-[var(--aree-radius-sm)] px-2 py-1 font-mono text-[11px] hidden sm:block">
            ESC
          </kbd>
        </div>

        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Results"
          className="max-h-[50vh] overflow-y-auto py-2 bg-aree-surface-2"
        >
          {filtered.length === 0 ? (
            <div className="text-aree-muted px-6 py-12 text-center text-sm">
              {emptyMessage}
            </div>
          ) : (
            groups.map(({ group, entries }) => (
              <div key={group} className="mb-3 px-2" role="group" aria-label={group}>
                <div className="text-[10px] font-bold tracking-wider text-aree-dim uppercase px-4 py-2 mt-2">
                  {group}
                </div>
                {entries.map(({ item, index }) => {
                  const isActive = index === active;
                  return (
                    <button
                      key={item.id}
                      id={`${listId}-opt-${index}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      tabIndex={-1}
                      data-index={index}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => activate(item)}
                      className={`flex w-full items-center gap-4 px-4 py-3 text-left rounded-[var(--aree-radius-md)] transition-colors ${
                        isActive
                          ? "bg-aree-surface-3 border border-aree-border-strong shadow-sm"
                          : "border border-transparent hover:bg-aree-surface-3/60"
                      }`}
                    >
                      {/* Selection is carried by the border and the arrow as well as
                          the fill, so it survives without colour perception. */}
                      <span
                        className={`flex items-center justify-center w-8 h-8 rounded-full shrink-0 ${
                          isActive
                            ? "bg-aree-forest/10 text-aree-forest"
                            : "bg-aree-surface-4 text-aree-muted"
                        }`}
                        aria-hidden
                      >
                        {item.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate text-[14px] ${
                            isActive
                              ? "text-aree-text font-semibold"
                              : "text-aree-body font-medium"
                          }`}
                        >
                          {item.label}
                        </span>
                        {item.hint ? (
                          <span className="text-aree-dim block truncate text-[12px] mt-0.5">
                            {item.hint}
                          </span>
                        ) : null}
                      </span>
                      {item.badge ? (
                        <span
                          className="shrink-0 text-[12px] font-bold px-2 py-1 rounded bg-aree-surface-4"
                          style={{ color: item.badge.color }}
                        >
                          {item.badge.text}
                        </span>
                      ) : null}
                      <span
                        className={`shrink-0 text-[12px] text-aree-forest ${
                          isActive ? "opacity-100" : "opacity-0"
                        }`}
                        aria-hidden
                      >
                        ↵
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="bg-aree-surface-1 border-t border-aree-border text-aree-muted flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3 text-[11px] font-medium">
          <span className="flex items-center gap-1.5">
            <kbd className="font-mono bg-aree-surface-3 px-1 rounded">↑</kbd>
            <kbd className="font-mono bg-aree-surface-3 px-1 rounded">↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="font-mono bg-aree-surface-3 px-1 rounded">↵</kbd> open
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="font-mono bg-aree-surface-3 px-1 rounded">esc</kbd> close
          </span>
          {recentItems.length > 0 ? (
            <span className="ml-auto hidden items-center gap-1.5 sm:flex">
              <Clock className="h-3 w-3" aria-hidden />
              {recentItems.length} recent
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
