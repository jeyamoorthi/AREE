"use client";

/**
 * AREE CommandBar Component
 * Top navigation and system telemetric control bar for the AREE command center.
 */

import { usePathname } from "next/navigation";
import {
  Clock,
  Compass,
  FileText,
  LayoutDashboard,
  MapPin,
  Menu,
  Radio,
  Search,
} from "lucide-react";

import { useSystemStatus } from "@/components/providers/LiveDataProvider";
import { istClock } from "@/lib/clock";

interface CommandBarProps {
  onOpenSearch?: () => void;
  onOpenMobile?: () => void;
}

export default function CommandBar({
  onOpenSearch,
  onOpenMobile,
}: CommandBarProps) {
  const pathname = usePathname();
  const statusState = useSystemStatus();
  const status = statusState.data;

  const offline = Boolean(statusState.error) && !status;
  const engineDown = Boolean(status && !status.engine_loaded);
  const live = Boolean(status?.engine_loaded);

  const indicatorColor = offline
    ? "var(--aree-red)"
    : engineDown
      ? "var(--aree-yellow)"
      : "var(--aree-green)";

  const indicatorLabel = offline
    ? "OFFLINE"
    : engineDown
      ? "ENGINE DOWN"
      : "LIVE";

  const clock = istClock(status?.server_time);

  // Derive current location breadcrumb
  let pageTitle = "National Overview";
  let PageIcon = MapPin;

  if (pathname.startsWith("/dashboard") || pathname.startsWith("/stations")) {
    pageTitle = "Command Center";
    PageIcon = LayoutDashboard;
  } else if (pathname.startsWith("/reports")) {
    pageTitle = "Reports & Analytics";
    PageIcon = FileText;
  }

  return (
    <header
      className="sticky top-0 z-30 flex h-[70px] items-center justify-between border-b border-aree-border bg-aree-bg/85 px-4 sm:px-6 backdrop-blur-md transition-colors"
      aria-label="Command bar"
    >
      {/* Left: Mobile Menu Trigger + Page Title & Breadcrumb */}
      <div className="flex items-center gap-3">
        {onOpenMobile && (
          <button
            type="button"
            onClick={onOpenMobile}
            className="lg:hidden flex h-8 w-8 items-center justify-center rounded-lg border border-aree-border bg-aree-surface-1 text-aree-muted hover:text-aree-text hover:bg-aree-surface-2 transition-colors cursor-pointer"
            aria-label="Open sidebar menu"
          >
            <Menu className="h-4 w-4" aria-hidden="true" />
          </button>
        )}

        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-aree-forest/10 text-aree-forest">
            <PageIcon className="h-4 w-4" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-aree-text leading-tight sm:text-base">
              {pageTitle}
            </h1>
            <span className="text-[10px] font-semibold tracking-wider text-aree-dim uppercase hidden sm:block">
              AREE Environmental Intel
            </span>
          </div>
        </div>
      </div>

      {/* Right: Search Bar Trigger & Live Telemetry Pill */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Search / Command Palette Trigger */}
        {onOpenSearch && (
          <button
            type="button"
            onClick={onOpenSearch}
            className="flex items-center gap-2.5 rounded-lg border border-aree-border bg-aree-surface-1 px-3 py-1.5 text-xs text-aree-muted shadow-2xs hover:border-aree-border-strong hover:text-aree-text hover:bg-aree-surface-2 transition-all cursor-pointer"
            aria-label="Search station, policy, or event"
          >
            <Search className="h-3.5 w-3.5 text-aree-dim" aria-hidden="true" />
            <span className="hidden md:inline text-aree-body font-medium">
              Search station, policy, event…
            </span>
            <kbd className="hidden sm:inline-flex items-center rounded border border-aree-border bg-aree-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-aree-dim">
              Ctrl K
            </kbd>
          </button>
        )}

        {/* Live Status & Clock Pill */}
        <div
          className="flex items-center gap-3 rounded-lg border border-aree-border bg-aree-surface-1 px-3 py-1.5 shadow-2xs text-xs"
          role="status"
          aria-live="polite"
        >
          {/* Status Dot + Label */}
          <span className="flex items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-full ${live ? "aree-live-dot" : ""}`}
              style={{ backgroundColor: indicatorColor }}
              aria-hidden="true"
            />
            <span
              className="text-[11px] font-bold tracking-wider"
              style={{ color: indicatorColor }}
            >
              {indicatorLabel}
            </span>
          </span>

          <span className="h-3.5 w-px bg-aree-border" aria-hidden="true" />

          {/* Active / Known stations count */}
          <span
            className="aree-num text-aree-body text-[11px] font-semibold"
            title="Active stations / Known stations"
          >
            {status
              ? `${status.active_stations}/${status.known_stations} ONLINE`
              : "—/— ONLINE"}
          </span>

          {/* IST Server Clock */}
          <span className="hidden h-3.5 w-px bg-aree-border md:block" aria-hidden="true" />

          <span className="aree-num text-aree-muted text-[11px] font-medium hidden md:flex items-center gap-1">
            <Clock className="h-3 w-3 text-aree-dim" aria-hidden="true" />
            {clock ?? "—"}
          </span>
        </div>
      </div>
    </header>
  );
}
